/* The Postgres schema for PgStore (pg-store.ts), as plain-SQL migrations.
 *
 * Board-only: the tables section 5 of docs/specs/storage-expansion.md sketches
 * for the board, history and webhook idempotency. The finance, auth and agent
 * tables in that sketch belong to later work and are deliberately absent.
 *
 * Migrations are an ordered list, applied by migrate() when a PgStore opens.
 * Each one runs at most once, recorded in schema_migrations, and the whole run
 * sits in ONE transaction behind a transaction-scoped advisory lock, so two
 * processes starting together serialise on the lock: the second sees the
 * first one's rows and applies nothing. A failed migration rolls back whole.
 * Never edit a migration that has shipped; append a new one.
 *
 * Deviations from the spec's sketch, all in service of one rule — the schema
 * must accept every board the Deno KV server accepted (it took any
 * board-shaped PUT; the title/note/priority caps live only in the ticket
 * routes) and give it back the way that server did:
 *  - No CHECKs on title length, note length or priority values. NOT NULL and
 *    the enums the server itself controls (board_id, kind, entity, op) stay.
 *  - cards.field_order / life_items.field_order: the item's keys in the order
 *    the client wrote them, so a read rebuilds the same object (jsonb keeps no
 *    key order) and an absent field stays absent rather than coming back as a
 *    column default (a life card has no `project`, and must not grow one).
 *  - board_head.layout: each board's column ids in order, including empty
 *    columns, which have no card rows to carry them (the webhook tests read
 *    `projects.doing.length === 0` after a move, so an emptied column must
 *    survive).
 *  - board_head.extra / life_notes.extra: unknown top-level board keys and
 *    unknown lifeMeta keys, so they round-trip like unknown card fields do.
 *  - changes.entity also allows 'board' (a layout or board.extra change), so
 *    a reconstruction from the log can rebuild empty columns too. */

import type postgres from "postgres";

// The single owner until accounts exist. Seeded by migration 1.
export const OWNER = "koda";

// Arbitrary but fixed: the key every process takes before migrating.
const MIGRATION_LOCK = 7_265_746_101;

export type Migration = { id: number; name: string; statements: string[] };

/* One statement per string: postgres.js sends each as a single extended-
 * protocol query, which can't carry several statements at once. */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "board",
    statements: [
      `CREATE TABLE owners (
         id         text PRIMARY KEY,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
      // rev is the HEAD revision: +1 on every successful write, never rewinds.
      `CREATE TABLE board_head (
         owner_id   text PRIMARY KEY REFERENCES owners(id),
         rev        bigint NOT NULL DEFAULT 0,
         updated_at timestamptz,
         layout     jsonb NOT NULL DEFAULT '{"projects": [], "life": []}',
         extra      jsonb NOT NULL DEFAULT '{}'
       )`,
      `CREATE TABLE cards (
         id            text PRIMARY KEY,
         owner_id      text   NOT NULL REFERENCES owners(id),
         board_id      text   NOT NULL CHECK (board_id IN ('projects', 'life')),
         column_id     text   NOT NULL,
         rank          text   NOT NULL COLLATE "C",
         title         text   NOT NULL,
         note          text   NOT NULL DEFAULT '',
         priority      text   NOT NULL DEFAULT 'med',
         created       bigint NOT NULL,
         project_id    text,
         pr            text,
         pr_rev        bigint,
         archived_at   timestamptz,
         archived_from text,
         deleted_at    timestamptz,
         row_version   bigint NOT NULL DEFAULT 1,
         field_order   text[] NOT NULL DEFAULT '{}',
         extra         jsonb  NOT NULL DEFAULT '{}'
       )`,
      `CREATE INDEX cards_board_col ON cards (owner_id, board_id, column_id, rank)
         WHERE archived_at IS NULL AND deleted_at IS NULL`,
      `CREATE INDEX cards_project ON cards (owner_id, project_id) WHERE deleted_at IS NULL`,
      `CREATE INDEX cards_pr ON cards (pr) WHERE pr IS NOT NULL`,
      `CREATE TABLE life_items (
         id          text PRIMARY KEY,
         owner_id    text  NOT NULL REFERENCES owners(id),
         kind        text  NOT NULL CHECK (kind IN ('focus', 'dates', 'stickies')),
         rank        text  NOT NULL COLLATE "C",
         data        jsonb NOT NULL,
         field_order text[] NOT NULL DEFAULT '{}',
         deleted_at  timestamptz
       )`,
      `CREATE TABLE life_notes (
         owner_id text PRIMARY KEY REFERENCES owners(id),
         notes    text  NOT NULL DEFAULT '',
         extra    jsonb NOT NULL DEFAULT '{}'
       )`,
      // One row per changed entity per rev, kept forever (no retention cap).
      `CREATE TABLE changes (
         rev       bigint NOT NULL,
         owner_id  text   NOT NULL,
         seq       int    NOT NULL,
         entity    text   NOT NULL CHECK (entity IN ('card', 'life_item', 'life_notes', 'board')),
         entity_id text   NOT NULL,
         op        text   NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
         before    jsonb,
         after     jsonb,
         actor     text   NOT NULL,
         at        timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (owner_id, rev, seq)
       )`,
      `CREATE TABLE revisions (
         owner_id   text   NOT NULL,
         rev        bigint NOT NULL,
         updated_at timestamptz NOT NULL,
         actor      text   NOT NULL,
         summary    text,
         PRIMARY KEY (owner_id, rev)
       )`,
      `CREATE TABLE webhook_deliveries (
         delivery_id text PRIMARY KEY,
         source      text NOT NULL DEFAULT 'github',
         outcome     text NOT NULL,
         rev         bigint,
         received_at timestamptz NOT NULL DEFAULT now()
       )`,
      `INSERT INTO owners (id) VALUES ('${OWNER}') ON CONFLICT DO NOTHING`,
      `INSERT INTO board_head (owner_id) VALUES ('${OWNER}') ON CONFLICT DO NOTHING`,
      `INSERT INTO life_notes (owner_id) VALUES ('${OWNER}') ON CONFLICT DO NOTHING`,
    ],
  },
];

/* Bring the database up to the newest migration. Returns how many were
 * applied (0 on every open after the first). */
export async function migrate(sql: postgres.Sql<any>): Promise<number> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id         int PRIMARY KEY,
         name       text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await tx.unsafe<{ id: number }[]>(`SELECT id FROM schema_migrations`)).map((row) => row.id),
    );
    let applied = 0;
    for (const migration of MIGRATIONS) {
      if (done.has(migration.id)) continue;
      for (const statement of migration.statements) await tx.unsafe(statement);
      await tx.unsafe(
        `INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`,
        [migration.id, migration.name],
      );
      applied++;
    }
    return applied;
  });
}
