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
 * Endpoints (all need `Authorization: Bearer $KODER_TOKEN`):
 *   GET   /state        → full doc (or an empty rev-0 doc on first run)
 *   GET   /state?rev=N   → the snapshot doc at rev N (404 if pruned)
 *   PUT   /state→ { baseRev, board } → { rev, updatedAt } | 409
 *   GET   /revisions     → kept snapshots: [{ rev, updatedAt }], newest first
 *   POST  /state/restore → { rev } → re-lands that snapshot as a new head rev
 *   POST  /tickets      → { title, note?, project?, column?, priority? } → { card, rev }
 *   GET   /tickets      → compact list; filters: ?project=<id>&column=<id>
 *   PATCH /tickets/:id  → any subset of { title, note, priority, project, column }
 *                         → edits the ticket in place; `column` moves it
 *                         → { card, column, rev }
 *   POST  /archive      → { cards } → lifts finished cards off the board
 *   GET   /archive      → everything archived so far, newest first
 *
 * Archive: the board is ONE KV value, so it can only ever hold ~60KB, and Done
 * is the only column that only ever grows. The archive is where done cards go
 * to stop counting against that budget — a separate, append-only, chunked set
 * of keys under ["archive", n], each sealed well short of the 64KB value cap.
 * Nothing else reads it; it exists so finishing work can't eventually wedge
 * sync (see js/archive.js).
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
    p === "/archive" || p === "/tickets" || p.startsWith("/tickets/");
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

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
      board: body.board,
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
  if (ticketMatch && req.method === "PATCH") {
    const id = ticketMatch[1];
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
      if (!card || from === null) return json({ error: `no ticket with id "${id}"` }, 404);
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
      if (res.ok) return json({ card, column: column ?? from, rev: doc.rev });
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
      if (res.ok) return json({ card, rev: doc.rev }, 201);
    }
    return json({ error: "write contention, retry" }, 503);
  }

  return json({ error: "not found" }, 404);
});
