/* Tests for the spike:db client (KODER-6784): spawns it against a stub server. */

import assert from "node:assert/strict";
import { parseEnvFile } from "./db-client.ts";

const clientPath = decodeURIComponent(new URL("./db-client.ts", import.meta.url).pathname).replace(/^\/(\w:)/, "$1");

Deno.test("parseEnvFile: export, quotes, comments, CRLF", () => {
  const got = parseEnvFile(
    '# c\r\nKODER_API=https://a.example\r\nexport KODER_TOKEN="tok en"\nBAD LINE\nQ=\'x\'\n',
  );
  assert.deepEqual(got, { KODER_API: "https://a.example", KODER_TOKEN: "tok en", Q: "x" });
});

type Seen = { url: string; auth: string | null };

async function withStub(
  respond: (url: URL) => Response,
  fn: (base: string, seen: Seen[]) => Promise<void>,
) {
  const seen: Seen[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    seen.push({ url: req.url, auth: req.headers.get("Authorization") });
    return respond(new URL(req.url));
  });
  try {
    await fn(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, seen);
  } finally {
    await server.shutdown();
  }
}

async function run(args: string[], env: Record<string, string>) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-net", "--allow-env", "--allow-read", clientPath, "--", ...args],
    env: { KODER_API: "", KODER_TOKEN: "", KODER_ENV_FILE: "", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

const COLD = { target: "neon", region: null, connectMs: 1.5, firstQueryMs: 2.5, serverVersion: "PostgreSQL 17" };
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.test("client: --cold --json prints exactly one JSON object on stdout", async () => {
  await withStub(() => json(COLD), async (base, seen) => {
    const r = await run(["--target", "neon", "--cold", "--json"], { KODER_API: base, KODER_TOKEN: "t1" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), COLD);
    assert.equal(seen.length, 1);
    const u = new URL(seen[0].url);
    assert.equal(u.pathname, "/spike/db");
    assert.equal(u.searchParams.get("target"), "neon");
    assert.equal(u.searchParams.get("cold"), "1");
    assert.equal(seen[0].auth, "Bearer t1");
  });
});

Deno.test("client: table output passes n through", async () => {
  const full = {
    ...COLD,
    selectOne: { n: 7, p50: 1, p95: 2, max: 3 },
    txn3: { n: 7, p50: 4, p95: 5 },
  };
  await withStub(() => json(full), async (base, seen) => {
    const r = await run(["--target", "neon", "--n", "7"], { KODER_API: base, KODER_TOKEN: "t" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(new URL(seen[0].url).searchParams.get("n"), "7");
    assert.match(r.stdout, /SELECT 1 p50 \(n=7\)\s+1\.0 ms/);
    assert.match(r.stdout, /txn p95\s+5\.0 ms/);
    assert.match(r.stdout, /version\s+PostgreSQL 17/);
  });
});

Deno.test("client: exits non-zero with the server's message on 400, 404 and 502", async () => {
  for (
    const [status, error] of [[400, "NEON_DATABASE_URL not set"], [404, "db spike disabled"], [502, "connect ECONNREFUSED"]] as const
  ) {
    await withStub(() => json({ error }, status), async (base) => {
      const r = await run(["--target", "neon", "--json"], { KODER_API: base, KODER_TOKEN: "t" });
      assert.notEqual(r.code, 0, `status ${status}`);
      assert.equal(r.stdout, "");
      assert.ok(r.stderr.includes(`HTTP ${status}`) && r.stderr.includes(error), r.stderr);
    });
  }
});

Deno.test("client: environment wins over the env file, which fills the gaps", async () => {
  const dir = await Deno.makeTempDir({ prefix: "koder-client-test-" });
  const file = `${dir}/.koder.env`;
  try {
    await withStub(() => json(COLD), async (base, seen) => {
      await Deno.writeTextFile(file, `KODER_API=http://127.0.0.1:1\nKODER_TOKEN=from-file\n`);
      // env API wins; token comes from the file
      let r = await run(["--target", "neon", "--cold", "--json"], { KODER_API: base, KODER_ENV_FILE: file });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.at(-1)!.auth, "Bearer from-file");
      // env token wins over the file too
      r = await run(["--target", "neon", "--cold", "--json"], { KODER_API: base, KODER_TOKEN: "from-env", KODER_ENV_FILE: file });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.at(-1)!.auth, "Bearer from-env");
      // file alone supplies both
      await Deno.writeTextFile(file, `KODER_API=${base}\nKODER_TOKEN=only-file\n`);
      r = await run(["--target", "neon", "--cold", "--json"], { KODER_ENV_FILE: file });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.at(-1)!.auth, "Bearer only-file");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("client: missing config or bad target exits non-zero", async () => {
  const noCfg = await run(["--target", "neon"], { KODER_ENV_FILE: "/nonexistent/.koder.env" });
  assert.notEqual(noCfg.code, 0);
  const bad = await run(["--target", "nope"], { KODER_API: "http://127.0.0.1:1", KODER_TOKEN: "t" });
  assert.notEqual(bad.code, 0);
});
