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
 * Endpoints (all need `Authorization: Bearer $KODER_TOKEN`):
 *   GET  /state    → full doc (or an empty rev-0 doc on first run)
 *   PUT  /state    → { baseRev, board } → { rev, updatedAt } | 409
 *   POST /tickets  → { title, note?, project?, column?, priority? } → { card, rev }
 *
 * Env: KODER_TOKEN (required), KODER_ORIGIN (optional — lock CORS to the
 * deployed board origin instead of "*" once you know it).
 *
 * Local dev:  KODER_TOKEN=dev deno task dev   (see deno.json)
 */

const kv = await Deno.openKv();
const TOKEN = Deno.env.get("KODER_TOKEN") ?? "";
const KEY = ["board"];

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
type Doc = {
  rev: number;
  updatedAt: string | null;
  // deno-lint-ignore no-explicit-any
  board: { projects: Record<string, any[]>; life: Record<string, any[]>; lifeMeta: Record<string, unknown> };
};

function emptyDoc(): Doc {
  return { rev: 0, updatedAt: null, board: { projects: {}, life: {}, lifeMeta: {} } };
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("KODER_ORIGIN") ?? "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (!TOKEN) return json({ error: "server misconfigured: KODER_TOKEN not set" }, 500);
  if (req.headers.get("Authorization") !== `Bearer ${TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  /* ---- GET /state ---- */
  if (url.pathname === "/state" && req.method === "GET") {
    const entry = await kv.get<Doc>(KEY);
    return json(entry.value ?? emptyDoc());
  }

  /* ---- PUT /state: full-board write, conditional on baseRev ---- */
  if (url.pathname === "/state" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !body.board || typeof body.board !== "object") {
      return json({ error: "expected { baseRev, board }" }, 400);
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
    const res = await kv.atomic().check(entry).set(KEY, doc).commit();
    if (!res.ok) return json({ error: "conflict: concurrent write, retry" }, 409);
    return json({ rev: doc.rev, updatedAt: doc.updatedAt });
  }

  /* ---- POST /tickets: the agent/CLI entrypoint ----
   * Server-side read-modify-write, so callers never need the whole board. */
  if (url.pathname === "/tickets" && req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.title !== "string" || !body.title.trim()) {
      return json({ error: "title (non-empty string) is required" }, 400);
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
      const res = await kv.atomic().check(entry).set(KEY, doc).commit();
      if (res.ok) return json({ card, rev: doc.rev }, 201);
    }
    return json({ error: "write contention, retry" }, 503);
  }

  return json({ error: "not found" }, 404);
});
