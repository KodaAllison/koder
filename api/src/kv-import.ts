/* The one-shot Deno KV -> Postgres import and its verifier (KODER-E214), the
 * tooling step 4 of docs/runbooks/cutover-to-node.md asks for. The CLI is
 * scripts/import-kv.ts; the logic lives here so tests can drive it.
 *
 * importDump() loads a dump (kv-dump.ts) into an EMPTY database in ONE
 * transaction: all or nothing. It builds rows with PgStore's own helpers
 * (planBoard, cardToRow, itemToRow, rankAt, upsertCards), so what lands is what
 * a PUT /state of the same board would have stored, normalisation included
 * (the intentional differences are listed in api/README.md, "What differs").
 * What it adds is the part no PUT can do: it sets board_head.rev to the KV
 * doc's exact rev (never reset, never bumped), writes the revisions row for
 * that rev (actor `migration`, no `changes` rows, so GET /state?rev=<head>
 * keeps working), the archive, and every webhook delivery id.
 *
 * verifyImport() reads the database back the way GET /state, GET /archive and
 * the webhook would (PgStore.readBoard / readArchive) and compares it with the
 * dump, with an expectation computed independently of the row code. */

import {
  cardToRow,
  itemToRow,
  type ItemRow,
  type PgSql,
  type PgTx,
  PgStore,
  planBoard,
  rankAt,
  upsertCards,
  wellFormed,
} from "./pg-store.ts";
import { OWNER } from "./pg-schema.ts";
import type { KvDump } from "./kv-dump.ts";
import type { Board } from "./store.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const MIGRATION_ACTOR = "migration";
export const DELIVERY_OUTCOME = "migrated";

/* The database already holds data. Thrown before anything is written. */
export class NotEmptyError extends Error {
  readonly found: Record<string, number>;
  constructor(found: Record<string, number>) {
    const what = Object.entries(found).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
    super(
      `refusing to import: the database is not empty (${what}). The import only loads into a ` +
        `freshly migrated, empty database; wipe it (runbook step 2.6) and run it again.`,
    );
    this.name = "NotEmptyError";
    this.found = found;
  }
}

export type ImportSummary = {
  rev: number;
  updatedAt: string;
  cards: number;
  lifeItems: number;
  archived: number;
  deliveries: number;
};

/* What makes a database "not empty": a head past rev 0, or any row in the
 * tables an import fills (soft-deleted rows count: they are someone's data). */
async function occupancy(tx: PgTx): Promise<Record<string, number>> {
  const [row] = await tx<Record<string, number>[]>`
    SELECT (SELECT rev FROM board_head WHERE owner_id = ${OWNER})::bigint AS board_head_rev,
           (SELECT count(*) FROM cards)::bigint AS cards,
           (SELECT count(*) FROM life_items)::bigint AS life_items,
           (SELECT count(*) FROM archived_cards)::bigint AS archived_cards,
           (SELECT count(*) FROM webhook_deliveries)::bigint AS webhook_deliveries,
           (SELECT count(*) FROM revisions)::bigint AS revisions,
           (SELECT count(*) FROM changes)::bigint AS changes`;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

/* Load a validated dump (validateDump) into an empty, migrated database. The
 * whole import is one transaction under the board_head row lock. Throws
 * NotEmptyError (database untouched) or whatever the database raised (rolled
 * back). */
export async function importDump(sql: PgSql, dump: KvDump): Promise<ImportSummary> {
  const { rev } = dump.doc;
  const updatedAt = new Date(dump.doc.updatedAt);
  const plan = planBoard(dump.doc.board as Board);

  // Rows exactly as diffBoard would build them for a first PUT: rank is the
  // card's position in its column, in array order.
  const nextRank = new Map<string, number>();
  const cards = plan.cards.map(({ card, board_id, column_id }) => {
    const slot = `${board_id}\u0000${column_id}`;
    const index = nextRank.get(slot) ?? 0;
    nextRank.set(slot, index + 1);
    // pr/prRev are server-owned on a PUT; here the KV card's own values are the
    // state being carried over, so they are handed to the row explicitly.
    const workflow = {
      pr: typeof card.pr === "string" ? card.pr : null,
      pr_rev: Number.isSafeInteger(card.prRev) ? (card.prRev as number) : null,
    };
    return cardToRow(card, board_id, column_id, rankAt(index), workflow);
  });
  const itemRank = new Map<string, number>();
  const items: ItemRow[] = plan.items.map(({ item, kind }) => {
    const index = itemRank.get(kind) ?? 0;
    itemRank.set(kind, index + 1);
    return itemToRow(item, kind, rankAt(index));
  });

  // Archive: chunks in n order, cards in array order; the first of two equal
  // ids wins, as POST /archive does here (KV could never hold two).
  const archive = wellFormed(dump.archive.flatMap((chunk) => chunk.cards)) as Json[];
  const deliveries = [...new Set(dump.deliveries)];

  return await sql.begin(async (tx) => {
    // The head row is the lock every other writer takes too.
    await tx`SELECT rev FROM board_head WHERE owner_id = ${OWNER} FOR UPDATE`;
    const found = await occupancy(tx);
    if (Object.values(found).some((n) => n > 0)) throw new NotEmptyError(found);

    const head = await tx<{ rev: number }[]>`
      UPDATE board_head
         SET rev = ${rev}, updated_at = ${updatedAt},
             layout = ${JSON.stringify(plan.meta.layout)}::text::jsonb,
             extra = ${JSON.stringify(plan.meta.extra)}::text::jsonb
       WHERE owner_id = ${OWNER} AND rev = 0
      RETURNING rev`;
    if (head.length !== 1) throw new Error("board_head is missing or moved under the import");

    if (cards.length) await upsertCards(tx, cards, "write");
    if (items.length) {
      await tx`
        INSERT INTO life_items (id, owner_id, kind, rank, data, field_order)
        SELECT r.id, ${OWNER}, r.kind, r.rank, r.data, r.field_order
          FROM jsonb_to_recordset(${JSON.stringify(items)}::text::jsonb) AS r(
                 id text, kind text, rank text, data jsonb, field_order text[])`;
    }
    await tx`
      UPDATE life_notes
         SET notes = ${plan.meta.notes}, extra = ${JSON.stringify(plan.meta.notesExtra)}::text::jsonb
       WHERE owner_id = ${OWNER}`;

    // The revision the cutover starts from: no changes rows, so nothing
    // rewinds past it, but GET /state?rev=<head> has a row to find.
    await tx`
      INSERT INTO revisions (owner_id, rev, updated_at, actor, summary)
      VALUES (${OWNER}, ${rev}, ${updatedAt}, ${MIGRATION_ACTOR}, 'imported from Deno KV')`;

    if (archive.length) {
      const body = JSON.stringify(archive);
      await tx`
        INSERT INTO archived_cards (id, owner_id, card)
        SELECT e.card->>'id', ${OWNER}, e.card
          FROM json_array_elements(${body}::text::json) WITH ORDINALITY AS e(card, n)
         ORDER BY e.n
        ON CONFLICT (id) DO NOTHING`;
    }
    if (deliveries.length) {
      await tx`
        INSERT INTO webhook_deliveries (delivery_id, outcome)
        SELECT d, ${DELIVERY_OUTCOME} FROM unnest(${deliveries}::text[]) AS d`;
    }

    const [counted] = await tx<{ archived: number }[]>`
      SELECT count(*)::bigint AS archived FROM archived_cards WHERE owner_id = ${OWNER}`;
    return {
      rev,
      updatedAt: updatedAt.toISOString(),
      cards: cards.length,
      lifeItems: items.length,
      archived: Number(counted.archived),
      deliveries: deliveries.length,
    };
  });
}

/* ---- Verification ---- */

export type VerifyResult = {
  // Anything here fails the cutover.
  differences: string[];
  // Documented, intentional differences that did apply to this dump.
  notes: string[];
  ok: boolean;
};

/* JSON with keys sorted at every depth, so jsonb's key order doesn't matter. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
}
const clip = (text: string, max = 240) => (text.length > max ? `${text.slice(0, max)}...` : text);

/* The board GET /state should return for a dump, worked out from the dump
 * alone: the normalisation api/README.md lists (well-formed strings, first
 * occurrence of a duplicate id, null projects/life as {}, lifeMeta's four keys)
 * and nothing else. Deliberately not built from PgStore's row helpers, so a
 * mistake in them can't also hide in the expectation. */
export function expectedBoard(board: Json): Json {
  const body = wellFormed(board) as Json;
  const seen = new Set<string>();
  const out: Json = {};
  for (const boardId of ["projects", "life"]) {
    const columns: Json = {};
    const source = body[boardId];
    if (typeof source === "object" && source !== null) {
      for (const [column, list] of Object.entries(source)) {
        columns[column] = (list as Json[]).filter((card) => {
          const id = card.id as string;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      }
    }
    out[boardId] = columns;
  }
  const lifeMeta = isObject(body.lifeMeta) ? body.lifeMeta : {};
  const seenItems = new Set<string>();
  const list = (kind: string) => {
    const value = lifeMeta[kind];
    if (!Array.isArray(value)) return [];
    return value.filter((item) => {
      if (!isObject(item) || typeof item.id !== "string" || seenItems.has(item.id)) return false;
      seenItems.add(item.id);
      return true;
    });
  };
  const known = new Set(["focus", "dates", "notes", "stickies"]);
  out.lifeMeta = {
    focus: list("focus"),
    dates: list("dates"),
    notes: typeof lifeMeta.notes === "string" ? lifeMeta.notes : "",
    stickies: list("stickies"),
    ...Object.fromEntries(Object.entries(lifeMeta).filter(([key]) => !known.has(key))),
  };
  for (const [key, value] of Object.entries(body)) {
    if (key !== "projects" && key !== "life" && key !== "lifeMeta") out[key] = value;
  }
  return out;
}

/* Compare what the database serves with the dump. Read-only. `store` is the
 * PgStore the server itself uses, so this is the GET side of the story. */
export async function verifyImport(
  sql: PgSql,
  dump: KvDump,
  store: PgStore = new PgStore(sql),
): Promise<VerifyResult> {
  const differences: string[] = [];
  const notes: string[] = [];
  const rawBoard = dump.doc.board;

  /* ---- head ---- */
  const live = await store.readBoard();
  if (live.rev !== dump.doc.rev) differences.push(`rev: dump ${dump.doc.rev}, database ${live.rev}`);
  const wantUpdated = new Date(dump.doc.updatedAt).toISOString();
  if (live.updatedAt !== wantUpdated) differences.push(`updatedAt: dump ${wantUpdated}, database ${live.updatedAt}`);

  /* ---- board: columns, order, counts, cards, lifeMeta, extras ---- */
  const want = expectedBoard(rawBoard);
  const have = live.board as unknown as Json;
  for (const boardId of ["projects", "life"]) {
    const wantCols = want[boardId] as Record<string, Json[]>;
    const haveCols = (have[boardId] ?? {}) as Record<string, Json[]>;
    const wantOrder = Object.keys(wantCols);
    const haveOrder = Object.keys(haveCols);
    if (JSON.stringify(wantOrder) !== JSON.stringify(haveOrder)) {
      differences.push(`${boardId} column order: dump [${wantOrder}], database [${haveOrder}]`);
    }
    for (const column of wantOrder) {
      const wantCards = wantCols[column];
      const haveCards = haveCols[column];
      if (!haveCards) {
        differences.push(`${boardId}.${column}: missing from the database`);
        continue;
      }
      if (wantCards.length !== haveCards.length) {
        differences.push(`${boardId}.${column}: ${wantCards.length} cards in the dump, ${haveCards.length} in the database`);
      }
      const wantIds = wantCards.map((c) => c.id);
      const haveIds = haveCards.map((c) => c.id);
      if (JSON.stringify(wantIds) !== JSON.stringify(haveIds)) {
        differences.push(`${boardId}.${column} card order: dump [${wantIds}], database [${haveIds}]`);
      }
      const haveById = new Map(haveCards.map((c) => [c.id as string, c]));
      for (const card of wantCards) {
        const got = haveById.get(card.id as string);
        if (got && canonical(got) !== canonical(card)) {
          differences.push(
            `${boardId}.${column} card ${String(card.id)} differs:\n    dump:     ${clip(canonical(card))}\n    database: ${clip(canonical(got))}`,
          );
        }
      }
    }
  }
  for (const key of Object.keys(have)) {
    if (!(key in want)) differences.push(`board has an unexpected key "${key}"`);
  }
  if (canonical(have.lifeMeta) !== canonical(want.lifeMeta)) {
    differences.push(`lifeMeta differs:\n    dump:     ${clip(canonical(want.lifeMeta))}\n    database: ${clip(canonical(have.lifeMeta))}`);
  } else {
    for (const kind of ["focus", "dates", "stickies"]) {
      const a = ((want.lifeMeta as Json)[kind] as Json[]).map((i) => i.id);
      const b = (((have.lifeMeta as Json)[kind] ?? []) as Json[]).map((i) => i.id);
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`lifeMeta.${kind} order: dump [${a}], database [${b}]`);
    }
  }
  // Everything else about the board (top-level extras and their order).
  const wantExtras = Object.keys(want).filter((k) => !["projects", "life", "lifeMeta"].includes(k));
  const haveExtras = Object.keys(have).filter((k) => !["projects", "life", "lifeMeta"].includes(k));
  if (JSON.stringify(wantExtras) !== JSON.stringify(haveExtras)) {
    differences.push(`board extra keys: dump [${wantExtras}], database [${haveExtras}]`);
  }
  for (const key of wantExtras) {
    if (canonical(want[key]) !== canonical(have[key])) differences.push(`board.${key} differs`);
  }

  /* ---- the revision the cutover starts from ---- */
  const [rev] = await sql<{ actor: string; updated_at: Date; changes: number }[]>`
    SELECT r.actor, r.updated_at,
           (SELECT count(*) FROM changes c WHERE c.owner_id = r.owner_id AND c.rev = r.rev)::bigint AS changes
      FROM revisions r WHERE r.owner_id = ${OWNER} AND r.rev = ${dump.doc.rev}`;
  if (!rev) {
    differences.push(`revisions: no row for rev ${dump.doc.rev}, so GET /state?rev=${dump.doc.rev} would 404`);
  } else {
    if (rev.actor !== MIGRATION_ACTOR) differences.push(`revisions[${dump.doc.rev}].actor is "${rev.actor}", expected "${MIGRATION_ACTOR}"`);
    if (rev.updated_at.toISOString() !== wantUpdated) differences.push(`revisions[${dump.doc.rev}].updated_at is ${rev.updated_at.toISOString()}, expected ${wantUpdated}`);
    if (Number(rev.changes) !== 0) differences.push(`revisions[${dump.doc.rev}] has ${rev.changes} changes rows, expected none`);
    const served = await store.boardAt(dump.doc.rev);
    if (!served || canonical(served.board) !== canonical(live.board)) {
      differences.push(`GET /state?rev=${dump.doc.rev} does not equal GET /state`);
    }
  }

  /* ---- archive: ids and order, each card exactly (key order included) ---- */
  const wantArchive: Json[] = [];
  const seenArchive = new Set<string>();
  for (const card of wellFormed(dump.archive.flatMap((chunk) => chunk.cards)) as Json[]) {
    if (seenArchive.has(card.id as string)) continue;
    seenArchive.add(card.id as string);
    wantArchive.push(card);
  }
  const haveArchive = (await store.readArchive()).cards as unknown as Json[];
  if (wantArchive.length !== haveArchive.length) {
    differences.push(`archive: ${wantArchive.length} cards in the dump, ${haveArchive.length} in the database`);
  }
  const wantArchiveIds = wantArchive.map((c) => c.id);
  const haveArchiveIds = haveArchive.map((c) => c.id);
  if (JSON.stringify(wantArchiveIds) !== JSON.stringify(haveArchiveIds)) {
    differences.push(`archive id order: dump [${clip(wantArchiveIds.join(","))}], database [${clip(haveArchiveIds.join(","))}]`);
  } else {
    wantArchive.forEach((card, i) => {
      if (JSON.stringify(card) !== JSON.stringify(haveArchive[i])) {
        differences.push(
          `archive card ${String(card.id)} differs:\n    dump:     ${clip(JSON.stringify(card))}\n    database: ${clip(JSON.stringify(haveArchive[i]))}`,
        );
      }
    });
  }

  /* ---- webhook deliveries: the id sets ---- */
  const wantDeliveries = new Set(dump.deliveries);
  const rows = await sql<{ delivery_id: string; outcome: string }[]>`SELECT delivery_id, outcome FROM webhook_deliveries`;
  const haveDeliveries = new Set(rows.map((r) => r.delivery_id));
  const missing = [...wantDeliveries].filter((id) => !haveDeliveries.has(id));
  const extra = [...haveDeliveries].filter((id) => !wantDeliveries.has(id));
  if (missing.length) differences.push(`deliveries missing from the database (${missing.length}): ${missing.slice(0, 10).join(", ")}`);
  if (extra.length) differences.push(`deliveries in the database but not the dump (${extra.length}): ${extra.slice(0, 10).join(", ")}`);
  const odd = rows.filter((r) => r.outcome !== DELIVERY_OUTCOME);
  if (odd.length) differences.push(`${odd.length} deliveries have an outcome other than "${DELIVERY_OUTCOME}"`);

  /* ---- documented, intentional differences that applied ---- */
  const columnsOf = (b: Json) => ["projects", "life"].flatMap((k) =>
    isObject(b[k]) ? Object.values(b[k] as Json).flatMap((l) => l as Json[]) : []);
  const ids = columnsOf(rawBoard).map((c) => c.id);
  if (new Set(ids).size !== ids.length) notes.push(`duplicate card ids collapsed to the first occurrence (${ids.length - new Set(ids).size})`);
  if (rawBoard.projects == null || rawBoard.life == null) notes.push("a null/absent projects or life became {}");
  if (JSON.stringify(wellFormed(rawBoard)) !== JSON.stringify(rawBoard)) notes.push("U+0000 / lone surrogates in the board became U+FFFD");
  if (JSON.stringify(wellFormed(dump.archive)) !== JSON.stringify(dump.archive)) notes.push("U+0000 / lone surrogates in the archive became U+FFFD");
  const archiveIds = dump.archive.flatMap((chunk) => chunk.cards.map((c) => c.id));
  if (new Set(archiveIds).size !== archiveIds.length) notes.push("duplicate archive ids collapsed to the first occurrence");
  if (new Set(dump.deliveries).size !== dump.deliveries.length) notes.push("duplicate delivery ids collapsed");

  return { differences, notes, ok: differences.length === 0 };
}
