/* Koder sync server — Deno Deploy + Deno KV.
 *
 * The server is the canonical copy of the board; the PWA keeps localStorage
 * as an offline cache and syncs against this. One KV entry, ["board"], holds:
 *
 *   { rev: number, updatedAt: string|null, board: { projects, life, lifeMeta } }
 *
 * `board` is exactly the shape the client stores under kanban-hub-v1.
 *
 * Concurrency model: monotonic rev + conditional writes.
 *  - PUT /state must send the baseRev it last synced; a stale baseRev gets a
 *    409 and the client merges + retries. This is what stops an open browser
 *    tab from silently overwriting a ticket an agent just POSTed.
 *  - Writes go through kv.atomic().check() so two racing writers can't both
 *    land on the same rev.
 *
 * History / undo: every write also snapshots the new doc under ["board", rev]
 * and prunes the one KEEP_REVISIONS behind, so the last N boards survive a bad
 * push. Restore rolls the chosen snapshot forward as a fresh rev (rev never
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
 * GitHub webhook (no bearer fallback; requires a valid HMAC made with
 * `KODER_WEBHOOK_SECRET`):
 *   POST  /webhooks/github → trusted PR events move a visible-ref ticket
 *
 * Archive: the board is ONE KV value, so it can only ever hold ~60KB, and Done
 * is the only column that only ever grows. The archive is where done cards go
 * to stop counting against that budget — a separate, append-only, chunked set
 * of keys under ["archive", n], each sealed well short of the 64KB value cap.
 * Nothing else reads it; it exists so finishing work can't eventually wedge
 * sync (see js/archive.js).
 *
 * Env: KODER_TOKEN (required), KODER_WEBHOOK_SECRET (required for the GitHub
 * webhook), KODER_ORIGIN (optional — lock CORS to the deployed board origin
 * instead of "*" once you know it), PORT (optional; defaults to 8000), and
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
import { nextWebhookRevision } from "./workflow.ts";

const KV_PATH = Deno.env.get("KODER_KV_PATH") || undefined;
const kv = await Deno.openKv(KV_PATH);
const TOKEN = Deno.env.get("KODER_TOKEN") ?? "";
const WEBHOOK_SECRET = Deno.env.get("KODER_WEBHOOK_SECRET") ?? "";
const PORT = Number(Deno.env.get("PORT") ?? "8000");
const KEY = ["board"];
const GITHUB_DELIVERY_KEY = ["github-delivery"];
const GITHUB_BODY_MAX = 256 * 1024;

const GITHUB_REPOS = new Set([
  "KodaAllison/koder",
  "KodaAllison/crook-community",
  "KodaAllison/holitrackr",
  "KodaAllison/portfolio-website",
]);

// How many past revisions to keep as restore points. Snapshots live under
// ["board", rev]; a prefix list on KEY returns exactly these (the current
// pointer ["board"] equals the prefix and is excluded). Each is a full board
// copy — cheap, and every write prunes the one this far behind.
const KEEP_REVISIONS = 20;

// Archived cards live under ["archive", n], separate from the board so they
// stop counting against its 60_000 budget.
const ARCHIVE_KEY = ["archive"];
// Seal a chunk once appending would take it past this. The gap to KV's 64KB
// value cap is deliberate: one append carries at most a whole board's worth of
// cards (<60_000, since that's all a PUT can hold), so a chunk that starts
// empty still lands under the cap.
const ARCHIVE_CHUNK_MAX = 50_000;

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
type TicketFields = {
  title?: string;
  note?: string;
  priority?: string;
  project?: string | null;
  column?: string;
};

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
type Board = {
  projects: Record<string, Card[]>;
  life: Record<string, Card[]>;
  lifeMeta: Record<string, unknown>;
};
type Doc = {
  rev: number; // the HEAD revision — see the "Terminology" note above
  updatedAt: string | null;
  board: Board;
};
type DeliveryGuard = {
  key: Deno.KvKey;
  entry: Deno.KvEntryMaybe<boolean>;
};
// A card as it looks once off the board: the client tags it with the board it
// came from and when it left, so an archive read is legible on its own.
type ArchivedCard = Card & { board?: string; archivedAt?: number };

function emptyDoc(): Doc {
  return { rev: 0, updatedAt: null, board: { projects: {}, life: {}, lifeMeta: {} } };
}

/* Commit a new doc as one atomic step: advance the current pointer, snapshot
 * the doc under ["board", rev], and prune the snapshot KEEP_REVISIONS behind.
 * `check(entry)` guards against a concurrent writer landing on the same rev.
 * All writers (PUT, POST, PATCH, restore) go through here so a snapshot can
 * never diverge from the rev that produced it. */
function commitDoc(entry: Deno.KvEntryMaybe<Doc>, doc: Doc, delivery?: DeliveryGuard) {
  const atomic = kv.atomic().check(entry);
  if (delivery) atomic.check(delivery.entry);
  atomic.set(KEY, doc)
    .set([...KEY, doc.rev], doc)
    .delete([...KEY, doc.rev - KEEP_REVISIONS]);
  if (delivery) {
    atomic.set(delivery.key, true);
  }
  return atomic.commit();
}

function recordDelivery(entry: Deno.KvEntryMaybe<Doc>, delivery: DeliveryGuard) {
  return kv.atomic()
    .check(entry)
    .check(delivery.entry)
    .set(delivery.key, true)
    .commit();
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

/* Every archive chunk, oldest first. Callers read the whole set: it's how a
 * POST dedupes by id across chunks, and the volume is a personal board's
 * finished tickets, not a data warehouse. */
async function readArchiveChunks(): Promise<{ index: number; cards: ArchivedCard[] }[]> {
  const chunks: { index: number; cards: ArchivedCard[] }[] = [];
  for await (const e of kv.list<ArchivedCard[]>({ prefix: ARCHIVE_KEY })) {
    const index = Number(e.key[e.key.length - 1]);
    if (Number.isInteger(index) && Array.isArray(e.value)) chunks.push({ index, cards: e.value });
  }
  chunks.sort((a, b) => a.index - b.index);
  return chunks;
}

/* Resolve a caller-supplied identifier to a card id, accepting either form:
 * the raw id (t_msa8scco_632be) or the ref the board shows (KODER-632B).
 *
 * Exact id match wins outright. Ids are unique and authoritative — they're the
 * merge key — so checking them first keeps every existing caller working
 * unchanged and means a ref can never shadow a real id.
 *
 * A ref is a truncation, so it CAN match more than one ticket. That's refused
 * rather than resolved arbitrarily: silently patching one of two tickets that
 * share a ref is the one failure mode worse than not patching at all. */
function resolveTicketId(
  board: Board,
  given: string,
): { id: string } | { error: Record<string, unknown>; status: number } {
  const allCards = Object.values(board.projects ?? {}).flatMap((cards) => cards ?? []);
  const byId = allCards.find((c) => c.id === given);
  if (byId) return { id: byId.id };

  const wanted = given.trim().toUpperCase();
  const matches = allCards.filter((c) => ticketRef(c).toUpperCase() === wanted);
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) {
    return {
      status: 409,
      error: {
        error: `ref "${given}" matches ${matches.length} tickets — use the id instead`,
        ids: matches.map((c) => c.id),
      },
    };
  }
  return { status: 404, error: { error: `no ticket with id or ref "${given}"` } };
}

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

/* pr/prRev are workflow state, not browser-editable card fields. A full-board
 * sync may move or edit a card, but it must carry the current server values
 * exactly. New cards (and legacy cards without workflow state) cannot acquire
 * either field from an untrusted PUT. */
function preserveWorkflowMetadata(incoming: Board, current: Board): Board {
  const board = structuredClone(incoming);
  const currentCards = new Map<string, Card>();
  for (const boardId of ["projects", "life"] as const) {
    for (const cards of Object.values(current[boardId] ?? {})) {
      for (const card of cards ?? []) currentCards.set(card.id, card);
    }
  }
  for (const boardId of ["projects", "life"] as const) {
    for (const cards of Object.values(board[boardId] ?? {})) {
      for (const card of cards ?? []) {
        const authoritative = currentCards.get(card.id);
        delete card.pr;
        delete card.prRev;
        if (authoritative && hasOwn(authoritative, "pr")) card.pr = authoritative.pr;
        if (authoritative && hasOwn(authoritative, "prRev")) card.prRev = authoritative.prRev;
      }
    }
  }
  return board;
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

function resolveVisibleTicket(
  board: Board,
  text: string,
): { id: string; ref: string } | { error: Record<string, unknown>; status: number } | null {
  const candidates = new Set(
    Array.from(text.matchAll(/\b[A-Z0-9]+-[A-Z0-9]{4}\b/gi), (match) => match[0].toUpperCase()),
  );
  const matches = new Map<string, string>();
  for (const candidate of candidates) {
    const resolved = resolveTicketId(board, candidate);
    if ("error" in resolved) {
      if (resolved.status === 409) return resolved;
      continue;
    }
    matches.set(resolved.id, candidate);
  }
  if (matches.size === 0) return null;
  if (matches.size > 1) {
    return {
      status: 409,
      error: {
        error: "PR title/body references more than one ticket",
        refs: [...matches.values()],
      },
    };
  }
  const [[id, ref]] = matches;
  return { id, ref };
}

function isNewerSameRepoPr(current: string, incoming: string): boolean {
  const currentMatch = current.match(/^(.+)#([1-9][0-9]*)$/);
  const incomingMatch = incoming.match(/^(.+)#([1-9][0-9]*)$/);
  if (!currentMatch || !incomingMatch || currentMatch[1] !== incomingMatch[1]) return false;
  return Number(incomingMatch[2]) > Number(currentMatch[2]);
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
  const key = [...GITHUB_DELIVERY_KEY, deliveryId];
  for (let attempt = 0; attempt < 5; attempt++) {
    const entry = await kv.get<Doc>(KEY);
    const delivery: DeliveryGuard = { key, entry: await kv.get<boolean>(key) };
    if (delivery.entry.value) {
      return json({ updated: false, redelivered: true, rev: (entry.value ?? emptyDoc()).rev });
    }
    if ((await recordDelivery(entry, delivery)).ok) return json(body, status);
  }
  return json({ error: "write contention, retry" }, 503);
}

/* The authenticated API surface. A GET to anything else is a static frontend
 * request (the PWA's files) and skips the token gate. */
function isApiPath(p: string): boolean {
  return p === "/state" || p === "/state/restore" || p === "/revisions" ||
    p === "/archive" || p === "/tickets" || p.startsWith("/tickets/");
}

Deno.serve({ port: PORT }, async (req: Request) => {
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
    const deliveryKey = [...GITHUB_DELIVERY_KEY, deliveryId];
    if ((await kv.get<boolean>(deliveryKey)).value) {
      const entry = await kv.get<Doc>(KEY);
      return json({ updated: false, redelivered: true, rev: (entry.value ?? emptyDoc()).rev });
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const delivery: DeliveryGuard = {
        key: deliveryKey,
        entry: await kv.get<boolean>(deliveryKey),
      };
      if (delivery.entry.value) {
        return json({ updated: false, redelivered: true, rev: (entry.value ?? emptyDoc()).rev });
      }
      const cur = structuredClone(entry.value ?? emptyDoc());
      const resolved = resolveVisibleTicket(cur.board, text);
      if (!resolved) {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json({ ignored: "no ticket ref" }, 202);
      }
      if ("error" in resolved) {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json(resolved.error, resolved.status);
      }

      let card: Card | null = null;
      let from: string | null = null;
      let fromCards: Card[] | null = null;
      let cardIndex = -1;
      for (const [column, cards] of Object.entries(cur.board.projects ?? {})) {
        const index = (cards ?? []).findIndex((candidate) => candidate.id === resolved.id);
        if (index !== -1) {
          from = column;
          fromCards = cards;
          cardIndex = index;
          card = cards[index];
          break;
        }
      }
      if (!card || from === null || !fromCards || cardIndex < 0) {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json({ ignored: "ticket no longer exists" }, 202);
      }
      if (from === "done" && target === "review") {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json({ ignored: "done is terminal for webhook events", ref: resolved.ref }, 202);
      }
      if (card.pr && card.pr !== pr && !isNewerSameRepoPr(card.pr, pr)) {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json({ ignored: "stale or cross-repository PR association", ref: resolved.ref }, 202);
      }
      if (from === target && card.pr === pr) {
        if (!(await recordDelivery(entry, delivery)).ok) continue;
        return json({ updated: false, ref: resolved.ref, column: from, pr, rev: cur.rev });
      }
      card.pr = pr;
      card.prRev = nextWebhookRevision(card.prRev);
      if (from !== target) {
        fromCards.splice(cardIndex, 1);
        (cur.board.projects[target] ??= []).push(card);
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const result = await commitDoc(entry, doc, delivery);
      if (result.ok) {
        return json({ updated: true, ref: resolved.ref, column: target, pr, rev: doc.rev });
      }
    }
    return json({ error: "write contention, retry" }, 503);
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

  /* ---- GET /state (optionally ?rev=N for a kept snapshot — a specific past
   * revision, not the current head; see the "Terminology" note above) ---- */
  if (url.pathname === "/state" && req.method === "GET") {
    const revParam = url.searchParams.get("rev");
    if (revParam !== null) {
      const requestedRev = Number(revParam);
      if (!Number.isInteger(requestedRev) || requestedRev < 0) {
        return json({ error: "rev must be a non-negative integer" }, 400);
      }
      const snap = await kv.get<Doc>([...KEY, requestedRev]);
      if (!snap.value) {
        return json({ error: `no snapshot for rev ${requestedRev} (only the last ${KEEP_REVISIONS} are kept)` }, 404);
      }
      return json(snap.value);
    }
    const entry = await kv.get<Doc>(KEY);
    return json(entry.value ?? emptyDoc());
  }

  /* ---- GET /revisions: the kept restore points, newest first ---- */
  if (url.pathname === "/revisions" && req.method === "GET") {
    const revisions: { rev: number; updatedAt: string | null }[] = [];
    for await (const e of kv.list<Doc>({ prefix: KEY })) {
      if (e.value) revisions.push({ rev: e.value.rev, updatedAt: e.value.updatedAt });
    }
    revisions.sort((a, b) => b.rev - a.rev);
    return json({ revisions });
  }

  /* ---- POST /state/restore: re-land a snapshot as a new head rev ----
   * Undo without rewinding: the old board becomes the newest rev, so clients
   * pull it back through the normal rev>SYNC.rev path. Same atomic + retry
   * shape as the ticket writers. The body's `rev` names the snapshot to
   * restore FROM (history), which is a different thing from `doc.rev` below
   * (the new HEAD this restore produces) — kept as separate locals so the
   * two don't get confused. */
  if (url.pathname === "/state/restore" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.rev !== "number" || !Number.isInteger(body.rev)) {
      return json({ error: "rev (integer) is required" }, 400);
    }
    const targetRev = body.rev;
    const snap = await kv.get<Doc>([...KEY, targetRev]);
    if (!snap.value) {
      return json({ error: `no snapshot for rev ${targetRev} (only the last ${KEEP_REVISIONS} are kept)` }, 404);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const cur = entry.value ?? emptyDoc();
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: snap.value.board,
      };
      const res = await commitDoc(entry, doc);
      if (res.ok) return json({ rev: doc.rev, restoredFrom: targetRev, updatedAt: doc.updatedAt });
    }
    return json({ error: "write contention, retry" }, 503);
  }

  /* ---- PUT /state: full-board write, conditional on baseRev ---- */
  if (url.pathname === "/state" && req.method === "PUT") {
    // Deno KV values cap at 64KB — reject early with a clear error instead of
    // letting kv.set() fail mysteriously once the board grows too big.
    const raw = await req.text();
    if (raw.length > 60_000) {
      return json({ error: "board too large (60KB limit — Deno KV caps values at 64KB)" }, 413);
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
    const entry = await kv.get<Doc>(KEY);
    const cur = entry.value ?? emptyDoc();
    if (typeof body.baseRev !== "number" || body.baseRev !== cur.rev) {
      return json({ error: "conflict: baseRev is stale", rev: cur.rev }, 409);
    }
    const doc: Doc = {
      rev: cur.rev + 1,
      updatedAt: new Date().toISOString(),
      board: preserveWorkflowMetadata(body.board, cur.board),
    };
    const res = await commitDoc(entry, doc);
    if (!res.ok) return json({ error: "conflict: concurrent write, retry" }, 409);
    return json({ rev: doc.rev, updatedAt: doc.updatedAt });
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

    for (let attempt = 0; attempt < 5; attempt++) {
      const chunks = await readArchiveChunks();
      const seen = new Set(chunks.flatMap((c) => c.cards.map((card) => card.id)));
      const fresh = incoming.filter((c) => !seen.has(c.id));
      // Already archived in full — an idempotent no-op, not an error, so a
      // client retrying a request that actually landed still gets to move on.
      if (!fresh.length) {
        return json({ archived: 0, duplicates: incoming.length, chunks: chunks.length });
      }

      const last = chunks[chunks.length - 1];
      // Start a fresh chunk when appending would overflow the current one.
      const sealed = !last ||
        JSON.stringify([...last.cards, ...fresh]).length > ARCHIVE_CHUNK_MAX;
      const index = last ? (sealed ? last.index + 1 : last.index) : 0;

      const entry = await kv.get<ArchivedCard[]>([...ARCHIVE_KEY, index]);
      const next = [...(entry.value ?? []), ...fresh];
      const res = await kv.atomic().check(entry)
        .set([...ARCHIVE_KEY, index], next).commit();
      if (res.ok) {
        return json({
          archived: fresh.length,
          duplicates: incoming.length - fresh.length,
          chunk: index,
        });
      }
    }
    return json({ error: "write contention, retry" }, 503);
  }

  /* ---- GET /archive: everything lifted off the board, newest first ---- */
  if (url.pathname === "/archive" && req.method === "GET") {
    const chunks = await readArchiveChunks();
    const cards = chunks.flatMap((c) => c.cards);
    cards.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    return json({ count: cards.length, chunks: chunks.length, cards });
  }

  /* ---- GET /tickets: compact read for agents ----
   * Flattens the projects board into one list with a `column` field, so a
   * caller can see work without understanding the board document. */
  if (url.pathname === "/tickets" && req.method === "GET") {
    const entry = await kv.get<Doc>(KEY);
    const board = (entry.value ?? emptyDoc()).board;
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      // Resolve on every attempt, just like PATCH, so a newly ambiguous ref
      // can never select an arbitrary ticket after write contention.
      const resolved = resolveTicketId(cur.board, given);
      if ("error" in resolved) return json(resolved.error, resolved.status);

      let card: Card | null = null;
      let column: string | null = null;
      for (const [col, cards] of Object.entries(cur.board.projects ?? {})) {
        const index = (cards ?? []).findIndex((candidate) => candidate.id === resolved.id);
        if (index !== -1) {
          card = cards.splice(index, 1)[0];
          column = col;
          break;
        }
      }
      if (!card || column === null) {
        return json({ error: `no ticket with id or ref "${given}"` }, 404);
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await commitDoc(entry, doc);
      if (res.ok) {
        return json({ card, ref: ticketRef(card), column, rev: doc.rev, board: doc.board });
      }
    }
    return json({ error: "write contention, retry" }, 503);
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      // Resolved inside the retry loop, against the board this attempt will
      // actually write: a ref could start matching a second ticket between
      // attempts, and that has to be caught rather than raced past.
      const resolved = resolveTicketId(cur.board, given);
      if ("error" in resolved) return json(resolved.error, resolved.status);
      const id = resolved.id;
      let card: Card | null = null;
      let from: string | null = null;
      for (const [col, cards] of Object.entries(cur.board.projects ?? {})) {
        const i = (cards ?? []).findIndex((c) => c.id === id);
        if (i !== -1) {
          from = col;
          // Only lift the card out when we're moving it — an edit with no
          // `column` must not reshuffle the column it already sits in.
          card = column === undefined ? cards[i] : cards.splice(i, 1)[0];
          break;
        }
      }
      if (!card || from === null) return json({ error: `no ticket with id or ref "${given}"` }, 404);
      Object.assign(card, edits);
      if (column !== undefined) {
        cur.board.projects ??= {};
        (cur.board.projects[column] ??= []).push(card);
      }
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await commitDoc(entry, doc);
      if (res.ok) return json({ card, ref: ticketRef(card), column: column ?? from, rev: doc.rev });
    }
    return json({ error: "write contention, retry" }, 503);
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

    // Atomic append with a few retries in case a client PUT lands mid-flight.
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      cur.board.projects ??= {};
      (cur.board.projects[column] ??= []).push(card);
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await commitDoc(entry, doc);
      if (res.ok) return json({ card, ref: ticketRef(card), rev: doc.rev }, 201);
    }
    return json({ error: "write contention, retry" }, 503);
  }

  return json({ error: "not found" }, 404);
});
