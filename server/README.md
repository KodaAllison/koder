# Koder sync server

A single-file Deno server (`main.ts`) backed by Deno KV. It holds the canonical
copy of the board; the PWA syncs against it and keeps localStorage as an
offline cache. It also gives agents/scripts a way to add tickets from a
terminal via `POST /tickets`.

## Run locally

```bash
cd server
KODER_TOKEN=dev deno task dev     # http://localhost:8000, KV in a local file
```

## Deploy (free) on Deno Deploy

1. https://dash.deno.com → New App → link this GitHub repo.
2. Build config: framework preset **None**, run as a **dynamic app** with
   entrypoint `server/main.ts`. (Don't accept the auto-detected "static site"
   preset — the repo's root `index.html` triggers it, and you'd get a file
   server that 404s `/state`.)
3. Settings → Environment Variables → add `KODER_TOKEN` (e.g. `openssl rand -hex 24`).
   Optionally `KODER_ORIGIN=https://<your-board-origin>` to lock down CORS.
4. Create a KV database (org sidebar → Databases) and attach it to the app
   (app Settings → Databases), then redeploy — `Deno.openKv()` fails until
   one is attached.
5. Put the app URL + token into `js/config.local.js` (copy
   `js/config.example.js`) and `scripts/.koder.env`:

   ```
   KODER_API=https://<app>.<org>.deno.net
   KODER_TOKEN=<token>
   ```

## Host the frontend (so it works on your phone)

`main.ts` is only the API. To reach the board on a phone you also need the
static frontend served over HTTPS (a service worker — install + offline —
requires it; a LAN `http://` address won't do). `static.ts` is a second Deno
Deploy app that serves the repo's static files and, crucially, *generates*
`js/config.local.js` from env vars — so the sync token lives in Deno Deploy's
settings instead of being committed (the file stays gitignored).

1. https://dash.deno.com → New App → link this same repo.
2. Run as a **dynamic app** (again decline the static-site preset), entrypoint
   `server/static.ts`.
3. Settings → Environment Variables:
   - `KODER_API_BASE` = the sync app's URL (e.g. `https://koder.<org>.deno.net`)
   - `KODER_API_TOKEN` = the **same** value as the sync app's `KODER_TOKEN`
4. Deploy. Note this app's URL — that's your board.
5. Back on the **sync** app, set `KODER_ORIGIN` to this board URL to lock CORS
   to just your frontend, then redeploy.
6. On the phone: open the board URL → browser menu → **Add to Home Screen**.
   Test offline (airplane mode) and that a ticket added on the PC shows up.

Local dev (serves on `http://localhost:8001`, alongside the API on `:8000`):

```bash
cd server
KODER_API_BASE=http://localhost:8000 KODER_API_TOKEN=dev deno task static
```

> Alternative: fold the static serving into `main.ts` so board + API are one
> same-origin app (no CORS, no `KODER_ORIGIN` needed). Kept separate here so the
> API stays a focused file and the frontend can scale/CDN independently.

## API

All endpoints require `Authorization: Bearer $KODER_TOKEN`.

### GET /state

Returns `{ rev, updatedAt, board }` where `board` is the client's full
`{ projects, life, lifeMeta }` document. First run returns `rev: 0` and an
empty board.

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/state"
```

### PUT /state

Full-board write, used by the PWA. Body: `{ baseRev, board }`. `baseRev` must
equal the current server rev, otherwise you get `409 { rev }` — re-GET, merge,
retry. Success: `{ rev, updatedAt }`.

### POST /tickets — the agent entrypoint

Body: `{ title, note?, project?, column?, priority? }`. Column is one of
`backlog | todo | doing | done` (default `backlog`); priority `low | med | high`
(default `med`); `project` should be a folder name under `Code/` (defaults to
unassigned). The server assigns the id and appends the card atomically —
callers never need to read or send the whole board.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $KODER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix login bug","project":"holitrackr","column":"todo","priority":"high"}' \
  "$KODER_API/tickets"
# → 201 { "card": { "id": "t_...", ... }, "rev": 42 }
```

### GET /tickets — read tickets

Flattens the projects board into one list; each ticket gains a `column` field.
Optional filters: `?project=<id>` and/or `?column=<id>`.

```bash
curl -sS -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/tickets?project=holitrackr&column=todo"
# → { "tickets": [ { "id": "t_...", "title": "...", "column": "todo", ... } ] }
```

### PATCH /tickets/:id — move a ticket

Body: `{ "column": "backlog" | "todo" | "doing" | "done" }`. Finds the ticket
anywhere on the projects board and moves it atomically. 404 if the id doesn't
exist.

```bash
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"column":"doing"}' "$KODER_API/tickets/t_abc123_x1y2z"
```

Or use the wrapper for all of the above:

```bash
./scripts/koder-ticket.sh "Fix login bug" --project holitrackr --priority high
./scripts/koder-ticket.sh list --project holitrackr --column todo
./scripts/koder-ticket.sh move t_abc123_x1y2z doing
```

## Security note

The PWA is a static site, so the token in `js/config.local.js` ships to any
browser that loads the board — treat it as low-stakes, not secret. That's
acceptable for a personal board on a private origin. Mitigations: set
`KODER_ORIGIN`, keep the board URL unguessable, rotate `KODER_TOKEN` in the
Deno Deploy settings if it leaks. Real per-user auth is the upgrade path if
the board ever goes multi-user.
