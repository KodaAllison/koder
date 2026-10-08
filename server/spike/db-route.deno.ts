/* Tests for the guarded DB probe (KODER-6784): percentiles(), the handler over a
 * PGlite socket server, and the route wired through the real main.ts. */

import assert from "node:assert/strict";
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { PGLiteSocketServer } from "npm:@electric-sql/pglite-socket@0.2.11";
import { handleDbSpike, percentiles } from "./db-route.ts";

const envOf = (o: Record<string, string>) => ({ get: (k: string) => o[k] });
const call = (qs: string, env: Record<string, string>) =>
  handleDbSpike(new URL(`http://x/spike/db?${qs}`), envOf(env));

/* port 0 + ssl-free URL, as in pglite.probe.ts */
async function withPglite(fn: (url: string, db: PGlite) => Promise<void>) {
  const db = new PGlite();
  await db.waitReady;
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
  await server.start();
  try {
    const port = Number(/(\d+)$/.exec(server.getServerConn())?.[1]);
    await fn(`postgres://postgres:s3cretpw@127.0.0.1:${port}/postgres?sslmode=disable`, db);
  } finally {
    await server.stop().catch(() => {});
    await db.close().catch(() => {});
  }
}

Deno.test("percentiles: nearest rank, rounded to 0.1 ms", () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(percentiles(s.reverse()), { n: 100, p50: 50, p95: 95, max: 100 });
  assert.deepEqual(percentiles([1.234, 9.876]), { n: 2, p50: 1.2, p95: 9.9, max: 9.9 });
  assert.deepEqual(percentiles([7]), { n: 1, p50: 7, p95: 7, max: 7 });
  assert.deepEqual(percentiles([]), { n: 0, p50: 0, p95: 0, max: 0 });
});

Deno.test("handler: 404 unless KODER_DB_SPIKE=1", async () => {
  for (const env of [{}, { KODER_DB_SPIKE: "0" }] as Record<string, string>[]) {
    const r = await call("target=neon", { ...env, NEON_DATABASE_URL: "postgres://u:p@h/d" });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "db spike disabled" });
  }
});

Deno.test("handler: 400 on bad target or missing URL", async () => {
  const on = { KODER_DB_SPIKE: "1" };
  assert.equal((await call("target=nope", on)).status, 400);
  assert.equal((await call("", on)).status, 400);
  const r = await call("target=neon", on);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "NEON_DATABASE_URL not set" });
  const d = await call("target=deploy", on);
  assert.deepEqual(await d.json(), { error: "DATABASE_URL not set" });
});

Deno.test("handler: 200 full run against PGlite, and cold=1, and n clamping", async () => {
  await withPglite(async (url) => {
    const env = { KODER_DB_SPIKE: "1", DATABASE_URL: url };
    const r = await call("target=deploy&n=5", env);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.target, "deploy");
    assert.ok(b.region === null || typeof b.region === "string");
    assert.equal(typeof b.connectMs, "number");
    assert.equal(typeof b.firstQueryMs, "number");
    assert.equal(b.selectOne.n, 5);
    assert.deepEqual(Object.keys(b.selectOne).sort(), ["max", "n", "p50", "p95"]);
    assert.equal(b.txn3.n, 5);
    assert.deepEqual(Object.keys(b.txn3).sort(), ["n", "p50", "p95"]);
    assert.match(b.serverVersion, /PostgreSQL/);
    assert.ok(!JSON.stringify(b).includes("s3cretpw"));

    // n is clamped to 1..500
    const lo = await (await call("target=deploy&n=0", env)).json();
    assert.equal(lo.selectOne.n, 1);
    const hi = await (await call("target=deploy&n=999", env)).json();
    assert.equal(hi.selectOne.n, 500);
    assert.equal(hi.txn3.n, 500);
  });
});

Deno.test("handler: cold=1 is write-free (no table created, nothing inserted)", async () => {
  await withPglite(async (url, db) => {
    const env = { KODER_DB_SPIKE: "1", DATABASE_URL: url };
    const c = await (await call("target=deploy&cold=1&n=500", env)).json();
    assert.deepEqual(Object.keys(c).sort(), ["connectMs", "firstQueryMs", "region", "serverVersion", "target"]);
    const t = await db.query<{ t: string | null }>("SELECT to_regclass('spike_probe')::text AS t");
    assert.equal(t.rows[0].t, null);

    // once the table exists, a cold run leaves its rows alone
    await call("target=deploy&n=2", env);
    const before = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM spike_probe")).rows[0].n;
    assert.equal(before, 2);
    await call("target=deploy&cold=1", env);
    const after = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM spike_probe")).rows[0].n;
    assert.equal(after, before);
  });
});

Deno.test("handler: a failure mid-loop is a 502 and the connection is still closed", async () => {
  await withPglite(async (url, db) => {
    const env = { KODER_DB_SPIKE: "1", DATABASE_URL: url };
    // A spike_probe without `note`: CREATE IF NOT EXISTS passes, the txn INSERT fails with BEGIN open.
    await db.exec("CREATE TABLE spike_probe (id bigserial PRIMARY KEY, at timestamptz DEFAULT now())");
    const bad = await call("target=deploy&n=3", env);
    assert.equal(bad.status, 502);
    assert.ok(!(await bad.text()).includes("s3cretpw"));
    // pglite-socket accepts one connection at a time: if the first leaked, this would hang
    // PGlite is one backend shared by every socket, so closing the connection doesn't roll
    // back the open txn the way a real Postgres does; do it by hand.
    await db.exec("ROLLBACK");
    await db.exec("DROP TABLE spike_probe");
    const ok = await Promise.race([
      call("target=deploy&n=3", env),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("connection leaked: next request hung")), 15000)),
    ]);
    assert.equal(ok.status, 200);
  });
});

Deno.test("handler: connection failure is a 502 that never echoes the password", async () => {
  const env = {
    KODER_DB_SPIKE: "1",
    NEON_DATABASE_URL: "postgres://user:hunter2pw@127.0.0.1:1/db?sslmode=disable",
  };
  const r = await call("target=neon&cold=1", env);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(JSON.parse(text).error.length > 0);
  assert.ok(!text.includes("hunter2pw") && !text.includes("postgres://"), text);
});

/* ---- through the real main.ts: auth first, then the guard, then the probe ---- */
const mainPath = decodeURIComponent(new URL("../main.ts", import.meta.url).pathname).replace(/^\/(\w:)/, "$1");
const TOKEN = "spike-test-token";

async function withServer(
  env: Record<string, string>,
  fn: (base: string) => Promise<void>,
) {
  const probe = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const dir = await Deno.makeTempDir({ prefix: "koder-spike-test-" });
  const server = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-kv", "--allow-env", "--allow-net", "--allow-read", "--allow-write", mainPath],
    cwd: dir,
    env: { KODER_TOKEN: TOKEN, KODER_KV_PATH: `${dir}/b.sqlite3`, PORT: String(port), ...env },
    stdout: "null",
    stderr: "null",
  }).spawn();
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 150; i++) {
      try {
        const r = await fetch(`${base}/state`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(200) });
        await r.body?.cancel();
        if (r.ok) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    await fn(base);
  } finally {
    try {
      server.kill();
    } catch { /* already gone */ }
    await server.status;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("main.ts: /spike/db checks the bearer token before anything else", async () => {
  await withServer({}, async (base) => {
    const noAuth = await fetch(`${base}/spike/db?target=neon`);
    assert.equal(noAuth.status, 401);
    await noAuth.body?.cancel();
    const bad = await fetch(`${base}/spike/db?target=neon`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(bad.status, 401);
    await bad.body?.cancel();
    const off = await fetch(`${base}/spike/db?target=neon`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(off.status, 404);
    assert.deepEqual(await off.json(), { error: "db spike disabled" });
  });
});

Deno.test("main.ts: /spike/db end to end against PGlite when enabled", async () => {
  await withPglite(async (url) => {
    await withServer({ KODER_DB_SPIKE: "1", NEON_DATABASE_URL: url }, async (base) => {
      const r = await fetch(`${base}/spike/db?target=neon&n=3`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.target, "neon");
      assert.equal(b.selectOne.n, 3);
      assert.equal(b.txn3.n, 3);
    });
  });
});
