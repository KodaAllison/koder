import { assertEquals, assert } from "jsr:@std/assert";
import { createGithubResolver, parsePullRef } from "./github.ts";

Deno.test("strict parser accepts only webhook-allowlisted canonical refs", () => {
  assertEquals(parsePullRef("KodaAllison/koder#22"), { repo: "KodaAllison/koder", number: 22, key: "KodaAllison/koder#22" });
  for (const value of ["evil/repo#1", "KodaAllison/koder#0", "KodaAllison/koder#01", " KodaAllison/koder#1", null]) assertEquals(parsePullRef(value), null);
});

Deno.test("resolver maps PR and CI with failure precedence and bearer auth", async () => {
  const requests: Request[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    if (request.url.includes("/pulls/")) return Response.json({ state: "closed", merged: true, mergeable: false, head: { sha: "a".repeat(40) } });
    if (request.url.includes("check-runs")) return Response.json({ check_runs: [{ status: "in_progress" }] });
    return Response.json({ statuses: [{ state: "failure" }] });
  };
  const resolver = createGithubResolver("secret", { fetch: fake as typeof fetch });
  assertEquals(await resolver.resolve(["KodaAllison/koder#22", "KodaAllison/koder#22", "evil/repo#1"]), {
    "KodaAllison/koder#22": { state: "merged", ci: "failing", mergeable: "conflicting" },
  });
  assertEquals(requests.length, 3);
  assert(requests.every((request) => request.headers.get("Authorization") === "Bearer secret"));
});

Deno.test("resolver dedupes inflight, honors fresh TTL, and serves stale on error", async () => {
  let clock = 0; let calls = 0; let fail = false;
  const fake = async () => { calls++; if (fail) throw new Error("offline"); return Response.json({ state: "open", merged: false, mergeable: null, head: { sha: null } }); };
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, now: () => clock, freshMs: 60, staleMs: 300 });
  const [a, b] = await Promise.all([resolver.resolve(["KodaAllison/koder#1"]), resolver.resolve(["KodaAllison/koder#1"])]);
  assertEquals(a, b); assertEquals(calls, 1);
  clock = 50; await resolver.resolve(["KodaAllison/koder#1"]); assertEquals(calls, 1);
  clock = 70; fail = true;
  assertEquals((await resolver.resolve(["KodaAllison/koder#1"]))["KodaAllison/koder#1"].state, "open");
});

Deno.test("resolver evicts least-recently-used entries and retries short rate limits", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return new Response("limited", { status: 429, headers: { "Retry-After": "0.001" } });
    return Response.json({ state: "open", merged: false, mergeable: true, head: { sha: null } });
  };
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, maxEntries: 1 });
  await resolver.resolve(["KodaAllison/koder#1"]);
  assertEquals(calls, 2);
  await resolver.resolve(["KodaAllison/koder#2"]);
  await resolver.resolve(["KodaAllison/koder#1"]);
  assertEquals(calls, 4);
});
