/* Koder sync server — Deno Deploy + a pluggable Store (Deno KV today).
 *
 * The server is the canonical copy of the board; the PWA keeps localStorage
 * as an offline cache and syncs against this. The board doc is
 *
 *   { rev: number, updatedAt: string|null, board: { projects, life, lifeMeta } }
 *
 * `board` is exactly the shape the client stores under kanban-hub-v1.
 *
 * This file is the HTTP layer: routing, auth, body parsing, status codes,
 * CORS and GitHub resolution. Persistence sits behind the Store interface
 * (store.ts), chosen by KODER_STORE; the only backend so far is KvStore
 * (kv-store.ts), which documents how the doc, snapshots, archive and webhook
 * deliveries are laid out in KV.
 *
 * Concurrency model: monotonic rev + conditional writes.
 *  - PUT /state must send the baseRev it last synced; a stale baseRev gets a
 *    409 and the client merges + retries. This is what stops an open browser
 *    tab from silently overwriting a ticket an agent just POSTed.
 *  - Every write is one atomic step in the store, so two racing writers can't
 *    both land on the same rev.
 *
 * History / undo: every write also snapshots the new doc, and the store keeps
 * the last N (Store.limits.keptRevisions), so a bad push is recoverable.
 * Restore rolls the chosen snapshot forward as a fresh rev (rev never
 * rewinds), so open tabs pull it back like any other change.
 *
 * Terminology — "rev" means different things depending on where you see it:
 *  - The board doc's own `rev` (`Doc.rev`) is the current HEAD: it increments
 *    by exactly 1 on every successful write and is what baseRev is checked
 *    against.
 *  - A `rev` you pass in (`?rev=N`, `POST /state/restore`'s body) instead
 *    names one SPECIFIC past snapshot to look up or restore — same numbering
 *    space as the head, but referring to history, not "the current one".
 *  - The `rev` returned alongside `card` from `POST`/`PATCH /tickets` is the
 *    BOARD's new head rev after that write landed — not a per-ticket
 *    version number. A ticket itself has no revision of its own.
 *
 * Bearer API endpoints (all need `Authorization: Bearer $KODER_TOKEN`):
 *   GET   /state        → full doc (or an empty rev-0 doc on first run)
 *   GET   /state?rev=N   → the snapshot doc at rev N (404 if pruned)
 *   PUT   /state→ { baseRev, board } → { rev, updatedAt } | 409
 *   GET   /revisions     → kept snapshots: [{ rev, updatedAt }], newest first
 *   POST  /state/restore → { rev } → re-lands that snapshot as a new head rev
 *   POST  /tickets      → { title, note?, project?, column?, priority? } → { card, ref, rev }
 *   GET   /tickets      → compact list (each ticket carries its derived `ref`);
 *                         filters: ?project=<id>&column=<id>
 *   PATCH /tickets/:id  → :id is either the raw id or the board's ref (KODER-8CDA);
 *                         any subset of { title, note, priority, project, column }
 *                         → edits the ticket in place; `column` moves it
 *   DELETE /tickets/:id → hard-delete an abandoned/superseded ticket
 *                         → { card, ref, column, rev, board }
 *   POST  /archive      → { cards } → lifts finished cards off the board
 *   GET   /archive      → everything archived so far, newest first
 *
 * Any board write the store can't hold answers 507 { error: "board store full:
 * N of M bytes …", size, limit } (413 for PUT /state) — see StoreFullError.
 *
 * GitHub webhook (no bearer fallback; requires a valid HMAC made with
 * `KODER_WEBHOOK_SECRET`):
 *   POST  /webhooks/github → trusted PR events move a visible-ref ticket
 *
 * Archive: the board can only ever hold Store.limits.boardBytes (64KB as
 * stored, under KV — a write past that is a 507 "board store full"), and Done
 * is the only column that only ever grows. The archive is where done cards go
 * to stop counting against that budget — append-only and separate from the
 * board. Nothing else reads it; it exists so finishing work can't eventually
 * wedge sync (see js/archive.js and kv-store.ts).
 *
 * Env: KODER_TOKEN (required), KODER_WEBHOOK_SECRET (required for the GitHub
 * webhook), KODER_ORIGIN (optional — lock CORS to the deployed board origin
 * instead of "*" once you know it), PORT (optional; defaults to 8000),
 * KODER_STORE (optional storage backend: "kv", the default, is the only one
 * implemented; "pg" and "dual" fail at startup until they are), and
 * KODER_KV_PATH (optional local/test database path; unset on Deno Deploy).
 *
 * Local dev:  KODER_TOKEN=dev deno task dev   (see deno.json)
 */

import { serveDir } from "jsr:@std/http/file-server";
import { fromFileUrl } from "jsr:@std/path";
import { timingSafeEqual } from "node:crypto";
/* The SAME derivation the board renders with — js/ref.js is dependency-free
 * plain ESM precisely so this import works and the two can't drift on what a
 * ref means. Deno does not type-check imported .js (no checkJs in deno.json),
 * so the JSDoc types there are advisory here. */
import { ticketRef } from "../js/ref.js";
import { createGithubResolver, GITHUB_REPOS, parsePullRef } from "./github.ts";
import {
  type ArchivedCard,
  type Board,
  type Card,
  type PutResult,
  type Store,
  StoreContentionError,
  StoreFullError,
  type TicketEdits,
} from "./store.ts";
import { KvStore } from "./kv-store.ts";

const TOKEN = Deno.env.get("KODER_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("KODER_WEBHOOK_SECRET") ?? "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const GITHUB_BODY_MAX = 256 * 1024;

/* Pick the storage backend once, at startup. Anything but a working backend
 * fails here — before the listener opens — rather than on the first request,
 * so a mistyped or not-yet-built KODER_STORE is a deploy failure, not a board
 * that answers 500s. "pg" and "dual" are reserved for the Postgres phases of
 * docs/specs/storage-expansion.md. */
async function openStore(): Promise<Store> {
  const backend = Deno.env.get("KODER_STORE") || "kv";
  switch (backend) {
    case "kv":
      return await KvStore.open(Deno.env.get("KODER_KV_PATH") || undefined);
    case "pg":
    case "dual":
      throw new Error(`KODER_STORE=${backend} is not implemented yet; only "kv" is available`);
    default:
      throw new Error(`unknown KODER_STORE "${backend}"; expected "kv", "pg" or "dual"`);
  }
}
const store = await openStore();

const githubResolver = createGithubResolver(GITHUB_TOKEN);

// Repo root (this file is in server/) — where the PWA's static files live, so
// one app can serve the frontend and the API. Derive from the module URL;
// fall back to cwd (the repo root under Deno Deploy) if it isn't a file URL.
const ROOT = (() => {
  try { return fromFileUrl(new URL("../", import.meta.url)); }
  catch { return "."; }
})();

const PROJECT_COLUMNS = ["backlog", "todo", "doing", "review", "done"];
const PRIORITIES = ["low", "med", "high"];

// Field caps, applied identically on create and edit.
const TITLE_MAX = 300;
const NOTE_MAX = 5000;

// The parts of a ticket a caller may set. Four of them live on the card;
// `column` is the board key the card sits under, not a field on the card.
const SETTABLE_FIELDS = ["title", "note", "priority", "project", "column"] as const;
type TicketFields = TicketEdits & { column?: string };

/* Every board write in the store checks the size in one place: an oversized
 * doc throws StoreFullError, which the request handler turns into a 507
 * (PUT /state answers 413 instead). Its body is { error, size, limit }. */
function storeFullBody(err: StoreFullError) {
  return { error: err.message, size: err.size, limit: err.limit };
}

/* Light shape check for a client-PUT board. The client's normalize() repairs
 * boards on read, but the server is the canonical copy — don't let a buggy
 * caller store something that isn't even board-shaped. Column values must be
 * arrays of objects that at minimum carry an id and a title. */
function isBoardShaped(b: unknown): b is Board {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  for (const key of ["projects", "life"]) {
    const cols = o[key];
    if (cols == null) continue; // client normalize() fills missing boards
    if (typeof cols !== "object") return false;
    for (const cards of Object.values(cols as Record<string, unknown>)) {
      if (!Array.isArray(cards)) return false;
      for (const c of cards) {
        if (!c || typeof c !== "object") return false;
        const card = c as Record<string, unknown>;
        if (typeof card.id !== "string" || typeof card.title !== "string") return false;
      }
    }
  }
  if (o.lifeMeta != null && typeof o.lifeMeta !== "object") return false;
  return true;
}

/* Validate the settable ticket fields present in a request body. POST /tickets
 * and PATCH /tickets/:id both go through here, so the caps and allowed values
 * live in one place and an edit can never store something a create would have
 * rejected. Fields absent from the body are absent from the result: PATCH
 * treats what comes back as the partial update to apply, while POST fills its
 * defaults into the body first (which is also how POST keeps its long-standing
 * leniency — see there). Returns the cleaned values, or the body for a 400. */
function cleanTicketFields(
  body: Record<string, unknown>,
): { fields: TicketFields } | { error: Record<string, unknown> } {
  const fields: TicketFields = {};
  for (const name of SETTABLE_FIELDS) {
    if (!(name in body)) continue;
    const v = body[name];
    switch (name) {
      case "title":
        if (typeof v !== "string" || !v.trim()) {
          return { error: { error: "title must be a non-empty string" } };
        }
        if (v.length > TITLE_MAX) {
          return { error: { error: `title too long (max ${TITLE_MAX} chars)` } };
        }
        fields.title = v.trim();
        break;
      case "note":
        if (typeof v !== "string") return { error: { error: "note must be a string" } };
        if (v.length > NOTE_MAX) {
          return { error: { error: `note too long (max ${NOTE_MAX} chars)` } };
        }
        fields.note = v.trim();
        break;
      case "priority":
        if (typeof v !== "string" || !PRIORITIES.includes(v)) {
          return { error: { error: `invalid priority "${v}"`, valid: PRIORITIES } };
        }
        fields.priority = v;
        break;
      case "project":
        // null and "" both mean unassigned — that's how the client stores it.
        if (v !== null && typeof v !== "string") {
          return { error: { error: "project must be a string or null" } };
        }
        fields.project = v ? v : null;
        break;
      case "column":
        if (typeof v !== "string" || !PROJECT_COLUMNS.includes(v)) {
          return { error: { error: `invalid column "${v}"`, valid: PROJECT_COLUMNS } };
        }
        fields.column = v;
        break;
    }
  }
  return { fields };
}

async function validGithubSignature(raw: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const supplied = Uint8Array.from(
    signature.slice("sha256=".length).match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  return timingSafeEqual(expected, supplied);
}

async function readGithubBody(
  req: Request,
): Promise<{ raw: Uint8Array<ArrayBuffer> } | { status: number; error: string }> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      return { status: 400, error: "invalid Content-Length" };
    }
    if (BigInt(contentLength) > BigInt(GITHUB_BODY_MAX)) {
      return { status: 413, error: `webhook body exceeds ${GITHUB_BODY_MAX} bytes` };
    }
  }

  if (!req.body) return { raw: new Uint8Array() };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GITHUB_BODY_MAX) {
      await reader.cancel();
      return { status: 413, error: `webhook body exceeds ${GITHUB_BODY_MAX} bytes` };
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { raw };
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("KODER_ORIGIN") ?? "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function recordGithubNoop(
  deliveryId: string,
  body: Record<string, unknown>,
  status: number,
): Promise<Response> {
  const recorded = await store.recordDelivery(deliveryId);
  if (recorded.kind === "redelivered") {
    return json({ updated: false, redelivered: true, rev: recorded.rev });
  }
  return json(body, status);
}

/* The authenticated API surface. A GET to anything else is a static frontend
 * request (the PWA's files) and skips the token gate. */
function isApiPath(p: string): boolean {
  return p === "/state" || p === "/state/restore" || p === "/revisions" ||
    p === "/archive" || p === "/pr-status" || p === "/tickets" || p.startsWith("/tickets/");
}

/* A write that can't fit the store is a 507 on every route (a valid request
 * the server has no room for), never a bare 500. PUT /state handles its own
 * case first to keep its long-standing 413. A server-side read-modify-write
 * that keeps losing races is a 503 the caller can retry. */
Deno.serve({ port: PORT }, async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof StoreFullError) return json(storeFullBody(err), 507);
    if (err instanceof StoreContentionError) return json({ error: err.message }, 503);
    throw err;
  }
});

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  /* ---- POST /webhooks/github: GitHub's signed PR event entrypoint ----
   * This route deliberately sits before bearer-token auth. GitHub never gets
   * KODER_TOKEN; authenticity comes only from the SHA-256 webhook signature. */
  if (url.pathname === "/webhooks/github") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!WEBHOOK_SECRET) {
      return json({ error: "server misconfigured: KODER_WEBHOOK_SECRET not set" }, 500);
    }
    const signature = req.headers.get("X-Hub-Signature-256");
    if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
      return json({ error: "invalid webhook signature" }, 401);
    }
    const suppliedDelivery = req.headers.get("X-GitHub-Delivery");
    if (!suppliedDelivery || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedDelivery)) {
      return json({ error: "invalid X-GitHub-Delivery" }, 400);
    }
    const deliveryId = suppliedDelivery.toLowerCase();
    const body = await readGithubBody(req);
    if ("error" in body) return json({ error: body.error }, body.status);
    const raw = body.raw;
    if (!await validGithubSignature(raw, signature)) {
      return json({ error: "invalid webhook signature" }, 401);
    }
    if (await store.hasDelivery(deliveryId)) {
      return json({ updated: false, redelivered: true, rev: (await store.getHead()).rev });
    }
    if (req.headers.get("X-GitHub-Event") !== "pull_request") {
      return await recordGithubNoop(deliveryId, { ignored: "unsupported event" }, 202);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return await recordGithubNoop(deliveryId, { error: "invalid JSON" }, 400);
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      return await recordGithubNoop(deliveryId, { error: "invalid webhook payload" }, 400);
    }
    const payload = decoded as Record<string, unknown>;
    const repository = payload.repository as Record<string, unknown> | null;
    const pullRequest = payload.pull_request as Record<string, unknown> | null;
    const baseRepoName = typeof repository?.full_name === "string" ? repository.full_name : null;
    const repo = baseRepoName && GITHUB_REPOS.has(baseRepoName)
      ? baseRepoName
      : undefined;
    if (!repo) {
      return await recordGithubNoop(deliveryId, { ignored: "untrusted repository" }, 202);
    }
    const action = payload.action;
    if (action !== "opened" && action !== "reopened" && action !== "closed") {
      return await recordGithubNoop(deliveryId, { ignored: "unsupported action" }, 202);
    }
    if (
      !pullRequest || !Number.isInteger(pullRequest.number) || Number(pullRequest.number) < 1 ||
      typeof pullRequest.title !== "string" ||
      (pullRequest.body !== null && typeof pullRequest.body !== "string")
    ) {
      return await recordGithubNoop(deliveryId, { error: "invalid pull_request payload" }, 400);
    }
    const head = pullRequest.head as Record<string, unknown> | null;
    const headRepo = head?.repo as Record<string, unknown> | null;
    if (typeof headRepo?.full_name !== "string") {
      return await recordGithubNoop(deliveryId, { error: "invalid pull_request head repository" }, 400);
    }
    if (headRepo.full_name !== repo) {
      return await recordGithubNoop(
        deliveryId,
        { ignored: "pull request head repository does not match base repository" },
        202,
      );
    }
    let target: "review" | "done" = "review";
    if (action === "closed") {
      if (pullRequest.merged !== true) {
        return await recordGithubNoop(
          deliveryId,
          { ignored: "pull request closed without merge" },
          202,
        );
      }
      target = "done";
    }

    const pr = `${repo}#${pullRequest.number}`;
    const text = `${pullRequest.title}\n${pullRequest.body ?? ""}`;
    /* The store decides the outcome against the board it reads and records the
     * delivery atomically with it — and with the card move, when there is one
     * (see applyWebhookEvent in store.ts for the transition rules). */
    const result = await store.commitWebhookMove({ deliveryId, pr, target, text });
    switch (result.kind) {
      case "redelivered":
        return json({ updated: false, redelivered: true, rev: result.rev });
      case "ignored":
        return json({ ignored: result.ignored, ref: result.ref }, 202);
      case "refused":
        return json(result.error, result.status);
      case "unchanged":
        return json({ updated: false, ref: result.ref, column: result.column, pr, rev: result.rev });
      case "moved":
        return json({ updated: true, ref: result.ref, column: result.column, pr, rev: result.rev });
    }
  }

  if (!TOKEN) return json({ error: "server misconfigured: KODER_TOKEN not set" }, 500);

  /* ---- Static frontend (no auth) ----
   * Any GET that isn't an API path serves the PWA's files, so this one app is
   * also the board a phone loads over HTTPS. The static files are public by
   * design (the repo is public); the board data only moves through the token-
   * gated API. The token itself is NEVER served: it used to be handed out via
   * a generated /js/config.local.js, which gave full read/write to anyone who
   * found the URL. Now each device gets it once via the app's "Connect sync"
   * flow (js/config.local.js remains a gitignored local-dev override, served
   * off disk if present). */
  if (req.method === "GET" && !isApiPath(url.pathname)) {
    return serveDir(req, { fsRoot: ROOT, quiet: true });
  }

  if (req.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  /* Fetched, never stored: only PR refs already attached to canonical project
   * cards are resolved. There is deliberately no caller-supplied repo/number. */
  if (url.pathname === "/pr-status") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const refs = Object.values((await store.readBoard()).board.projects ?? {})
      .flatMap((cards) => cards ?? []).map((card) => card.pr);
    const validCount = refs.filter((ref) => parsePullRef(ref) !== null).length;
    if (validCount === 0) return json({});
    if (!GITHUB_TOKEN) return json({ error: "PR status temporarily unavailable" }, 503);
    return json(await githubResolver.resolve(refs));
  }

  /* ---- GET /state (optionally ?rev=N for a kept snapshot — a specific past
   * revision, not the current head; see the "Terminology" note above) ---- */
  if (url.pathname === "/state" && req.method === "GET") {
    const revParam = url.searchParams.get("rev");
    if (revParam !== null) {
      const requestedRev = Number(revParam);
      if (!Number.isInteger(requestedRev) || requestedRev < 0) {
        return json({ error: "rev must be a non-negative integer" }, 400);
      }
      const snap = await store.boardAt(requestedRev);
      if (!snap) {
        return json({ error: `no snapshot for rev ${requestedRev} (only the last ${store.limits.keptRevisions} are kept)` }, 404);
      }
      return json(snap);
    }
    return json(await store.readBoard());
  }

  /* ---- GET /revisions: the kept restore points, newest first ---- */
  if (url.pathname === "/revisions" && req.method === "GET") {
    return json({ revisions: await store.listRevisions() });
  }

  /* ---- POST /state/restore: re-land a snapshot as a new head rev ----
   * Undo without rewinding: the old board becomes the newest rev, so clients
   * pull it back through the normal rev>SYNC.rev path. The body's `rev`
   * names the snapshot to restore FROM (history), which is a different thing
   * from `restored.rev` below (the new HEAD this restore produces) — kept as
   * separate locals so the two don't get confused. */
  if (url.pathname === "/state/restore" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.rev !== "number" || !Number.isInteger(body.rev)) {
      return json({ error: "rev (integer) is required" }, 400);
    }
    const targetRev = body.rev;
    const restored = await store.restore(targetRev);
    if (!restored) {
      return json({ error: `no snapshot for rev ${targetRev} (only the last ${store.limits.keptRevisions} are kept)` }, 404);
    }
    return json({ rev: restored.rev, restoredFrom: targetRev, updatedAt: restored.updatedAt });
  }

  /* ---- PUT /state: full-board write, conditional on baseRev ---- */
  if (url.pathname === "/state" && req.method === "PUT") {
    // The real size check is the store's, against what it actually stores
    // (see StoreFullError). This only refuses to parse a body that couldn't
    // possibly fit, with the same message shape.
    const limit = store.limits.boardBytes;
    const raw = await req.text();
    if (raw.length > 4 * limit) {
      return json({
        error: `board too large: request body is ${raw.length} characters,` +
          ` store holds ${limit} bytes — archive done tickets to free space`,
        limit,
      }, 413);
    }
    let body: { baseRev?: unknown; board?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (!body || typeof body !== "object" || !isBoardShaped(body.board)) {
      return json({ error: "expected { baseRev, board } with board-shaped board" }, 400);
    }
    if (typeof body.baseRev !== "number") {
      return json({ error: "conflict: baseRev is stale", rev: (await store.getHead()).rev }, 409);
    }
    let res: PutResult;
    try {
      // The store keeps the current server pr/prRev on every card, whatever
      // the body says (see preserveWorkflowMetadata in store.ts).
      res = await store.applyBoardPut(body.baseRev, body.board);
    } catch (err) {
      // The whole board was sent, so "too big" is the request's fault: 413,
      // which the PWA already reads as "archive done cards".
      if (err instanceof StoreFullError) return json(storeFullBody(err), 413);
      throw err;
    }
    if (res.kind === "stale") return json({ error: "conflict: baseRev is stale", rev: res.rev }, 409);
    if (res.kind === "conflict") return json({ error: "conflict: concurrent write, retry" }, 409);
    return json({ rev: res.rev, updatedAt: res.updatedAt });
  }

  /* ---- POST /archive: lift finished cards off the board ----
   * Append-only. The client sends the done cards it is about to drop, and only
   * removes them locally once this returns ok — so a failure here loses
   * nothing, and a retry after a half-failed request is safe because ids
   * already present are skipped rather than duplicated. */
  if (url.pathname === "/archive" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !Array.isArray(body.cards)) {
      return json({ error: "expected { cards: [...] }" }, 400);
    }
    const incoming: ArchivedCard[] = body.cards.filter((c: unknown) => {
      if (!c || typeof c !== "object") return false;
      const card = c as Record<string, unknown>;
      return typeof card.id === "string" && typeof card.title === "string";
    });
    if (!incoming.length) return json({ error: "no id/title-shaped cards in body" }, 400);

    const res = await store.archive(incoming);
    switch (res.kind) {
      // Already archived in full — an idempotent no-op, not an error, so a
      // client retrying a request that actually landed still gets to move on.
      case "duplicates":
        return json({ archived: 0, duplicates: res.duplicates, chunks: res.chunks });
      // A board under the cap can't produce this, but the body is the
      // caller's, so refuse rather than let the store throw a bare 500.
      case "tooLarge":
        return json({
          error: `archive batch too large: ${res.size} of ${res.limit} bytes — send fewer cards`,
          size: res.size,
          limit: res.limit,
        }, 413);
      case "archived":
        return json({ archived: res.archived, duplicates: res.duplicates, chunk: res.chunk });
    }
  }

  /* ---- GET /archive: everything lifted off the board, newest first ---- */
  if (url.pathname === "/archive" && req.method === "GET") {
    const { chunks, cards } = await store.readArchive();
    cards.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    return json({ count: cards.length, chunks, cards });
  }

  /* ---- GET /tickets: compact read for agents ----
   * Flattens the projects board into one list with a `column` field, so a
   * caller can see work without understanding the board document. */
  if (url.pathname === "/tickets" && req.method === "GET") {
    const board = (await store.readBoard()).board;
    const project = url.searchParams.get("project");
    const column = url.searchParams.get("column");
    const tickets: (Card & { column: string; ref: string })[] = [];
    for (const [col, cards] of Object.entries(board.projects ?? {})) {
      if (column && col !== column) continue;
      for (const c of cards ?? []) {
        if (project && c.project !== project) continue;
        // `ref` is derived per response, never stored — see js/ref.js. Callers
        // get it for free, so the CLI doesn't reimplement the rule and neither
        // does any agent hitting this endpoint directly.
        tickets.push({ ...c, column: col, ref: ticketRef(c) });
      }
    }
    return json({ tickets });
  }

  /* ---- PATCH /tickets/:id: move and/or edit a ticket ----
   * Takes any subset of { title, note, priority, project, column }; whatever
   * you leave out is left alone.
   *
   * `column` moves the card, which is the agent workflow: move to "doing"
   * when picking work up, "review" once a PR is raised. "done" is reserved
   * for after merge — a human or a separate reviewing agent moves it there,
   * not the implementing agent.
   *
   * The other four edit the card where it sits, so a title, note, priority or
   * project that was wrong at creation can be fixed from the CLI or by an
   * agent, instead of needing a whole-board PUT /state (which means reading
   * and re-sending the board, and racing the open browser tab for it).
   *
   * Values go through cleanTicketFields, the same validation POST uses, and
   * the write goes through the same atomic read-modify-write. The `rev` in
   * the response is the board's new head after this write, not a revision of
   * the ticket itself — tickets don't have their own version number. */
  const ticketMatch = url.pathname.match(/^\/tickets\/([^/]+)$/);
  /* ---- DELETE /tickets/:id: permanently remove abandoned work ----
   * This is deliberately distinct from moving to done: done is completed
   * work, while deletion is for tickets that should no longer be on the
   * board. The old board remains recoverable through revision snapshots. */
  if (ticketMatch && req.method === "DELETE") {
    const given = ticketMatch[1];
    const res = await store.deleteTicket(given);
    if (res.kind === "unresolved") return json(res.error, res.status);
    const { card, column, rev, board } = res;
    return json({ card, ref: ticketRef(card), column, rev, board });
  }

  if (ticketMatch && req.method === "PATCH") {
    // Not decoded: ids are alphanumeric + underscore and refs are A-Z0-9 with
    // one hyphen, so neither is ever percent-encoded — and decodeURIComponent
    // throws on malformed input like "/tickets/%", turning what should be a
    // 404 into an uncaught 500.
    const given = ticketMatch[1];
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "expected a JSON object body", settable: SETTABLE_FIELDS }, 400);
    }
    const cleaned = cleanTicketFields(body);
    if ("error" in cleaned) return json(cleaned.error, 400);
    const { column, ...edits } = cleaned.fields;
    if (column === undefined && Object.keys(edits).length === 0) {
      return json({ error: "nothing to patch", settable: SETTABLE_FIELDS }, 400);
    }
    const res = await store.patchTicket(given, { column, edits });
    if (res.kind === "unresolved") return json(res.error, res.status);
    return json({ card: res.card, ref: ticketRef(res.card), column: res.column, rev: res.rev });
  }

  /* ---- POST /tickets: the agent/CLI entrypoint ----
   * Server-side read-modify-write, so callers never need the whole board.
   * The `rev` in the response is the board's new head after this write, not
   * a revision of the created ticket — tickets don't have their own version
   * number, they just ride along with whatever the board's head is. */
  if (url.pathname === "/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "title (non-empty string) is required" }, 400);
    }
    /* Fill POST's defaults in BEFORE validating, so create and edit judge the
     * same values through cleanTicketFields. This is also what preserves the
     * leniency POST has always had: an unrecognised priority, or a non-string
     * note/project/column, falls back to the default rather than 400ing.
     * PATCH has no defaults to fall back to and so rejects instead — an edit
     * that silently ignored the value you asked for is worse than an error. */
    if (!PRIORITIES.includes(body.priority)) body.priority = "med";
    if (typeof body.note !== "string") body.note = "";
    if (typeof body.project !== "string" || !body.project) body.project = null;
    if (typeof body.column !== "string" || !body.column) body.column = "backlog";

    const cleaned = cleanTicketFields(body);
    if ("error" in cleaned) return json(cleaned.error, 400);
    const fields = cleaned.fields;
    if (typeof fields.title !== "string") {
      return json({ error: "title (non-empty string) is required" }, 400);
    }
    const column = fields.column ?? "backlog";

    // Matches the client's card shape (saveModal in js/app.js) exactly.
    const card: Card = {
      id: `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 5)}`,
      title: fields.title,
      note: fields.note ?? "",
      priority: fields.priority ?? "med",
      created: Date.now(),
      project: fields.project ?? null,
    };

    const { rev } = await store.createTicket(card, column);
    return json({ card, ref: ticketRef(card), rev }, 201);
  }

  return json({ error: "not found" }, 404);
}
