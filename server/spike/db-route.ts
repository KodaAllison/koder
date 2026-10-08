/* DB latency probe for the storage spike (KODER-6784, measurement KODER-2B82).
 *
 *   GET /spike/db?target=deploy|neon[&n=100][&cold=1]
 *
 * main.ts routes here after bearer auth. The handler is pure over (url, env) so
 * the tests can drive it without a server. Disabled unless KODER_DB_SPIKE=1.
 * Every request opens a fresh single connection (so connect cost is measured)
 * and always closes it. A connection string is never echoed. */

import postgres from "npm:postgres@3.4.9";

export type Env = { get(key: string): string | undefined };

const JSON_HEADERS = { "Content-Type": "application/json" };
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/* Nearest-rank percentiles over raw samples; values rounded to 0.1 ms. */
export function percentiles(samples: number[]): { n: number; p50: number; p95: number; max: number } {
  const n = samples.length;
  if (n === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  return { n, p50: round(at(50)), p95: round(at(95)), max: round(s[n - 1]) };
}

const TARGETS: Record<string, string> = { deploy: "DATABASE_URL", neon: "NEON_DATABASE_URL" };

/* Strip the password (raw and percent-decoded) and any full connection string. */
function scrub(message: string, connStr: string): string {
  let out = message.split(connStr).join("<url>");
  try {
    const pw = new URL(connStr).password;
    for (const p of new Set([pw, decodeURIComponent(pw)])) if (p) out = out.split(p).join("***");
  } catch { /* unparseable URL: nothing more to strip */ }
  return out.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "<url>");
}

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, performance.now() - t0];
}

export async function handleDbSpike(url: URL, env: Env): Promise<Response> {
  if (env.get("KODER_DB_SPIKE") !== "1") return reply({ error: "db spike disabled" }, 404);

  const target = url.searchParams.get("target") ?? "";
  const varName = TARGETS[target];
  if (!varName) return reply({ error: "target must be deploy or neon" }, 400);
  const connStr = env.get(varName);
  if (!connStr) return reply({ error: `${varName} not set` }, 400);

  const nRaw = Number.parseInt(url.searchParams.get("n") ?? "100", 10);
  const n = Math.min(500, Math.max(1, Number.isFinite(nRaw) ? nRaw : 100));
  const cold = url.searchParams.get("cold") === "1";

  let host = "";
  try {
    host = new URL(connStr).hostname;
  } catch { /* the driver will report it */ }

  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres(connStr, {
      max: 1,
      connect_timeout: 15,
      idle_timeout: 5,
      onnotice: () => {},
      ...(host.includes("-pooler") ? { prepare: false } : {}),
    });
  } catch (e) {
    return reply({ error: scrub(e instanceof Error ? e.message : String(e), connStr) }, 502);
  }
  try {
    // reserve() opens the one connection now, so connectMs is just the connect.
    const [c, connectMs] = await time(() => sql.reserve());
    const [[ver], firstQueryMs] = await time(() => c`SELECT version() AS v`);
    const serverVersion = String(ver.v);
    const head = {
      target,
      region: Deno.env.get("DENO_REGION") ?? null,
      connectMs: round(connectMs),
      firstQueryMs: round(firstQueryMs),
    };
    if (cold) return reply({ ...head, serverVersion });

    await c`CREATE TABLE IF NOT EXISTS spike_probe (id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), note text)`;
    await c`DELETE FROM spike_probe WHERE at < now() - interval '1 day'`;

    const one: number[] = [];
    for (let i = 0; i < n; i++) one.push((await time(() => c`SELECT 1`))[1]);

    const txn: number[] = [];
    for (let i = 0; i < n; i++) {
      const note = `probe ${i}`;
      const t0 = performance.now();
      await c.unsafe("BEGIN");
      await c`INSERT INTO spike_probe (note) VALUES (${note})`;
      await c`SELECT count(*) FROM spike_probe`;
      await c.unsafe("COMMIT");
      txn.push(performance.now() - t0);
    }
    const { p50, p95 } = percentiles(txn);
    c.release();
    return reply({ ...head, selectOne: percentiles(one), txn3: { n: txn.length, p50, p95 }, serverVersion });
  } catch (e) {
    return reply({ error: scrub(e instanceof Error ? e.message : String(e), connStr) }, 502);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
