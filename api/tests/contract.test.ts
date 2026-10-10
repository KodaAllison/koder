/* The server's contract suite, ported step for step from server/webhook.deno.ts
 * (the Deno KV server's suite) to node:test. It spawns the real
 * api/src/main.ts and drives it only over HTTP, so it doesn't know or care how
 * the store lays the board out: the same steps passed against Deno KV, and
 * must pass against Postgres, which is how the PWA and the CLI can't tell the
 * two servers apart.
 *
 * The database is PGlite (Postgres compiled to WASM, in this process) behind
 * @electric-sql/pglite-socket, so the server talks to it with the same
 * postgres.js driver and wire protocol it uses against Neon. Every spawned
 * server gets a FRESH database; the harness keeps the PGlite handle, which
 * the Postgres-specific steps at the end use to set up rows the API can't.
 *
 * Steps the KV suite ran only against KV (its 64KB value cap, its 20-revision
 * pruning, its archive chunking) are not carried over; the one Postgres limit
 * a client can hit, the 2 MiB PUT cap, has a step of its own instead. */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { get as httpGet, request as httpRequest } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { nextWebhookRevision } from "../src/workflow.ts";

/* The subtest call, so the ported steps read as they did under Deno
 * (`await step(name, fn)`). Every step runs: none is skipped or pended. */
function stepper(t: TestContext) {
  return (name: string, fn: () => void | Promise<void>) => t.test(name, fn);
}

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
  body: RequestInit["body"],
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

/* A chunked body that never declares its length, written over a raw socket
 * so the server can only find out it's too big by counting. Resolves with the
 * status code of whatever the server answers. */
async function postChunkedOversizedWebhook(baseUrl: string): Promise<number> {
  const url = new URL(baseUrl);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await once(socket, "connect");
  let received = "";
  const statusLine = new Promise<string>((resolve, reject) => {
    socket.on("data", (data: Buffer) => {
      received += data.toString("latin1");
      const end = received.indexOf("\r\n");
      if (end !== -1) resolve(received.slice(0, end));
    });
    socket.on("close", () => reject(new Error(`connection closed after ${JSON.stringify(received)}`)));
  });
  // The server may close its receive side as soon as it emits the 413.
  socket.on("error", () => {});
  const write = (bytes: Uint8Array | string) =>
    new Promise<void>((resolve) => socket.write(bytes, () => resolve()));
  try {
    await write([
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
    ].join("\r\n"));
    for (const chunk of [new Uint8Array(200_000), new Uint8Array(100_000)]) {
      await write(`${chunk.length.toString(16)}\r\n`);
      await write(chunk);
      await write("\r\n");
    }
    await write("0\r\n\r\n");
    return Number((await statusLine).split(" ")[1]);
  } finally {
    socket.destroy();
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

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/* ---- The harness: a fresh Postgres per server, and the server itself ---- */

type Database = { db: PGlite; url: string; close(): Promise<void> };

/* An empty in-memory Postgres behind a socket server on a free port. The
 * socket server has no TLS (pg-store.ts turns ssl off for 127.0.0.1) and serves
 * one connection at a time, so every server gets KODER_PG_MAX=1. */
async function freshDatabase(maxConnections = 1): Promise<Database> {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections });
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

// The parent's environment minus anything that would change the server's
// behaviour under test (a developer's real token, database or origin).
function serverEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(KODER_|NEON_|GITHUB_TOKEN$|PORT$)/.test(name)) delete env[name];
  }
  return { ...env, ...extra };
}

type RunningServer = { child: ChildProcess; baseUrl: string; stderr: () => string; stop(): Promise<void> };

/* Spawn `node api/src/main.ts` on a free port (PORT=0) and resolve once it
 * prints the port it bound, the line Deno.serve used to print. */
async function startServer(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const child = spawn(process.execPath, [MAIN], {
    env: serverEnv({
      KODER_TOKEN: TOKEN,
      KODER_WEBHOOK_SECRET: SECRET,
      NEON_DATABASE_URL: databaseUrl,
      KODER_PG_MAX: "1",
      PORT: "0",
      ...env,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
      const match = stdout.match(/Listening on http:\/\/localhost:(\d+)\//);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}) before listening:\n${stderr}`)));
  });
  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

/* Run main.ts to completion (it is expected to refuse to start). */
async function runServerToExit(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [MAIN], {
    env: serverEnv({ KODER_TOKEN: TOKEN, PORT: "0", ...env }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => (stderr += data.toString()));
  const [code] = await once(child, "exit") as [number | null];
  return { code, stderr };
}

test("startup fails fast, without leaking the password, unless the database is usable", async () => {
  // A port nothing listens on: bind one, then let it go.
  const closed = await new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
  for (
    const [name, env, message] of [
      ["no NEON_DATABASE_URL", {}, "NEON_DATABASE_URL is not set"],
      ["not a URL", { NEON_DATABASE_URL: "not a url" }, "NEON_DATABASE_URL is not a valid postgres:// URL"],
      ["bad pool size", { NEON_DATABASE_URL: "postgres://u:p@127.0.0.1/db", KODER_PG_MAX: "0" }, "KODER_PG_MAX must be a positive integer"],
      [
        "unreachable database",
        { NEON_DATABASE_URL: `postgres://koder:s3cret-Pa55@127.0.0.1:${closed}/koder` },
        "PgStore could not open the database",
      ],
    ] as [string, Record<string, string>, string][]
  ) {
    const { code, stderr } = await runServerToExit(env);
    assert.notEqual(code, 0, name);
    assert.ok(stderr.includes(message), `${name}: ${stderr}`);
    assert.ok(!stderr.includes("s3cret-Pa55"), `${name} leaked the password: ${stderr}`);
  }
});

test("Koder API contract (Postgres)", async (t) => {
    const database = await freshDatabase();
    const server = await startServer(database.url);
    const baseUrl = server.baseUrl;
    const db = database.db;
    const step = stepper(t);

    try {
      await waitForServer(baseUrl);

      await step("a fresh database answers GET /state with the empty rev-0 doc", async () => {
        const response = await fetch(`${baseUrl}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("etag"), '"0"');
        assert.equal(response.headers.get("content-type"), "application/json");
        // Byte for byte what the KV server sent before its first write.
        assert.equal(
          await response.text(),
          JSON.stringify({ rev: 0, updatedAt: null, board: { projects: {}, life: {}, lifeMeta: {} } }),
        );
      });

      await step("GET /state sends an ETag and answers 304 to a matching If-None-Match", async () => {
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

      await step("PR status route enforces read auth and stays read-only", async () => {
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

      await step(
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

      await step("a valid GitHub delivery ID is mandatory", async () => {
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

      await step(
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

      await step(
        "oversized fixed and streamed bodies are rejected with 413",
        async () => {
          const fixed = await postRawWebhook(baseUrl, "x".repeat(300_000));
          assert.equal(fixed.status, 413);

          assert.equal(await postChunkedOversizedWebhook(baseUrl), 413);
        },
      );

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step("untrusted events and actions are ignored", async () => {
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

      await step(
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

      await step(
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

      await step(
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

      await step("closed and merged moves the ticket to done", async () => {
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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

      await step(
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
       * behaviour every backend must share is asserted; the steps that pinned
       * KV's limits were not carried over (see the header). ---- */
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

      await step(
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

      await step("archive refuses malformed bodies and needs the bearer token", async () => {
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

      await step("GET /revisions lists restore points newest first and includes the head", async () => {
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

      await step(
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

      await step("restore and snapshot lookups refuse bad or unknown revs", async () => {
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

      await step("POST /tickets validates input and refuses without touching the board", async () => {
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

      await step("POST /tickets creates one card, one revision, with its ref", async () => {
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

      await step("POST /tickets fills defaults and ignores unusable optional values", async () => {
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

      await step("PATCH edits each field in place, one revision per write", async () => {
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

      await step("PATCH column moves the card to the end of its new column", async () => {
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

      await step("PATCH resolves ids and refs, and refuses unknown or ambiguous ones", async () => {
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

      await step("PATCH refuses invalid bodies and applies nothing when any field is bad", async () => {
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

      await step("PATCH cannot set pr or prRev", async () => {
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

      /* ---- Postgres-specific steps. Nothing above can see how the board is
       * stored; these check what the row layout must get right, and use the
       * PGlite handle (`db`) where the API can't set the scene. ---- */
      const PG_BOARD_MAX = 2 * 1024 * 1024;

      await step("a PUT body over 2 MiB is refused with the 413 shape", async () => {
        const before = await seedBoard(baseUrl, { todo: [card()] });
        const chars = PG_BOARD_MAX + 1;
        const res = await call("PUT", "/state", undefined, "x".repeat(chars));
        assert.equal(res.status, 413);
        assert.deepEqual(await res.json(), {
          error: `board too large: request body is ${chars} characters,` +
            ` store holds ${PG_BOARD_MAX} bytes — archive done tickets to free space`,
          limit: PG_BOARD_MAX,
        });
        await assertUntouched(before);

        // Under the character cap, over the byte budget as stored (an em dash
        // is three bytes of UTF-8): the store's own check, still a 413.
        const board = {
          projects: { todo: [card("t_ticket_1a2b", "koder", { note: "—".repeat(800_000) })] },
          life: {},
          lifeMeta: {},
        };
        const big = await call("PUT", "/state", { baseRev: before.rev, board });
        assert.equal(big.status, 413);
        const body = await big.json() as { error: string; size: number; limit: number };
        assert.match(body.error, /^board store full: \d+ of 2097152 bytes — archive done tickets to free space$/);
        assert.equal(body.limit, PG_BOARD_MAX);
        assert.ok(body.size > PG_BOARD_MAX);
        await assertUntouched(before);
      });

      await step("concurrent PUTs on one baseRev: exactly one lands, the rest are stale", async () => {
        const seeded = await seedBoard(baseUrl, { todo: [card("t_race_0001")] });
        /* PGlite runs one transaction at a time, and the server holds one
         * pooled connection, so these PUTs are serialised rather than truly
         * racing: this proves the compare-and-swap on baseRev (each later PUT
         * re-reads the head under its lock and finds it moved), not the
         * row-lock contention a real Postgres would add. */
        const responses = await Promise.all([1, 2, 3, 4].map((n) =>
          call("PUT", "/state", {
            baseRev: seeded.rev,
            board: { projects: { todo: [card("t_race_0001", "koder", { title: `racer ${n}` })] }, life: {}, lifeMeta: {} },
          })
        ));
        const bodies = await Promise.all(responses.map((r) => r.json())) as Record<string, unknown>[];
        const won = responses.map((r, i) => [r.status, bodies[i]] as const).filter(([status]) => status === 200);
        assert.equal(won.length, 1, JSON.stringify(responses.map((r) => r.status)));
        assert.equal(won[0][1].rev, seeded.rev + 1);
        for (const [i, r] of responses.entries()) {
          if (r.status === 200) continue;
          assert.equal(r.status, 409);
          assert.deepEqual(bodies[i], { error: "conflict: baseRev is stale", rev: seeded.rev + 1 });
        }
        const after = await getState(baseUrl);
        assert.equal(after.rev, seeded.rev + 1);
        const winner = responses.findIndex((r) => r.status === 200);
        assert.equal(after.board.projects.todo[0].title, `racer ${winner + 1}`);
      });

      await step("archiving a live card changes neither GET /state nor rev; a PUT decides whether it leaves the board", async () => {
        const seeded = await seedBoard(baseUrl, { todo: [card("t_live_0001"), card("t_arch_pg01")] });
        const posted = {
          ...card("t_arch_pg01"),
          board: "projects",
          archivedAt: 5000,
          clientField: { z: 1, a: { y: [1, "two", null], b: 2 } },
        };
        const res = await call("POST", "/archive", { cards: [posted] });
        assert.equal(res.status, 200);
        const body = await res.json() as { archived: number; duplicates: number };
        assert.deepEqual([body.archived, body.duplicates], [1, 0]);

        // The archive is its own store: the board and rev never moved, and the
        // card is still on it.
        await assertUntouched(seeded);
        assert.deepEqual((await getState(baseUrl)).board.projects.todo.map((c) => c.id), ["t_live_0001", "t_arch_pg01"]);
        const inArchive = async () => (await readArchive()).cards.filter((c) => c.id === "t_arch_pg01");
        assert.deepEqual(await inArchive(), [posted]);
        // Key order is as posted, top level and nested (jsonb would reorder it).
        assert.deepEqual(Object.keys((await inArchive())[0]), Object.keys(posted));
        assert.equal(JSON.stringify((await inArchive())[0]), JSON.stringify(posted));

        // The client drops the card with its next PUT: off the board, still archived.
        let state = await putBoard(baseUrl, { projects: { todo: [card("t_live_0001")] }, life: {}, lifeMeta: {} });
        assert.ok(!JSON.stringify(state.board).includes("t_arch_pg01"));
        assert.deepEqual(await inArchive(), [posted]);

        // A PUT that re-sends the id (a stale tab) keeps it on the board, as on KV;
        // the archived copy is not rewritten.
        state = await putBoard(baseUrl, {
          projects: {
            todo: [card("t_live_0001"), card("t_arch_pg01", "koder", { title: "resent from a stale tab" })],
          },
          life: {},
          lifeMeta: {},
        });
        assert.equal(state.board.projects.todo[1].title, "resent from a stale tab");
        assert.deepEqual(await inArchive(), [posted]);
      });

      /* ---- Ticket writes, seen from the database: what the HTTP contract
       * can't tell, that each write is one set of `changes` rows and one
       * `revisions` row, and one rev. ---- */
      type ChangeRow = { seq: number; entity: string; entity_id: string; op: string; before: any; after: any; actor: string };
      const headRev = async () => (await db.query<{ rev: number }>(`SELECT rev::int AS rev FROM board_head`)).rows[0].rev;
      const logged = async (rev: number) => ({
        revisions: (await db.query<{ actor: string; summary: string | null }>(
          `SELECT actor, summary FROM revisions WHERE rev = $1`, [rev],
        )).rows,
        changes: (await db.query<ChangeRow>(
          `SELECT seq::int AS seq, entity, entity_id, op, before, after, actor FROM changes WHERE rev = $1 ORDER BY seq`, [rev],
        )).rows,
      });

      await step("POST, PATCH and DELETE /tickets each write one revisions row and their changes rows, rev + 1", async () => {
        const seeded = await seedBoard(baseUrl, { todo: [card("t_log_0001"), card("t_log_0002")] });

        // Create in a column the board doesn't have yet: the layout grows with it.
        const created = await createTicket({ title: "logged", column: "review" });
        assert.equal(created.status, 201);
        const made = await created.json() as { card: Card; rev: number };
        assert.equal(made.rev, seeded.rev + 1);
        assert.equal(await headRev(), made.rev);
        let log = await logged(made.rev);
        assert.deepEqual(log.revisions, [{ actor: "cli", summary: "1× card insert, 1× board update" }]);
        assert.deepEqual(log.changes.map((c) => [c.seq, c.entity, c.op, c.actor]), [[1, "card", "insert", "cli"], [2, "board", "update", "cli"]]);
        assert.equal(log.changes[0].before, null);
        assert.equal(log.changes[0].entity_id, made.card.id);
        assert.equal(log.changes[0].after.title, "logged");
        assert.equal(log.changes[0].after.column_id, "review");
        assert.deepEqual(log.changes[1].before.layout.projects, ["todo"]);
        assert.deepEqual(log.changes[1].after.layout.projects, ["todo", "review"]);
        assert.deepEqual(Object.keys((await getState(baseUrl)).board.projects), ["todo", "review"]);

        // An edit keeps the position: one card update, the rank untouched.
        const edited = await patchBody("t_log_0001", { title: "edited" });
        assert.equal(edited.status, 200);
        assert.equal((await edited.json() as Patched).rev, made.rev + 1);
        log = await logged(made.rev + 1);
        assert.deepEqual(log.revisions, [{ actor: "cli", summary: "1× card update" }]);
        assert.equal(log.changes.length, 1);
        assert.equal(log.changes[0].before.title, "Webhook ticket");
        assert.equal(log.changes[0].after.title, "edited");
        assert.equal(log.changes[0].after.rank, log.changes[0].before.rank);

        // A patch that changes nothing is still a write, like KV: rev + 1, no rows.
        const same = await patchBody("t_log_0001", { title: "edited" });
        assert.equal((await same.json() as Patched).rev, made.rev + 2);
        log = await logged(made.rev + 2);
        assert.deepEqual(log.revisions, [{ actor: "cli", summary: null }]);
        assert.deepEqual(log.changes, []);

        // A move goes to the end of the target column: after the card created there.
        const moved = await patchBody("t_log_0001", { column: "review" });
        assert.equal((await moved.json() as Patched).rev, made.rev + 3);
        log = await logged(made.rev + 3);
        assert.equal(log.changes.length, 1);
        assert.deepEqual([log.changes[0].before.column_id, log.changes[0].after.column_id], ["todo", "review"]);
        assert.equal(log.changes[0].after.rank, "00000001");
        assert.deepEqual((await getState(baseUrl)).board.projects.review.map((c) => c.id), [made.card.id, "t_log_0001"]);

        // A refused write leaves no trace.
        assert.equal((await patchBody("KODER-DEAD", { title: "ghost" })).status, 404);
        assert.equal(await headRev(), made.rev + 3);

        // Delete soft-deletes the row and logs the card as it was.
        const deleted = await call("DELETE", "/tickets/t_log_0002");
        assert.equal(deleted.status, 200);
        const deletedBody = await deleted.json() as { rev: number; board: Doc["board"] };
        assert.equal(deletedBody.rev, made.rev + 4);
        assert.deepEqual(deletedBody.board, (await getState(baseUrl)).board);
        log = await logged(made.rev + 4);
        assert.deepEqual(log.revisions, [{ actor: "cli", summary: "1× card delete" }]);
        assert.equal(log.changes.length, 1);
        assert.equal(log.changes[0].after, null);
        assert.equal(log.changes[0].before.title, "Webhook ticket");
        const gone = (await db.query<{ gone: boolean }>(`SELECT deleted_at IS NOT NULL AS gone FROM cards WHERE id = 't_log_0002'`)).rows;
        assert.deepEqual(gone, [{ gone: true }]);

        // Exactly one revisions row per write, none extra.
        const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM revisions WHERE rev > $1`, [seeded.rev])).rows[0].n;
        assert.equal(n, 5);
      });

      await step("concurrent ticket writes all land, each seeing the previous one, revs consecutive", async () => {
        const seeded = await seedBoard(baseUrl, { todo: [card("t_conc_0001", "koder", { title: "orig", note: "orig" })] });
        /* Different fields of one ticket. Each write reads the previous write's
         * result, so none is lost, and the revs are consecutive. As with the PUT
         * race above, this does NOT prove the head lock or lock_timeout: PGlite
         * serves one connection and the server pool is 1, so these transactions
         * run one after another whether or not FOR UPDATE is there. */
        const fields: Record<string, unknown>[] = [{ title: "T" }, { note: "N" }, { priority: "high" }, { project: "holitrackr" }];
        const patched = await Promise.all(fields.map((f) => patchBody("t_conc_0001", f)));
        const results = await Promise.all(patched.map(async (r) => {
          assert.equal(r.status, 200);
          return await r.json() as Patched;
        }));
        const byRev = results.map((r, i) => ({ ...r, fields: fields[i] })).sort((a, b) => a.rev - b.rev);
        assert.deepEqual(byRev.map((r) => r.rev), [1, 2, 3, 4].map((n) => seeded.rev + n));
        for (const [i, r] of byRev.entries()) {
          for (const earlier of byRev.slice(0, i + 1)) {
            for (const [key, value] of Object.entries(earlier.fields)) {
              assert.deepEqual((r.card as unknown as Record<string, unknown>)[key], value, `rev ${r.rev} lost ${key}`);
            }
          }
        }
        const final = (await getState(baseUrl)).board.projects.todo[0];
        assert.deepEqual([final.title, final.note, final.priority, final.project], ["T", "N", "high", "holitrackr"]);

        // Concurrent creates all land, in the column in rev order, ranks distinct.
        const head = await getState(baseUrl);
        const posted = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => createTicket({ title: `racer ${n}`, column: "todo" })));
        const made = await Promise.all(posted.map(async (r) => {
          assert.equal(r.status, 201);
          return await r.json() as { card: Card; rev: number };
        }));
        made.sort((a, b) => a.rev - b.rev);
        assert.deepEqual(made.map((m) => m.rev), [1, 2, 3, 4, 5, 6].map((n) => head.rev + n));
        const after = await getState(baseUrl);
        assert.equal(after.rev, head.rev + 6);
        assert.deepEqual(after.board.projects.todo.map((c) => c.id), ["t_conc_0001", ...made.map((m) => m.card.id)]);
        const ranks = (await db.query<{ n: number }>(
          `SELECT count(DISTINCT rank)::int AS n FROM cards WHERE column_id = 'todo' AND deleted_at IS NULL`,
        )).rows[0].n;
        assert.equal(ranks, 7);
      });

      await step("create and patch are refused with a 507 at the 2 MiB budget, writing nothing", async () => {
        const board = (note: string) => ({
          projects: { todo: [card("t_full_0001", "koder", { note }), card("t_full_0002")] },
          life: {},
          lifeMeta: {},
        });
        const empty = await putBoard(baseUrl, board(""));
        const base = Buffer.byteLength(JSON.stringify(empty.board));
        const slack = 3000; // room for a small ticket, not for a 5000-char note
        const full = await putBoard(baseUrl, board("x".repeat(PG_BOARD_MAX - slack - base)));
        assert.equal(Buffer.byteLength(JSON.stringify(full.board)), PG_BOARD_MAX - slack);
        const noRowsAfter = async () =>
          assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM revisions WHERE rev > $1`, [full.rev])).rows[0].n, 0);

        const refusals = [
          await createTicket({ title: "over budget", note: "n".repeat(5000) }),
          await patchBody("t_full_0002", { note: "n".repeat(5000) }),
        ];
        for (const res of refusals) {
          assert.equal(res.status, 507);
          const body = await res.json() as { error: string; size: number; limit: number };
          assert.match(body.error, /^board store full: \d+ of 2097152 bytes — archive done tickets to free space$/);
          assert.equal(body.limit, PG_BOARD_MAX);
          assert.ok(body.size > PG_BOARD_MAX);
        }
        await assertUntouched(full);
        await noRowsAfter();

        // Under the budget it still lands, and an edit that frees room does too.
        assert.equal((await createTicket({ title: "fits" })).status, 201);
        assert.equal((await patchBody("t_full_0001", { note: "" })).status, 200);
        assert.equal((await createTicket({ title: "n".repeat(300), note: "n".repeat(5000) })).status, 201);
      });

      await step("concurrent identical POST /archive: exactly one batch is counted as archived", async () => {
        const batch = [archived("t_archc_0001", 10), archived("t_archc_0002", 20)];
        const responses = await Promise.all([1, 2, 3, 4, 5].map(() => call("POST", "/archive", { cards: batch })));
        const bodies = await Promise.all(responses.map(async (r) => {
          assert.equal(r.status, 200);
          return await r.json() as Record<string, number>;
        }));
        const landed = bodies.filter((b) => "chunk" in b);
        assert.equal(landed.length, 1, JSON.stringify(bodies));
        assert.deepEqual([landed[0].archived, landed[0].duplicates], [2, 0]);
        for (const b of bodies.filter((x) => !("chunk" in x))) {
          assert.deepEqual([b.archived, b.duplicates], [0, 2]);
        }
        const mine = (await readArchive()).cards.filter((c) => c.id.startsWith("t_archc_"));
        assert.deepEqual(mine.map((c) => c.id), ["t_archc_0002", "t_archc_0001"]); // newest archivedAt first
        const seqs = (await db.query<{ id: string }>(`SELECT id FROM archived_cards WHERE id LIKE 't_archc_%' ORDER BY seq`)).rows;
        assert.deepEqual(seqs.map((r) => r.id), ["t_archc_0001", "t_archc_0002"]);
      });

      await step("PUT keeps stored pr/prRev and can't forge, strip or replace them", async () => {
        // The webhook port is slice 2's; the database stands in for it here.
        let state = await seedBoard(baseUrl, {
          doing: [card("t_ticket_1a2b", "koder", { pr: "KodaAllison/koder#40", prRev: 1 })],
        });
        assert.equal("pr" in state.board.projects.doing[0], false);
        assert.equal("prRev" in state.board.projects.doing[0], false);

        await db.query(`UPDATE cards SET pr = 'KodaAllison/koder#41', pr_rev = 1 WHERE id = 't_ticket_1a2b'`);
        state = await getState(baseUrl);
        assert.equal(state.board.projects.doing[0].pr, "KodaAllison/koder#41");
        assert.equal(state.board.projects.doing[0].prRev, 1);
        // pr/prRev come last, where preserveWorkflowMetadata left them on KV.
        assert.deepEqual(Object.keys(state.board.projects.doing[0]).slice(-2), ["pr", "prRev"]);

        const stripped = structuredClone(state.board);
        const moved = stripped.projects.doing.pop()!;
        delete moved.pr;
        delete moved.prRev;
        moved.title = "browser edit without metadata";
        stripped.projects.review = [moved];
        state = await putBoard(baseUrl, stripped);
        assert.equal(state.board.projects.review[0].title, "browser edit without metadata");
        assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
        assert.equal(state.board.projects.review[0].prRev, 1);

        const forged = structuredClone(state.board);
        forged.projects.review[0].pr = "KodaAllison/koder#999";
        forged.projects.review[0].prRev = 7;
        state = await putBoard(baseUrl, forged);
        assert.equal(state.board.projects.review[0].pr, "KodaAllison/koder#41");
        assert.equal(state.board.projects.review[0].prRev, 1);

        // Across boards too: the card keeps its link wherever it is moved.
        const toLife = structuredClone(state.board);
        toLife.life = { todo: toLife.projects.review.splice(0, 1) };
        state = await putBoard(baseUrl, toLife);
        assert.equal(state.board.life.todo[0].pr, "KodaAllison/koder#41");

        // Deleted, then sent again (as an old tab would): it comes back as a
        // new card, without the link, as KV's preserveWorkflowMetadata had it.
        const gone = await putBoard(baseUrl, { projects: { review: [] }, life: { todo: [] }, lifeMeta: {} });
        assert.deepEqual(gone.board.life.todo, []);
        state = await putBoard(baseUrl, {
          projects: { review: [card("t_ticket_1a2b", "koder", { pr: "KodaAllison/koder#41", prRev: 1 })] },
          life: {},
          lifeMeta: {},
        });
        assert.equal("pr" in state.board.projects.review[0], false);
        assert.equal("prRev" in state.board.projects.review[0], false);
      });

      await step("duplicate ids in one PUT: the first occurrence wins, deterministically", async () => {
        const board = {
          projects: {
            todo: [card("t_dup_0001", "koder", { title: "first" }), card("t_dup_0002", "koder", { title: "kept" })],
            doing: [card("t_dup_0001", "koder", { title: "second" })],
          },
          life: { todo: [card("t_dup_0002", "koder", { title: "life copy" })] },
          lifeMeta: {
            focus: [{ id: "i_dup_1", text: "focus", done: false }],
            dates: [],
            notes: "",
            stickies: [{ id: "i_dup_1", text: "sticky copy", color: "yellow" }],
          },
        };
        const first = await putBoard(baseUrl, board);
        assert.deepEqual(first.board.projects.todo.map((c) => c.title), ["first", "kept"]);
        assert.deepEqual(first.board.projects.doing, []);
        assert.deepEqual(first.board.life.todo, []);
        assert.deepEqual(first.board.lifeMeta.focus, [{ id: "i_dup_1", text: "focus", done: false }]);
        assert.deepEqual(first.board.lifeMeta.stickies, []);
        const again = await putBoard(baseUrl, board);
        assert.equal(again.rev, first.rev + 1);
        assert.deepEqual(again.board, first.board);
      });

      await step("round trip: random successive boards come back from GET as they were PUT", async () => {
        const seed = Number(process.env.KODER_TEST_SEED ?? Math.floor(Math.random() * 2 ** 31));
        const g = generator(seed);
        let put = 0;
        try {
          for (let run = 0; run < 3; run++) {
            let board = randomBoard(g, `r${run}`);
            for (let edit = 0; edit < 8; edit++) {
              if (edit > 0) board = mutateBoard(g, board, `r${run}e${edit}`);
              put++;
              const head = await getState(baseUrl);
              const res = await call("PUT", "/state", { baseRev: head.rev, board });
              assert.equal(res.status, 200, await res.clone().text());
              const { rev } = await res.json() as { rev: number };
              assert.equal(rev, head.rev + 1);
              const got = await getState(baseUrl);
              assert.equal(got.rev, rev);
              assertRoundTrip(got.board, board);
            }
          }
        } catch (err) {
          // A new error, not an edited message: the reporter prints an
          // assertion's original text, and the seed is the part that matters.
          throw new Error(
            `round trip failed at PUT #${put}; rerun with KODER_TEST_SEED=${seed}: ` +
              (err instanceof Error ? err.message : String(err)),
            { cause: err },
          );
        }
      });

      await step("GET /state 304s and CORS, and PUT /state's refusals keep their shapes", async () => {
        const auth = { Authorization: `Bearer ${TOKEN}` };
        const seeded = await seedBoard(baseUrl, { doing: [card()] });
        const etag = `"${seeded.rev}"`;
        const first = await fetch(`${baseUrl}/state`, { headers: auth });
        assert.equal(first.status, 200);
        assert.equal(first.headers.get("etag"), etag);
        assert.equal(first.headers.get("cache-control"), "no-cache");
        assert.equal(first.headers.get("vary"), "Authorization");
        assert.equal(first.headers.get("content-type"), "application/json");
        assert.equal(first.headers.get("access-control-allow-origin"), "*");
        assert.equal(first.headers.get("access-control-expose-headers"), "ETag");
        await first.body?.cancel();
        for (const inm of [etag, `W/${etag}`, `"0", ${etag}`, "*"]) {
          const hit = await fetch(`${baseUrl}/state`, { headers: { ...auth, "If-None-Match": inm } });
          assert.equal(hit.status, 304, inm);
          assert.equal(hit.headers.get("etag"), etag);
          assert.equal(hit.headers.get("vary"), "Authorization");
          assert.equal(await hit.text(), "");
        }
        const miss = await fetch(`${baseUrl}/state`, { headers: { ...auth, "If-None-Match": `"${seeded.rev + 9}"` } });
        assert.equal(miss.status, 200);
        assert.equal((await miss.json() as Doc).rev, seeded.rev);

        const preflight = await fetch(`${baseUrl}/state`, { method: "OPTIONS" });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, PUT, POST, PATCH, DELETE, OPTIONS");
        assert.equal(preflight.headers.get("access-control-allow-headers"), "Authorization, Content-Type, If-None-Match");
        assert.equal(preflight.headers.get("access-control-max-age"), "86400");

        const put = (body: unknown, raw?: string) => call("PUT", "/state", body, raw);
        const stale = await put({ baseRev: seeded.rev - 1, board: seeded.board });
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { error: "conflict: baseRev is stale", rev: seeded.rev });
        const noBase = await put({ board: seeded.board });
        assert.equal(noBase.status, 409);
        assert.deepEqual(await noBase.json(), { error: "conflict: baseRev is stale", rev: seeded.rev });
        const badJson = await put(undefined, "{nope");
        assert.equal(badJson.status, 400);
        assert.deepEqual(await badJson.json(), { error: "invalid JSON" });
        for (
          const board of [
            null,
            { projects: { todo: [{ id: "t_x" }] } },
            { projects: { todo: "not a list" } },
            { projects: { todo: [null] } },
            { lifeMeta: "notes" },
          ]
        ) {
          const res = await put({ baseRev: seeded.rev, board });
          assert.equal(res.status, 400, JSON.stringify(board));
          assert.deepEqual(await res.json(), { error: "expected { baseRev, board } with board-shaped board" });
        }
        const noAuth = await fetch(`${baseUrl}/state`, { method: "PUT", body: JSON.stringify({ baseRev: seeded.rev, board: seeded.board }) });
        assert.equal(noAuth.status, 401);
        assert.deepEqual(await noAuth.json(), { error: "unauthorized" });
        const wrongToken = await fetch(`${baseUrl}/state`, { headers: { Authorization: "Bearer nope" } });
        assert.equal(wrongToken.status, 401);
        const unknown = await call("DELETE", "/state");
        assert.equal(unknown.status, 404);
        assert.deepEqual(await unknown.json(), { error: "not found" });
        const webhookGet = await fetch(`${baseUrl}/webhooks/github`);
        assert.equal(webhookGet.status, 405);
        assert.deepEqual(await webhookGet.json(), { error: "method not allowed" });
        await assertUntouched(seeded);
      });

      await step("PR status with a link on the board: auth, method, no refs, and 503 without GITHUB_TOKEN", async () => {
        const empty = await seedBoard(baseUrl, { doing: [card()] });
        assert.equal((await fetch(`${baseUrl}/pr-status`)).status, 401);
        assert.equal((await call("POST", "/pr-status", {})).status, 405);
        const none = await call("GET", "/pr-status");
        assert.equal(none.status, 200);
        assert.deepEqual(await none.json(), {});
        await db.query(`UPDATE cards SET pr = 'KodaAllison/koder#22', pr_rev = 1 WHERE id = 't_ticket_1a2b'`);
        const unavailable = await call("GET", "/pr-status");
        assert.equal(unavailable.status, 503);
        assert.deepEqual(await unavailable.json(), { error: "PR status temporarily unavailable" });
        assert.equal((await getState(baseUrl)).rev, empty.rev);
      });

      await step("U+0000 and lone surrogates are stored as U+FFFD, not refused", async () => {
        const odd = "a\u0000b \uD800 c\uDC00";
        const clean = "a�b � c�";
        const res = await call("PUT", "/state", {
          baseRev: (await getState(baseUrl)).rev,
          board: {
            projects: {
              [`col ${odd}`]: [{
                ...card("t_odd_0001"),
                title: `title ${odd}`,
                note: `note ${odd}`,
                [`key ${odd}`]: { nested: [`deep ${odd}`] },
              }],
            },
            life: {},
            lifeMeta: { focus: [], dates: [], notes: `notes ${odd}`, stickies: [] },
          },
        });
        assert.equal(res.status, 200, await res.clone().text());
        const board = (await getState(baseUrl)).board;
        assert.deepEqual(Object.keys(board.projects), [`col ${clean}`]);
        const stored = board.projects[`col ${clean}`][0] as unknown as Record<string, unknown>;
        assert.equal(stored.title, `title ${clean}`);
        assert.equal(stored.note, `note ${clean}`);
        assert.deepEqual(stored[`key ${clean}`], { nested: [`deep ${clean}`] });
        assert.equal(board.lifeMeta.notes, `notes ${clean}`);
      });

      await step("a null, absent or array-shaped board comes back as an object", async () => {
        // The KV server stored these as sent; rows give them back the way the
        // client's normalize() reads them anyway (exception (7) in pg-store.ts).
        const head = await getState(baseUrl);
        const res = await call("PUT", "/state", {
          baseRev: head.rev,
          board: { projects: [[card("t_arr_0001")], []], lifeMeta: {} },
        });
        assert.equal(res.status, 200);
        let board = (await getState(baseUrl)).board;
        assert.deepEqual(board.projects, { 0: [card("t_arr_0001")], 1: [] });
        assert.deepEqual(board.life, {});
        await putBoard(baseUrl, { projects: null, life: null, lifeMeta: {} } as unknown as Doc["board"]);
        board = (await getState(baseUrl)).board;
        assert.deepEqual(board.projects, {});
        assert.deepEqual(board.life, {});
      });

      await step("a request path starting with // is a path, not a host", async () => {
        const url = new URL(baseUrl);
        const raw = (method: string, path: string) =>
          new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
            const req = httpRequest(
              { host: url.hostname, port: url.port, path, method, headers: { Authorization: `Bearer ${TOKEN}` } },
              (res) => {
                let body = "";
                res.on("data", (d: Buffer) => (body += d.toString()));
                res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body }));
              },
            );
            req.on("error", reject);
            req.end();
          });
        // As under Deno: "//x/state" isn't /state, so a GET is a static
        // request, normalised with a redirect as serveDir did, and any other
        // method is the API's 404.
        const get = await raw("GET", "//x/state");
        assert.equal(get.status, 301);
        assert.equal(get.location, "/x/state");
        const put = await raw("PUT", "//x/state");
        assert.equal(put.status, 404);
        assert.deepEqual(JSON.parse(put.body), { error: "not found" });
        assert.equal((await raw("GET", "/state")).status, 200);
      });

      await step("GET /tickets flattens the projects board with refs and filters", async () => {
        await seedBoard(baseUrl, {
          todo: [card("t_list_0a01", "koder"), card("t_list_0b02", "holitrackr")],
          doing: [card("t_list_0c03", null as unknown as string)],
        });
        const listed = async (query = "") => {
          const res = await call("GET", `/tickets${query}`);
          assert.equal(res.status, 200);
          return (await res.json() as { tickets: (Card & { column: string; ref: string })[] }).tickets;
        };
        assert.deepEqual((await listed()).map((t) => [t.id, t.column, t.ref]), [
          ["t_list_0a01", "todo", "KODER-0A01"],
          ["t_list_0b02", "todo", "HOLIT-0B02"],
          ["t_list_0c03", "doing", "NOPROJ-0C03"],
        ]);
        assert.deepEqual((await listed("?project=holitrackr")).map((t) => t.id), ["t_list_0b02"]);
        assert.deepEqual((await listed("?column=doing")).map((t) => t.id), ["t_list_0c03"]);
        assert.equal((await fetch(`${baseUrl}/tickets`)).status, 401);
      });

      await step("the PWA's files are served without auth, and nothing else in the repo is", async () => {
        const root = fileURLToPath(new URL("../../", import.meta.url));
        for (
          const [path, file, type] of [
            ["/", "index.html", "text/html; charset=UTF-8"],
            ["/index.html", "index.html", "text/html; charset=UTF-8"],
            ["/sw.js", "sw.js", "text/javascript; charset=UTF-8"],
            ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json; charset=UTF-8"],
            ["/css/styles.css", "css/styles.css", "text/css; charset=UTF-8"],
            ["/js/app.js", "js/app.js", "text/javascript; charset=UTF-8"],
            ["/js/ref.js", "js/ref.js", "text/javascript; charset=UTF-8"],
            ["/js/projects.json", "js/projects.json", "application/json; charset=UTF-8"],
            ["/icons/icon-192.png", "icons/icon-192.png", "image/png"],
          ]
        ) {
          const res = await fetch(`${baseUrl}${path}`);
          assert.equal(res.status, 200, path);
          assert.equal(res.headers.get("content-type"), type, path);
          assert.deepEqual(Buffer.from(await res.arrayBuffer()), await readFile(`${root}${file}`), path);
          const etag = res.headers.get("etag");
          assert.match(etag ?? "", /^W\/"/, path);
          assert.ok(res.headers.get("last-modified"), path);
          const again = await fetch(`${baseUrl}${path}`, { headers: { "If-None-Match": etag! } });
          assert.equal(again.status, 304, path);
          assert.equal(await again.text(), "", path);
        }

        // The rest of the repo, dotfiles, unknown files and bare directories.
        for (
          const path of [
            "/server/main.ts", "/server/deno.json", "/api/src/main.ts", "/api/package.json",
            "/docs/specs/storage-expansion.md", "/scripts/koder-ticket.sh", "/tests/store.test.mjs",
            "/package.json", "/README.md", "/CLAUDE.md", "/.git/HEAD", "/.gitignore", "/js/.secret",
            "/nope.html", "/js/nope.js", "/js/", "/spike/db",
          ]
        ) {
          const res = await fetch(`${baseUrl}${path}`);
          assert.equal(res.status, 404, path);
          assert.equal(await res.text(), "Not Found", path);
        }

        // Paths as sent on the wire (fetch would normalise them first).
        const raw = (path: string) =>
          new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
            const url = new URL(baseUrl);
            httpGet({ host: url.hostname, port: url.port, path }, (res) => {
              let body = "";
              res.on("data", (d: Buffer) => (body += d.toString()));
              res.on("end", () => resolve({ status: res.statusCode!, location: res.headers.location, body }));
            }).on("error", reject);
          });
        for (
          const [path, location] of [
            // An encoded slash survives URL parsing and is only decoded here,
            // so its ".." is resolved by the static server: a redirect to
            // the canonical path, which is then refused like any other.
            ["/js/..%2F..%2Fserver%2Fmain.ts", "/server/main.ts"],
            ["/js//app.js", "/js/app.js"],
            ["/js/app.js/", "/js/app.js"],
            ["/js", "/js/"],
          ]
        ) {
          const res = await raw(path);
          assert.equal(res.status, 301, path);
          assert.equal(res.location, location, path);
        }
        // Plain and %2e dot segments are resolved by URL parsing before the
        // static server sees the path; a backslash, NUL or broken escape is
        // refused outright.
        for (const path of ["/js/../server/main.ts", "/css/%2e%2e/.git/HEAD", "/js/..%5C..%5Cserver%5Cmain.ts", "/js/app.js%00.png", "/js/%E0%A4%A", "/js/C:..%5C..%5Cpackage.json"]) {
          const res = await raw(path);
          assert.equal(res.status, 404, path);
        }
      });

      /* ---- History, restore and the webhook, seen from Postgres. There are
       * no snapshots: board@N is the live rows with the `changes` log undone
       * back to N, so these check that every writer logs enough for that to
       * come out byte for byte, and that the webhook's delivery row and its
       * move are one transaction. ---- */

      // GET /state as sent: the body text, which is what a client stores.
      const stateText = async (path = "/state") => {
        const res = await call("GET", path);
        assert.equal(res.status, 200, path);
        const text = await res.text();
        return { text, doc: JSON.parse(text) as Doc };
      };
      const listRevisions = async () => {
        const res = await call("GET", "/revisions");
        assert.equal(res.status, 200);
        return (await res.json() as { revisions: { rev: number; updatedAt: string }[] }).revisions;
      };
      const tableCounts = async () =>
        (await db.query<Record<string, number>>(
          `SELECT (SELECT count(*) FROM revisions)::int AS revisions,
                  (SELECT count(*) FROM changes)::int AS changes,
                  (SELECT count(*) FROM webhook_deliveries)::int AS deliveries,
                  (SELECT count(*) FROM archived_cards)::int AS archived`,
        )).rows[0];
      const deliveryRow = async (id: string) =>
        (await db.query<{ outcome: string; rev: number }>(
          `SELECT outcome, rev::int AS rev FROM webhook_deliveries WHERE delivery_id = $1`, [id],
        )).rows;
      const pullRequest = (number: number, title: string, action = "opened") => ({
        action,
        repository: { full_name: "KodaAllison/koder" },
        pull_request: { number, title, body: null, merged: action === "closed" },
      });

      await step("history: after a random run of every kind of write, GET /state?rev=N is byte for byte what GET /state said at N", async () => {
        const seed = Number(process.env.KODER_TEST_SEED ?? Math.floor(Math.random() * 2 ** 31));
        let action = "";
        try {
          for (const runSeed of [seed, seed + 1]) {
            const g = generator(runSeed);
            // Start from a full random board: both boards, lifeMeta items, notes.
            await seedBoard(baseUrl, {});
            const start = await call("PUT", "/state", {
              baseRev: (await getState(baseUrl)).rev,
              board: randomBoard(g, `h${runSeed % 1000}`),
            });
            assert.equal(start.status, 200);
            const seen = new Map<number, string>(); // rev -> GET /state body
            const first = await stateText();
            seen.set(first.doc.rev, first.text);
            let current = first.doc;
            let graveyard: AnyCard[] = [];
            let prNumber = 1000;
            const projectCards = () =>
              Object.entries(current.board.projects).flatMap(([column, cards]) => cards.map((c) => ({ ...c, column })));
            for (let n = 0; n < 80; n++) {
              const kind = g.int(12);
              const target = g.pick(projectCards());
              action = `run ${runSeed}, write #${n}, kind ${kind}`;
              let res: Response;
              if (kind <= 3 || (kind >= 5 && kind <= 7 && !target)) {
                // A tab's sync: moves, reorders, deletes, re-adds, edits,
                // columns, lifeMeta, and now and then an unknown top-level key.
                const columns = Object.keys(current.board.projects).length + Object.keys(current.board.life).length;
                const base = structuredClone(current.board) as unknown as AnyBoard;
                Object.defineProperty(base, "_deleted", { value: graveyard, enumerable: false });
                const board = columns ? mutateBoard(g, base, `h${runSeed % 1000}x${n}`) : randomBoard(g, `h${runSeed % 1000}x${n}`);
                graveyard = (board as unknown as { _deleted?: AnyCard[] })._deleted ?? [];
                const top = board as unknown as Record<string, unknown>;
                if (g.chance(0.15)) top.settings = { theme: g.pick(["dark", "light"]), n };
                else if (g.chance(0.1)) delete top.settings;
                res = await call("PUT", "/state", { baseRev: current.rev, board });
              } else if (kind === 4) {
                res = await createTicket({
                  title: text(g),
                  column: g.pick(["backlog", "todo", "doing", "review", "done"]),
                  project: g.pick(["koder", "holitrackr", null]),
                });
              } else if (kind === 5) {
                res = await patchBody(target!.id, g.chance(0.5) ? { title: text(g) } : { note: text(g), priority: "high" });
              } else if (kind === 6) {
                res = await patchBody(target!.id, { column: g.pick(["backlog", "todo", "doing", "review", "done"]) });
              } else if (kind === 7) {
                res = await call("DELETE", `/tickets/${target!.id}`);
              } else if (kind === 8) {
                // A webhook for a ticket with a quotable ref (any outcome will do:
                // moved, unchanged, ignored or refused; only a move bumps rev).
                const tickets = (await (await call("GET", "/tickets")).json() as { tickets: { ref: string }[] }).tickets
                  .filter((t) => /^[A-Z0-9]+-[A-Z0-9]{4}$/.test(t.ref));
                const ref = tickets.length ? g.pick(tickets).ref : "KODER-NONE";
                res = await postWebhook(baseUrl, pullRequest(prNumber++, `${ref} history`, g.chance(0.5) ? "opened" : "closed"));
              } else if (kind === 9) {
                res = await call("POST", "/state/restore", { rev: g.pick([...seen.keys()]) });
              } else if (kind === 10 && target) {
                // Archive is not a board write: no rev, no change to GET /state.
                res = await call("POST", "/archive", { cards: [{ ...target, board: "projects", archivedAt: n }] });
              } else {
                res = await createTicket({ title: `filler ${n}` });
              }
              assert.ok(res.status < 500, `${res.status} ${await res.text()}`);
              const after = await stateText();
              assert.ok(after.doc.rev === current.rev || after.doc.rev === current.rev + 1, "one write is at most one rev");
              if (seen.has(after.doc.rev)) assert.equal(after.text, seen.get(after.doc.rev), "a rev is one body");
              seen.set(after.doc.rev, after.text);
              current = after.doc;
            }

            action = `run ${runSeed}, checking history`;
            const revs = [...seen.keys()].sort((a, b) => a - b);
            assert.deepEqual(revs, revs.map((_, i) => revs[0] + i), "every rev in the run was seen");
            for (const rev of revs) {
              const res = await call("GET", `/state?rev=${rev}`);
              assert.equal(res.status, 200, `rev ${rev}`);
              assert.equal(await res.text(), seen.get(rev), `GET /state?rev=${rev}`);
            }
            const listed = await listRevisions();
            assert.equal(listed[0].rev, current.rev);
            for (let i = 1; i < listed.length; i++) assert.equal(listed[i].rev, listed[i - 1].rev - 1, "newest first, none missing");
            for (const r of listed) {
              if (!seen.has(r.rev)) continue;
              const doc = JSON.parse(seen.get(r.rev)!) as Doc;
              assert.deepEqual(r, { rev: doc.rev, updatedAt: doc.updatedAt });
            }
          }
        } catch (err) {
          // A new error, not an edited message: the seed is the part that matters.
          throw new Error(
            `history failed at ${action}; rerun with KODER_TEST_SEED=${seed}: ` +
              (err instanceof Error ? err.message : String(err)),
            { cause: err },
          );
        }
      });

      await step("restore: an older rev, twice, from before a card existed, then forward writes; links follow the current card", async () => {
        const seen = new Map<number, string>();
        const record = async () => {
          const { text, doc } = await stateText();
          seen.set(doc.rev, text);
          return doc;
        };
        const find = (doc: Doc, id: string) => Object.values(doc.board.projects).flat().find((c) => c.id === id);

        await seedBoard(baseUrl, { todo: [card("t_rest_aaaa"), card("t_rest_bbbb", "koder", { title: "B" })] });
        const unlinked = await record();
        assert.equal((await openPr(40, "KODER-AAAA")).status, 200);
        assert.equal((await openPr(41, "KODER-BBBB")).status, 200);
        const linked = await record();
        const created = await createTicket({ title: "born later", column: "todo" });
        assert.equal(created.status, 201);
        const later = (await created.json() as { card: Card }).card;
        const withLater = await record();
        // A is relinked to a newer PR; B is deleted, link and all.
        assert.equal((await openPr(42, "KODER-AAAA")).status, 200);
        assert.equal((await call("DELETE", "/tickets/t_rest_bbbb")).status, 200);
        const current = await record();
        assert.deepEqual([find(current, "t_rest_aaaa")?.pr, find(current, "t_rest_aaaa")?.prRev], ["KodaAllison/koder#42", 2]);

        // Back to `linked`: A keeps its CURRENT link (#42, 2), B (deleted since)
        // comes back with its own (#41, 1), and the later card is gone. All
        // else is `linked` exactly, key order included.
        const first = await restoreRev(linked.rev);
        assert.equal(first.rev, current.rev + 1);
        const restored = await record();
        const expected = structuredClone(linked.board);
        const a = Object.values(expected.projects).flat().find((c) => c.id === "t_rest_aaaa")!;
        a.pr = "KodaAllison/koder#42";
        a.prRev = 2;
        assert.equal(JSON.stringify(restored.board), JSON.stringify(expected));
        assert.deepEqual([find(restored, "t_rest_bbbb")?.pr, find(restored, "t_rest_bbbb")?.prRev], ["KodaAllison/koder#41", 1]);
        assert.equal(find(restored, later.id), undefined);
        const log = await logged(first.rev);
        assert.deepEqual(log.revisions.map((r) => r.actor), ["restore"]);
        assert.ok(log.changes.every((c) => c.actor === "restore"));

        // Restoring the same rev again is a write of its own, to the same board.
        const second = await restoreRev(linked.rev);
        assert.equal(second.rev, first.rev + 1);
        const twice = await record();
        assert.equal(JSON.stringify(twice.board), JSON.stringify(restored.board));
        assert.deepEqual((await logged(second.rev)).changes, []);

        // The rev after the later card was made brings it back as it was.
        await restoreRev(withLater.rev);
        const back = await record();
        assert.deepEqual(find(back, later.id), find(withLater, later.id));

        // From before any link: both survive now, so both keep their current links.
        await restoreRev(unlinked.rev);
        const oldest = await record();
        assert.deepEqual(oldest.board.projects.todo.map((c) => [c.id, c.pr, c.prRev]), [
          ["t_rest_aaaa", "KodaAllison/koder#42", 2],
          ["t_rest_bbbb", "KodaAllison/koder#41", 1],
        ]);

        // Forward writes after all that: a PUT, a PATCH, a webhook move.
        const edited = structuredClone(oldest.board);
        edited.projects.todo[0].title = "after restore";
        assert.equal((await call("PUT", "/state", { baseRev: oldest.rev, board: edited })).status, 200);
        await record();
        assert.equal((await patchBody("t_rest_bbbb", { column: "doing" })).status, 200);
        await record();
        assert.equal((await openPr(43, "KODER-BBBB")).status, 200);
        const end = await record();
        assert.deepEqual([find(end, "t_rest_bbbb")?.pr, find(end, "t_rest_bbbb")?.prRev], ["KodaAllison/koder#43", 2]);

        // Every rev seen on the way is served back byte for byte.
        for (const [rev, text] of seen) assert.equal((await stateText(`/state?rev=${rev}`)).text, text, `rev ${rev}`);
      });

      await step("webhook: one delivery id fired concurrently moves the card once and bumps rev once", async () => {
        const before = await seedBoard(baseUrl, { doing: [card("t_conc_hook")] });
        /* PGlite runs one transaction at a time and the server pool is 1, so
         * these deliveries are serialised, not truly concurrent: this proves
         * the predicate (the delivery check loaded under the head lock, and
         * ON CONFLICT on the delivery id), not the lock wait itself. */
        const delivery = freshDelivery();
        const responses = await Promise.all(
          Array.from({ length: 6 }, () => postWebhook(baseUrl, pullRequest(60, "KODER-HOOK concurrent"), { delivery })),
        );
        const bodies = await Promise.all(responses.map(async (r) => {
          assert.equal(r.status, 200);
          return await r.json() as { updated: boolean; redelivered?: boolean; rev: number };
        }));
        assert.equal(bodies.filter((b) => b.updated).length, 1, JSON.stringify(bodies));
        assert.equal(bodies.filter((b) => b.redelivered).length, 5, JSON.stringify(bodies));
        assert.ok(bodies.every((b) => b.rev === before.rev + 1), JSON.stringify(bodies));
        const after = await getState(baseUrl);
        assert.equal(after.rev, before.rev + 1);
        assert.deepEqual(after.board.projects.review.map((c) => [c.id, c.pr, c.prRev]), [["t_conc_hook", "KodaAllison/koder#60", 1]]);
        assert.deepEqual(await deliveryRow(delivery), [{ outcome: "moved", rev: before.rev + 1 }]);
        assert.deepEqual((await logged(after.rev)).revisions.map((r) => r.actor), ["webhook"]);
        // The card, and the review column it created.
        assert.deepEqual(
          (await logged(after.rev)).changes.map((c) => [c.entity, c.entity_id, c.op, c.actor]),
          [["card", "t_conc_hook", "update", "webhook"], ["board", "koda", "update", "webhook"]],
        );

        // One id, two payloads racing: a no-op (recordDelivery) and a move
        // (commitWebhookMove). Whichever records first decides; the rest are
        // redeliveries, and the board moved at most once.
        const mixed = freshDelivery();
        const base = await seedBoard(baseUrl, { doing: [card("t_conc_hook")] });
        const raced = await Promise.all(Array.from({ length: 6 }, (_, i) =>
          postWebhook(baseUrl, pullRequest(61, "KODER-HOOK mixed", i % 2 ? "synchronize" : "opened"), { delivery: mixed })
        ));
        const raceBodies = await Promise.all(raced.map((r) => r.json())) as { updated?: boolean; ignored?: string }[];
        const rows = await deliveryRow(mixed);
        assert.equal(rows.length, 1);
        const final = await getState(baseUrl);
        const moves = raceBodies.filter((b) => b.updated === true).length;
        if (rows[0].outcome === "moved") {
          assert.equal(moves, 1);
          assert.equal(final.rev, base.rev + 1);
        } else {
          assert.equal(rows[0].outcome, "noop");
          assert.equal(moves, 0);
          assert.equal(final.rev, base.rev);
        }
        assert.equal(raceBodies.filter((b) => b.updated === undefined && b.ignored === undefined).length, 0);
      });

      /* Fault injection through the database the harness holds: a trigger that
       * raises a chosen SQLSTATE on insert, installed and removed from the
       * test. Nothing in the server knows about it.
       *
       * Two quirks of PGlite behind pglite-socket 0.2.11 shape these steps;
       * neither is Postgres behaviour (on a real server each connection is
       * its own session and replies come in order):
       *  - when a statement in the MIDDLE of a pipelined batch fails, replies
       *    get out of step (the server can see 25P02 instead of the injected
       *    code, and PGlite answer a later query with the wrong rows), so each
       *    fault sits on the LAST statement of the write's batch: the
       *    revisions row; the delivery row for a webhook move; the only
       *    statement of a delivery no-op or an archive. That still fails the
       *    transaction after every other write in it;
       *  - after a failed transaction the server can answer before PGlite has
       *    run its ROLLBACK, and the test's `db` shares PGlite's one session,
       *    so settled() waits for the session to leave the aborted transaction
       *    before the test touches the database. */
      const settled = async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            await db.query("SELECT 1");
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        throw new Error("PGlite's session never left the failed transaction");
      };
      await db.exec(`
        CREATE FUNCTION koder_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected fault on %', TG_TABLE_NAME USING ERRCODE = TG_ARGV[0];
        END $$`);
      const injectFault = (table: string, code: string) =>
        db.exec(`CREATE TRIGGER koder_test_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION koder_test_fault('${code}')`);
      const removeFault = (table: string) => db.exec(`DROP TRIGGER koder_test_fault ON ${table}`);

      await step("a webhook move and its delivery row commit together or not at all", async () => {
        const before = await seedBoard(baseUrl, { doing: [card("t_atom_hook")] });
        const counts = await tableCounts();
        const delivery = freshDelivery();
        const payload = pullRequest(70, "KODER-HOOK atomic");
        // The delivery insert fails after the head update, the card's new
        // row, its changes row and the revisions row have all been written
        // in the same transaction.
        await injectFault("webhook_deliveries", "P0001");
        try {
          assert.equal((await postWebhook(baseUrl, payload, { delivery })).status, 500);
        } finally {
          await settled();
          await removeFault("webhook_deliveries");
        }
        await assertUntouched(before);
        assert.deepEqual(await tableCounts(), counts);
        assert.deepEqual(await deliveryRow(delivery), []);
        assert.deepEqual(
          (await db.query(`SELECT pr FROM cards WHERE id = 't_atom_hook'`)).rows,
          [{ pr: null }],
        );

        // GitHub's redelivery of the same id then lands, once.
        const retry = await postWebhook(baseUrl, payload, { delivery });
        assert.equal(retry.status, 200);
        assert.equal((await retry.json() as { updated: boolean }).updated, true);
        assert.equal((await getState(baseUrl)).rev, before.rev + 1);
        assert.deepEqual(await deliveryRow(delivery), [{ outcome: "moved", rev: before.rev + 1 }]);
      });

      await step("contention (40001, 55P03) on any write is a 503 that leaves no trace, and the retry lands", async () => {
        const contention = { error: "write contention, retry" };
        /* Fault on `table`, send `request`: 503, and the board, rev and every
         * history/delivery/archive table exactly as they were. Then remove the
         * fault and send the same request again: `ok`. */
        const faulted = async (code: string, table: string, request: () => Promise<Response>, ok: number) => {
          const before = await getState(baseUrl);
          const counts = await tableCounts();
          await injectFault(table, code);
          try {
            const res = await request();
            assert.equal(res.status, 503, `${code} on ${table}`);
            assert.deepEqual(await res.json(), contention);
          } finally {
            await settled();
            await removeFault(table);
          }
          await assertUntouched(before);
          assert.deepEqual(await tableCounts(), counts, `${code} on ${table}`);
          const res = await request();
          assert.equal(res.status, ok, `${code} on ${table}, retried: ${await res.clone().text()}`);
          return res;
        };
        for (const code of ["40001", "55P03"]) {
          const seeded = await seedBoard(baseUrl, {
            todo: [card("t_fault_0001"), card("t_fault_0002"), card("t_fault_hook")],
          });
          const edited = structuredClone(seeded.board);
          edited.projects.todo[0].title = `edited under ${code}`;
          await faulted(code, "revisions", () => call("PUT", "/state", { baseRev: seeded.rev, board: edited }), 200);
          await faulted(code, "revisions", () => createTicket({ title: `made under ${code}` }), 201);
          await faulted(code, "revisions", () => patchBody("t_fault_0001", { column: "doing" }), 200);
          await faulted(code, "revisions", () => call("DELETE", "/tickets/t_fault_0002"), 200);
          await faulted(code, "revisions", () => call("POST", "/state/restore", { rev: seeded.rev }), 200);

          // The webhook: a move (board write), a no-op decided on the board
          // (commitWebhookMove), and one decided without it (recordDelivery).
          const move = freshDelivery();
          const moved = await faulted(code, "webhook_deliveries", () => postWebhook(baseUrl, pullRequest(80, "KODER-HOOK fault"), { delivery: move }), 200);
          assert.equal((await moved.json() as { updated: boolean }).updated, true);
          assert.equal((await deliveryRow(move))[0].outcome, "moved");
          const noRef = freshDelivery();
          await faulted(code, "webhook_deliveries", () => postWebhook(baseUrl, pullRequest(81, "no ref here"), { delivery: noRef }), 202);
          assert.equal((await deliveryRow(noRef))[0].outcome, "ignored: no ticket ref");
          const noop = freshDelivery();
          await faulted(code, "webhook_deliveries", () => postWebhook(baseUrl, pullRequest(82, "KODER-HOOK", "synchronize"), { delivery: noop }), 202);
          assert.equal((await deliveryRow(noop))[0].outcome, "noop");

          // The archive.
          const lifted = await faulted(code, "archived_cards", () => call("POST", "/archive", { cards: [archived(`t_fault_arch${code}`, 1)] }), 200);
          assert.equal((await lifted.json() as { archived: number }).archived, 1);
        }
        await db.exec(`DROP FUNCTION koder_test_fault()`);
      });

      await step("a long history: /revisions lists the newest 200, and older revs are still served and restorable", async () => {
        const seeded = await seedBoard(baseUrl, { todo: [card("t_long_0001")] });
        const oldestOfStep = await stateText();
        let rev = seeded.rev;
        for (let i = 0; i < 300; i++) {
          const todo = [card("t_long_0001", "koder", { title: `v${i}` })];
          if (i % 3 === 0) todo.push(card(`t_long_x${i}`));
          const res = await call("PUT", "/state", { baseRev: rev, board: { projects: { todo }, life: {}, lifeMeta: {} } });
          assert.equal(res.status, 200);
          rev = (await res.json() as { rev: number }).rev;
        }
        const head = await stateText();
        assert.equal(head.doc.rev, seeded.rev + 300);

        const listed = await listRevisions();
        assert.equal(listed.length, 200);
        assert.deepEqual(listed[0], { rev: head.doc.rev, updatedAt: head.doc.updatedAt });
        assert.deepEqual(listed.map((r) => r.rev), Array.from({ length: 200 }, (_, i) => head.doc.rev - i));

        // Older than anything listed, and still there.
        assert.equal((await stateText(`/state?rev=${seeded.rev}`)).text, oldestOfStep.text);
        const first = await stateText("/state?rev=1");
        assert.equal(first.doc.rev, 1);
        assert.equal((await call("GET", "/state?rev=0")).status, 404);
        // Integers past 2^53 (and past bigint) are unknown revs, not a 500.
        for (const huge of ["9007199254740993", "99999999999999999999", "1e30"]) {
          const res = await call("GET", `/state?rev=${huge}`);
          assert.equal(res.status, 404, huge);
          assert.match(String(await errorOf(res)), /^no snapshot for rev /);
          assert.equal((await call("POST", "/state/restore", undefined, `{"rev": ${huge}}`)).status, 404, huge);
        }

        // Restoring the database's very first rev, and this step's oldest.
        await restoreRev(1);
        assert.equal(JSON.stringify((await getState(baseUrl)).board), JSON.stringify(first.doc.board));
        await restoreRev(seeded.rev);
        const now = await getState(baseUrl);
        assert.equal(now.rev, head.doc.rev + 2);
        assert.equal(JSON.stringify(now.board), JSON.stringify(oldestOfStep.doc.board));
        assert.equal((await listRevisions())[0].rev, now.rev);
      });
    } finally {
      await server.stop();
      if (server.stderr()) t.diagnostic(`server stderr:\n${server.stderr()}`);
      await database.close();
    }
});

test("Postgres: migrations are idempotent across a restart, and the board survives it", async () => {
  /* Two socket slots, though only one server runs at a time: killing a
   * process on Windows resets its connection, and pglite-socket 0.2.11 never
   * frees the slot of a connection that ended in ECONNRESET, so with one slot
   * the restarted server would be turned away. */
  const database = await freshDatabase(2);
  try {
    let server = await startServer(database.url);
    const board = {
      projects: { todo: [card("t_restart_0001")], doing: [] },
      life: { todo: [card("t_restart_0002", "koder", { title: "life" })] },
      lifeMeta: { focus: [{ id: "f_1", text: "keep me", done: true }], dates: [], notes: "n", stickies: [] },
    };
    const before = await putBoard(server.baseUrl, board);
    await server.stop();

    server = await startServer(database.url);
    try {
      assert.deepEqual(await getState(server.baseUrl), before);
      const after = await putBoard(server.baseUrl, before.board);
      assert.equal(after.rev, before.rev + 1);
    } finally {
      await server.stop();
    }
    const count = async (table: string) =>
      Number((await database.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
    assert.equal(await count("schema_migrations"), 2);
    assert.equal(await count("owners"), 1);
    assert.equal(await count("board_head"), 1);
    assert.equal(await count("life_notes"), 1);
    assert.equal(await count("revisions"), 2);
    // Migration 2 retired the archived flag on cards in favour of its own table.
    const columns = (await database.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'cards'`,
    )).rows.map((row) => row.column_name);
    assert.ok(!columns.includes("archived_at") && !columns.includes("archived_from"));
    assert.equal(await count("archived_cards"), 0);
  } finally {
    await database.close();
  }
});

/* ---- The round-trip property: a seeded generator of boards ---- */

type Rand = { next(): number; int(n: number): number; pick<T>(items: readonly T[]): T; chance(p: number): boolean };

// mulberry32: small, fast, and the same sequence for the same seed everywhere.
function generator(seed: number): Rand {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
  };
}

// Text that has tripped stores before: multi-byte UTF-8, astral emoji, JSON
// and SQL metacharacters, whitespace, and the two things Postgres can't
// store as sent, U+0000 and a lone surrogate (both come back as U+FFFD; see
// storable() below and exception (6) in pg-store.ts).
const WORDS = [
  "Fix", "the", "sync", "—", "em dash", "naïve café", "日本語", "🚀", "👩‍💻", "\"quoted\"", "back\\slash",
  "new\nline", "tab\there", "<b>html</b>", "  padded  ", "→", "100%", "'; DROP TABLE cards; --", "{}", "[]",
  "nul\u0000byte", "lone\uD800high", "\uDC00lone low",
];
const text = (g: Rand) => Array.from({ length: 1 + g.int(4) }, () => g.pick(WORDS)).join(" ");

type AnyCard = Record<string, unknown>;
type AnyBoard = { projects: Record<string, AnyCard[]>; life: Record<string, AnyCard[]>; lifeMeta: Record<string, unknown> };

function randomCard(g: Rand, id: string, boardId: "projects" | "life"): AnyCard {
  const entries: [string, unknown][] = [["id", id], ["title", text(g)]];
  if (g.chance(0.8)) entries.push(["note", g.chance(0.3) ? "" : text(g)]);
  entries.push(["priority", g.chance(0.85) ? g.pick(["low", "med", "high"]) : g.pick(["urgent", 2, null])]);
  entries.push(["created", g.chance(0.9) ? 1_700_000_000_000 + g.int(1e9) : g.pick([1.5, "yesterday", -1])]);
  if (boardId === "projects" && g.chance(0.9)) entries.push(["project", g.pick(["koder", "holitrackr", null, ""])]);
  if (g.chance(0.3)) entries.push(["custom", { nested: [1, text(g), { deep: g.chance(0.5), n: g.int(100) }] }]);
  if (g.chance(0.2)) entries.push(["tags", [text(g), text(g)]]);
  if (g.chance(0.1)) entries.push(["weird key ✓", null]);
  if (g.chance(0.1)) entries.push(["ratio", g.int(1000) / 8]);
  if (g.chance(0.15)) entries.push(["pr", "KodaAllison/koder#9"], ["prRev", 3]); // forged: never stored
  // Key order is part of what round-trips: shuffle all but the id sometimes.
  if (g.chance(0.3)) {
    const rest = entries.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = g.int(i + 1);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    entries.splice(1, rest.length, ...rest);
  }
  return Object.fromEntries(entries);
}

function randomItem(g: Rand, id: string, kind: string): AnyCard {
  if (kind === "focus") return { id, text: text(g), done: g.chance(0.5) };
  if (kind === "dates") return { id, title: text(g), date: `2026-${1 + g.int(12)}-${1 + g.int(28)}` };
  return { id, text: text(g), color: g.pick(["yellow", "pink", "blue"]), ...(g.chance(0.2) ? { pinned: true } : {}) };
}

function randomColumns(g: Rand, boardId: "projects" | "life"): string[] {
  const base = boardId === "projects" ? ["backlog", "todo", "doing", "review", "done"] : ["todo", "doing", "done"];
  const columns = base.filter(() => g.chance(0.85));
  if (g.chance(0.3)) columns.push(g.pick(["someday", "waiting", "col—ü", "7", "col\u0000nul", "col\uD83Dhalf"]));
  return columns.length ? columns : ["todo"];
}

function randomBoard(g: Rand, tag: string): AnyBoard {
  let n = 0;
  const board: AnyBoard = { projects: {}, life: {}, lifeMeta: {} };
  for (const boardId of ["projects", "life"] as const) {
    for (const column of randomColumns(g, boardId)) {
      board[boardId][column] = Array.from(
        { length: g.chance(0.25) ? 0 : g.int(5) },
        () => randomCard(g, `t_${tag}_${boardId[0]}${n++}`, boardId),
      );
    }
  }
  board.lifeMeta = {
    focus: Array.from({ length: g.int(3) }, () => randomItem(g, `i_${tag}_${n++}`, "focus")),
    dates: Array.from({ length: g.int(3) }, () => randomItem(g, `i_${tag}_${n++}`, "dates")),
    notes: g.chance(0.5) ? "" : text(g),
    stickies: Array.from({ length: g.int(3) }, () => randomItem(g, `i_${tag}_${n++}`, "stickies")),
    ...(g.chance(0.2) ? { theme: { dark: true } } : {}),
  };
  return board;
}

/* One random edit of the kinds a real tab makes between syncs, applied 1-4
 * times: move, reorder, delete, re-add a deleted id, edit fields, add cards,
 * add or drop columns, and the same for the lifeMeta lists. */
function mutateBoard(g: Rand, previous: AnyBoard, tag: string): AnyBoard {
  // Deleted cards ride along on the board object, out of sight of JSON and
  // structuredClone, so a later edit can re-add one.
  const graveyard = [...((previous as unknown as { _deleted?: AnyCard[] })._deleted ?? [])];
  const board = structuredClone(previous);
  const columns = () =>
    (["projects", "life"] as const).flatMap((b) => Object.keys(board[b]).map((c) => [b, c] as const));
  const lists = () => columns().map(([b, c]) => board[b][c]);
  let n = 0;
  for (let i = 1 + g.int(4); i > 0; i--) {
    const [b, c] = g.pick(columns());
    const list = board[b][c];
    switch (g.int(8)) {
      case 0: { // move a card anywhere (either board)
        const from = g.pick(lists().filter((l) => l.length));
        if (!from) break;
        const [moved] = from.splice(g.int(from.length), 1);
        list.splice(g.int(list.length + 1), 0, moved);
        break;
      }
      case 1: // reorder a column
        list.reverse();
        if (list.length > 2) list.push(list.shift()!);
        break;
      case 2: { // delete a card
        const from = g.pick(lists().filter((l) => l.length));
        if (from) graveyard.push(from.splice(g.int(from.length), 1)[0]);
        break;
      }
      case 3: { // re-add a deleted id, edited
        const back = graveyard.splice(g.int(graveyard.length), 1)[0];
        if (back) list.push(randomCard(g, back.id as string, b));
        break;
      }
      case 4: { // edit a card's fields
        const target = g.pick(lists().filter((l) => l.length));
        if (!target) break;
        const index = g.int(target.length);
        const edited: AnyCard = { ...target[index], title: text(g) };
        if (g.chance(0.5)) edited.extraField = { at: tag };
        if (g.chance(0.3)) delete edited.note;
        if (g.chance(0.2)) edited.priority = g.pick(["low", "med", "high", "urgent"]);
        target[index] = edited;
        break;
      }
      case 5: // add cards
        for (let k = 1 + g.int(3); k > 0; k--) list.splice(g.int(list.length + 1), 0, randomCard(g, `t_${tag}_${n++}`, b));
        break;
      case 6: // add an empty column, or drop one (its cards go with it)
        if (g.chance(0.5)) board[b][`extra-${tag}`] = [];
        else if (Object.keys(board[b]).length > 1) {
          graveyard.push(...board[b][c]);
          delete board[b][c];
        }
        break;
      case 7: { // lifeMeta: add, drop, edit, reorder; notes
        const kind = g.pick(["focus", "dates", "stickies"]);
        const items = board.lifeMeta[kind] as AnyCard[];
        const op = g.int(4);
        if (op === 0) items.push(randomItem(g, `i_${tag}_${n++}`, kind));
        else if (op === 1 && items.length) items.splice(g.int(items.length), 1);
        else if (op === 2 && items.length) items[0] = randomItem(g, items[0].id as string, kind);
        else items.reverse();
        if (g.chance(0.3)) board.lifeMeta.notes = text(g);
        break;
      }
    }
  }
  Object.defineProperty(board, "_deleted", { value: graveyard, enumerable: false });
  return board;
}

/* GET must give back what was PUT: equal values, the same key order on every
 * card and board, and pr/prRev never taken from a body. Nested values of
 * unknown fields are compared by value only (jsonb doesn't keep their key
 * order). */
/* What the store makes of any string it is sent: U+0000 and lone surrogates
 * replaced with U+FFFD, in keys and values at every depth. Spelled out here
 * rather than imported, so the test states the rule instead of reusing the
 * code under test. */
function storable<T>(value: T): T {
  if (typeof value === "string") {
    let out = "";
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          out += value[i] + value[i + 1];
          i++;
          continue;
        }
      }
      out += unit === 0 || (unit >= 0xD800 && unit <= 0xDFFF) ? "�" : value[i];
    }
    return out as T;
  }
  if (Array.isArray(value)) return value.map(storable) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k), storable(v)])) as T;
  }
  return value;
}

function assertRoundTrip(got: Doc["board"], sent: AnyBoard) {
  const expected = storable(structuredClone(sent));
  for (const b of ["projects", "life"] as const) {
    for (const cards of Object.values(expected[b])) {
      for (const c of cards) {
        delete c.pr;
        delete c.prRev;
      }
    }
  }
  assert.deepEqual(got, expected);
  assert.deepEqual(Object.keys(got), Object.keys(expected));
  for (const b of ["projects", "life"] as const) {
    assert.deepEqual(Object.keys(got[b]), Object.keys(expected[b]), `${b} column order`);
    for (const [column, cards] of Object.entries(expected[b])) {
      cards.forEach((c, i) => assert.deepEqual(Object.keys(got[b][column][i]), Object.keys(c), `${b}.${column}[${i}] key order`));
    }
  }
}
