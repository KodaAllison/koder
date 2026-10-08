/* Local client for the guarded DB probe (KODER-6784).
 *
 *   deno task spike:db -- --target neon|deploy [--n 100] [--cold] [--json]
 *
 * KODER_API / KODER_TOKEN come from the environment, else scripts/.koder.env
 * (env wins, same as scripts/koder-ticket.sh). Exits non-zero on any error. */

import { parseArgs } from "node:util";

/* Parse KEY=value lines of a shell-style env file (optional `export`, quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

async function loadConfig(): Promise<{ api: string; token: string }> {
  let file: Record<string, string> = {};
  try {
    const path = new URL("../../scripts/.koder.env", import.meta.url);
    file = parseEnvFile(await Deno.readTextFile(path));
  } catch { /* no env file: environment only */ }
  const api = Deno.env.get("KODER_API") || file.KODER_API;
  const token = Deno.env.get("KODER_TOKEN") || file.KODER_TOKEN;
  if (!api || !token) fail("set KODER_API and KODER_TOKEN in the environment or scripts/.koder.env");
  return { api: api.replace(/\/+$/, ""), token };
}

function fail(msg: string): never {
  console.error(`spike:db: ${msg}`);
  Deno.exit(1);
}

const { values: flags } = parseArgs({
  args: Deno.args.filter((a) => a !== "--"),
  options: { target: { type: "string" }, n: { type: "string" }, cold: { type: "boolean" }, json: { type: "boolean" } },
});
if (flags.target !== "neon" && flags.target !== "deploy") {
  fail("usage: deno task spike:db -- --target neon|deploy [--n 100] [--cold] [--json]");
}
const { api, token } = await loadConfig();
const qs = new URLSearchParams({ target: flags.target });
if (flags.n) qs.set("n", flags.n);
if (flags.cold) qs.set("cold", "1");

let res: Response;
try {
  res = await fetch(`${api}/spike/db?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
} catch (e) {
  fail(`request failed: ${e instanceof Error ? e.message : e}`);
}
const text = await res.text();
let body: Record<string, any>;
try {
  body = JSON.parse(text);
} catch {
  fail(`HTTP ${res.status}: ${text.slice(0, 200)}`);
}
if (!res.ok) fail(`HTTP ${res.status}: ${body.error ?? text.slice(0, 200)}`);

if (flags.json) {
  console.log(JSON.stringify(body, null, 2));
} else {
  const ms = (v: unknown) => (typeof v === "number" ? `${v.toFixed(1)} ms` : "-");
  const rows: [string, string][] = [
    ["target", String(body.target)],
    ["region", String(body.region ?? "unknown")],
    ["connect", ms(body.connectMs)],
    ["first query", ms(body.firstQueryMs)],
  ];
  if (body.selectOne) {
    rows.push(
      [`SELECT 1 p50 (n=${body.selectOne.n})`, ms(body.selectOne.p50)],
      ["SELECT 1 p95", ms(body.selectOne.p95)],
      ["SELECT 1 max", ms(body.selectOne.max)],
      [`txn p50 (n=${body.txn3.n})`, ms(body.txn3.p50)],
      ["txn p95", ms(body.txn3.p95)],
    );
  }
  rows.push(["version", String(body.serverVersion)]);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
}
