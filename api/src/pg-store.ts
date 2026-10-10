/* PgStore — the Store (store.ts) backed by Postgres (Neon in production,
 * reached through NEON_DATABASE_URL; PGlite in the tests). INCOMPLETE until
 * KODER-EE05 slice 3: reads, PUT /state, the ticket routes and the archive
 * work; history (boardAt, listRevisions, restore) and the webhook throw until
 * slice 3 lands them.
 *
 * Layout (pg-schema.ts): the board is rows, not one document. A card is a row
 * in `cards` keyed by its client id, placed by (board_id, column_id, rank);
 * lifeMeta's three lists are rows in `life_items`, its legacy `notes` string a
 * row in `life_notes`; `board_head` holds the rev, updatedAt and each board's
 * column order. readBoard() assembles the same {rev, updatedAt, board} doc
 * the Deno KV server returned, and a PUT /state is diffed against the rows
 * (section 7.2 of docs/specs/storage-expansion.md) rather than replacing a
 * blob. The archive is NOT part of the board: it is its own append-only table
 * (archived_cards), written without touching the head, as the KV server kept
 * it in separate keys. A card is archived while still live on the board; the
 * client drops it with a later PUT.
 *
 * Round-tripping a board: whatever a client PUTs comes back from GET /state
 * as it was sent, as KV did, with these exceptions, each forced by keying
 * rows on ids:
 *  (1) a card id that appears twice in one body (in two columns, or on both
 *      boards) keeps only its FIRST occurrence, in board order projects then
 *      life, columns and cards in body order; the same for lifeMeta item ids
 *      across focus, dates and stickies;
 *  (2) a lifeMeta item that isn't an object with a string id is dropped;
 *  (3) lifeMeta always comes back with all four keys (focus, dates, notes,
 *      stickies), a non-list or non-string coerced to empty the way the
 *      client's normalize() would;
 *  (4) jsonb keeps no key order inside nested values of unknown fields
 *      (top-level key order is kept, see field_order);
 *  (5) every string in the body, keys and values at any depth, is made
 *      storable first (wellFormed below): U+0000, which Postgres text and
 *      jsonb can't hold, becomes U+FFFD, and so does a lone UTF-16
 *      surrogate, which has no UTF-8 encoding. KV stored both as sent; here
 *      GET returns the replaced form, rather than the PUT failing with a 500
 *      the PWA would retry forever;
 *  (6) a board whose `projects` or `life` is null or absent comes back as
 *      {}, and an array-shaped one (isBoardShaped lets it through) comes back
 *      as an object keyed "0", "1", ...; the client's normalize() reads both
 *      the same way.
 *
 * Connections: ONE postgres() client per process with a small pool
 * (KODER_PG_MAX, default 3). Every statement is a network round trip to Neon,
 * so a PUT pipelines: postgres.js sends queries issued together inside a
 * transaction without waiting for each reply, and applyBoardPut issues its
 * loads as one batch and its writes as another. */

import postgres from "postgres";
import { migrate, OWNER } from "./pg-schema.ts";
import {
  type Actor,
  type ArchivedCard,
  type ArchiveResult,
  type Board,
  type Card,
  type Doc,
  emptyDoc,
  type Head,
  type PutResult,
  type Store,
  resolveTicketId,
  StoreContentionError,
  StoreFullError,
  type StoreLimits,
  type TicketEdits,
  type Unresolved,
  type WebhookEvent,
  type WebhookResult,
} from "./store.ts";

// The PUT body cap the spec proposes for a relational store (section 6, "413
// policy"); the stored board gets the same budget, measured as UTF-8 JSON.
const BOARD_MAX = 2 * 1024 * 1024;

const BOARD_IDS = ["projects", "life"] as const;
type BoardId = typeof BOARD_IDS[number];
const LIFE_KINDS = ["focus", "dates", "stickies"] as const;
type LifeKind = typeof LIFE_KINDS[number];
const LIFE_META_KEYS = new Set(["focus", "dates", "notes", "stickies"]);
type Json = Record<string, unknown>;

/* ---- Rows: the board as PgStore stores it ---- */

export type CardRow = {
  id: string;
  board_id: BoardId;
  column_id: string;
  rank: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project_id: string | null;
  field_order: string[];
  extra: Json;
  pr: string | null;
  pr_rev: number | null;
};
export type ItemRow = { id: string; kind: LifeKind; rank: string; data: Json; field_order: string[] };
export type Layout = Record<BoardId, string[]>;
// Everything about one board that isn't a card or an item: board_head's
// layout/extra and the life_notes row.
export type BoardMeta = { layout: Layout; extra: Json; notes: string; notesExtra: Json };
export type BoardRows = { meta: BoardMeta; cards: CardRow[]; items: ItemRow[] };

/* Ranks are positional: the card's index in its column, zero-padded so text
 * order (COLLATE "C") is numeric order. A full-board PUT already carries every
 * column's complete order, so this is exact and trivially correct. The cost
 * is write amplification: a card inserted near the top of a column renumbers
 * every card below it (each a row update and a `changes` row). Fractional
 * indexing would touch only the moved card, at the price of key generation,
 * growing keys and periodic rebalancing; worth it once clients send single
 * moves (the spec's Phase 4 ops API), not while every write is a whole board.
 * Eight digits outlast any column a 2 MiB board can hold. */
export function rankAt(index: number): string {
  return String(index).padStart(8, "0");
}

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* JSON with object keys sorted at every depth: equal values give equal
 * strings whatever order jsonb handed the keys back in. Only used to decide
 * whether a row changed. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
}

/* A card's known fields go to typed columns when they have the type the
 * column holds; anything else (an unknown field, or a known one with an odd
 * type that KV would store as is) goes to `extra` under its own name, and
 * `field_order` remembers which keys the card had and in what order. pr/prRev
 * are never taken from a card: `workflow` carries the stored values. Built
 * with fromEntries, never by assignment, so a "__proto__" key stays data. */
export function cardToRow(
  card: Json,
  board_id: BoardId,
  column_id: string,
  rank: string,
  workflow: { pr: string | null; pr_rev: number | null },
): CardRow {
  const row: CardRow = {
    id: String(card.id),
    board_id,
    column_id,
    rank,
    title: "",
    note: "",
    priority: "med",
    created: 0,
    project_id: null,
    field_order: [],
    extra: {},
    ...workflow,
  };
  const extra: [string, unknown][] = [];
  for (const [key, value] of Object.entries(card)) {
    if (key === "pr" || key === "prRev") continue; // server-owned
    row.field_order.push(key);
    if (key === "id") continue;
    if ((key === "title" || key === "note" || key === "priority") && typeof value === "string") {
      row[key] = value;
    } else if (key === "created" && Number.isSafeInteger(value)) {
      row.created = value as number;
    } else if (key === "project" && (value === null || typeof value === "string")) {
      row.project_id = value;
    } else {
      extra.push([key, value]);
    }
  }
  row.extra = Object.fromEntries(extra);
  return row;
}

export function rowToCard(row: CardRow): Card {
  const column = (key: string): unknown => {
    switch (key) {
      case "id":
        return row.id;
      case "title":
      case "note":
      case "priority":
      case "created":
        return row[key];
      case "project":
        return row.project_id;
    }
    return undefined;
  };
  const entries: [string, unknown][] = [];
  for (const key of row.field_order) {
    const value = hasOwn(row.extra, key) ? row.extra[key] : column(key);
    if (value !== undefined) entries.push([key, value]);
  }
  // Last, where preserveWorkflowMetadata left them on a KV card.
  if (row.pr !== null) entries.push(["pr", row.pr]);
  if (row.pr_rev !== null) entries.push(["prRev", row.pr_rev]);
  return Object.fromEntries(entries) as Card;
}

export function itemToRow(item: Json, kind: LifeKind, rank: string): ItemRow {
  return { id: String(item.id), kind, rank, data: item, field_order: Object.keys(item) };
}

export function rowToItem(row: ItemRow): Json {
  return Object.fromEntries(
    row.field_order.filter((key) => hasOwn(row.data, key)).map((key) => [key, row.data[key]]),
  );
}

/* Rows back into the board the KV server would have held. Columns come out
 * in layout order (empty ones included), each sorted by rank; a column a card
 * names but the layout lacks is appended, as KV appended a column a write
 * created. */
export function rowsToBoard({ meta, cards, items }: BoardRows): Board {
  const byRank = (a: { rank: string }, b: { rank: string }) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
  const board: [string, unknown][] = [];
  for (const boardId of BOARD_IDS) {
    const columns = new Map<string, CardRow[]>(meta.layout[boardId].map((id) => [id, []]));
    for (const row of cards) {
      if (row.board_id !== boardId) continue;
      if (!columns.has(row.column_id)) columns.set(row.column_id, []);
      columns.get(row.column_id)!.push(row);
    }
    board.push([
      boardId,
      Object.fromEntries([...columns].map(([id, rows]) => [id, rows.sort(byRank).map(rowToCard)])),
    ]);
  }
  const list = (kind: LifeKind) => items.filter((row) => row.kind === kind).sort(byRank).map(rowToItem);
  board.push(["lifeMeta", Object.fromEntries([
    ["focus", list("focus")],
    ["dates", list("dates")],
    ["notes", meta.notes],
    ["stickies", list("stickies")],
    ...Object.entries(meta.notesExtra),
  ])]);
  return Object.fromEntries([...board, ...Object.entries(meta.extra)]) as Board;
}

/* ---- A PUT body, flattened into what applyBoardPut writes ----
 * Everything that can be decided from the body alone, before the transaction
 * opens: column layout, which occurrence of a duplicated id wins, the
 * lifeMeta coercions. Ranks and pr wait for the rows (an archived id drops
 * out of its column, and pr comes from the stored card). */
type PlannedCard = { card: Json; board_id: BoardId; column_id: string };
type PlannedItem = { item: Json; kind: LifeKind };
type Plan = { meta: BoardMeta; cards: PlannedCard[]; items: PlannedItem[] };

/* Every string made storable: U+0000 and lone surrogates become U+FFFD, in
 * object keys and values at every depth (exception (5) above). Applied to the
 * whole body before planning, so the diff, the size check and the rows all
 * see the board GET will return. Built with fromEntries, never by
 * assignment, so a "__proto__" key stays data. */
export function wellFormed(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed().replaceAll("\u0000", "�");
  if (Array.isArray(value)) return value.map(wellFormed);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [wellFormed(key) as string, wellFormed(v)]),
    );
  }
  return value;
}

export function planBoard(board: Board): Plan {
  const body = wellFormed(board) as Json;
  const layout: Layout = { projects: [], life: [] };
  const cards: PlannedCard[] = [];
  const seenCards = new Set<string>();
  for (const boardId of BOARD_IDS) {
    const columns = body[boardId];
    // main.ts's isBoardShaped has already checked the shape; null/absent is
    // an empty board, as the client's normalize() would read it.
    if (typeof columns !== "object" || columns === null) continue;
    for (const [columnId, list] of Object.entries(columns as Record<string, Json[]>)) {
      layout[boardId].push(columnId);
      for (const card of list) {
        const id = card.id as string;
        if (seenCards.has(id)) continue; // first occurrence wins
        seenCards.add(id);
        cards.push({ card, board_id: boardId, column_id: columnId });
      }
    }
  }
  const lifeMeta = isObject(body.lifeMeta) ? body.lifeMeta : {};
  const items: PlannedItem[] = [];
  const seenItems = new Set<string>();
  for (const kind of LIFE_KINDS) {
    const list = lifeMeta[kind];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item) || typeof item.id !== "string" || seenItems.has(item.id)) continue;
      seenItems.add(item.id);
      items.push({ item, kind });
    }
  }
  const meta: BoardMeta = {
    layout,
    extra: Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== "projects" && key !== "life" && key !== "lifeMeta"),
    ),
    notes: typeof lifeMeta.notes === "string" ? lifeMeta.notes : "",
    notesExtra: Object.fromEntries(Object.entries(lifeMeta).filter(([key]) => !LIFE_META_KEYS.has(key))),
  };
  return { meta, cards, items };
}

// What a `changes` row records for each entity: everything needed to put the
// row back the way it was (or rebuild it), and nothing about its lifecycle.
const cardState = (row: CardRow) => ({
  board_id: row.board_id,
  column_id: row.column_id,
  rank: row.rank,
  title: row.title,
  note: row.note,
  priority: row.priority,
  created: row.created,
  project_id: row.project_id,
  field_order: row.field_order,
  extra: row.extra,
  pr: row.pr,
  pr_rev: row.pr_rev,
});
const itemState = (row: ItemRow) => ({
  kind: row.kind,
  rank: row.rank,
  data: row.data,
  field_order: row.field_order,
});

type Change = {
  seq: number;
  entity: "card" | "life_item" | "life_notes" | "board";
  entity_id: string;
  op: "insert" | "update" | "delete";
  before: unknown;
  after: unknown;
};

// A stored row as applyBoardPut loads it: live, or soft-deleted and named by
// the body.
type StoredCard = CardRow & { deleted: boolean };
type StoredItem = ItemRow & { deleted: boolean };

// Thrown inside the transaction to roll it back when the compare-and-swap on
// board_head finds another writer got there first.
class LostRace extends Error {}

type PgTx = postgres.TransactionSql<{ int8: number }>;

/* How long a server-initiated write waits for the board_head lock before
 * giving up as contention. Whole seconds: a held lock is another write's few
 * round trips, so waiting longer than this means something is stuck. */
const LOCK_TIMEOUT = "5s";

/* Lock-not-available (lock_timeout), serialization failure and deadlock: the
 * write lost to a concurrent one and can simply be retried by the caller. */
const CONTENTION_CODES = new Set(["55P03", "40001", "40P01"]);

function isContention(err: unknown): boolean {
  return CONTENTION_CODES.has((err as { code?: string }).code ?? "");
}

/* The one write path every board write ends in (PUT, POST/PATCH/DELETE
 * tickets): the head's compare-and-swap first, then the caller's row writes,
 * then the `changes` rows and the `revisions` row, all pipelined; the row
 * count of the head update is checked once the batch is back, and a miss
 * rolls the transaction back with LostRace. `writes` are queries the caller
 * built from tx; they run in the order given, after the head update. The
 * timestamp is taken in JS, at millisecond precision, so the `updatedAt`
 * returned is exactly what GET /state and revisions.updated_at hold. Returns
 * the new rev (baseRev + 1). */
async function commitWrite(tx: PgTx, w: {
  baseRev: number;
  now: Date;
  actor: Actor;
  layout: Layout;
  extra: Json;
  changes: Change[];
  writes: PromiseLike<unknown>[];
}): Promise<number> {
  const { baseRev, now, actor, changes } = w;
  const rev = baseRev + 1;
  const headUpdate = tx`
    UPDATE board_head
       SET rev = rev + 1, updated_at = ${now},
           layout = ${JSON.stringify(w.layout)}::text::jsonb,
           extra = ${JSON.stringify(w.extra)}::text::jsonb
     WHERE owner_id = ${OWNER} AND rev = ${baseRev}
    RETURNING rev`;
  const writes: PromiseLike<unknown>[] = [headUpdate, ...w.writes];
  if (changes.length) {
    writes.push(tx`
      INSERT INTO changes (rev, owner_id, seq, entity, entity_id, op, before, after, actor, at)
      SELECT ${rev}, ${OWNER}, r.seq, r.entity, r.entity_id, r.op, r.before, r.after, ${actor}, ${now}
        FROM jsonb_to_recordset(${JSON.stringify(changes)}::text::jsonb) AS r(
               seq int, entity text, entity_id text, op text, before jsonb, after jsonb)`);
  }
  writes.push(tx`
    INSERT INTO revisions (owner_id, rev, updated_at, actor, summary)
    VALUES (${OWNER}, ${rev}, ${now}, ${actor}, ${summarize(changes)})`);
  await Promise.all(writes);
  if ((await headUpdate as unknown[]).length !== 1) throw new LostRace();
  return rev;
}

/* Upsert card rows. A conflict is a soft-deleted row coming back, or a live
 * one being rewritten; pr/pr_rev are never taken from `rows`: a live card keeps
 * its own, a resurrected one comes back without. */
function upsertCards(tx: PgTx, rows: CardRow[]) {
  return tx`
    INSERT INTO cards AS c (id, owner_id, board_id, column_id, rank, title, note, priority,
                            created, project_id, field_order, extra)
    SELECT r.id, ${OWNER}, r.board_id, r.column_id, r.rank, r.title, r.note, r.priority,
           r.created, r.project_id, r.field_order, r.extra
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS r(
             id text, board_id text, column_id text, rank text, title text, note text,
             priority text, created bigint, project_id text, field_order text[], extra jsonb)
    ON CONFLICT (id) DO UPDATE SET
      board_id = EXCLUDED.board_id, column_id = EXCLUDED.column_id, rank = EXCLUDED.rank,
      title = EXCLUDED.title, note = EXCLUDED.note, priority = EXCLUDED.priority,
      created = EXCLUDED.created, project_id = EXCLUDED.project_id,
      field_order = EXCLUDED.field_order, extra = EXCLUDED.extra,
      pr = CASE WHEN c.deleted_at IS NULL THEN c.pr END,
      pr_rev = CASE WHEN c.deleted_at IS NULL THEN c.pr_rev END,
      deleted_at = NULL,
      row_version = c.row_version + 1
    WHERE c.owner_id = EXCLUDED.owner_id`;
}

function softDeleteCards(tx: PgTx, ids: string[], now: Date) {
  return tx`
    UPDATE cards SET deleted_at = ${now}, row_version = row_version + 1
     WHERE owner_id = ${OWNER} AND id = ANY(${ids}::text[]) AND deleted_at IS NULL`;
}

/* ---- Connection ---- */

/* SSL is off for a local database (the tests' PGlite socket has none) and
 * when the URL says sslmode=disable. Otherwise an sslmode in the URL is
 * honoured as given (Neon's strings carry sslmode=require, which is what the
 * storage spike measured), and with none, TLS is required and verified. */
function sslFor(url: URL): postgres.Options<{}>["ssl"] | undefined {
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  const mode = url.searchParams.get("sslmode");
  if (local || mode === "disable") return false;
  return mode ? undefined : "verify-full";
}

/* Strip the password (raw and percent-decoded) and any connection string from
 * a driver error, so a startup failure never prints the secret. */
export function scrubSecret(message: string, url: string): string {
  let out = message.split(url).join("<url>");
  try {
    const pw = new URL(url).password;
    for (const p of new Set([pw, decodeURIComponent(pw)])) if (p) out = out.split(p).join("***");
  } catch { /* unparseable URL: nothing more to strip */ }
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "<url>");
}

// What a server-initiated write loads under the head lock: the live board.
type Locked = {
  head: { rev: number; layout: Layout; extra: Json };
  cards: CardRow[];
  items: ItemRow[];
  notes: { notes: string; extra: Json };
};

/* The rank that puts a card after everything now in a projects column: one
 * past the highest rank there (ranks are the zero-padded positions a PUT
 * wrote, so "one past" is the end), or the first rank of an empty column. */
function endRank(cards: CardRow[], column: string): string {
  let end = -1;
  for (const row of cards) {
    if (row.board_id === "projects" && row.column_id === column) end = Math.max(end, Number(row.rank));
  }
  return rankAt(end + 1);
}

// The layout with `column` added at the end of the projects board if it isn't there.
function withColumn(layout: Layout, column: string): Layout {
  return layout.projects.includes(column) ? layout : { ...layout, projects: [...layout.projects, column] };
}

// Record the board's own change (a new column) when the layout moved.
function layoutChange(
  change: (c: Omit<Change, "seq">) => unknown,
  head: Locked["head"],
  layout: Layout,
) {
  if (layout === head.layout) return;
  change({
    entity: "board",
    entity_id: OWNER,
    op: "update",
    before: { layout: head.layout, extra: head.extra },
    after: { layout, extra: head.extra },
  });
}

/* resolveTicketId over the live projects cards, then the row it named. The
 * 404/409 bodies are the pure function's own. */
function findTicket(cur: Locked, given: string): { prior: CardRow } | Unresolved {
  const board = rowsToBoard({
    meta: { layout: cur.head.layout, extra: {}, notes: "", notesExtra: {} },
    cards: cur.cards,
    items: [],
  });
  const resolved = resolveTicketId(board, given);
  if ("error" in resolved) return { kind: "unresolved", ...resolved };
  const prior = cur.cards.find((row) => row.id === resolved.id && row.board_id === "projects");
  if (!prior) {
    return { kind: "unresolved", status: 404, error: { error: `no ticket with id or ref "${given}"` } };
  }
  return { prior };
}

function notYet(method: string): never {
  throw new Error(`PgStore.${method} is not implemented yet (KODER-EE05 slice 3)`);
}

// int8 (rev, created, pr_rev, counts) arrives as a string by default. Every
// int8 here is far inside 2^53, so read them as numbers, once, here.
const PG_TYPES = {
  int8: {
    to: 20,
    from: [20],
    serialize: (value: number) => String(value),
    parse: (value: string) => Number(value),
  },
};
type PgSql = postgres.Sql<{ int8: number }>;

export class PgStore implements Store {
  readonly limits: StoreLimits = {
    boardBytes: BOARD_MAX,
    requestBytes: BOARD_MAX,
    // Every revision stays reachable (no retention cap), so the 404 for an
    // unknown rev never claims "only the last N are kept".
    keptRevisions: null,
  };

  private readonly sql: PgSql;

  constructor(sql: PgSql) {
    this.sql = sql;
  }

  /* Connect, migrate, and hand back a ready store; throws (with the password
   * scrubbed) if the database can't be reached or migrated, which main.ts
   * turns into a startup failure. */
  static async open(connectionString: string, options: { max: number }): Promise<PgStore> {
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new Error("NEON_DATABASE_URL is not a valid postgres:// URL");
    }
    const ssl = sslFor(url);
    /* Neon's connection strings carry `channel_binding=require`, a libpq
     * client option. postgres.js doesn't know it and would forward it to the
     * server as a startup setting, which Postgres rejects as an unknown
     * parameter; it doesn't do channel binding either, so drop it. */
    let target = connectionString;
    if (url.searchParams.has("channel_binding")) {
      url.searchParams.delete("channel_binding");
      target = url.href;
    }
    let sql: PgSql;
    try {
      sql = postgres(target, {
        max: options.max,
        ...(ssl === undefined ? {} : { ssl }),
        // Neon's pooler (PgBouncer, transaction mode) can't hold named prepared
        // statements across transactions; the spike measured with this setting.
        ...(url.hostname.includes("-pooler") ? { prepare: false } : {}),
        connect_timeout: 15,
        onnotice: () => {},
        types: PG_TYPES,
      }) as unknown as PgSql;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PgStore could not open the database: ${scrubSecret(message, connectionString)}`);
    }
    try {
      await migrate(sql);
    } catch (err) {
      await sql.end({ timeout: 1 }).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PgStore could not open the database: ${scrubSecret(message, connectionString)}`);
    }
    return new PgStore(sql);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async getHead(): Promise<Head> {
    const [head] = await this.sql<{ rev: number; updated_at: Date | null }[]>`
      SELECT rev, updated_at FROM board_head WHERE owner_id = ${OWNER}`;
    return { rev: head.rev, updatedAt: head.updated_at?.toISOString() ?? null };
  }

  /* One statement, so the head and the rows come from one snapshot: a write
   * landing mid-read can never pair one rev with another rev's board (the
   * ETag is the rev). Before the first write this is KV's empty rev-0 doc. */
  async readBoard(): Promise<Doc> {
    const [row] = await this.sql<{
      rev: number;
      updated_at: Date | null;
      layout: Layout;
      extra: Json;
      notes: { notes: string; extra: Json } | null;
      cards: CardRow[];
      items: ItemRow[];
    }[]>`
      SELECT h.rev, h.updated_at, h.layout, h.extra,
        (SELECT row_to_json(n) FROM (
           SELECT notes, extra FROM life_notes WHERE owner_id = h.owner_id) n) AS notes,
        (SELECT coalesce(json_agg(c ORDER BY c.board_id, c.column_id, c.rank), '[]') FROM (
           SELECT id, board_id, column_id, rank, title, note, priority, created, project_id,
                  field_order, extra, pr, pr_rev
             FROM cards
            WHERE owner_id = h.owner_id AND deleted_at IS NULL) c) AS cards,
        (SELECT coalesce(json_agg(i ORDER BY i.kind, i.rank), '[]') FROM (
           SELECT id, kind, rank, data, field_order
             FROM life_items
            WHERE owner_id = h.owner_id AND deleted_at IS NULL) i) AS items
      FROM board_head h WHERE h.owner_id = ${OWNER}`;
    if (row.rev === 0) return emptyDoc();
    const meta: BoardMeta = {
      layout: row.layout,
      extra: row.extra,
      notes: row.notes?.notes ?? "",
      notesExtra: row.notes?.extra ?? {},
    };
    return {
      rev: row.rev,
      updatedAt: row.updated_at?.toISOString() ?? null,
      board: rowsToBoard({ meta, cards: row.cards, items: row.items }),
    };
  }

  boardAt(_rev: number): Promise<Doc | null> {
    notYet("boardAt");
  }

  listRevisions(): Promise<Head[]> {
    notYet("listRevisions");
  }

  /* Oldest append first (the route sorts by archivedAt itself). There are no
   * storage chunks here, so `chunks` is 1 once anything is archived and 0
   * before: the contract only asks for an integer >= 0, and archive() reports
   * the same figure for an all-duplicates batch. */
  async readArchive(): Promise<{ chunks: number; cards: ArchivedCard[] }> {
    const rows = await this.sql<{ card: ArchivedCard }[]>`
      SELECT card FROM archived_cards WHERE owner_id = ${OWNER} ORDER BY seq`;
    return { chunks: rows.length ? 1 : 0, cards: rows.map((row) => row.card) };
  }

  hasDelivery(_deliveryId: string): Promise<boolean> {
    notYet("hasDelivery");
  }

  /* PUT /state as diff-apply (spec section 7.2), in ONE transaction and four
   * round trips: BEGIN; the head lock and the loads, pipelined; the writes,
   * pipelined; COMMIT. A stale baseRev stops after the loads (three).
   *
   * The loads are separate statements on purpose. Under READ COMMITTED each
   * statement takes its own snapshot when it starts; the server runs a
   * pipeline in order, so the card/item loads start only after
   * `SELECT … FOR UPDATE` has the lock, and see every write committed before
   * it. One statement with subqueries would read all of it from a snapshot
   * taken BEFORE the lock wait, and could diff against a board another writer
   * had already replaced.
   *
   * What the body cannot do: write pr/pr_rev (a live card keeps its stored
   * values; a new card, or one resurrected from a soft delete, gets none —
   * the rule preserveWorkflowMetadata applies on KV). A live card missing from
   * the body is soft-deleted; the archive is a separate table the PUT never
   * reads, so an archived id the body re-sends is just a card. Every PUT bumps rev by exactly 1, a no-op included:
   * clients set their sync point from the rev a PUT returns. */
  async applyBoardPut(baseRev: number, board: Board, actor: Actor): Promise<PutResult> {
    const plan = planBoard(board);
    const cardIds = plan.cards.map((c) => c.card.id as string);
    const itemIds = plan.items.map((i) => i.item.id as string);
    const now = new Date();
    try {
      return await this.sql.begin(async (tx) => {
        const [heads, storedCards, storedItems, notesRows] = await Promise.all([
          tx<{ rev: number; layout: Layout; extra: Json }[]>`
            SELECT rev, layout, extra FROM board_head WHERE owner_id = ${OWNER} FOR UPDATE`,
          tx<StoredCard[]>`
            SELECT id, board_id, column_id, rank, title, note, priority, created, project_id,
                   field_order, extra, pr, pr_rev, deleted_at IS NOT NULL AS deleted
              FROM cards
             WHERE owner_id = ${OWNER} AND (deleted_at IS NULL OR id = ANY(${cardIds}::text[]))`,
          tx<StoredItem[]>`
            SELECT id, kind, rank, data, field_order, deleted_at IS NOT NULL AS deleted
              FROM life_items
             WHERE owner_id = ${OWNER} AND (deleted_at IS NULL OR id = ANY(${itemIds}::text[]))`,
          tx<{ notes: string; extra: Json }[]>`
            SELECT notes, extra FROM life_notes WHERE owner_id = ${OWNER}`,
        ]);
        const head = heads[0];
        if (head.rev !== baseRev) return { kind: "stale", rev: head.rev } as PutResult;

        const changes: Change[] = [];
        const change = (c: Omit<Change, "seq">) => changes.push({ seq: changes.length + 1, ...c });

        /* ---- Cards ---- */
        const stored = new Map(storedCards.map((row) => [row.id, row]));
        const nextRank = new Map<string, number>();
        const nextCards: CardRow[] = [];
        const upserts: CardRow[] = [];
        for (const { card, board_id, column_id } of plan.cards) {
          const id = card.id as string;
          const prior = stored.get(id);
          const slot = `${board_id}\u0000${column_id}`;
          const index = nextRank.get(slot) ?? 0;
          nextRank.set(slot, index + 1);
          const live = prior && !prior.deleted;
          const row = cardToRow(card, board_id, column_id, rankAt(index), {
            pr: live ? prior.pr : null,
            pr_rev: live ? prior.pr_rev : null,
          });
          nextCards.push(row);
          if (!prior) {
            upserts.push(row);
            change({ entity: "card", entity_id: id, op: "insert", before: null, after: cardState(row) });
          } else if (prior.deleted) {
            // Resurrected: back on the board as a fresh card.
            upserts.push(row);
            change({ entity: "card", entity_id: id, op: "insert", before: null, after: cardState(row) });
          } else if (canonical(cardState(prior)) !== canonical(cardState(row))) {
            upserts.push(row);
            change({ entity: "card", entity_id: id, op: "update", before: cardState(prior), after: cardState(row) });
          }
        }
        const kept = new Set(nextCards.map((row) => row.id));
        const removedCards: string[] = [];
        for (const row of storedCards) {
          if (row.deleted || kept.has(row.id)) continue;
          removedCards.push(row.id);
          change({ entity: "card", entity_id: row.id, op: "delete", before: cardState(row), after: null });
        }

        /* ---- lifeMeta items ---- */
        const storedItemMap = new Map(storedItems.map((row) => [row.id, row]));
        const itemRank = new Map<LifeKind, number>();
        const nextItems: ItemRow[] = [];
        const itemUpserts: ItemRow[] = [];
        for (const { item, kind } of plan.items) {
          const index = itemRank.get(kind) ?? 0;
          itemRank.set(kind, index + 1);
          const row = itemToRow(item, kind, rankAt(index));
          nextItems.push(row);
          const prior = storedItemMap.get(row.id);
          if (!prior || prior.deleted) {
            itemUpserts.push(row);
            change({ entity: "life_item", entity_id: row.id, op: "insert", before: null, after: itemState(row) });
          } else if (canonical(itemState(prior)) !== canonical(itemState(row))) {
            itemUpserts.push(row);
            change({ entity: "life_item", entity_id: row.id, op: "update", before: itemState(prior), after: itemState(row) });
          }
        }
        const keptItems = new Set(nextItems.map((row) => row.id));
        const removedItems: string[] = [];
        for (const row of storedItems) {
          if (row.deleted || keptItems.has(row.id)) continue;
          removedItems.push(row.id);
          change({ entity: "life_item", entity_id: row.id, op: "delete", before: itemState(row), after: null });
        }

        /* ---- life notes, and the board's own shape ---- */
        const priorNotes = notesRows[0] ?? { notes: "", extra: {} };
        const notesAfter = { notes: plan.meta.notes, extra: plan.meta.notesExtra };
        const notesChanged = canonical(priorNotes) !== canonical(notesAfter);
        if (notesChanged) {
          change({ entity: "life_notes", entity_id: OWNER, op: "update", before: priorNotes, after: notesAfter });
        }
        const boardBefore = { layout: head.layout, extra: head.extra };
        const boardAfter = { layout: plan.meta.layout, extra: plan.meta.extra };
        if (canonical(boardBefore) !== canonical(boardAfter) ||
          // canonical() sorts keys, but column ORDER lives in the arrays and
          // board.extra's key order is part of what GET returns.
          JSON.stringify(Object.keys(boardBefore.extra)) !== JSON.stringify(Object.keys(boardAfter.extra))) {
          change({ entity: "board", entity_id: OWNER, op: "update", before: boardBefore, after: boardAfter });
        }

        /* The size check, on the board exactly as GET /state will return it,
         * before anything is written. */
        const size = Buffer.byteLength(
          JSON.stringify(rowsToBoard({ meta: plan.meta, cards: nextCards, items: nextItems })),
        );
        if (size > BOARD_MAX) throw new StoreFullError(size, BOARD_MAX);

        /* ---- Writes: one pipelined batch through commitWrite, which puts the
         * head's compare-and-swap first. Statements with nothing to do aren't
         * sent. Set-based throughout: each statement takes its rows as one
         * jsonb array, so a PUT costs the same round trips whether it touches
         * one card or five hundred. JSON goes in as `${…}::text::jsonb`: as a
         * text parameter postgres.js sends the string as is, prepared or not
         * (Neon's pooler runs unprepared); a bare `::jsonb` makes a prepared
         * statement's jsonb serializer JSON-encode the string again, storing a
         * jsonb string instead of the object. ---- */
        const writes: PromiseLike<unknown>[] = [];
        if (upserts.length) writes.push(upsertCards(tx, upserts));
        if (removedCards.length) writes.push(softDeleteCards(tx, removedCards, now));
        if (itemUpserts.length) {
          writes.push(tx`
            INSERT INTO life_items AS l (id, owner_id, kind, rank, data, field_order)
            SELECT r.id, ${OWNER}, r.kind, r.rank, r.data, r.field_order
              FROM jsonb_to_recordset(${JSON.stringify(itemUpserts)}::text::jsonb) AS r(
                     id text, kind text, rank text, data jsonb, field_order text[])
            ON CONFLICT (id) DO UPDATE SET
              kind = EXCLUDED.kind, rank = EXCLUDED.rank, data = EXCLUDED.data,
              field_order = EXCLUDED.field_order, deleted_at = NULL
            WHERE l.owner_id = EXCLUDED.owner_id`);
        }
        if (removedItems.length) {
          writes.push(tx`
            UPDATE life_items SET deleted_at = ${now}
             WHERE owner_id = ${OWNER} AND id = ANY(${removedItems}::text[]) AND deleted_at IS NULL`);
        }
        if (notesChanged) {
          writes.push(tx`
            UPDATE life_notes
               SET notes = ${plan.meta.notes}, extra = ${JSON.stringify(plan.meta.notesExtra)}::text::jsonb
             WHERE owner_id = ${OWNER}`);
        }
        const rev = await commitWrite(tx, {
          baseRev,
          now,
          actor,
          layout: plan.meta.layout,
          extra: plan.meta.extra,
          changes,
          writes,
        });
        return { kind: "ok", rev, updatedAt: now.toISOString() } as PutResult;
      });
    } catch (err) {
      if (err instanceof LostRace) return { kind: "conflict" };
      throw err;
    }
  }

  /* ---- Server-initiated writes: POST/PATCH/DELETE tickets ----
   * Read-modify-write under the head lock, in ONE transaction: BEGIN; the lock
   * and the loads, pipelined (as in applyBoardPut); the writes, pipelined;
   * COMMIT. Four round trips, whatever the ticket. They need no baseRev: the
   * lock is taken first, so the board they change is the current one, and the
   * second of two racing writers simply sees the first's result. The loads are
   * the whole live board (it is capped at 2 MiB), because resolving a ref and
   * the size check both need all of it.
   *
   * Waiting for the lock is bounded by LOCK_TIMEOUT; a timeout, a deadlock or
   * a serialization failure is StoreContentionError (a 503 the caller retries).
   *
   * Like KV's, every successful call bumps rev by exactly 1, a PATCH that
   * changes nothing included. */
  private async locked<T>(fn: (tx: PgTx, cur: Locked) => Promise<T>): Promise<T> {
    try {
      return await this.sql.begin(async (tx): Promise<T> => {
        const [, heads, cards, items, notes] = await Promise.all([
          tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`),
          tx<{ rev: number; layout: Layout; extra: Json }[]>`
            SELECT rev, layout, extra FROM board_head WHERE owner_id = ${OWNER} FOR UPDATE`,
          tx<CardRow[]>`
            SELECT id, board_id, column_id, rank, title, note, priority, created, project_id,
                   field_order, extra, pr, pr_rev
              FROM cards WHERE owner_id = ${OWNER} AND deleted_at IS NULL`,
          tx<ItemRow[]>`
            SELECT id, kind, rank, data, field_order
              FROM life_items WHERE owner_id = ${OWNER} AND deleted_at IS NULL`,
          tx<{ notes: string; extra: Json }[]>`
            SELECT notes, extra FROM life_notes WHERE owner_id = ${OWNER}`,
        ]);
        return await fn(tx, { head: heads[0], cards, items, notes: notes[0] ?? { notes: "", extra: {} } });
      }) as T;
    } catch (err) {
      if (err instanceof LostRace || isContention(err)) {
        throw new StoreContentionError();
      }
      throw err;
    }
  }

  /* The size check, then the shared write path. `cards` is the live card set
   * AFTER the change; the board built from it is what GET /state will return,
   * so it is what is measured against the budget, before anything is written. */
  private async commitTicketWrite(tx: PgTx, cur: Locked, w: {
    now: Date;
    actor: Actor;
    layout: Layout;
    cards: CardRow[];
    changes: Change[];
    writes: PromiseLike<unknown>[];
  }): Promise<{ rev: number; board: Board }> {
    const board = rowsToBoard({
      meta: { layout: w.layout, extra: cur.head.extra, notes: cur.notes.notes, notesExtra: cur.notes.extra },
      cards: w.cards,
      items: cur.items,
    });
    const size = Buffer.byteLength(JSON.stringify(board));
    if (size > BOARD_MAX) throw new StoreFullError(size, BOARD_MAX);
    const rev = await commitWrite(tx, {
      baseRev: cur.head.rev,
      now: w.now,
      actor: w.actor,
      layout: w.layout,
      extra: cur.head.extra,
      changes: w.changes,
      writes: w.writes,
    });
    return { rev, board };
  }

  /* Append to the END of a projects column, creating the column (at the end of
   * the layout) when it doesn't exist yet. The card is stored as given, minus
   * pr/prRev, which only the webhook writes. */
  createTicket(card: Card, column: string, actor: Actor): Promise<{ rev: number }> {
    const now = new Date();
    return this.locked(async (tx, cur) => {
      const clean = wellFormed(card) as Card;
      const col = wellFormed(column) as string;
      if (cur.cards.some((row) => row.id === clean.id)) {
        throw new Error(`ticket id ${clean.id} is already on the board`);
      }
      const row = cardToRow(clean, "projects", col, endRank(cur.cards, col), { pr: null, pr_rev: null });
      const layout = withColumn(cur.head.layout, col);
      const changes: Change[] = [];
      const change = (c: Omit<Change, "seq">) => changes.push({ seq: changes.length + 1, ...c });
      change({ entity: "card", entity_id: row.id, op: "insert", after: cardState(row), before: null });
      layoutChange(change, cur.head, layout);
      const { rev } = await this.commitTicketWrite(tx, cur, {
        now,
        actor,
        layout,
        cards: [...cur.cards, row],
        changes,
        // The id can only collide with a soft-deleted row (checked above for
        // live ones), which this brings back as a new card.
        writes: [upsertCards(tx, [row])],
      });
      return { rev };
    });
  }

  /* Resolve over the live projects cards exactly as KV does (id first, then
   * ref), edit in place, and with `column` move the card to the END of that
   * column, even when it is already there. An edit-only patch keeps its
   * position. Returns the card as GET /state will show it. */
  patchTicket(
    given: string,
    change: { column?: string; edits: TicketEdits },
    actor: Actor,
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number } | Unresolved> {
    const now = new Date();
    return this.locked(async (tx, cur) => {
      const found = findTicket(cur, given);
      if ("kind" in found) return found;
      const { prior } = found;
      const column = change.column === undefined ? undefined : wellFormed(change.column) as string;
      const card = Object.assign(rowToCard(prior), wellFormed(change.edits)) as Card;
      const target = column ?? prior.column_id;
      const row = cardToRow(
        card,
        "projects",
        target,
        column === undefined ? prior.rank : endRank(cur.cards.filter((r) => r.id !== prior.id), target),
        { pr: prior.pr, pr_rev: prior.pr_rev },
      );
      const layout = column === undefined ? cur.head.layout : withColumn(cur.head.layout, column);
      const changes: Change[] = [];
      const changeRow = (c: Omit<Change, "seq">) => changes.push({ seq: changes.length + 1, ...c });
      const writes: PromiseLike<unknown>[] = [];
      if (canonical(cardState(prior)) !== canonical(cardState(row))) {
        changeRow({ entity: "card", entity_id: row.id, op: "update", before: cardState(prior), after: cardState(row) });
        writes.push(upsertCards(tx, [row]));
      }
      layoutChange(changeRow, cur.head, layout);
      const { rev } = await this.commitTicketWrite(tx, cur, {
        now,
        actor,
        layout,
        cards: cur.cards.map((r) => (r.id === prior.id ? row : r)),
        changes,
        writes,
      });
      return { kind: "ok", card: rowToCard(row), column: target, rev } as const;
    });
  }

  /* KV removed the card from the doc; here the row is soft-deleted (a later
   * PUT that re-sends the id brings it back as a new card). The column stays
   * in the layout when it empties. */
  deleteTicket(
    given: string,
    actor: Actor,
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number; board: Board } | Unresolved> {
    const now = new Date();
    return this.locked(async (tx, cur) => {
      const found = findTicket(cur, given);
      if ("kind" in found) return found;
      const { prior } = found;
      const { rev, board } = await this.commitTicketWrite(tx, cur, {
        now,
        actor,
        layout: cur.head.layout,
        cards: cur.cards.filter((r) => r.id !== prior.id),
        changes: [{ seq: 1, entity: "card", entity_id: prior.id, op: "delete", before: cardState(prior), after: null }],
        writes: [softDeleteCards(tx, [prior.id], now)],
      });
      return { kind: "ok", card: rowToCard(prior), column: prior.column_id, rev, board } as const;
    });
  }

  restore(_rev: number): Promise<{ rev: number; updatedAt: string } | null> {
    notYet("restore");
  }

  /* Append-only and idempotent by card id, in ONE autocommit statement: no
   * lock on board_head, no rev, no `cards` or `changes` rows (the archive is
   * not part of the board). ON CONFLICT DO NOTHING makes a retry, a mixed
   * batch and two identical requests racing all come out right: the id is the
   * primary key, so exactly one insert of it lands, and the loser's RETURNING
   * omits it. Within one batch the first of two equal ids wins (KV kept both).
   * Cards are stored as plain `json` (text as sent, so key order survives; jsonb
   * would reorder), client fields included. Two concurrent batches holding the
   * same new ids in opposite orders can deadlock; that is StoreContentionError,
   * like the ticket writes. The batch is capped at the board budget; there are no chunks, so `chunk` is always 0
   * and `chunks` 1 (see readArchive). */
  async archive(cards: ArchivedCard[]): Promise<ArchiveResult> {
    const body = JSON.stringify(wellFormed(cards));
    const size = Buffer.byteLength(body);
    if (size > BOARD_MAX) return { kind: "tooLarge", size, limit: BOARD_MAX };
    let landed: { id: string }[];
    try {
      landed = await this.sql<{ id: string }[]>`
        INSERT INTO archived_cards (id, owner_id, card)
        SELECT e.card->>'id', ${OWNER}, e.card
          FROM json_array_elements(${body}::text::json) WITH ORDINALITY AS e(card, n)
         ORDER BY e.n
        ON CONFLICT (id) DO NOTHING
        RETURNING id`;
    } catch (err) {
      if (isContention(err)) throw new StoreContentionError();
      throw err;
    }
    if (!landed.length) return { kind: "duplicates", duplicates: cards.length, chunks: 1 };
    return { kind: "archived", archived: landed.length, duplicates: cards.length - landed.length, chunk: 0 };
  }

  recordDelivery(_deliveryId: string): Promise<{ kind: "recorded" } | { kind: "redelivered"; rev: number }> {
    notYet("recordDelivery");
  }

  commitWebhookMove(_event: WebhookEvent): Promise<WebhookResult> {
    notYet("commitWebhookMove");
  }
}

/* revisions.summary: a short human line for a future history view, e.g.
 * "2× card insert, 1× card update". Null for a no-op PUT. */
function summarize(changes: Change[]): string | null {
  const counts = new Map<string, number>();
  for (const c of changes) {
    const key = `${c.entity} ${c.op}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts].map(([key, n]) => `${n}× ${key}`).join(", ");
}
