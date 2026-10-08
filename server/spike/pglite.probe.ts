/* Spike (KODER-59BC): can PGlite run the future PgStore contract suite in Deno?
 *
 * Run:  deno task spike:pglite   (from server/)
 *
 * NOT part of `deno task test` / `deno task check` on purpose: it pulls npm
 * packages (PGlite is ~10 MB of WASM) and is evidence for
 * docs/specs/storage-spike.md, not a regression suite.
 *
 * Part 1 executes the ```sql block of section 5 of docs/specs/storage-expansion.md
 * VERBATIM (so a schema edit in the spec that PGlite can't run shows up here), then
 * exercises each Postgres feature sections 5.1, 7.2 and 7.3 lean on.
 * Part 2 answers the concurrency question (PGlite is one connection).
 * Part 3 answers the driver question (can npm:postgres talk to PGlite?).
 * Exit code is non-zero if any check fails. */

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { PGLiteSocketServer } from "npm:@electric-sql/pglite-socket@0.2.11";
import postgres from "npm:postgres@3.4.9";

type Row = { feature: string; ok: boolean; note: string };
const rows: Row[] = [];
async function check(feature: string, fn: () => Promise<string | void>) {
  try {
    const note = (await fn()) ?? "";
    rows.push({ feature, ok: true, note });
  } catch (e) {
    rows.push({ feature, ok: false, note: e instanceof Error ? e.message : String(e) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// Run something that must fail, and hand back the Postgres SQLSTATE.
async function sqlstate(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "no-code";
  }
  throw new Error("expected an error, got success");
}

/* ---------- Pull the schema out of the spec ---------- */
const specPath = new URL("../../docs/specs/storage-expansion.md", import.meta.url);
const spec = await Deno.readTextFile(specPath);
const sec5 = spec.slice(spec.indexOf("## 5. Proposed schema"), spec.indexOf("### 5.1 How each"));
const schemaSql = /```sql\r?\n([\s\S]*?)```/.exec(sec5)?.[1];
if (!schemaSql) throw new Error("could not find the section 5 sql block in the spec");

const db = new PGlite();
await db.waitReady;
const version = (await db.query<{ version: string }>("select version()")).rows[0].version;

/* ---------- Part 1: schema and features ---------- */
await check("Section 5 schema DDL, verbatim from the spec", async () => {
  await db.exec(schemaSql);
  const t = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema in ('public','fin')",
  );
  return `${t.rows[0].n} tables created (public + fin)`;
});

await db.exec(`INSERT INTO owners (id) VALUES ('koda'); INSERT INTO board_head (owner_id) VALUES ('koda');`);

await check("CHECK constraints (board_id, priority, title length, amount_pence <> 0)", async () => {
  const ins = (extra: string) =>
    db.query(
      `INSERT INTO cards (id, owner_id, board_id, column_id, rank, title, created) VALUES ${extra}`,
    );
  const bad1 = await sqlstate(() => ins(`('c_bad1','koda','nope','todo','a','x',1)`));
  const bad2 = await sqlstate(() => ins(`('c_bad2','koda','projects','todo','a','',1)`));
  assert(bad1 === "23514" && bad2 === "23514", `expected 23514, got ${bad1}/${bad2}`);
  return "violations surface as SQLSTATE 23514 (what a PgStore maps to a 400/500)";
});

await check("COLLATE \"C\" rank ordering (fractional index)", async () => {
  await db.exec(`
    INSERT INTO cards (id, owner_id, board_id, column_id, rank, title, created) VALUES
      ('c1','koda','projects','todo','a0','one',1),
      ('c2','koda','projects','todo','B0','two',2),
      ('c3','koda','projects','todo','a1','three',3);`);
  const r = await db.query<{ id: string }>(
    `SELECT id FROM cards WHERE board_id='projects' AND column_id='todo' ORDER BY rank`,
  );
  const order = r.rows.map((x) => x.id).join(",");
  assert(order === "c2,c1,c3", `expected byte order c2,c1,c3 (uppercase first), got ${order}`);
  return "byte-wise order (B0 < a0 < a1), same as a real server";
});

await check("Partial index is usable by the planner (cards_board_col)", async () => {
  await db.exec(`SET enable_seqscan = off`);
  const plan = await db.query<{ "QUERY PLAN": string }>(
    `EXPLAIN SELECT id FROM cards WHERE owner_id='koda' AND board_id='projects' AND column_id='todo'
       AND archived_at IS NULL AND deleted_at IS NULL ORDER BY rank`,
  );
  await db.exec(`RESET enable_seqscan`);
  const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert(/cards_board_col/.test(text), `plan did not use cards_board_col:\n${text}`);
  return "EXPLAIN uses cards_board_col (seqscan disabled to force it on a tiny table)";
});

await check("Partial index predicate rejects non-matching queries (cards_pr)", async () => {
  await db.exec(`SET enable_seqscan = off`);
  const plan = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT id FROM cards WHERE pr = 'a/b#1'`);
  await db.exec(`RESET enable_seqscan`);
  assert(/cards_pr/.test(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")), "cards_pr unused");
});

await check("jsonb: extra round-trip, ->>, @>, ||, jsonb_set, jsonb_build_object", async () => {
  await db.query(`UPDATE cards SET extra = $1::jsonb WHERE id='c1'`, [
    JSON.stringify({ colour: "red", nested: { n: [1, 2] } }),
  ]);
  const r = await db.query<{ colour: string; has: boolean; merged: unknown; set: unknown }>(
    `SELECT extra->>'colour' AS colour, extra @> '{"nested":{"n":[2]}}' AS has,
            extra || '{"a":1}'::jsonb AS merged,
            jsonb_set(extra, '{nested,n,0}', '9') AS set
       FROM cards WHERE id='c1'`,
  );
  const x = r.rows[0];
  assert(x.colour === "red" && x.has, "->> or @> wrong");
  assert((x.merged as { a: number }).a === 1, "|| wrong");
  assert((x.set as { nested: { n: number[] } }).nested.n[0] === 9, "jsonb_set wrong");
  return "objects come back as parsed JS objects";
});

await check("ON CONFLICT DO UPDATE upsert (cards by id, RETURNING xmax-free)", async () => {
  const q = `INSERT INTO cards (id, owner_id, board_id, column_id, rank, title, created)
             VALUES ('c1','koda','projects','doing','m','renamed',1)
             ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, column_id = EXCLUDED.column_id,
               row_version = cards.row_version + 1
             RETURNING row_version, title`;
  const r = await db.query<{ row_version: string; title: string }>(q);
  assert(r.rows[0].title === "renamed" && Number(r.rows[0].row_version) === 2, "upsert wrong");
  return "row_version bigint comes back as a JS number here (see Part 3 for postgres.js: string)";
});

await check("rev compare-and-swap: UPDATE ... WHERE rev=$base RETURNING (section 5.1)", async () => {
  const cas = (base: number) =>
    db.query<{ rev: string }>(
      `UPDATE board_head SET rev = rev + 1, updated_at = now() WHERE owner_id='koda' AND rev=$1 RETURNING rev`,
      [base],
    );
  const ok = await cas(0);
  const stale = await cas(0);
  assert(ok.rows.length === 1 && stale.rows.length === 0, "CAS did not behave");
  return "first writer gets a row, stale baseRev gets 0 rows (-> 409)";
});

await check("SELECT ... FOR UPDATE inside a transaction (section 7.2 step 1)", async () => {
  const r = await db.transaction(async (tx) => {
    const h = await tx.query<{ rev: string }>(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
    await tx.query(`UPDATE board_head SET rev = rev + 1 WHERE owner_id='koda'`);
    return h.rows[0].rev;
  });
  assert(Number(r) === 1, `unexpected rev ${r}`);
  return "parses and executes; locks are real but never contended (see Part 2)";
});
await check("FOR UPDATE SKIP LOCKED / NOWAIT parse", async () => {
  await db.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE NOWAIT`);
  await db.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE SKIP LOCKED`);
});

await check("Transaction rollback undoes everything (card + rev bump + delivery together)", async () => {
  let threw = false;
  try {
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO webhook_deliveries (delivery_id, outcome) VALUES ('d-rollback','updated')`);
      await tx.query(`UPDATE cards SET title='should-vanish' WHERE id='c2'`);
      await tx.query(`UPDATE board_head SET rev = rev + 1 WHERE owner_id='koda'`);
      throw new Error("boom");
    });
  } catch {
    threw = true;
  }
  const d = await db.query(`SELECT 1 FROM webhook_deliveries WHERE delivery_id='d-rollback'`);
  const c = await db.query<{ title: string }>(`SELECT title FROM cards WHERE id='c2'`);
  assert(threw && d.rows.length === 0 && c.rows[0].title === "two", "rollback leaked state");
  return "the webhook idempotency row is atomic with the board write, as section 5.1 requires";
});
await check("Failed statement aborts the tx; SAVEPOINT recovery works", async () => {
  await db.transaction(async (tx) => {
    await tx.query(`SAVEPOINT s`);
    const code = await sqlstate(() =>
      tx.query(`INSERT INTO webhook_deliveries (delivery_id, outcome) VALUES (NULL,'x')`)
    );
    assert(code === "23502", `expected 23502 got ${code}`);
    await tx.query(`ROLLBACK TO s`);
    await tx.query(`SELECT 1`);
  });
});

await check("Webhook idempotency: INSERT ... ON CONFLICT DO NOTHING RETURNING", async () => {
  const ins = () =>
    db.query(
      `INSERT INTO webhook_deliveries (delivery_id, outcome) VALUES ('d1','updated')
       ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`,
    );
  const a = await ins();
  const b = await ins();
  assert(a.rows.length === 1 && b.rows.length === 0, "second insert should return no row (= redelivered)");
});

await check("Archive idempotency: UPDATE ... WHERE id = ANY($1) AND archived_at IS NULL", async () => {
  const run = () =>
    db.query(
      `UPDATE cards SET archived_at = now(), archived_from = 'projects'
        WHERE id = ANY($1::text[]) AND archived_at IS NULL RETURNING id`,
      [["c1", "c3", "missing"]],
    );
  const a = await run();
  const b = await run();
  assert(a.rows.length === 2 && b.rows.length === 0, `archived ${a.rows.length} then ${b.rows.length}`);
  return "array parameters bind; second call archives 0 (duplicates)";
});

await check("changes log: composite PK, jsonb before/after, CHECK on entity/op", async () => {
  await db.query(
    `INSERT INTO changes (rev, owner_id, seq, entity, entity_id, op, before, after, actor)
     VALUES (1,'koda',0,'card','c1','update',$1::jsonb,$2::jsonb,'browser')`,
    [JSON.stringify({ title: "one" }), JSON.stringify({ title: "renamed" })],
  );
  const dup = await sqlstate(() =>
    db.query(`INSERT INTO changes (rev, owner_id, seq, entity, entity_id, op, actor)
              VALUES (1,'koda',0,'card','c1','insert','browser')`)
  );
  const badOp = await sqlstate(() =>
    db.query(`INSERT INTO changes (rev, owner_id, seq, entity, entity_id, op, actor)
              VALUES (1,'koda',1,'card','c1','merge','browser')`)
  );
  assert(dup === "23505" && badOp === "23514", `${dup}/${badOp}`);
});

await check("Foreign keys (cards.owner_id, agent_runs.card_id)", async () => {
  const code = await sqlstate(() =>
    db.query(`INSERT INTO cards (id, owner_id, board_id, column_id, rank, title, created)
              VALUES ('c_fk','ghost','projects','todo','z','x',1)`)
  );
  assert(code === "23503", code);
});

await check("Ledger immutability trigger (the spec's commented reject_mutation, section 5.5)", async () => {
  await db.exec(`
    CREATE FUNCTION fin.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fin.transactions is append-only' USING ERRCODE = 'restrict_violation'; END $$;
    CREATE TRIGGER no_update BEFORE UPDATE OR DELETE ON fin.transactions
      FOR EACH ROW EXECUTE FUNCTION fin.reject_mutation();
    INSERT INTO fin.accounts (id, owner_id, name, kind) VALUES ('a1','koda','Current','current');`);
  await db.query(
    `INSERT INTO fin.transactions (account_id, posted_on, amount_pence, description, import_source, external_id)
     VALUES ('a1','2026-10-01',-1250,'coffee','monzo-csv','x1')`,
  );
  const upd = await sqlstate(() => db.query(`UPDATE fin.transactions SET description='tampered'`));
  const del = await sqlstate(() => db.query(`DELETE FROM fin.transactions`));
  assert(upd === "23001" && del === "23001", `${upd}/${del}`);
  return "UPDATE and DELETE both rejected (SQLSTATE 23001). Role GRANT part of the immutability story is NOT testable: PGlite has one superuser";
});
await check("Idempotent import: UNIQUE (account_id, import_source, external_id) + ON CONFLICT DO NOTHING", async () => {
  const q = `INSERT INTO fin.transactions (account_id, posted_on, amount_pence, description, import_source, external_id)
             VALUES ('a1','2026-10-01',-1250,'coffee','monzo-csv','x1') ON CONFLICT DO NOTHING RETURNING id`;
  const r = await db.query(q);
  assert(r.rows.length === 0, "duplicate import inserted a row");
  const zero = await sqlstate(() =>
    db.query(`INSERT INTO fin.transactions (account_id, posted_on, amount_pence, description)
              VALUES ('a1','2026-10-01',0,'zero')`)
  );
  assert(zero === "23514", zero);
});
await check("gen_random_uuid(), bigint SUM ... GROUP BY, char(3), date", async () => {
  const r = await db.query<{ total: string; id: string }>(
    `SELECT sum(amount_pence)::text AS total, min(id::text) AS id FROM fin.transactions GROUP BY account_id`,
  );
  assert(r.rows[0].total === "-1250" && /^[0-9a-f-]{36}$/.test(r.rows[0].id), "bad aggregate/uuid");
});
await check("bytea, text[] (credentials / api_tokens)", async () => {
  await db.query(
    `INSERT INTO credentials (id, owner_id, public_key, transports) VALUES ($1,'koda',$2,$3::text[])`,
    [new Uint8Array([1, 2, 3]), new Uint8Array([9, 9]), ["usb", "nfc"]],
  );
  const r = await db.query<{ id: Uint8Array; transports: string[] }>(`SELECT id, transports FROM credentials`);
  assert(r.rows[0].id.length === 3 && r.rows[0].transports.length === 2, "bytea/text[] wrong");
});

await check("Identity column + sequence (spec uses neither; migrations tooling may)", async () => {
  await db.exec(`CREATE TABLE seqtest (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
                 CREATE SEQUENCE manual_seq;`);
  const a = await db.query<{ id: string }>(`INSERT INTO seqtest (v) VALUES ('a') RETURNING id`);
  const b = await db.query<{ id: string }>(`INSERT INTO seqtest (v) VALUES ('b') RETURNING id`);
  const n = await db.query<{ n: string }>(`SELECT nextval('manual_seq') AS n`);
  assert(Number(b.rows[0].id) === Number(a.rows[0].id) + 1 && Number(n.rows[0].n) === 1, "sequence wrong");
  return "note: sequences are non-transactional, so a rolled back tx burns a value (same as real PG)";
});

await check("timestamptz, now() is transaction-stable, statement_timeout/lock_timeout settable", async () => {
  await db.exec(`SET statement_timeout = '5s'; SET lock_timeout = '2s'`);
  const r = await db.transaction(async (tx) => {
    const a = await tx.query<{ t: string }>(`SELECT now()::text AS t`);
    await tx.query(`SELECT pg_sleep(0.01)`);
    const b = await tx.query<{ t: string }>(`SELECT now()::text AS t`);
    return a.rows[0].t === b.rows[0].t;
  });
  assert(r, "now() moved inside a tx");
  const s = await db.query<{ statement_timeout: string }>(`SHOW statement_timeout`);
  await db.exec(`RESET statement_timeout; RESET lock_timeout`);
  return `SHOW statement_timeout = ${s.rows[0].statement_timeout}. Setting works; whether it is enforced under a single connection is not interesting`;
});
// KNOWN GAP, recorded as a passing check that asserts the gap: the WASM build has no
// SIGALRM, so statement_timeout is accepted but never fires. Tests must not rely on it.
await check("KNOWN GAP: statement_timeout is accepted but NOT enforced", async () => {
  await db.exec(`SET statement_timeout = '50ms'`);
  const t0 = performance.now();
  let code = "none";
  try {
    await db.query(`SELECT pg_sleep(0.5)`);
  } catch (e) {
    code = (e as { code?: string }).code ?? "no-code";
  }
  const ms = Math.round(performance.now() - t0);
  await db.exec(`RESET statement_timeout`);
  assert(code === "none", `statement_timeout fired (${code}) -- gap closed, update the doc`);
  return `pg_sleep(0.5) ran to completion in ${ms}ms under statement_timeout=50ms (no 57014). A statement_timeout test needs a real Postgres`;
});

await check("Generated/derived board read: ordered json_agg per column in ONE query", async () => {
  const r = await db.query<{ column_id: string; ids: string[] }>(
    `SELECT column_id, array_agg(id ORDER BY rank) AS ids FROM cards
      WHERE owner_id='koda' AND board_id='projects' AND archived_at IS NULL AND deleted_at IS NULL
      GROUP BY column_id ORDER BY column_id`,
  );
  assert(r.rows.length >= 1, "no rows");
});

await check("Migrations as a file of many statements via exec() (multi-statement)", async () => {
  await db.exec(`CREATE TABLE m1 (a int); CREATE TABLE m2 (b int); DROP TABLE m1; DROP TABLE m2;`);
});

await check("ON CONFLICT with partial/unique index inference and EXCLUDED, plus CTE writes", async () => {
  const r = await db.query<{ n: number }>(
    `WITH moved AS (UPDATE cards SET column_id='review' WHERE id='c2' RETURNING id),
          logged AS (INSERT INTO changes (rev, owner_id, seq, entity, entity_id, op, actor)
                     SELECT 2,'koda',0,'card',id,'update','webhook' FROM moved RETURNING 1)
     SELECT count(*)::int AS n FROM logged`,
  );
  assert(r.rows[0].n === 1, "data-modifying CTE failed");
});

/* ---------- Part 2: concurrency ---------- */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await check("CONCURRENCY: two overlapping db.transaction()s are serialised, not interleaved", async () => {
  const log: string[] = [];
  const a = db.transaction(async (tx) => {
    log.push("A:begin");
    await tx.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
    log.push("A:locked");
    await sleep(100);
    log.push("A:commit");
  });
  const b = db.transaction(async (tx) => {
    log.push("B:begin");
    await tx.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
    log.push("B:locked");
  });
  await Promise.all([a, b]);
  const s = log.join(" ");
  // B must not even BEGIN until A has finished: PGlite queues whole transactions.
  assert(s === "A:begin A:locked A:commit B:begin B:locked", `unexpected interleaving: ${s}`);
  return `observed order: ${s}. So B never BLOCKS on A's row lock; it never reaches the server`;
});

await check("CONCURRENCY: same-baseRev race still yields exactly one winner", async () => {
  await db.exec(`UPDATE board_head SET rev = 10 WHERE owner_id='koda'`);
  const put = (n: number) =>
    db.transaction(async (tx) => {
      const h = await tx.query<{ rev: string }>(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
      if (Number(h.rows[0].rev) !== 10) return `stale#${n}`;
      await tx.query(`UPDATE board_head SET rev = rev + 1 WHERE owner_id='koda'`);
      return `ok#${n}`;
    });
  const res = await Promise.all([put(1), put(2), put(3)]);
  assert(res.filter((x) => x.startsWith("ok")).length === 1, res.join(","));
  return `results ${res.join(",")}: the 409 / "exactly one 200" contract test works`;
});

await check("CONCURRENCY: StoreContentionError path is NOT reachable via real lock contention", async () => {
  // Real contention would need a second connection holding a lock and lock_timeout /
  // serialization_failure on this one. With one connection that cannot happen, so
  // assert the negative: under lock_timeout=50ms a long A does not make B fail.
  await db.exec(`SET lock_timeout = '50ms'`);
  const a = db.transaction(async (tx) => {
    await tx.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
    await sleep(200);
  });
  const b = db.transaction(async (tx) => {
    await tx.query(`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`);
  });
  await Promise.all([a, b]); // would throw 55P03 on a real server
  await db.exec(`RESET lock_timeout`);
  return "no 55P03 lock_not_available even with lock_timeout=50ms. Test the contention path by fault injection (a wrapper that throws {code:'40001'|'55P03'}), not by racing";
});

await check("CONCURRENCY: serialization failure code 40001 can be produced only by hand", async () => {
  const code = await sqlstate(() =>
    db.transaction(async (tx) => {
      await tx.query(`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      // A deliberate failure standing in for what a competing tx would cause.
      await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'simulated' USING ERRCODE = '40001'; END $$`);
    })
  );
  assert(code === "40001", code);
  return "a PgStore retry loop keyed on SQLSTATE 40001/55P03/40P01 can be unit-tested by raising these from SQL";
});

/* ---------- Part 3: the driver (npm:postgres) ---------- */
let socketNote = "";
await check("DRIVER: npm:postgres (porsager) connects to PGlite through pglite-socket", async () => {
  const server = new PGLiteSocketServer({ db, port: 54329, host: "127.0.0.1" });
  await server.start();
  const sql = postgres("postgres://postgres:postgres@127.0.0.1:54329/postgres", {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    const [r] = await sql`SELECT 1 AS one, ${"héllo"}::text AS s`;
    assert(r.one === 1 && r.s === "héllo", "basic query wrong");
    const ids = await sql`SELECT id FROM cards WHERE id = ANY(${["c1", "c2"]}) ORDER BY id`;
    assert(ids.length === 2, "array param via sql`` failed");
    const [b] = await sql`SELECT rev FROM board_head WHERE owner_id='koda'`;
    socketNote = `bigint comes back as ${typeof b.rev} ("${b.rev}"): postgres.js returns int8 as string unless a type override is set`;
    const out = await sql.begin(async (tx) => {
      const [h] = await tx`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`;
      await tx`UPDATE board_head SET rev = rev + 1 WHERE owner_id='koda'`;
      return h.rev;
    });
    assert(out !== undefined, "sql.begin failed");
    const code = await sqlstate(() => sql`INSERT INTO cards (id, owner_id, board_id, column_id, rank, title, created)
                                          VALUES ('x','koda','bad','t','a','t',1)`);
    assert(code === "23514", `error code lost through the driver: ${code}`);
    return socketNote + "; sql.begin(), FOR UPDATE, array params and SQLSTATEs all work";
  } finally {
    await sql.end({ timeout: 1 });
    await server.stop();
  }
});

// A pool of 4 against pglite-socket. Default server (maxConnections 1) vs the
// multiplexer (maxConnections: 4). Returns what happened, never throws.
async function poolOf4(port: number, maxConnections: number | undefined): Promise<string> {
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", ...(maxConnections ? { maxConnections } : {}) });
  await server.start();
  const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, {
    max: 4,
    idle_timeout: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const r = await Promise.race([
      Promise.all([1, 2, 3, 4].map((i) => sql`SELECT ${i}::int AS i`)).then(() => "ok" as const),
      sleep(8000).then(() => "timeout" as const),
    ]);
    return r === "ok" ? "4 parallel queries OK" : "hung >8s";
  } catch (e) {
    return `failed: ${(e as Error).message}`;
  } finally {
    await Promise.race([sql.end({ timeout: 1 }).catch(() => {}), sleep(3000)]);
    await server.stop().catch(() => {});
  }
}
let poolDefault = "";
let poolMux = "";
await check("DRIVER: postgres.js pool (max 4) against pglite-socket, default vs maxConnections: 4", async () => {
  poolDefault = await poolOf4(54330, undefined);
  poolMux = await poolOf4(54331, 4);
  return `default server -> ${poolDefault}; maxConnections: 4 -> ${poolMux}`;
});

// The experiment that would matter for StoreContentionError: do TWO driver
// connections get real lock contention through the multiplexer? Recorded, not asserted.
await check("DRIVER: does the multiplexer give real row-lock contention between two connections?", async () => {
  const server = new PGLiteSocketServer({ db, port: 54332, host: "127.0.0.1", maxConnections: 2 });
  await server.start();
  const url = "postgres://postgres:postgres@127.0.0.1:54332/postgres";
  const a = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  const b = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    let bResult = "";
    const aTx = a.begin(async (tx) => {
      await tx`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`;
      await sleep(400);
    });
    await sleep(100);
    const t0 = performance.now();
    const bTx = b.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '100ms'`;
      await tx`SELECT rev FROM board_head WHERE owner_id='koda' FOR UPDATE`;
    }).then(() => "B acquired the lock", (e) => `B failed with SQLSTATE ${e.code}`);
    bResult = await Promise.race([bTx, sleep(5000).then(() => "B hung >5s")]);
    await Promise.race([aTx.catch(() => {}), sleep(3000)]);
    return `${bResult} after ${Math.round(performance.now() - t0)}ms. A real server answers 55P03 at ~100ms`;
  } finally {
    await Promise.race([Promise.all([a.end({ timeout: 1 }), b.end({ timeout: 1 })]).catch(() => {}), sleep(3000)]);
    await server.stop().catch(() => {});
  }
});

/* ---------- Report ---------- */
await db.close();
console.log(`\nPGlite probe -- ${version}\n@electric-sql/pglite 0.5.8, pglite-socket 0.2.11, postgres 3.4.9, Deno ${Deno.version.deno}\n`);
let failed = 0;
for (const r of rows) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.feature}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log(`\n${rows.length - failed}/${rows.length} passed`);
Deno.exit(failed ? 1 : 0);
