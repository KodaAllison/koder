/* The server's contract suite. It spawns the real main.ts and drives it only
 * over HTTP, so it doesn't know or care which Store backs it: KODER_STORE
 * (default "kv") is passed straight through to the server, and the same steps
 * are meant to pass against every backend. The few steps that pin a
 * backend-specific limit (KV's 64KB value cap) say so and only run there. */

import assert from "node:assert/strict";
import { serialize } from "node:v8";
import { nextWebhookRevision } from "./workflow.ts";

const STORE = Deno.env.get("KODER_STORE") || "kv";
const TOKEN = "webhook-test-token";
const SECRET = "webhook-test-secret";
let deliverySequence = 1;

function freshDelivery(): string {
  return `00000000-0000-4000-8000-${
    (deliverySequence++).toString(16).padStart(12, "0")
  }`;
}

type Card = {
  id: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project: string | null;
  pr?: string;
  prRev?: number;
};

type Doc = {
  rev: number;
  updatedAt: string | null;
  board: {
    projects: Record<string, Card[]>;
    life: Record<string, Card[]>;
    lifeMeta: Record<string, unknown>;
  };
};

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `sha256=${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

async function waitForServer(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/state`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(200),
      });
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

async function getState(baseUrl: string, path = "/state"): Promise<Doc> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  return await response.json() as Doc;
}

async function seedBoard(
  baseUrl: string,
  projects: Record<string, Card[]>,
): Promise<Doc> {
  // Tests deliberately reset through the public sync seam. Delete old IDs in
  // one revision first so server-owned workflow metadata cannot bleed between
  // otherwise independent scenarios or be forged by the next PUT.
  let current = await getState(baseUrl);
  let response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baseRev: current.rev,
      board: { projects: {}, life: {}, lifeMeta: {} },
    }),
  });
  assert.equal(response.status, 200);
  current = await getState(baseUrl);
  response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baseRev: current.rev,
      board: { projects, life: {}, lifeMeta: {} },
    }),
  });
  assert.equal(response.status, 200);
  return await getState(baseUrl);
}

async function putBoard(baseUrl: string, board: Doc["board"]): Promise<Doc> {
  const current = await getState(baseUrl);
  const response = await fetch(`${baseUrl}/state`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ baseRev: current.rev, board }),
  });
  assert.equal(response.status, 200);
  return await getState(baseUrl);
}

async function postWebhook(
  baseUrl: string,
  payload: unknown,
  options: {
    signature?:
      | "valid"
      | "invalid"
      | "uppercaseHex"
      | "uppercasePrefix"
      | "short"
      | "missing";
    event?: string;
    bearer?: boolean;
    delivery?: string | null;
  } = {},
): Promise<Response> {
  const normalized = structuredClone(payload) as Record<string, unknown>;
  const repository = normalized?.repository as
    | Record<string, unknown>
    | undefined;
  const pullRequest = normalized?.pull_request as
    | Record<string, unknown>
    | undefined;
  if (
    typeof repository?.full_name === "string" && pullRequest &&
    !("head" in pullRequest)
  ) {
    pullRequest.head = { repo: { full_name: repository.full_name } };
  }
  const body = JSON.stringify(normalized);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Event": options.event ?? "pull_request",
  });
  const delivery = options.delivery === undefined
    ? freshDelivery()
    : options.delivery;
  if (delivery !== null) headers.set("X-GitHub-Delivery", delivery);
  if (options.signature !== "missing") {
    const signed = await signature(body);
    const digest = signed.slice("sha256=".length);
    headers.set(
      "X-Hub-Signature-256",
      options.signature === "invalid"
        ? `sha256=${"0".repeat(64)}`
        : options.signature === "uppercaseHex"
        ? `sha256=${digest.toUpperCase()}`
        : options.signature === "uppercasePrefix"
        ? `SHA256=${digest}`
        : options.signature === "short"
        ? `sha256=${digest.slice(0, 63)}`
        : signed,
    );
  }
  if (options.bearer) headers.set("Authorization", `Bearer ${TOKEN}`);
  return await fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers,
    body,
  });
}

async function postRawWebhook(
  baseUrl: string,
  body: BodyInit,
  delivery = freshDelivery(),
): Promise<Response> {
  return await fetch(`${baseUrl}/webhooks/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": delivery,
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  });
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function postChunkedOversizedWebhook(baseUrl: string): Promise<number> {
  const url = new URL(baseUrl);
  const conn = await Deno.connect({
    hostname: url.hostname,
    port: Number(url.port),
  });
  const encoder = new TextEncoder();
  try {
    await writeAll(
      conn,
      encoder.encode([
        "POST /webhooks/github HTTP/1.1",
        `Host: ${url.host}`,
        "Content-Type: application/json",
        `X-GitHub-Delivery: ${freshDelivery()}`,
        "X-GitHub-Event: pull_request",
        `X-Hub-Signature-256: sha256=${"0".repeat(64)}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "",
      ].join("\r\n")),
    );
    try {
      for (const chunk of [new Uint8Array(200_000), new Uint8Array(100_000)]) {
        await writeAll(
          conn,
          encoder.encode(`${chunk.length.toString(16)}\r\n`),
        );
        await writeAll(conn, chunk);
        await writeAll(conn, encoder.encode("\r\n"));
      }
      await writeAll(conn, encoder.encode("0\r\n\r\n"));
    } catch {
      // The server may close its receive side as soon as it emits the 413.
    }

    const response = new Uint8Array(4096);
    const size = await conn.read(response);
    assert.notEqual(size, null);
    const statusLine =
      new TextDecoder().decode(response.subarray(0, size ?? 0)).split(
        "\r\n",
        1,
      )[0];
    return Number(statusLine.split(" ")[1]);
  } finally {
    conn.close();
  }
}

function card(
  id = "t_ticket_1a2b",
  project = "koder",
  extra: Partial<Card> = {},
): Card {
  return {
    id,
    title: "Webhook ticket",
    note: "",
    priority: "med",
    created: 1,
    project,
    ...extra,
  };
}

// Deno KV's per-value cap, in bytes of the V8 serialization it stores (which
// node:v8 serialize() reproduces exactly). The board is one value. Steps
// that depend on this run only when KODER_STORE is "kv" (see kvOnly below).
const STORE_VALUE_MAX = 65_536;

/* Seed a board whose stored doc sits `headroom` bytes (±4) under the cap: a
 * filler card padded to size plus a small KODER-5A11 card to act on. The
 * filler note starts with an em dash, so V8 stores it as two-byte chars. */
async function seedNearFullBoard(baseUrl: string, headroom: number): Promise<Doc> {
  const projects = (padding: number) => ({
    todo: [
      card("t_filler_f111", "koder", { note: "—" + "a".repeat(padding) }),
      card("t_small_5a11"),
    ],
    doing: [],
  });
  const first = await seedBoard(baseUrl, projects(1000));
  const grow = Math.floor((STORE_VALUE_MAX - headroom - serialize(first).byteLength) / 2);
  const doc = await seedBoard(baseUrl, projects(1000 + grow));
  const left = STORE_VALUE_MAX - serialize(doc).byteLength;
  assert.ok(Math.abs(left - headroom) <= 4, `expected ~${headroom} bytes free, got ${left}`);
  return doc;
}

function assertStoreFullBody(body: { error: string; size: number; limit: number }) {
  assert.match(
    body.error,
    /^board store full: \d+ of 65536 bytes — archive done tickets to free space$/,
  );
  assert.equal(body.limit, STORE_VALUE_MAX);
  assert.ok(body.size > STORE_VALUE_MAX);
}

async function patchTicket(
  baseUrl: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${baseUrl}/tickets/${id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });
}

const mainUrl = new URL("./main.ts", import.meta.url);
const SERVER_ARGS = [
  "run",
  "--unstable-kv",
  "--allow-env",
  "--allow-net",
  "--allow-read",
  "--allow-write",
  Deno.build.os === "windows"
    ? decodeURIComponent(mainUrl.pathname.slice(1))
    : decodeURIComponent(mainUrl.pathname),
];

Deno.test("KODER_STORE fails fast at startup unless the backend exists", async () => {
  for (
    const [backend, message] of [
      ["pg", 'KODER_STORE=pg is not implemented yet; only "kv" is available'],
      ["dual", 'KODER_STORE=dual is not implemented yet; only "kv" is available'],
      ["mongo", 'unknown KODER_STORE "mongo"; expected "kv", "pg" or "dual"'],
    ]
  ) {
    const dir = await Deno.makeTempDir({ prefix: "koder-store-select-test-" });
    try {
      const { code, stderr } = await new Deno.Command(Deno.execPath(), {
        args: SERVER_ARGS,
        cwd: dir,
        env: {
          KODER_TOKEN: TOKEN,
          KODER_STORE: backend,
          KODER_KV_PATH: `${dir}/board.sqlite3`,
          PORT: "0",
        },
        stdout: "null",
        stderr: "piped",
      }).output();
      assert.notEqual(code, 0, backend);
      assert.ok(new TextDecoder().decode(stderr).includes(message), backend);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test({
  name: `GitHub PR webhook (KODER_STORE=${STORE})`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const kvDir = await Deno.makeTempDir({ prefix: "koder-webhook-test-" });
    const server = new Deno.Command(Deno.execPath(), {
      args: SERVER_ARGS,
      cwd: kvDir,
      env: {
        KODER_TOKEN: TOKEN,
        KODER_WEBHOOK_SECRET: SECRET,
        KODER_STORE: STORE,
        KODER_KV_PATH: `${kvDir}/board.sqlite3`,
        PORT: String(port),
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    const baseUrl = `http://127.0.0.1:${port}`;
    // A step that pins KV's 64KB value cap: skipped (reported as ignored)
    // against any other backend, whose capacity is its own.
    const kvOnly = (name: string, fn: () => Promise<void>) =>
      t.step({ name, fn, ignore: STORE !== "kv" });

    try {
      await waitForServer(baseUrl);

      await t.step("GET /state sends an ETag and answers 304 to a matching If-None-Match", async () => {
        const auth = { Authorization: `Bearer ${TOKEN}` };
        const seeded = await seedBoard(baseUrl, { doing: [card()] });
        const etag = `"${seeded.rev}"`;

        const first = await fetch(`${baseUrl}/state`, { headers: auth });
        assert.equal(first.status, 200);
        assert.equal(first.headers.get("etag"), etag);
        assert.equal(first.headers.get("cache-control"), "no-cache");
        assert.equal(first.headers.get("access-control-expose-headers"), "ETag");
        assert.equal((await first.json() as Doc).rev, seeded.rev);

        const cond = (inm: string, path = "/state") =>
          fetch(`${baseUrl}${path}`, { headers: { ...auth, "If-None-Match": inm } });
        for (const inm of [etag, `W/${etag}`, `"0", ${etag}`, "*"]) {
          const hit = await cond(inm);
          assert.equal(hit.status, 304, `If-None-Match: ${inm}`);
          assert.equal(hit.headers.get("etag"), etag);
          assert.equal(hit.headers.get("cache-control"), "no-cache");
          assert.equal(hit.headers.get("vary"), "Authorization");
          assert.ok(hit.headers.get("access-control-allow-origin"));
          assert.equal(await hit.text(), "");
        }
        const miss = await cond(`"${seeded.rev + 100}"`);
        assert.equal(miss.status, 200);
        assert.equal((await miss.json() as Doc).rev, seeded.rev);

        // A conditional request still needs the bearer token.
        const noAuth = await fetch(`${baseUrl}/state`, { headers: { "If-None-Match": etag } });
        assert.equal(noAuth.status, 401);

        // Snapshots carry the same validator.
        const snap = await fetch(`${baseUrl}/state?rev=${seeded.rev}`, { headers: auth });
        assert.equal(snap.status, 200);
        assert.equal(snap.headers.get("etag"), etag);
        await snap.body?.cancel();
        assert.equal((await cond(etag, `/state?rev=${seeded.rev}`)).status, 304);

        // After a write the old ETag no longer matches: 200 with the new board.
        const put = await fetch(`${baseUrl}/state`, {
          method: "PUT",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            baseRev: seeded.rev,
            board: { ...seeded.board, projects: { doing: [card(undefined, undefined, { title: "changed" })] } },
          }),
        });
        assert.equal(put.status, 200);
        const { rev } = await put.json() as { rev: number };
        const after = await cond(etag);
        assert.equal(after.status, 200);
        assert.equal(after.headers.get("etag"), `"${rev}"`);
        const afterDoc = await after.json() as Doc;
        assert.equal(afterDoc.rev, rev);
        assert.equal(afterDoc.board.projects.doing[0].title, "changed");
        assert.equal((await cond(`"${rev}"`)).status, 304);

        // Ticket writes bump rev too: POST /tickets invalidates the new ETag.
        const created = await fetch(`${baseUrl}/tickets`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "etag ticket", project: "koder" }),
        });
        assert.equal(created.status, 201);
        const viaTicket = await cond(`"${rev}"`);
        assert.equal(viaTicket.status, 200);
        const ticketDoc = await viaTicket.json() as Doc;
        assert.equal(ticketDoc.rev, rev + 1);
        assert.equal(viaTicket.headers.get("etag"), `"${rev + 1}"`);
        assert.ok(Object.values(ticketDoc.board.projects).flat().some((c) => c.title === "etag ticket"));
      });

      await t.step("PR status route enforces read auth and stays read-only", async () => {
        const empty = await seedBoard(baseUrl, {});
        const unauthorized = await fetch(`${baseUrl}/pr-status`);
        assert.equal(unauthorized.status, 401);
        const wrongMethod = await fetch(`${baseUrl}/pr-status`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(wrongMethod.status, 405);
        const noRefs = await fetch(`${baseUrl}/pr-status`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(noRefs.status, 200);
        assert.deepEqual(await noRefs.json(), {});
        assert.equal((await getState(baseUrl)).rev, empty.rev);

        await seedBoard(baseUrl, { doing: [card()] });
        const linked = await postWebhook(baseUrl, {
          action: "opened",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 22,
            title: "KODER-1A2B status route",
            body: null,
            merged: false,
          },
        });
        assert.equal(linked.status, 200);
        const beforeStatus = await getState(baseUrl);
        const unavailable = await fetch(`${baseUrl}/pr-status`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { error: "PR status temporarily unavailable" });
        const afterStatus = await getState(baseUrl);
        assert.equal(afterStatus.rev, beforeStatus.rev);
        assert.deepEqual(afterStatus.board, beforeStatus.board);
      });

      await t.step(
        "missing and invalid HMACs are rejected with no bearer fallback",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B Auto-move cards from PR events",
              body: null,
              merged: false,
            },
          };
          const missing = await postWebhook(baseUrl, payload, {
            signature: "missing",
            bearer: true,
          });
          const invalid = await postWebhook(baseUrl, payload, {
            signature: "invalid",
            bearer: true,
          });

          assert.equal(missing.status, 401);
          assert.equal(invalid.status, 401);
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step("a valid GitHub delivery ID is mandatory", async () => {
        const before = await seedBoard(baseUrl, { doing: [card()] });
        const payload = {
          action: "opened",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 14,
            title: "KODER-1A2B missing delivery",
            body: null,
            merged: false,
          },
        };
        const missing = await postWebhook(baseUrl, payload, { delivery: null });
        const malformed = await postWebhook(baseUrl, payload, {
          delivery: "not-a-guid",
        });

        assert.equal(missing.status, 400);
        assert.equal(malformed.status, 400);
        assert.equal((await getState(baseUrl)).rev, before.rev);
      });

      await t.step(
        "signature grammar accepts lowercase sha256 hex only",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B uppercase signature",
              body: null,
              merged: false,
            },
          };

          for (
            const signature of [
              "uppercaseHex",
              "uppercasePrefix",
              "short",
            ] as const
          ) {
            assert.equal(
              (await postWebhook(baseUrl, payload, { signature })).status,
              401,
              signature,
            );
          }
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step(
        "oversized fixed and streamed bodies are rejected with 413",
        async () => {
          const fixed = await postRawWebhook(baseUrl, "x".repeat(300_000));
          assert.equal(fixed.status, 413);

          assert.equal(await postChunkedOversizedWebhook(baseUrl), 413);
        },
      );

      await t.step(
        "only the four active repositories are trusted",
        async () => {
          for (
            const repo of [
              "KodaAllison/koder",
              "KodaAllison/crook-community",
              "KodaAllison/holitrackr",
              "KodaAllison/portfolio-website",
            ]
          ) {
            await seedBoard(baseUrl, { todo: [card()] });
            const response = await postWebhook(baseUrl, {
              action: "opened",
              repository: { full_name: repo },
              pull_request: {
                number: 7,
                title: "KODER-1A2B trusted repository",
                body: null,
                merged: false,
              },
            });
            assert.equal(response.status, 200, repo);
            const state = await getState(baseUrl);
            assert.equal(state.board.projects.review[0].pr, `${repo}#7`);
          }

          const before = await seedBoard(baseUrl, { todo: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/inactive-repo" },
            pull_request: {
              number: 7,
              title: "KODER-1A2B untrusted repository",
              body: null,
              merged: false,
            },
          });
          assert.equal(response.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await t.step(
        "repository identity requires exact canonical casing and deduplicates variants",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const delivery = freshDelivery();
          const variant = {
            action: "opened",
            repository: { full_name: "kodaallison/koder" },
            pull_request: {
              number: 8,
              title: "KODER-1A2B casing must be canonical",
              body: null,
              merged: false,
              head: { repo: { full_name: "kodaallison/koder" } },
            },
          };
          assert.equal(
            (await postWebhook(baseUrl, variant, { delivery })).status,
            202,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);

          const canonical = structuredClone(variant);
          canonical.repository.full_name = "KodaAllison/koder";
          canonical.pull_request.head.repo.full_name = "KodaAllison/koder";
          const replay = await postWebhook(baseUrl, canonical, { delivery });
          assert.equal(
            (await replay.json() as { redelivered?: boolean }).redelivered,
            true,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);
        },
      );

      await t.step(
        "full-board PUT cannot forge, strip, or replace workflow metadata",
        async () => {
          const forged = card("t_ticket_1a2b", "koder", {
            pr: "KodaAllison/koder#40",
            prRev: 1,
          });
          let state = await seedBoard(baseUrl, { doing: [forged] });
          assert.equal(state.board.projects.doing[0].pr, undefined);
          assert.equal(state.board.projects.doing[0].prRev, undefined);

          const opened = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 41,
              title: "KODER-1A2B establish server metadata",
              body: null,
              merged: false,
            },
          });
          assert.equal(opened.status, 200);
          state = await getState(baseUrl);
          assert.equal(state.board.projects.review[0].prRev, 1);

          const stripped = structuredClone(state.board);
          delete stripped.projects.review[0].pr;
          delete stripped.projects.review[0].prRev;
          stripped.projects.review[0].title = "browser edit without metadata";
          state = await putBoard(baseUrl, stripped);
          assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
          assert.equal(state.board.projects.review[0].prRev, 1);

          const forgedEqual = structuredClone(state.board);
          forgedEqual.projects.review[0].pr = "KodaAllison/koder#999";
          forgedEqual.projects.review[0].prRev = 1;
          state = await putBoard(baseUrl, forgedEqual);
          assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
          assert.equal(state.board.projects.review[0].prRev, 1);
        },
      );

      await t.step(
        "webhook markers increment safely and recover from legacy values",
        () => {
          assert.equal(nextWebhookRevision(0), 1);
          assert.equal(nextWebhookRevision(41), 42);
          assert.equal(nextWebhookRevision(Number.MAX_SAFE_INTEGER), 1);
          assert.equal(nextWebhookRevision(Number.MAX_SAFE_INTEGER + 1), 1);
          assert.equal(nextWebhookRevision(-1), 1);
          assert.equal(nextWebhookRevision("41"), 1);
        },
      );

      await t.step(
        "fork pull requests cannot mutate and their delivery is deduplicated",
        async () => {
          const before = await seedBoard(baseUrl, { doing: [card()] });
          const delivery = freshDelivery();
          const payload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 22,
              title: "KODER-1A2B outsider branch",
              body: null,
              merged: false,
              head: { repo: { full_name: "outsider/koder" } },
            },
          };
          const first = await postWebhook(baseUrl, payload, { delivery });
          assert.equal(first.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const replay = await postWebhook(baseUrl, {
            ...payload,
            pull_request: {
              ...payload.pull_request,
              head: { repo: { full_name: "KodaAllison/koder" } },
            },
          }, { delivery });
          assert.equal(
            (await replay.json() as { redelivered?: boolean }).redelivered,
            true,
          );
          assert.deepEqual((await getState(baseUrl)).board, before.board);
        },
      );

      await t.step("untrusted events and actions are ignored", async () => {
        const before = await seedBoard(baseUrl, { todo: [card()] });
        const payload = {
          action: "synchronize",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 7,
            title: "KODER-1A2B ignored event",
            body: null,
            merged: false,
          },
        };
        assert.equal((await postWebhook(baseUrl, payload)).status, 202);
        assert.equal(
          (await postWebhook(baseUrl, payload, { event: "issues" })).status,
          202,
        );
        assert.equal((await getState(baseUrl)).rev, before.rev);
      });

      await t.step(
        "every authenticated no-op delivery is permanently deduplicated",
        async () => {
          const mutatingPayload = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B mutate if delivery was not recorded",
              body: null,
              merged: false,
            },
          };
          const cases: Array<{
            name: string;
            projects: Record<string, Card[]>;
            payload: unknown;
            options: { event?: string };
            status: number;
            replay?: unknown;
          }> = [
            {
              name: "unsupported event",
              projects: { doing: [card()] },
              payload: mutatingPayload,
              options: { event: "issues" },
              status: 202,
            },
            {
              name: "unsupported action",
              projects: { doing: [card()] },
              payload: { ...mutatingPayload, action: "synchronize" },
              options: {},
              status: 202,
            },
            {
              name: "disallowed repository",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                repository: { full_name: "KodaAllison/inactive-repo" },
              },
              options: {},
              status: 202,
            },
            {
              name: "no matching ref",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                pull_request: {
                  ...mutatingPayload.pull_request,
                  title: "KODER-FFFF no match",
                },
              },
              options: {},
              status: 202,
            },
            {
              name: "ambiguous refs",
              projects: { doing: [card(), card("t_ticket_3c4d")] },
              payload: {
                ...mutatingPayload,
                pull_request: {
                  ...mutatingPayload.pull_request,
                  title: "KODER-1A2B and KODER-3C4D",
                },
              },
              options: {},
              status: 409,
            },
            {
              name: "closed without merge",
              projects: { doing: [card()] },
              payload: {
                ...mutatingPayload,
                action: "closed",
                pull_request: {
                  ...mutatingPayload.pull_request,
                  merged: false,
                },
              },
              options: {},
              status: 202,
            },
            {
              name: "unchanged transition",
              projects: {
                review: [
                  card("t_ticket_1a2b", "koder", {
                    pr: "KodaAllison/koder#14",
                  }),
                ],
              },
              payload: mutatingPayload,
              options: {},
              status: 200,
              replay: {
                ...mutatingPayload,
                action: "closed",
                pull_request: { ...mutatingPayload.pull_request, merged: true },
              },
            },
          ];

          for (const scenario of cases) {
            let before = await seedBoard(baseUrl, scenario.projects);
            if (scenario.name === "unchanged transition") {
              assert.equal(
                (await postWebhook(baseUrl, mutatingPayload)).status,
                200,
              );
              before = await getState(baseUrl);
            }
            const delivery = freshDelivery();
            const first = await postWebhook(baseUrl, scenario.payload, {
              ...scenario.options,
              delivery,
            });
            assert.equal(first.status, scenario.status, scenario.name);
            assert.equal(
              (await getState(baseUrl)).rev,
              before.rev,
              scenario.name,
            );

            const replay = await postWebhook(
              baseUrl,
              scenario.replay ?? mutatingPayload,
              { delivery },
            );
            assert.equal(replay.status, 200, `${scenario.name} replay`);
            const replayBody = await replay.json() as { redelivered?: boolean };
            assert.equal(
              replayBody.redelivered,
              true,
              `${scenario.name} replay`,
            );
            const after = await getState(baseUrl);
            assert.equal(after.rev, before.rev, `${scenario.name} replay`);
            assert.deepEqual(
              after.board,
              before.board,
              `${scenario.name} replay`,
            );
          }
        },
      );

      await t.step(
        "opened moves a visible-ref ticket to review and stores the PR",
        async () => {
          await seedBoard(baseUrl, { doing: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 14,
              title: "KODER-1A2B Auto-move cards from PR events",
              body: "Implements the webhook.",
              merged: false,
            },
          });

          assert.equal(response.status, 200);
          const state = await getState(baseUrl);
          assert.equal(state.board.projects.doing.length, 0);
          assert.equal(state.board.projects.review[0].id, "t_ticket_1a2b");
          assert.equal(
            state.board.projects.review[0].pr,
            "KodaAllison/koder#14",
          );
        },
      );

      await t.step(
        "reopened finds a ref in the body and moves the ticket to review",
        async () => {
          await seedBoard(baseUrl, { todo: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "reopened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 15,
              title: "Reopen webhook work",
              body: "Ticket: KODER-1A2B",
              merged: false,
            },
          });

          assert.equal(response.status, 200);
          const state = await getState(baseUrl);
          assert.equal(state.board.projects.todo.length, 0);
          assert.equal(state.board.projects.review[0].id, "t_ticket_1a2b");
          assert.equal(
            state.board.projects.review[0].pr,
            "KodaAllison/koder#15",
          );
        },
      );

      await t.step("closed and merged moves the ticket to done", async () => {
        await seedBoard(baseUrl, { review: [card()] });
        const response = await postWebhook(baseUrl, {
          action: "closed",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: {
            number: 16,
            title: "Finish KODER-1A2B",
            body: null,
            merged: true,
          },
        });

        assert.equal(response.status, 200);
        const state = await getState(baseUrl);
        assert.equal(state.board.projects.review.length, 0);
        assert.equal(state.board.projects.done[0].id, "t_ticket_1a2b");
        assert.equal(state.board.projects.done[0].pr, "KodaAllison/koder#16");
        assert.equal(state.board.projects.done[0].prRev, 1);
      });

      await t.step(
        "done is terminal for delayed or replacement open events",
        async () => {
          await seedBoard(baseUrl, {
            review: [card()],
          });
          const merged = await postWebhook(baseUrl, {
            action: "closed",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 20,
              title: "Merge KODER-1A2B",
              body: null,
              merged: true,
            },
          });
          assert.equal(merged.status, 200);
          const afterMerged = await getState(baseUrl);

          for (const number of [20, 21]) {
            const delivery = freshDelivery();
            const delayed = await postWebhook(baseUrl, {
              action: number === 20 ? "opened" : "reopened",
              repository: { full_name: "KodaAllison/koder" },
              pull_request: {
                number,
                title: "KODER-1A2B must stay done",
                body: null,
                merged: false,
              },
            }, { delivery });
            assert.equal(delayed.status, 202);
            assert.deepEqual(
              (await getState(baseUrl)).board,
              afterMerged.board,
            );

            const replay = await postWebhook(baseUrl, {
              action: "closed",
              repository: { full_name: "KodaAllison/koder" },
              pull_request: {
                number: 21,
                title: "KODER-1A2B replay must not mutate",
                body: null,
                merged: true,
              },
            }, { delivery });
            assert.equal(
              (await replay.json() as { redelivered?: boolean }).redelivered,
              true,
            );
            assert.equal((await getState(baseUrl)).rev, afterMerged.rev);
          }
        },
      );

      await t.step(
        "only a newer same-repo PR can replace an active PR association",
        async () => {
          await seedBoard(baseUrl, { review: [card()] });
          assert.equal((await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 30,
              title: "Current KODER-1A2B",
              body: null,
              merged: false,
            },
          })).status, 200);
          const before = await getState(baseUrl);
          const stale = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 29,
              title: "Old KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(stale.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const crossRepo = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/holitrackr" },
            pull_request: {
              number: 99,
              title: "Cross-repo KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(crossRepo.status, 202);
          assert.equal((await getState(baseUrl)).rev, before.rev);

          const replacement = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 31,
              title: "Replacement KODER-1A2B",
              body: null,
              merged: false,
            },
          });
          assert.equal(replacement.status, 200);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev + 1);
          assert.equal(
            after.board.projects.review[0].pr,
            "KodaAllison/koder#31",
          );
        },
      );

      await t.step(
        "closed without merge is a board-revision no-op",
        async () => {
          const before = await seedBoard(baseUrl, { review: [card()] });
          const response = await postWebhook(baseUrl, {
            action: "closed",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 17,
              title: "Abandon KODER-1A2B",
              body: null,
              merged: false,
            },
          });

          assert.equal(response.status, 202);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "an ambiguous visible ref is refused without changing the board",
        async () => {
          const before = await seedBoard(baseUrl, {
            todo: [card("t_first_abcd"), card("t_second_abcd")],
          });
          const response = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 18,
              title: "KODER-ABCD ambiguous ticket",
              body: null,
              merged: false,
            },
          });

          assert.equal(response.status, 409);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "DELETE removes one resolved ticket and records a recoverable revision",
        async () => {
          await seedBoard(baseUrl, {
            doing: [card(), card("t_keep_beef")],
          });
          const workflow = await postWebhook(baseUrl, {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 20,
              title: "Preserve KODER-BEEF while deleting another ticket",
              body: null,
              merged: false,
            },
          });
          assert.equal(workflow.status, 200);
          const before = await getState(baseUrl);
          const response = await fetch(`${baseUrl}/tickets/KODER-1A2B`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });

          assert.equal(response.status, 200);
          const result = await response.json() as {
            card: Card;
            ref: string;
            column: string;
            rev: number;
            board: Doc["board"];
          };
          assert.equal(result.card.id, "t_ticket_1a2b");
          assert.equal(result.ref, "KODER-1A2B");
          assert.equal(result.column, "doing");
          assert.equal(result.rev, before.rev + 1);

          const after = await getState(baseUrl);
          assert.equal(after.rev, result.rev);
          assert.deepEqual(result.board, after.board);
          assert.deepEqual(after.board.projects.doing, []);
          assert.equal(after.board.projects.review[0].id, "t_keep_beef");
          assert.equal(after.board.projects.review[0].pr, "KodaAllison/koder#20");
          assert.equal(after.board.projects.review[0].prRev, 1);
          assert.deepEqual(
            (await getState(baseUrl, `/state?rev=${before.rev}`)).board,
            before.board,
          );
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${result.rev}`),
            after,
          );

          const retry = await fetch(`${baseUrl}/tickets/t_ticket_1a2b`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(retry.status, 404);
          assert.equal((await getState(baseUrl)).rev, result.rev);

          const restored = await fetch(`${baseUrl}/state/restore`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ rev: before.rev }),
          });
          assert.equal(restored.status, 200);
          const restoredState = await getState(baseUrl);
          assert.equal(restoredState.rev, result.rev + 1);
          assert.equal(restoredState.board.projects.doing[0].id, "t_ticket_1a2b");
          assert.equal(restoredState.board.projects.review[0].pr, "KodaAllison/koder#20");
        },
      );

      const openPr = (number: number, ref: string) =>
        postWebhook(baseUrl, {
          action: "opened",
          repository: { full_name: "KodaAllison/koder" },
          pull_request: { number, title: `${ref} PR ${number}`, body: null, merged: false },
        });
      const restoreRev = async (rev: number) => {
        const response = await fetch(`${baseUrl}/state/restore`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ rev }),
        });
        assert.equal(response.status, 200);
        return await response.json() as { rev: number; restoredFrom: number };
      };

      await t.step(
        "restore keeps the current PR link when the snapshot predates it",
        async () => {
          // Snapshot with the old text and no link at all.
          const snapshot = await seedBoard(baseUrl, {
            todo: [card("t_ticket_1a2b", "koder", { title: "Old text" })],
          });
          assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
          const linked = await getState(baseUrl);
          const card1 = linked.board.projects.review[0];
          assert.equal(card1.pr, "KodaAllison/koder#20");
          assert.equal(card1.prRev, 1);
          // Edit the text through the sync seam (the PUT keeps the link).
          const edited = structuredClone(linked.board);
          edited.projects.review[0].title = "New text";
          const afterEdit = await putBoard(baseUrl, edited);

          const result = await restoreRev(snapshot.rev);
          assert.equal(result.restoredFrom, snapshot.rev);
          assert.equal(result.rev, afterEdit.rev + 1);
          const restored = await getState(baseUrl);
          assert.equal(restored.rev, result.rev);
          // Text and column come from the snapshot...
          assert.equal(restored.board.projects.todo[0].title, "Old text");
          assert.equal(restored.board.projects.review?.length ?? 0, 0);
          // ...but the link and its revision counter are the current ones.
          assert.equal(restored.board.projects.todo[0].pr, "KodaAllison/koder#20");
          assert.equal(restored.board.projects.todo[0].prRev, 1);
          // It is a snapshotted head rev like any other write.
          assert.deepEqual(await getState(baseUrl, `/state?rev=${result.rev}`), restored);
        },
      );

      await t.step(
        "restore after the PR link changed keeps the newest pr and prRev",
        async () => {
          await seedBoard(baseUrl, { review: [card("t_ticket_1a2b")] });
          assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
          const first = await getState(baseUrl);
          assert.equal(first.board.projects.review[0].prRev, 1);
          assert.equal((await openPr(21, "KODER-1A2B")).status, 200);
          const second = await getState(baseUrl);
          assert.equal(second.board.projects.review[0].pr, "KodaAllison/koder#21");
          assert.equal(second.board.projects.review[0].prRev, 2);

          await restoreRev(first.rev);
          const restored = await getState(baseUrl);
          assert.equal(restored.board.projects.review[0].pr, "KodaAllison/koder#21");
          assert.equal(restored.board.projects.review[0].prRev, 2);
        },
      );

      await t.step(
        "restore matches cards by id across columns and leaves other fields alone",
        async () => {
          const snapshot = await seedBoard(baseUrl, {
            todo: [card("t_ticket_1a2b", "koder", { note: "snapshot note" })],
            doing: [card("t_other_0001", "koder", { title: "Unlinked" })],
          });
          assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
          await restoreRev(snapshot.rev);
          const restored = await getState(baseUrl);
          const linked = restored.board.projects.todo[0];
          assert.equal(linked.note, "snapshot note");
          assert.equal(linked.pr, "KodaAllison/koder#20");
          assert.equal(linked.prRev, 1);
          const other = restored.board.projects.doing[0];
          assert.equal(other.title, "Unlinked");
          assert.equal("pr" in other, false);
          assert.equal("prRev" in other, false);
        },
      );

      await t.step(
        "restore keeps a deleted card's own link, not stripping or forging one",
        async () => {
          await seedBoard(baseUrl, { review: [card("t_ticket_1a2b")] });
          assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
          const withLink = await getState(baseUrl);
          // Delete the card; the current board has no pr/prRev for it at all.
          const deleted = await fetch(`${baseUrl}/tickets/t_ticket_1a2b`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(deleted.status, 200);

          await restoreRev(withLink.rev);
          const restored = await getState(baseUrl);
          // The webhook-written link comes back with the card, unchanged.
          assert.equal(restored.board.projects.review[0].id, "t_ticket_1a2b");
          assert.equal(restored.board.projects.review[0].pr, "KodaAllison/koder#20");
          assert.equal(restored.board.projects.review[0].prRev, 1);
          // The webhook still owns the counter: it continues from there.
          assert.equal((await openPr(22, "KODER-1A2B")).status, 200);
          assert.equal((await getState(baseUrl)).board.projects.review[0].prRev, 2);
        },
      );

      await t.step(
        "a restored deleted card may carry a link older than a later relink",
        async () => {
          await seedBoard(baseUrl, { review: [card("t_ticket_1a2b")] });
          assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
          const first = await getState(baseUrl);
          assert.equal((await openPr(21, "KODER-1A2B")).status, 200);
          const deleted = await fetch(`${baseUrl}/tickets/t_ticket_1a2b`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          assert.equal(deleted.status, 200);

          // Documented behaviour: the orphan returns with the snapshot's #20/1,
          // not the since-deleted #21/2.
          await restoreRev(first.rev);
          const restored = (await getState(baseUrl)).board.projects.review[0];
          assert.equal(restored.pr, "KodaAllison/koder#20");
          assert.equal(restored.prRev, 1);
          // The next event for the newer PR repairs it.
          assert.equal((await openPr(21, "KODER-1A2B")).status, 200);
          const healed = (await getState(baseUrl)).board.projects.review[0];
          assert.equal(healed.pr, "KodaAllison/koder#21");
          assert.equal(healed.prRev, 2);
        },
      );

      await t.step(
        "DELETE refuses missing and ambiguous refs without a revision change",
        async () => {
          const before = await seedBoard(baseUrl, {
            todo: [card("t_first_abcd"), card("t_second_abcd")],
          });
          const missing = await fetch(`${baseUrl}/tickets/KODER-DEAD`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          const ambiguous = await fetch(`${baseUrl}/tickets/KODER-ABCD`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TOKEN}` },
          });

          assert.equal(missing.status, 404);
          assert.equal(ambiguous.status, 409);
          assert.deepEqual(
            (await ambiguous.json() as { ids: string[] }).ids,
            ["t_first_abcd", "t_second_abcd"],
          );
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await t.step(
        "redelivery is idempotent and the changed revision is snapshotted",
        async () => {
          await seedBoard(baseUrl, { doing: [card()] });
          const openedDelivery = freshDelivery();
          const mergedDelivery = freshDelivery();
          const opened = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 19,
              title: "Deliver KODER-1A2B twice",
              body: null,
              merged: false,
            },
          };
          const first = await postWebhook(baseUrl, opened, {
            delivery: openedDelivery,
          });
          assert.equal(first.status, 200);
          const firstBody = await first.json() as {
            updated: boolean;
            rev: number;
          };
          assert.equal(firstBody.updated, true);
          const afterOpened = await getState(baseUrl);
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${firstBody.rev}`),
            afterOpened,
          );

          const merged = await postWebhook(baseUrl, {
            ...opened,
            action: "closed",
            pull_request: { ...opened.pull_request, merged: true },
          }, { delivery: mergedDelivery });
          assert.equal(merged.status, 200);
          const mergedBody = await merged.json() as {
            updated: boolean;
            rev: number;
          };
          assert.equal(mergedBody.updated, true);

          const second = await postWebhook(baseUrl, opened, {
            delivery: openedDelivery,
          });
          assert.equal(second.status, 200);
          const secondBody = await second.json() as {
            updated: boolean;
            redelivered: boolean;
            rev: number;
          };
          assert.equal(secondBody.updated, false);
          assert.equal(secondBody.redelivered, true);
          assert.equal(secondBody.rev, mergedBody.rev);

          const current = await getState(baseUrl);
          assert.equal(current.rev, mergedBody.rev);
          assert.equal(current.board.projects.done[0].id, "t_ticket_1a2b");
          assert.equal(current.board.projects.done[0].prRev, 2);
          assert.deepEqual(
            await getState(baseUrl, `/state?rev=${mergedBody.rev}`),
            current,
          );
        },
      );

      /* ---- Routes the webhook-centred steps above don't reach: archive,
       * revisions, restore/snapshot lookups, and ticket create/edit. Only
       * behaviour every backend must share is asserted; anything that pins
       * KV's limits is kvOnly (below). ---- */
      const call = (method: string, path: string, body?: unknown, raw?: string) =>
        fetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          },
          body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)),
        });
      const errorOf = async (res: Response) => (await res.json() as { error: unknown }).error;
      // The board and rev are exactly as they were: a refused write left no trace.
      const assertUntouched = async (before: Doc) => {
        const after = await getState(baseUrl);
        assert.equal(after.rev, before.rev);
        assert.deepEqual(after.board, before.board);
      };

      type ArchiveRead = { count: number; chunks: number; cards: (Card & { archivedAt?: number })[] };
      const readArchive = async () => {
        const res = await call("GET", "/archive");
        assert.equal(res.status, 200);
        return await res.json() as ArchiveRead;
      };
      const archived = (id: string, archivedAt: number) => ({
        ...card(id, "koder", { note: `note for ${id}` }),
        board: "projects",
        archivedAt,
      });

      await t.step(
        "archive is append-only and idempotent by id, listed newest first",
        async () => {
          const boardBefore = await seedBoard(baseUrl, { todo: [card()] });
          const before = await readArchive();
          assert.deepEqual(Object.keys(before).sort(), ["cards", "chunks", "count"]);
          assert.equal(before.count, before.cards.length);
          assert.ok(Number.isInteger(before.chunks) && before.chunks >= 0);

          const a = archived("t_arch_a001", 1000);
          const b = archived("t_arch_b002", 3000);
          const c = archived("t_arch_c003", 2000);
          const first = await call("POST", "/archive", { cards: [a, b] });
          assert.equal(first.status, 200);
          const firstBody = await first.json() as Record<string, number>;
          assert.deepEqual(Object.keys(firstBody).sort(), ["archived", "chunk", "duplicates"]);
          assert.equal(firstBody.archived, 2);
          assert.equal(firstBody.duplicates, 0);
          assert.equal(typeof firstBody.chunk, "number"); // which chunk is the backend's business

          const afterFirst = await readArchive();
          assert.equal(afterFirst.count, before.count + 2);
          // `chunks` is the backend's own storage unit: only its type is contract.
          assert.ok(Number.isInteger(afterFirst.chunks) && afterFirst.chunks >= 0);
          const mine = (read: ArchiveRead) => read.cards.filter((x) => x.id.startsWith("t_arch_"));
          assert.deepEqual(mine(afterFirst).map((x) => x.id), ["t_arch_b002", "t_arch_a001"]);
          assert.deepEqual(mine(afterFirst)[1], a);

          // Retrying a request that already landed is a no-op, not an error.
          const repeat = await call("POST", "/archive", { cards: [a, b] });
          assert.equal(repeat.status, 200);
          assert.deepEqual(await repeat.json(), {
            archived: 0,
            duplicates: 2,
            chunks: afterFirst.chunks,
          });
          assert.equal((await readArchive()).count, before.count + 2);

          // A mixed batch archives only the new ids and counts the rest.
          const mixed = await call("POST", "/archive", { cards: [b, c] });
          assert.equal(mixed.status, 200);
          const mixedBody = await mixed.json() as { archived: number; duplicates: number };
          assert.equal(mixedBody.archived, 1);
          assert.equal(mixedBody.duplicates, 1);
          const afterMixed = await readArchive();
          assert.equal(afterMixed.count, before.count + 3);
          assert.deepEqual(mine(afterMixed).map((x) => x.id), ["t_arch_b002", "t_arch_c003", "t_arch_a001"]);

          // Entries that aren't id/title-shaped are dropped, not archived.
          const junk = await call("POST", "/archive", {
            cards: [{ id: "t_arch_notitle" }, 5, null, archived("t_arch_d004", 4000)],
          });
          assert.equal(junk.status, 200);
          const junkBody = await junk.json() as { archived: number; duplicates: number };
          assert.equal(junkBody.archived, 1);
          assert.equal(junkBody.duplicates, 0);
          const afterJunk = await readArchive();
          assert.equal(afterJunk.count, before.count + 4);
          assert.ok(!afterJunk.cards.some((x) => x.id === "t_arch_notitle"));

          // The archive is a separate store: the board never moved.
          await assertUntouched(boardBefore);
        },
      );

      await t.step("archive refuses malformed bodies and needs the bearer token", async () => {
        const boardBefore = await getState(baseUrl);
        const before = await readArchive();
        for (
          const [name, body, raw] of [
            ["not JSON", undefined, "not json"],
            ["no body fields", {}, undefined],
            ["cards not an array", { cards: "t_x" }, undefined],
            ["empty cards", { cards: [] }, undefined],
            ["no id/title-shaped card", { cards: [{ id: "t_arch_x" }, { title: "y" }, null, 7] }, undefined],
          ] as [string, unknown, string | undefined][]
        ) {
          const res = await call("POST", "/archive", body, raw);
          assert.equal(res.status, 400, name);
          assert.equal(typeof await errorOf(res), "string", name);
        }
        assert.equal((await readArchive()).count, before.count);
        await assertUntouched(boardBefore);

        assert.equal((await fetch(`${baseUrl}/archive`)).status, 401);
        const noAuthPost = await fetch(`${baseUrl}/archive`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cards: [archived("t_arch_noauth", 1)] }),
        });
        assert.equal(noAuthPost.status, 401);
        assert.equal((await readArchive()).count, before.count);
      });

      await t.step("GET /revisions lists restore points newest first and includes the head", async () => {
        await seedBoard(baseUrl, { todo: [card()] });
        const listed = async () => {
          const res = await call("GET", "/revisions");
          assert.equal(res.status, 200);
          const body = await res.json() as { revisions: { rev: number; updatedAt: string }[] };
          assert.deepEqual(Object.keys(body), ["revisions"]);
          return body.revisions;
        };
        const revisions = await listed();
        const head = await getState(baseUrl);
        assert.ok(revisions.length >= 1);
        for (const r of revisions) {
          assert.deepEqual(Object.keys(r).sort(), ["rev", "updatedAt"]);
          assert.ok(Number.isInteger(r.rev));
          assert.ok(!Number.isNaN(Date.parse(r.updatedAt)));
        }
        for (let i = 1; i < revisions.length; i++) {
          assert.ok(revisions[i - 1].rev > revisions[i].rev, "strictly newest first");
        }
        assert.deepEqual(revisions[0], { rev: head.rev, updatedAt: head.updatedAt });
        // Every listed restore point is one GET /state?rev=N can actually serve.
        for (const r of revisions) {
          const snap = await getState(baseUrl, `/state?rev=${r.rev}`);
          assert.equal(snap.rev, r.rev);
          assert.equal(snap.updatedAt, r.updatedAt);
        }

        // A write adds exactly one entry on top; the old head stays reachable.
        const created = await call("POST", "/tickets", { title: "revision probe" });
        assert.equal(created.status, 201);
        const after = await listed();
        assert.equal(after[0].rev, head.rev + 1);
        assert.equal(after[1].rev, head.rev);

        assert.equal((await fetch(`${baseUrl}/revisions`)).status, 401);
      });

      await t.step(
        "restore re-lands a snapshot as a new head and leaves history intact",
        async () => {
          const a = await seedBoard(baseUrl, { todo: [card("t_ticket_1a2b"), card("t_other_0001")] });
          const b = await putBoard(baseUrl, {
            ...a.board,
            projects: { todo: [card("t_ticket_1a2b", "koder", { title: "B edit" })], done: [card("t_other_0001")] },
          });
          const c = await putBoard(baseUrl, { ...b.board, projects: { doing: [card("t_new_0002")] } });
          assert.ok(a.rev < b.rev && b.rev < c.rev);

          const res = await call("POST", "/state/restore", { rev: a.rev });
          assert.equal(res.status, 200);
          const body = await res.json() as { rev: number; restoredFrom: number; updatedAt: string };
          assert.deepEqual(Object.keys(body).sort(), ["restoredFrom", "rev", "updatedAt"]);
          assert.equal(body.restoredFrom, a.rev);
          // Rev never rewinds: the old board becomes the newest rev.
          assert.equal(body.rev, c.rev + 1);

          const now = await getState(baseUrl);
          assert.equal(now.rev, body.rev);
          assert.equal(now.updatedAt, body.updatedAt);
          assert.deepEqual(now.board, a.board);
          // It is a snapshotted head like any write, and the old snapshots didn't change.
          assert.deepEqual(await getState(baseUrl, `/state?rev=${body.rev}`), now);
          assert.deepEqual((await getState(baseUrl, `/state?rev=${a.rev}`)).board, a.board);
          assert.deepEqual((await getState(baseUrl, `/state?rev=${c.rev}`)).board, c.board);
          const listed = await (await call("GET", "/revisions")).json() as { revisions: { rev: number }[] };
          assert.equal(listed.revisions[0].rev, body.rev);

          // Restoring the head itself is still a write of its own.
          const again = await call("POST", "/state/restore", { rev: body.rev });
          assert.equal(again.status, 200);
          assert.equal((await again.json() as { rev: number }).rev, body.rev + 1);
          assert.deepEqual((await getState(baseUrl)).board, a.board);
        },
      );

      await t.step("restore and snapshot lookups refuse bad or unknown revs", async () => {
        const before = await seedBoard(baseUrl, { todo: [card()] });
        for (
          const [name, body, raw] of [
            ["not JSON", undefined, "nope"],
            ["no rev", {}, undefined],
            ["rev as a string", { rev: String(before.rev) }, undefined],
            ["rev null", { rev: null }, undefined],
            ["rev fractional", { rev: 1.5 }, undefined],
          ] as [string, unknown, string | undefined][]
        ) {
          const res = await call("POST", "/state/restore", body, raw);
          assert.equal(res.status, 400, name);
          assert.equal(typeof await errorOf(res), "string", name);
        }
        const unknown = before.rev + 1000;
        const missing = await call("POST", "/state/restore", { rev: unknown });
        assert.equal(missing.status, 404);
        assert.match(String(await errorOf(missing)), new RegExp(`^no snapshot for rev ${unknown}\\b`));
        await assertUntouched(before);

        for (const bad of ["abc", "-1", "1.5"]) {
          const res = await call("GET", `/state?rev=${bad}`);
          assert.equal(res.status, 400, bad);
          assert.equal(typeof await errorOf(res), "string", bad);
        }
        const none = await call("GET", `/state?rev=${unknown}`);
        assert.equal(none.status, 404);
        assert.match(String(await errorOf(none)), new RegExp(`^no snapshot for rev ${unknown}\\b`));
      });

      const createTicket = (body: unknown, raw?: string) => call("POST", "/tickets", body, raw);

      await t.step("POST /tickets validates input and refuses without touching the board", async () => {
        const before = await seedBoard(baseUrl, { todo: [card()] });
        for (
          const [name, body, raw] of [
            ["not JSON", undefined, "not json"],
            ["null body", null, undefined],
            ["no title", { note: "n" }, undefined],
            ["empty title", { title: "" }, undefined],
            ["blank title", { title: "   " }, undefined],
            ["non-string title", { title: 7 }, undefined],
            ["title over 300 chars", { title: "x".repeat(301) }, undefined],
            ["note over 5000 chars", { title: "ok", note: "n".repeat(5001) }, undefined],
            ["unknown column", { title: "ok", column: "archive" }, undefined],
          ] as [string, unknown, string | undefined][]
        ) {
          const res = await createTicket(body, raw);
          assert.equal(res.status, 400, name);
          assert.equal(typeof await errorOf(res), "string", name);
        }
        await assertUntouched(before);
      });

      await t.step("POST /tickets creates one card, one revision, with its ref", async () => {
        const before = await seedBoard(baseUrl, { todo: [card("t_existing_0001")] });
        const res = await createTicket({
          title: "  Make it so  ",
          note: " a note ",
          priority: "high",
          project: "koder",
          column: "todo",
          pr: "KodaAllison/koder#1",
          prRev: 5,
        });
        assert.equal(res.status, 201);
        const made = await res.json() as { card: Card; ref: string; rev: number };
        assert.deepEqual(Object.keys(made).sort(), ["card", "ref", "rev"]);
        assert.equal(made.rev, before.rev + 1);
        assert.equal(typeof made.card.id, "string");
        assert.match(made.ref, /^KODER-[0-9A-Z]{4}$/);
        assert.equal(made.ref, `KODER-${made.card.id.slice(-4).toUpperCase()}`);
        assert.equal(made.card.title, "Make it so");
        assert.equal(made.card.note, "a note");
        assert.equal(made.card.priority, "high");
        assert.equal(made.card.project, "koder");
        assert.equal(typeof made.card.created, "number");
        // pr/prRev are the webhook's; a create can't set them.
        assert.equal("pr" in made.card, false);
        assert.equal("prRev" in made.card, false);

        const now = await getState(baseUrl);
        assert.equal(now.rev, made.rev);
        assert.deepEqual(now.board.projects.todo.map((c) => c.id), ["t_existing_0001", made.card.id]);
        assert.deepEqual(now.board.projects.todo[1], made.card);
        assert.deepEqual(
          (await getState(baseUrl, `/state?rev=${made.rev}`)).board.projects.todo[1],
          made.card,
        );
        const listed = await (await call("GET", "/tickets?project=koder&column=todo")).json() as {
          tickets: (Card & { ref: string; column: string })[];
        };
        const found = listed.tickets.find((x) => x.id === made.card.id);
        assert.equal(found?.ref, made.ref);
        assert.equal(found?.column, "todo");

        // Every create is exactly one revision.
        const second = await createTicket({ title: "Second", column: "todo" });
        assert.equal((await second.json() as { rev: number }).rev, made.rev + 1);
        assert.equal((await getState(baseUrl)).rev, made.rev + 1);
      });

      await t.step("POST /tickets fills defaults and ignores unusable optional values", async () => {
        await seedBoard(baseUrl, {});
        const plain = await createTicket({ title: "Just a title" });
        assert.equal(plain.status, 201);
        const made = await plain.json() as { card: Card; ref: string };
        assert.equal(made.card.priority, "med");
        assert.equal(made.card.note, "");
        assert.equal(made.card.project, null);
        assert.match(made.ref, /^NOPROJ-[0-9A-Z]{4}$/);
        assert.deepEqual((await getState(baseUrl)).board.projects.backlog.map((c) => c.id), [made.card.id]);

        // POST has always been lenient about optional fields: bad ones fall back.
        const lenient = await createTicket({
          title: "Lenient",
          priority: "urgent",
          note: 5,
          project: 7,
          column: "",
        });
        assert.equal(lenient.status, 201);
        const card2 = (await lenient.json() as { card: Card }).card;
        assert.equal(card2.priority, "med");
        assert.equal(card2.note, "");
        assert.equal(card2.project, null);
        assert.deepEqual(
          (await getState(baseUrl)).board.projects.backlog.map((c) => c.id),
          [made.card.id, card2.id],
        );

        // The caps are inclusive.
        const edge = await createTicket({ title: "x".repeat(300), note: "n".repeat(5000) });
        assert.equal(edge.status, 201);
      });

      const patchBody = (id: string, fields: unknown, raw?: string) =>
        call("PATCH", `/tickets/${id}`, fields, raw);
      type Patched = { card: Card; ref: string; column: string; rev: number };
      const seedThree = () =>
        seedBoard(baseUrl, {
          todo: [
            card("t_aaaa_0001", "koder", { title: "A" }),
            card("t_bbbb_0002", "koder", { title: "B", note: "keep me" }),
            card("t_cccc_0003", "koder", { title: "C" }),
          ],
          doing: [],
        });

      await t.step("PATCH edits each field in place, one revision per write", async () => {
        const seeded = await seedThree();
        let rev = seeded.rev;
        const edit = async (given: string, fields: Record<string, unknown>) => {
          const res = await patchBody(given, fields);
          assert.equal(res.status, 200, JSON.stringify(fields));
          const body = await res.json() as Patched;
          assert.deepEqual(Object.keys(body).sort(), ["card", "column", "ref", "rev"]);
          assert.equal(body.rev, ++rev);
          assert.equal(body.column, "todo");
          assert.equal((await getState(baseUrl)).rev, rev);
          return body;
        };

        const titled = await edit("t_bbbb_0002", { title: "  Renamed  " });
        assert.equal(titled.card.title, "Renamed");
        assert.equal(titled.ref, "KODER-0002");
        assert.equal(titled.card.note, "keep me");
        const afterTitle = await getState(baseUrl);
        // An edit leaves the card where it sat; the neighbours are untouched.
        assert.deepEqual(afterTitle.board.projects.todo.map((c) => c.id), ["t_aaaa_0001", "t_bbbb_0002", "t_cccc_0003"]);
        assert.deepEqual(afterTitle.board.projects.todo[0], seeded.board.projects.todo[0]);
        assert.deepEqual(afterTitle.board.projects.todo[2], seeded.board.projects.todo[2]);
        assert.deepEqual(afterTitle.board.projects.todo[1], titled.card);

        assert.equal((await edit("t_bbbb_0002", { note: "  new note " })).card.note, "new note");
        assert.equal((await edit("t_bbbb_0002", { note: "" })).card.note, "");
        for (const priority of ["high", "low", "med"]) {
          assert.equal((await edit("t_bbbb_0002", { priority })).card.priority, priority);
        }

        // project feeds the ref, so changing it renames the ref the card answers to.
        const moved = await edit("t_bbbb_0002", { project: "holitrackr" });
        assert.equal(moved.card.project, "holitrackr");
        assert.equal(moved.ref, "HOLIT-0002");
        assert.equal((await patchBody("KODER-0002", { title: "stale ref" })).status, 404);
        assert.equal((await edit("HOLIT-0002", { project: null })).ref, "NOPROJ-0002");
        assert.equal((await edit("t_bbbb_0002", { project: "holitrackr" })).card.project, "holitrackr");
        // "" and null both mean unassigned.
        assert.equal((await edit("t_bbbb_0002", { project: "" })).card.project, null);
        rev = (await getState(baseUrl)).rev; // the 404 above wrote nothing

        // Several fields in one call are one write.
        const several = await edit("t_bbbb_0002", { title: "Multi", note: "n2", priority: "high", project: "koder" });
        assert.deepEqual(
          [several.card.title, several.card.note, several.card.priority, several.card.project],
          ["Multi", "n2", "high", "koder"],
        );
        const final = (await getState(baseUrl)).board.projects.todo[1];
        assert.deepEqual(final, several.card);
        assert.equal(final.created, seeded.board.projects.todo[1].created);
        // And that revision is snapshotted.
        assert.deepEqual((await getState(baseUrl, `/state?rev=${rev}`)).board.projects.todo[1], final);
      });

      await t.step("PATCH column moves the card to the end of its new column", async () => {
        const seeded = await seedBoard(baseUrl, {
          todo: [card("t_aaaa_0001", "koder", { title: "A" }), card("t_bbbb_0002", "koder", { title: "B" })],
          doing: [card("t_cccc_0003", "koder", { title: "C" })],
        });
        const toDoing = await patchBody("KODER-0001", { column: "doing" });
        assert.equal(toDoing.status, 200);
        const body = await toDoing.json() as Patched;
        assert.equal(body.column, "doing");
        assert.equal(body.rev, seeded.rev + 1);
        assert.equal(body.card.title, "A");
        const afterMove = await getState(baseUrl);
        assert.deepEqual(afterMove.board.projects.todo.map((c) => c.id), ["t_bbbb_0002"]);
        assert.deepEqual(afterMove.board.projects.doing.map((c) => c.id), ["t_cccc_0003", "t_aaaa_0001"]);

        // A move and an edit together are still one write.
        const both = await patchBody("t_bbbb_0002", { column: "done", title: "Shipped" });
        assert.equal(both.status, 200);
        const bothBody = await both.json() as Patched;
        assert.equal(bothBody.column, "done");
        assert.equal(bothBody.card.title, "Shipped");
        assert.equal(bothBody.rev, body.rev + 1);
        const afterBoth = await getState(baseUrl);
        assert.deepEqual(afterBoth.board.projects.todo, []);
        assert.deepEqual(afterBoth.board.projects.done.map((c) => c.title), ["Shipped"]);

        // Every project column is a valid target; anything else is refused.
        for (const column of ["backlog", "todo", "doing", "review", "done"]) {
          const res = await patchBody("t_cccc_0003", { column });
          assert.equal(res.status, 200, column);
          assert.equal((await res.json() as Patched).column, column);
        }
        const bad = await patchBody("t_cccc_0003", { column: "archive" });
        assert.equal(bad.status, 400);
        assert.deepEqual((await bad.json() as { valid: string[] }).valid, ["backlog", "todo", "doing", "review", "done"]);
      });

      await t.step("PATCH resolves ids and refs, and refuses unknown or ambiguous ones", async () => {
        const seeded = await seedThree();
        // Id, ref, and a ref in any case all name the same card.
        for (const [given, title] of [["t_aaaa_0001", "by id"], ["KODER-0001", "by ref"], ["koder-0001", "by lowercase ref"]]) {
          const res = await patchBody(given, { title });
          assert.equal(res.status, 200, given);
          const body = await res.json() as Patched;
          assert.equal(body.card.id, "t_aaaa_0001");
          assert.equal(body.ref, "KODER-0001");
          assert.equal(body.card.title, title);
        }

        const head = await getState(baseUrl);
        assert.equal(head.rev, seeded.rev + 3);
        for (const given of ["KODER-DEAD", "t_nope_0000"]) {
          const res = await patchBody(given, { title: "ghost" });
          assert.equal(res.status, 404, given);
          assert.equal(typeof await errorOf(res), "string");
        }
        await assertUntouched(head);

        const twins = await seedBoard(baseUrl, {
          todo: [card("t_first_abcd"), card("t_second_abcd")],
        });
        const ambiguous = await patchBody("KODER-ABCD", { title: "which one" });
        assert.equal(ambiguous.status, 409);
        const ambiguousBody = await ambiguous.json() as { error: string; ids: string[] };
        assert.equal(typeof ambiguousBody.error, "string");
        assert.deepEqual(ambiguousBody.ids, ["t_first_abcd", "t_second_abcd"]);
        await assertUntouched(twins);
        // The raw id still gets through.
        const byId = await patchBody("t_second_abcd", { title: "this one" });
        assert.equal(byId.status, 200);
        assert.equal((await getState(baseUrl)).board.projects.todo[1].title, "this one");
      });

      await t.step("PATCH refuses invalid bodies and applies nothing when any field is bad", async () => {
        const before = await seedThree();
        for (
          const [name, body, raw] of [
            ["not JSON", undefined, "not json"],
            ["null body", null, undefined],
            ["array body", [], undefined],
            ["empty object", {}, undefined],
            ["only unknown fields", { colour: "red" }, undefined],
            ["empty title", { title: "" }, undefined],
            ["blank title", { title: "  " }, undefined],
            ["non-string title", { title: 5 }, undefined],
            ["title over 300 chars", { title: "x".repeat(301) }, undefined],
            ["non-string note", { note: 5 }, undefined],
            ["note over 5000 chars", { note: "n".repeat(5001) }, undefined],
            ["unknown priority", { priority: "urgent" }, undefined],
            ["non-string priority", { priority: 3 }, undefined],
            ["non-string project", { project: 5 }, undefined],
            ["non-string column", { column: 5 }, undefined],
            ["valid title with a bad priority", { title: "applied?", priority: "urgent" }, undefined],
          ] as [string, unknown, string | undefined][]
        ) {
          const res = await patchBody("t_bbbb_0002", body, raw);
          assert.equal(res.status, 400, name);
          assert.equal(typeof await errorOf(res), "string", name);
        }
        await assertUntouched(before);

        // The caps are inclusive.
        const edge = await patchBody("t_bbbb_0002", { title: "x".repeat(300), note: "n".repeat(5000) });
        assert.equal(edge.status, 200);
      });

      await t.step("PATCH cannot set pr or prRev", async () => {
        await seedBoard(baseUrl, { todo: [card("t_ticket_1a2b"), card("t_plain_0002")] });
        assert.equal((await openPr(20, "KODER-1A2B")).status, 200);
        const linked = await getState(baseUrl);
        assert.equal(linked.board.projects.review[0].pr, "KodaAllison/koder#20");

        // Alone they're not settable fields at all.
        const only = await patchBody("KODER-1A2B", { pr: "evil/repo#9", prRev: 99 });
        assert.equal(only.status, 400);
        await assertUntouched(linked);

        // Alongside a real edit they are ignored, and the webhook's values stand.
        const mixed = await patchBody("KODER-1A2B", { title: "retitled", pr: "evil/repo#9", prRev: 99 });
        assert.equal(mixed.status, 200);
        const mixedCard = (await mixed.json() as Patched).card;
        assert.equal(mixedCard.title, "retitled");
        assert.equal(mixedCard.pr, "KodaAllison/koder#20");
        assert.equal(mixedCard.prRev, 1);
        const after = await getState(baseUrl);
        assert.equal(after.board.projects.review[0].pr, "KodaAllison/koder#20");
        assert.equal(after.board.projects.review[0].prRev, 1);

        // A card with no link can't acquire one this way either.
        const plain = await patchBody("t_plain_0002", { title: "still plain", pr: "evil/repo#9", prRev: 1 });
        assert.equal(plain.status, 200);
        const plainCard = (await plain.json() as Patched).card;
        assert.equal("pr" in plainCard, false);
        assert.equal("prRev" in plainCard, false);
        const stored = (await getState(baseUrl)).board.projects.todo[0];
        assert.equal("pr" in stored, false);
        assert.equal("prRev" in stored, false);
      });

      await kvOnly(
        "a ticket write that would overflow the board store is a 507 with a clear message",
        async () => {
          const before = await seedNearFullBoard(baseUrl, 24);

          const post = await fetch(`${baseUrl}/tickets`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: "One ticket too many", project: "koder" }),
          });
          assert.equal(post.status, 507);
          assertStoreFullBody(await post.json());

          const patch = await patchTicket(baseUrl, "KODER-5A11", {
            note: "a note long enough to push the board past the cap",
          });
          assert.equal(patch.status, 507);
          assertStoreFullBody(await patch.json());

          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev);
          assert.deepEqual(after.board, before.board);
        },
      );

      await kvOnly(
        "a PATCH that doesn't grow the board still lands on a near-full store",
        async () => {
          const before = await seedNearFullBoard(baseUrl, 24);
          const response = await patchTicket(baseUrl, "KODER-5A11", {
            priority: "low",
            column: "doing",
          });
          assert.equal(response.status, 200);
          const after = await getState(baseUrl);
          assert.equal(after.rev, before.rev + 1);
          assert.equal(after.board.projects.doing[0].id, "t_small_5a11");
          assert.equal(after.board.projects.doing[0].priority, "low");
        },
      );

      await kvOnly(
        "a webhook move that would overflow is a 507 and can be redelivered once there is room",
        async () => {
          const before = await seedNearFullBoard(baseUrl, 24);
          const delivery = freshDelivery();
          const opened = {
            action: "opened",
            repository: { full_name: "KodaAllison/koder" },
            pull_request: {
              number: 31,
              title: "Ship KODER-5A11",
              body: null,
              merged: false,
            },
          };
          const full = await postWebhook(baseUrl, opened, { delivery });
          assert.equal(full.status, 507);
          assertStoreFullBody(await full.json());
          assert.equal((await getState(baseUrl)).rev, before.rev);

          // The refused delivery was not recorded, so it lands once space frees.
          await seedBoard(baseUrl, { todo: [card("t_small_5a11")] });
          const retried = await postWebhook(baseUrl, opened, { delivery });
          assert.equal(retried.status, 200);
          assert.equal((await retried.json() as { updated: boolean }).updated, true);
        },
      );

      await kvOnly(
        "PUT /state measures the stored size, not the JSON length",
        async () => {
          const before = await seedBoard(baseUrl, { todo: [card()] });
          // ~33K chars of JSON (well under the old 60_000 guard), but every
          // char is stored as two bytes because the string isn't Latin-1.
          const board = {
            projects: { todo: [card("t_ticket_1a2b", "koder", { note: "—".repeat(33_000) })] },
            life: {},
            lifeMeta: {},
          };
          const body = JSON.stringify({ baseRev: before.rev, board });
          assert.ok(body.length < 60_000);
          const response = await fetch(`${baseUrl}/state`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
            },
            body,
          });
          assert.equal(response.status, 413);
          assertStoreFullBody(await response.json());
          assert.equal((await getState(baseUrl)).rev, before.rev);
        },
      );

      await kvOnly(
        "revisions are pruned to the last 20, and a pruned rev's 404 says so",
        async () => {
          while ((await getState(baseUrl)).rev < 25) {
            assert.equal((await createTicket({ title: "pad history" })).status, 201);
          }
          const head = await getState(baseUrl);
          const listed = await (await call("GET", "/revisions")).json() as { revisions: { rev: number }[] };
          assert.deepEqual(
            listed.revisions.map((r) => r.rev),
            Array.from({ length: 20 }, (_, i) => head.rev - i),
          );
          const pruned = head.rev - 20;
          const message = `no snapshot for rev ${pruned} (only the last 20 are kept)`;
          const lookup = await call("GET", `/state?rev=${pruned}`);
          assert.equal(lookup.status, 404);
          assert.equal(await errorOf(lookup), message);
          const restore = await call("POST", "/state/restore", { rev: pruned });
          assert.equal(restore.status, 404);
          assert.equal(await errorOf(restore), message);
          await assertUntouched(head);
        },
      );

      await kvOnly(
        "an archive batch too big for one KV value is a 413 and nothing is archived",
        async () => {
          const before = await readArchive();
          const res = await call("POST", "/archive", {
            cards: [{ ...archived("t_arch_huge", 1), note: "—".repeat(40_000) }],
          });
          assert.equal(res.status, 413);
          const body = await res.json() as { error: string; size: number; limit: number };
          assert.match(body.error, /^archive batch too large: \d+ of 65536 bytes — send fewer cards$/);
          assert.equal(body.limit, STORE_VALUE_MAX);
          assert.ok(body.size > body.limit);
          assert.deepEqual(await readArchive(), before);
        },
      );

      await kvOnly(
        "PUT /state refuses a body past 4x the stored cap before parsing it",
        async () => {
          const before = await getState(baseUrl);
          const chars = 4 * STORE_VALUE_MAX + 1;
          const res = await call("PUT", "/state", undefined, "x".repeat(chars));
          assert.equal(res.status, 413);
          assert.deepEqual(await res.json(), {
            error: `board too large: request body is ${chars} characters,` +
              ` store holds ${STORE_VALUE_MAX} bytes — archive done tickets to free space`,
            limit: STORE_VALUE_MAX,
          });
          await assertUntouched(before);
        },
      );
    } finally {
      server.kill("SIGTERM");
      await server.status;
      await Deno.remove(kvDir, { recursive: true });
    }
  },
});
