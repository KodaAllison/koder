/* The one-shot KV -> Postgres import and its verifier (KODER-E214): the
 * validator in kv-dump.ts, importDump / verifyImport in kv-import.ts, and the
 * CLI scripts/import-kv.ts. Runs against PGlite behind pglite-socket, the same
 * way contract.test.ts does, so the import uses the real postgres.js driver
 * and the real migrations. Every test gets a FRESH empty database. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { DUMP_FORMAT, DUMP_VERSION, DumpError, type KvDump, validateDump } from "../src/kv-dump.ts";
import { importDump, MIGRATION_ACTOR, NotEmptyError, verifyImport } from "../src/kv-import.ts";
import { openSql, PgStore, type PgSql } from "../src/pg-store.ts";

const CLI = fileURLToPath(new URL("../scripts/import-kv.ts", import.meta.url));

type Database = { db: PGlite; url: string; close(): Promise<void> };

async function freshDatabase(): Promise<Database> {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 1 });
  await socket.start();
  return {
    db,
    url: `postgres://postgres:postgres@${socket.getServerConn()}/postgres`,
    async close() {
      await socket.stop();
      await db.close();
    },
  };
}

/* A migrated empty database and its client, torn down afterwards. */
async function withDatabase(fn: (ctx: { database: Database; sql: PgSql }) => Promise<void>) {
  const database = await freshDatabase();
  const sql = await openSql(database.url, { max: 1 });
  try {
    await fn({ database, sql });
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
    await database.close();
  }
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Card ${id}`,
  note: "",
  priority: "med",
  created: 1_760_000_000_000,
  project: null,
  ...extra,
});

function makeDump(overrides: Partial<KvDump> = {}): KvDump {
  return {
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    exportedAt: "2026-10-11T12:00:00.000Z",
    doc: {
      rev: 41,
      updatedAt: "2026-10-10T09:30:00.000Z",
      board: {
        projects: {
          backlog: [card("t_a1"), card("t_a2", { pr: "owner/repo#7", prRev: 12, extraField: { nested: [1, 2] } })],
          doing: [card("t_b1")],
          review: [],
          done: [card("t_c1")],
        },
        life: { today: [card("t_l1")], later: [] },
        lifeMeta: {
          focus: [{ id: "f1", text: "Ship it" }, { id: "f2", text: "Sleep" }],
          dates: [{ id: "d1", label: "Launch", date: "2026-11-01" }],
          notes: "remember the milk",
          stickies: [{ id: "s1", text: "hi" }],
        },
        unknownTopLevel: { keep: "me" },
      },
    },
    archive: [
      { n: 0, cards: [card("t_old1", { archivedAt: 1_750_000_000_000, board: "projects" })] },
      { n: 1, cards: [card("t_old2", { archivedAt: 1_751_000_000_000, board: "projects" })] },
    ],
    deliveries: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
    ...overrides,
  };
}

/* ---- kv-dump.ts ---- */

test("validateDump accepts a well-formed dump and hands it back", () => {
  const dump = makeDump();
  assert.equal(validateDump(dump), dump);
});

test("validateDump lists every problem, not just the first", () => {
  const bad = {
    format: "something-else",
    version: 99,
    exportedAt: 5,
    doc: { rev: 0, updatedAt: "not a date", board: { projects: { backlog: "nope" } } },
    archive: [{ n: 1, cards: [{ id: "" }] }, { n: 1, cards: [] }],
    deliveries: ["ok", ""],
  };
  assert.throws(
    () => validateDump(bad),
    (err: unknown) => {
      assert.ok(err instanceof DumpError);
      const text = err.problems.join("\n");
      for (const expected of ["format is", "version is", "exportedAt", "doc.rev", "doc.updatedAt", "backlog is not an array", "archive[0].cards[0]", "archive[1].n", "deliveries[1]"]) {
        assert.ok(text.includes(expected), `expected a problem mentioning ${expected}:\n${text}`);
      }
      return true;
    },
  );
  assert.throws(() => validateDump([]), DumpError);
  assert.throws(() => validateDump(null), DumpError);
});

test("validateDump refuses an empty KV (rev 0): there is nothing to import", () => {
  const dump = makeDump();
  dump.doc.rev = 0;
  assert.throws(() => validateDump(dump), /doc\.rev must be an integer >= 1/);
});

test("validateDump allows a null projects/life and a null lifeMeta, as KV could hold", () => {
  const dump = makeDump();
  dump.doc.board = { projects: null, life: null, lifeMeta: null };
  assert.doesNotThrow(() => validateDump(dump));
});

/* ---- importDump + verifyImport ---- */

test("imports into an empty database and the verifier finds it identical", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    const summary = await importDump(sql, validateDump(dump));
    assert.deepEqual(summary, {
      rev: 41,
      updatedAt: "2026-10-10T09:30:00.000Z",
      cards: 5,
      lifeItems: 4,
      archived: 2,
      deliveries: 2,
    });

    const result = await verifyImport(sql, dump);
    assert.deepEqual(result.differences, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.notes, []);
  });
});

test("the head rev is the KV doc's exact rev, with a migration revisions row and no changes", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);

    const store = new PgStore(sql);
    const head = await store.getHead();
    assert.equal(head.rev, 41);
    assert.equal(head.updatedAt, "2026-10-10T09:30:00.000Z");

    const [row] = await sql<{ actor: string; changes: number }[]>`
      SELECT actor, (SELECT count(*) FROM changes)::bigint AS changes FROM revisions WHERE rev = 41`;
    assert.equal(row.actor, MIGRATION_ACTOR);
    assert.equal(Number(row.changes), 0);

    // GET /state?rev=<head> has a row to find and serves the live board.
    const served = await store.boardAt(41);
    assert.ok(served);
    assert.deepEqual(served.board, (await store.readBoard()).board);
    assert.deepEqual((await store.listRevisions()).map((r) => r.rev), [41]);
  });
});

test("cards keep their order, their pr/prRev and their unknown fields", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);
    const { board } = await new PgStore(sql).readBoard();
    const projects = board.projects as unknown as Record<string, { id: string; pr?: string; prRev?: number; extraField?: unknown }[]>;
    assert.deepEqual(projects.backlog.map((c) => c.id), ["t_a1", "t_a2"]);
    assert.equal(projects.backlog[1].pr, "owner/repo#7");
    assert.equal(projects.backlog[1].prRev, 12);
    assert.deepEqual(projects.backlog[1].extraField, { nested: [1, 2] });
    assert.deepEqual(Object.keys(projects), ["backlog", "doing", "review", "done"]);
  });
});

test("the archive and every webhook delivery id come across", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);
    const store = new PgStore(sql);

    const archive = await store.readArchive();
    assert.deepEqual(archive.cards.map((c) => c.id), ["t_old1", "t_old2"]);
    for (const id of dump.deliveries) assert.equal(await store.hasDelivery(id), true);
    assert.equal(await store.hasDelivery("00000000-0000-4000-8000-0000000000ff"), false);
  });
});

test("the first write after the import is head + 1, and a stale base rev conflicts", async () => {
  await withDatabase(async ({ sql }) => {
    await importDump(sql, makeDump());
    const store = new PgStore(sql);
    const { board } = await store.readBoard();

    const stale = await store.applyBoardPut(40, board, "browser");
    assert.notEqual(stale.kind, "ok", "a PWA still on a pre-import rev must conflict, not overwrite");

    const written = await store.applyBoardPut(41, board, "browser");
    assert.equal(written.kind, "ok");
    assert.equal((await store.getHead()).rev, 42);
  });
});

test("refuses a database that already holds data and leaves it untouched", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);

    await assert.rejects(
      () => importDump(sql, dump),
      (err: unknown) => {
        assert.ok(err instanceof NotEmptyError);
        assert.ok(err.found.cards > 0);
        assert.match(err.message, /not empty/);
        return true;
      },
    );
    assert.deepEqual((await verifyImport(sql, dump)).differences, []);
  });
});

test("a database with only a past write (no cards) still counts as not empty", async () => {
  await withDatabase(async ({ sql }) => {
    const store = new PgStore(sql);
    await store.applyBoardPut(0, { projects: {}, life: {}, lifeMeta: { focus: [], dates: [], notes: "", stickies: [] } } as never, "browser");
    await assert.rejects(() => importDump(sql, makeDump()), NotEmptyError);
  });
});

test("a failure part way through rolls the whole import back", async () => {
  await withDatabase(async ({ sql }) => {
    // A duplicate-safe import can't fail on content, so break it at the database:
    // a webhook_deliveries insert that violates a constraint on the last statement.
    await sql`ALTER TABLE webhook_deliveries ADD CONSTRAINT never CHECK (outcome <> 'migrated')`;
    await assert.rejects(() => importDump(sql, makeDump()));
    await sql`ALTER TABLE webhook_deliveries DROP CONSTRAINT never`;

    const [counts] = await sql<{ cards: number; revisions: number; rev: number }[]>`
      SELECT (SELECT count(*) FROM cards)::bigint AS cards,
             (SELECT count(*) FROM revisions)::bigint AS revisions,
             (SELECT rev FROM board_head)::bigint AS rev`;
    assert.equal(Number(counts.cards), 0);
    assert.equal(Number(counts.revisions), 0);
    assert.equal(Number(counts.rev), 0);

    // And the same database imports cleanly afterwards: it really was left empty.
    await importDump(sql, makeDump());
  });
});

test("the verifier reports a changed card, a missing delivery and a moved head", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);

    await sql`UPDATE cards SET title = 'tampered' WHERE id = 't_b1'`;
    await sql`DELETE FROM webhook_deliveries WHERE delivery_id = '00000000-0000-4000-8000-000000000002'`;
    await sql`UPDATE board_head SET rev = 42`;

    const result = await verifyImport(sql, dump);
    assert.equal(result.ok, false);
    const text = result.differences.join("\n");
    assert.match(text, /rev: dump 41, database 42/);
    assert.match(text, /card t_b1 differs/);
    assert.match(text, /deliveries missing from the database \(1\)/);
  });
});

test("the verifier reports an archive that was reordered or truncated", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    await importDump(sql, dump);
    await sql`DELETE FROM archived_cards WHERE id = 't_old2'`;
    const result = await verifyImport(sql, dump);
    assert.equal(result.ok, false);
    assert.match(result.differences.join("\n"), /archive: 2 cards in the dump, 1 in the database/);
  });
});

test("documented differences import cleanly and are noted, not failed", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump();
    // A duplicate card id, a null life board, a NUL byte and a repeated delivery id.
    (dump.doc.board.projects as Record<string, unknown[]>).done.push(card("t_a1", { title: "duplicate of t_a1" }));
    dump.doc.board.life = null;
    (dump.doc.board.projects as Record<string, { title: string }[]>).doing[0].title = "nul\u0000byte";
    dump.deliveries.push(dump.deliveries[0]);

    await importDump(sql, validateDump(dump));
    const result = await verifyImport(sql, dump);
    assert.deepEqual(result.differences, []);
    const notes = result.notes.join("\n");
    assert.match(notes, /duplicate card ids collapsed/);
    assert.match(notes, /projects or life became \{\}/);
    assert.match(notes, /U\+0000/);
    assert.match(notes, /duplicate delivery ids collapsed/);
  });
});

test("an import with no archive and no deliveries is fine", async () => {
  await withDatabase(async ({ sql }) => {
    const dump = makeDump({ archive: [], deliveries: [] });
    const summary = await importDump(sql, dump);
    assert.equal(summary.archived, 0);
    assert.equal(summary.deliveries, 0);
    assert.deepEqual((await verifyImport(sql, dump)).differences, []);
  });
});

/* ---- scripts/import-kv.ts ---- */

/* Async, not spawnSync: PGlite's socket server lives in THIS process, so the
 * event loop has to keep turning while the CLI connects to it. */
function runCli(args: string[], env: Record<string, string>) {
  const clean = { ...process.env };
  delete clean.NEON_DATABASE_URL;
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test("the CLI imports, then verifies, then refuses a second import (exit codes 0, 0, 1)", async () => {
  const database = await freshDatabase();
  const dir = await mkdtemp(join(tmpdir(), "koder-kv-import-"));
  try {
    const file = join(dir, "dump.json");
    await writeFile(file, JSON.stringify(makeDump()));
    const env = { NEON_DATABASE_URL: database.url };

    // The CLI is a separate process and PGlite serves one connection at a time,
    // so each run below finishes (and closes its connection) before the next.
    const first = await runCli([file], env);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /imported: rev 41, 5 cards, 4 lifeMeta items, 2 archived, 2 deliveries/);
    assert.match(first.out, /verify: OK/);

    const verifyOnly = await runCli([file, "--verify-only"], env);
    assert.equal(verifyOnly.code, 0, verifyOnly.err);
    assert.match(verifyOnly.out, /verify: OK/);
    assert.doesNotMatch(verifyOnly.out, /imported:/);

    const second = await runCli([file], env);
    assert.equal(second.code, 1);
    assert.match(second.err, /refusing to import: the database is not empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await database.close();
  }
});

test("the CLI exits 2 on bad usage and 1 on a bad dump, and never prints the connection string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "koder-kv-import-"));
  try {
    const url = "postgres://user:hunter2secret@127.0.0.1:1/db";
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ format: "nope" }));
    const good = join(dir, "good.json");
    await writeFile(good, JSON.stringify(makeDump()));

    assert.equal((await runCli([], { NEON_DATABASE_URL: url })).code, 2);
    assert.equal((await runCli([good, "--nonsense"], { NEON_DATABASE_URL: url })).code, 2);
    assert.equal((await runCli([good], {})).code, 2);

    const invalid = await runCli([bad], { NEON_DATABASE_URL: url });
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /not a valid koder-kv-dump file/);

    // Nothing listens on port 1: the connection error must not echo the password.
    const unreachable = await runCli([good], { NEON_DATABASE_URL: url });
    assert.equal(unreachable.code, 1);
    assert.doesNotMatch(unreachable.out + unreachable.err, /hunter2secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
