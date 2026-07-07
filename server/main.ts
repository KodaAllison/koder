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
 * Endpoints (all need `Authorization: Bearer $KODER_TOKEN`):
 *   GET   /state        → full doc (or an empty rev-0 doc on first run)
 *   GET   /state?rev=N   → the snapshot doc at rev N (404 if pruned)
 *   PUT   /state→ { baseRev, board } → { rev, updatedAt } | 409
 *   GET   /revisions     → kept snapshots: [{ rev, updatedAt }], newest first
 *   POST  /state/restore → { rev } → re-lands that snapshot as a new head rev
 *   POST  /tickets      → { title, note?, project?, column?, priority? } → { card, rev }
 *   GET   /tickets      → compact list; filters: ?project=<id>&column=<id>
 *   PATCH /tickets/:id  → { column } → moves the ticket → { card, column, rev }
 *
 * Env: KODER_TOKEN (required), KODER_ORIGIN (optional — lock CORS to the
 * deployed board origin instead of "*" once you know it).
 *
 * Local dev:  KODER_TOKEN=dev deno task dev   (see deno.json)
 */

import { serveDir } from "jsr:@std/http/file-server";
import { fromFileUrl } from "jsr:@std/path";

const kv = await Deno.openKv();
const TOKEN = Deno.env.get("KODER_TOKEN") ?? "";
const KEY = ["board"];

// How many past revisions to keep as restore points. Snapshots live under
// ["board", rev]; a prefix list on KEY returns exactly these (the current
// pointer ["board"] equals the prefix and is excluded). Each is a full board
// copy — cheap, and every write prunes the one this far behind.
const KEEP_REVISIONS = 20;

// Repo root (this file is in server/) — where the PWA's static files live, so
// one app can serve the frontend and the API. Derive from the module URL;
// fall back to cwd (the repo root under Deno Deploy) if it isn't a file URL.
const ROOT = (() => {
  try { return fromFileUrl(new URL("../", import.meta.url)); }
  catch { return "."; }
})();

const PROJECT_COLUMNS = ["backlog", "todo", "doing", "done"];
const PRIORITIES = ["low", "med", "high"];

type Card = {
  id: string;
  title: string;
  note: string;
  priority: string;
  created: number;
  project: string | null;
};
type Board = {
  projects: Record<string, Card[]>;
  life: Record<string, Card[]>;
  lifeMeta: Record<string, unknown>;
};
type Doc = {
  rev: number;
  updatedAt: string | null;
  board: Board;
};

function emptyDoc(): Doc {
  return { rev: 0, updatedAt: null, board: { projects: {}, life: {}, lifeMeta: {} } };
}

/* Commit a new doc as one atomic step: advance the current pointer, snapshot
 * the doc under ["board", rev], and prune the snapshot KEEP_REVISIONS behind.
 * `check(entry)` guards against a concurrent writer landing on the same rev.
 * All writers (PUT, POST, PATCH, restore) go through here so a snapshot can
 * never diverge from the rev that produced it. */
function commitDoc(entry: Deno.KvEntryMaybe<Doc>, doc: Doc) {
  return kv.atomic()
    .check(entry)
    .set(KEY, doc)
    .set([...KEY, doc.rev], doc)
    .delete([...KEY, doc.rev - KEEP_REVISIONS])
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

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("KODER_ORIGIN") ?? "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* The authenticated API surface. A GET to anything else is a static frontend
 * request (the PWA's files) and skips the token gate. */
function isApiPath(p: string): boolean {
  return p === "/state" || p === "/state/restore" || p === "/revisions" ||
    p === "/tickets" || p.startsWith("/tickets/");
}

/* Generate the gitignored js/config.local.js so the token lives in env, not
 * git. base is this same origin — board and API are one app, so the browser's
 * calls are same-origin and never hit CORS. TOKEN is guaranteed set by the
 * time this runs (the handler 500s earlier otherwise). */
function configJs(origin: string): Response {
  const cfg = { base: origin, token: TOKEN };
  return new Response(`window.KODER_API = ${JSON.stringify(cfg)};\n`, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store", // token/URL can change without a shell redeploy
    },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!TOKEN) return json({ error: "server misconfigured: KODER_TOKEN not set" }, 500);

  /* ---- Static frontend (no auth) ----
   * Any GET that isn't an API path serves the PWA's files, so this one app is
   * also the board a phone loads over HTTPS. js/config.local.js is generated
   * from env; everything else comes off disk. API paths fall through to the
   * token gate below. */
  if (req.method === "GET" && !isApiPath(url.pathname)) {
    if (url.pathname === "/js/config.local.js") return configJs(url.origin);
    return serveDir(req, { fsRoot: ROOT, quiet: true });
  }

  if (req.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  /* ---- GET /state (optionally ?rev=N for a kept snapshot) ---- */
  if (url.pathname === "/state" && req.method === "GET") {
    const revParam = url.searchParams.get("rev");
    if (revParam !== null) {
      const rev = Number(revParam);
      if (!Number.isInteger(rev) || rev < 0) {
        return json({ error: "rev must be a non-negative integer" }, 400);
      }
      const snap = await kv.get<Doc>([...KEY, rev]);
      if (!snap.value) {
        return json({ error: `no snapshot for rev ${rev} (only the last ${KEEP_REVISIONS} are kept)` }, 404);
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
   * shape as the ticket writers. */
  if (url.pathname === "/state/restore" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.rev !== "number" || !Number.isInteger(body.rev)) {
      return json({ error: "rev (integer) is required" }, 400);
    }
    const snap = await kv.get<Doc>([...KEY, body.rev]);
    if (!snap.value) {
      return json({ error: `no snapshot for rev ${body.rev} (only the last ${KEEP_REVISIONS} are kept)` }, 404);
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
      if (res.ok) return json({ rev: doc.rev, restoredFrom: body.rev, updatedAt: doc.updatedAt });
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
      board: body.board,
    };
    const res = await commitDoc(entry, doc);
    if (!res.ok) return json({ error: "conflict: concurrent write, retry" }, 409);
    return json({ rev: doc.rev, updatedAt: doc.updatedAt });
  }

  /* ---- GET /tickets: compact read for agents ----
   * Flattens the projects board into one list with a `column` field, so a
   * caller can see work without understanding the board document. */
  if (url.pathname === "/tickets" && req.method === "GET") {
    const entry = await kv.get<Doc>(KEY);
    const board = (entry.value ?? emptyDoc()).board;
    const project = url.searchParams.get("project");
    const column = url.searchParams.get("column");
    const tickets: (Card & { column: string })[] = [];
    for (const [col, cards] of Object.entries(board.projects ?? {})) {
      if (column && col !== column) continue;
      for (const c of cards ?? []) {
        if (project && c.project !== project) continue;
        tickets.push({ ...c, column: col });
      }
    }
    return json({ tickets });
  }

  /* ---- PATCH /tickets/:id: move a ticket between columns ----
   * The agent workflow: move to "doing" when picking work up, "done" when
   * finished. Same atomic read-modify-write pattern as POST. */
  const moveMatch = url.pathname.match(/^\/tickets\/([^/]+)$/);
  if (moveMatch && req.method === "PATCH") {
    const id = moveMatch[1];
    const body = await req.json().catch(() => null);
    if (!body || !PROJECT_COLUMNS.includes(body.column)) {
      return json({ error: "column is required", valid: PROJECT_COLUMNS }, 400);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const entry = await kv.get<Doc>(KEY);
      const cur = structuredClone(entry.value ?? emptyDoc());
      let card: Card | null = null;
      for (const cards of Object.values(cur.board.projects ?? {})) {
        const i = (cards ?? []).findIndex((c) => c.id === id);
        if (i !== -1) {
          card = cards.splice(i, 1)[0];
          break;
        }
      }
      if (!card) return json({ error: `no ticket with id "${id}"` }, 404);
      cur.board.projects ??= {};
      (cur.board.projects[body.column] ??= []).push(card);
      const doc: Doc = {
        rev: cur.rev + 1,
        updatedAt: new Date().toISOString(),
        board: cur.board,
      };
      const res = await commitDoc(entry, doc);
      if (res.ok) return json({ card, column: body.column, rev: doc.rev });
    }
    return json({ error: "write contention, retry" }, 503);
  }

  /* ---- POST /tickets: the agent/CLI entrypoint ----
   * Server-side read-modify-write, so callers never need the whole board. */
  if (url.pathname === "/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.title !== "string" || !body.title.trim()) {
      return json({ error: "title (non-empty string) is required" }, 400);
    }
    if (body.title.length > 300 || (typeof body.note === "string" && body.note.length > 5000)) {
      return json({ error: "too long: title max 300 chars, note max 5000" }, 400);
    }
    const column = typeof body.column === "string" && body.column ? body.column : "backlog";
    if (!PROJECT_COLUMNS.includes(column)) {
      return json({ error: `invalid column "${column}"`, valid: PROJECT_COLUMNS }, 400);
    }
    const priority = PRIORITIES.includes(body.priority) ? body.priority : "med";

    // Matches the client's card shape (saveModal in js/app.js) exactly.
    const card: Card = {
      id: `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 5)}`,
      title: body.title.trim(),
      note: typeof body.note === "string" ? body.note.trim() : "",
      priority,
      created: Date.now(),
      project: typeof body.project === "string" && body.project ? body.project : null,
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
      if (res.ok) return json({ card, rev: doc.rev }, 201);
    }
    return json({ error: "write contention, retry" }, 503);
  }

  return json({ error: "not found" }, 404);
});
