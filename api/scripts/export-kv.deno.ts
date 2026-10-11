/* One-off, READ-ONLY export of the Deno KV board into a single JSON dump
 * (KODER-E214). Run it under Deno, because only Deno can read KV; the dump is
 * loaded into Postgres by api/scripts/import-kv.ts under Node.
 *
 *   # a local KV database file
 *   deno run --allow-read --allow-write --unstable-kv \
 *     api/scripts/export-kv.deno.ts ./kv.sqlite3 ./koder-kv-2026-01-01.json
 *
 *   # the Deno Deploy database, over KV Connect
 *   DENO_KV_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-write --unstable-kv \
 *     api/scripts/export-kv.deno.ts https://api.deno.com/databases/<id>/connect ./koder-kv-2026-01-01.json
 *
 * (--unstable-kv is only needed on Deno 1.x; harmless on 2.x.)
 *
 * It only ever calls kv.get and kv.list, so it cannot change the database. A
 * local path that doesn't exist is refused, because Deno.openKv would create an
 * empty database there. The output file is created exclusively (an existing file
 * is never overwritten) and readable by you only: it is your whole board.
 * Keep it outside the repo.
 *
 * Key layout (mirrors server/kv-store.ts; nothing is imported from server/):
 *   ["board"]                    the doc {rev, updatedAt, board}
 *   ["archive", n]               an array of archived cards
 *   ["github-delivery", id]      true
 * The ["board", rev] snapshots are NOT exported: history starts at the cutover. */

import { DUMP_FORMAT, DUMP_VERSION, type KvDump, validateDump } from "../src/kv-dump.ts";

const [target, out] = Deno.args;
if (!target || !out || Deno.args.length !== 2) {
  console.error("usage: deno run ... api/scripts/export-kv.deno.ts <kv file path | https://... KV Connect URL> <out.json>");
  Deno.exit(2);
}

const remote = /^https?:\/\//i.test(target);
if (remote && !Deno.env.get("DENO_KV_ACCESS_TOKEN")) {
  console.error("DENO_KV_ACCESS_TOKEN is not set (needed to read a remote KV database)");
  Deno.exit(2);
}
if (!remote) {
  try {
    if (!(await Deno.stat(target)).isFile) throw new Error("not a file");
  } catch {
    // openKv would silently create an empty database at a wrong path.
    console.error(`${target} is not an existing KV database file; refusing to open (it would be created empty)`);
    Deno.exit(2);
  }
}

const kv = await Deno.openKv(target);
try {
  const board = await kv.get<{ rev: number; updatedAt: string | null; board: Record<string, unknown> }>(["board"]);
  if (!board.value) {
    console.error('no ["board"] entry in this database: wrong database? Nothing exported.');
    Deno.exit(1);
  }

  const archive: KvDump["archive"] = [];
  for await (const entry of kv.list<Record<string, unknown>[]>({ prefix: ["archive"] })) {
    const n = entry.key[entry.key.length - 1];
    if (entry.key.length !== 2 || typeof n !== "number") {
      console.error(`unexpected archive key ${JSON.stringify(entry.key)}`);
      Deno.exit(1);
    }
    archive.push({ n, cards: entry.value });
  }
  archive.sort((a, b) => a.n - b.n);

  const deliveries: string[] = [];
  for await (const entry of kv.list<boolean>({ prefix: ["github-delivery"] })) {
    const id = entry.key[entry.key.length - 1];
    if (entry.key.length !== 2 || typeof id !== "string") {
      console.error(`unexpected delivery key ${JSON.stringify(entry.key)}`);
      Deno.exit(1);
    }
    deliveries.push(id);
  }

  const dump = {
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    exportedAt: new Date().toISOString(),
    doc: board.value,
    archive,
    deliveries,
  };
  // The same check the importer runs, so a bad dump fails here, not at cutover.
  validateDump(dump);

  try {
    await Deno.writeTextFile(out, JSON.stringify(dump), { createNew: true, mode: 0o600 });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    console.error(`${out} already exists; refusing to overwrite it. Pick a new file name.`);
    Deno.exit(1);
  }
  console.log(
    `exported rev ${board.value.rev}: ${archive.reduce((n, c) => n + c.cards.length, 0)} archived cards in ` +
      `${archive.length} chunks, ${deliveries.length} deliveries -> ${out}`,
  );
} finally {
  kv.close();
}
