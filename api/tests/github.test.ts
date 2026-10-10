/* Unit tests for the PR status resolver (src/github.ts), ported one for one
 * from server/github.deno.ts: Deno.test -> node:test, @std/assert ->
 * node:assert/strict. The fake fetches answer with Response.json, which Node
 * has as Deno does. */

import assert from "node:assert/strict";
import test from "node:test";
import { createGithubResolver, parsePullRef } from "../src/github.ts";

test("strict parser accepts only webhook-allowlisted canonical refs", () => {
  assert.deepEqual(parsePullRef("KodaAllison/koder#22"), { repo: "KodaAllison/koder", number: 22, key: "KodaAllison/koder#22" });
  for (const value of ["evil/repo#1", "KodaAllison/koder#0", "KodaAllison/koder#01", " KodaAllison/koder#1", null]) assert.deepEqual(parsePullRef(value), null);
});

test("resolver maps PR and CI with failure precedence and bearer auth", async () => {
  const requests: Request[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request);
    if (request.url.includes("/pulls/")) return Response.json({ state: "closed", merged: true, mergeable: false, head: { sha: "a".repeat(40) } });
    if (request.url.includes("check-runs")) return Response.json({ check_runs: [{ status: "in_progress" }] });
    return Response.json({ statuses: [{ state: "failure" }] });
  };
  const resolver = createGithubResolver("secret", { fetch: fake as typeof fetch });
  assert.deepEqual(await resolver.resolve(["KodaAllison/koder#22", "KodaAllison/koder#22", "evil/repo#1"]), {
    "KodaAllison/koder#22": { state: "merged", ci: "failing", mergeable: "conflicting" },
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.headers.get("Authorization") === "Bearer secret"));
});

test("resolver dedupes inflight, honors fresh TTL, and serves stale on error", async () => {
  let clock = 0; let calls = 0; let fail = false;
  const fake = async () => { calls++; if (fail) throw new Error("offline"); return Response.json({ state: "open", merged: false, mergeable: null, head: { sha: null } }); };
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, now: () => clock, freshMs: 60, staleMs: 300 });
  const [a, b] = await Promise.all([resolver.resolve(["KodaAllison/koder#1"]), resolver.resolve(["KodaAllison/koder#1"])]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  clock = 50; await resolver.resolve(["KodaAllison/koder#1"]); assert.equal(calls, 1);
  clock = 70; fail = true;
  assert.equal((await resolver.resolve(["KodaAllison/koder#1"]))["KodaAllison/koder#1"].state, "open");
});

test("resolver evicts least-recently-used entries", async () => {
  let calls = 0;
  const fake = async () => (calls++, Response.json({ state: "open", merged: false, mergeable: true, head: { sha: null } }));
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, maxEntries: 1 });
  await resolver.resolve(["KodaAllison/koder#1"]);
  assert.equal(calls, 1);
  await resolver.resolve(["KodaAllison/koder#2"]);
  await resolver.resolve(["KodaAllison/koder#1"]);
  assert.equal(calls, 3);
});

test("resolver blocks subsequent requests until a long rate limit expires", async () => {
  let clock = 1_000; let calls = 0;
  const fake = async () => (calls++, new Response("limited", { status: 429, headers: { "Retry-After": "120" } }));
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, now: () => clock });
  assert.deepEqual(await resolver.resolve(["KodaAllison/koder#1"]), {});
  assert.deepEqual(await resolver.resolve(["KodaAllison/koder#2"]), {});
  assert.equal(calls, 1);
  clock += 120_001;
  await resolver.resolve(["KodaAllison/koder#2"]);
  assert.equal(calls, 2);
});

test("queued requests observe a rate limit before reaching GitHub", async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return new Response("limited", { status: 403, headers: { "X-RateLimit-Reset": "200" } });
  };
  const resolver = createGithubResolver("token", { fetch: fake as typeof fetch, now: () => 100_000, concurrency: 1 });
  assert.deepEqual(await resolver.resolve(["KodaAllison/koder#5", "KodaAllison/koder#6"]), {});
  assert.equal(calls, 1);
});

test("stale checks fail and combined top-level status participates in precedence", async () => {
  const responses = [
    Response.json({ state: "open", merged: false, mergeable: true, head: { sha: "a".repeat(40) } }),
    Response.json({ check_runs: [{ status: "completed", conclusion: "stale" }, { status: "in_progress" }] }),
    Response.json({ state: "success", statuses: [] }),
  ];
  const resolver = createGithubResolver("token", { fetch: (async () => responses.shift()!) as typeof fetch });
  assert.equal((await resolver.resolve(["KodaAllison/koder#3"]))["KodaAllison/koder#3"].ci, "failing");

  const topLevel = [
    Response.json({ state: "open", merged: false, mergeable: true, head: { sha: "b".repeat(40) } }),
    Response.json({ check_runs: [] }), Response.json({ state: "pending", statuses: [] }),
  ];
  const pending = createGithubResolver("token", { fetch: (async () => topLevel.shift()!) as typeof fetch });
  assert.equal((await pending.resolve(["KodaAllison/koder#4"]))["KodaAllison/koder#4"].ci, "pending");
});
