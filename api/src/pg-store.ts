/* PgStore — the Store (store.ts) backed by Postgres (Neon in production,
 * reached through NEON_DATABASE_URL; PGlite in the tests). INCOMPLETE until
 * KODER-EE05 slice 3: reads work; PUT /state, history, the archive, the
 * ticket routes and the webhook throw until slices 2 and 3 land them.
 *
 * Layout (pg-schema.ts): the board is rows, not one document. A card is a row
 * in `cards` keyed by its client id, placed by (board_id, column_id, rank);
 * lifeMeta's three lists are rows in `life_items`, its legacy `notes` string a
 * row in `life_notes`; `board_head` holds the rev, updatedAt and each board's
 * column order. readBoard() assembles the same {rev, updatedAt, board} doc
 * the Deno KV server returned, and a PUT /state is diffed against the rows
 * (section 7.2 of docs/specs/storage-expansion.md) rather than replacing a
 * blob.
 *
 * Round-tripping a board: whatever a client PUTs comes back from GET /state
 * as it was sent, as KV did, with these exceptions, each forced by keying
 * rows on ids:
 *  (1) a card id that appears twice in one body (in two columns, or on both
 *      boards) keeps only its FIRST occurrence, in board order projects then
 *      life, columns and cards in body order; the same for lifeMeta item ids
 *      across focus, dates and stickies;
 *  (2) a lifeMeta item that isn't an object with a string id is dropped;
 *  (3) a card whose id is archived stays archived and off the board: a PUT
 *      never touches an archived row (whether a re-sent archived id should
 *      come back is the archive slice's decision, not this one's);
 *  (4) lifeMeta always comes back with all four keys (focus, dates, notes,
 *      stickies), a non-list or non-string coerced to empty the way the
 *      client's normalize() would;
 *  (5) jsonb keeps no key order inside nested values of unknown fields
 *      (top-level key order is kept, see field_order);
 *  (6) Postgres text can't hold U+0000, and a lone UTF-16 surrogate can't be
 *      encoded as UTF-8, so a board carrying either fails the write (500)
 *      where KV stored it.
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

function notYet(method: string): never {
  throw new Error(`PgStore.${method} is not implemented yet (KODER-EE05 slice 2/3)`);
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
            WHERE owner_id = h.owner_id AND archived_at IS NULL AND deleted_at IS NULL) c) AS cards,
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

  readArchive(): Promise<{ chunks: number; cards: ArchivedCard[] }> {
    notYet("readArchive");
  }

  hasDelivery(_deliveryId: string): Promise<boolean> {
    notYet("hasDelivery");
  }

  applyBoardPut(_baseRev: number, _board: Board, _actor: Actor): Promise<PutResult> {
    notYet("applyBoardPut");
  }

  createTicket(_card: Card, _column: string): Promise<{ rev: number }> {
    notYet("createTicket");
  }

  patchTicket(
    _given: string,
    _change: { column?: string; edits: TicketEdits },
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number } | Unresolved> {
    notYet("patchTicket");
  }

  deleteTicket(
    _given: string,
  ): Promise<{ kind: "ok"; card: Card; column: string; rev: number; board: Board } | Unresolved> {
    notYet("deleteTicket");
  }

  restore(_rev: number): Promise<{ rev: number; updatedAt: string } | null> {
    notYet("restore");
  }

  archive(_cards: ArchivedCard[]): Promise<ArchiveResult> {
    notYet("archive");
  }

  recordDelivery(_deliveryId: string): Promise<{ kind: "recorded" } | { kind: "redelivered"; rev: number }> {
    notYet("recordDelivery");
  }

  commitWebhookMove(_event: WebhookEvent): Promise<WebhookResult> {
    notYet("commitWebhookMove");
  }
}
