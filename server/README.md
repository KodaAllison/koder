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

`main.ts` serves **both** the API and the PWA's static files, so the same one
Deno Deploy app is your board — reachable over HTTPS, which a phone needs for
install + offline (a LAN `http://` address won't do). No second app, and no
CORS: the board calls its own origin. Any `GET` that isn't an API path
(`/state`, `/tickets…`) is served off disk; `js/config.local.js` is *generated*
from the token in env, so the secret lives in Deno Deploy settings and the file
stays gitignored.

If the sync app from the section above is already deployed, you're basically
done — just **redeploy** it with this version of `main.ts` and open its URL:

1. dash.deno.com → your app → it redeploys on push (or hit Redeploy).
2. Confirm `KODER_TOKEN` is set and a KV database is attached (as above).
3. On the phone: open the app URL → browser menu → **Add to Home Screen**.
   Test offline (airplane mode) and that a ticket added on the PC shows up.

Local dev serves the whole board at `http://localhost:8000`:

```bash
cd server
KODER_TOKEN=dev deno task dev
# open http://localhost:8000 — frontend + API from one process
```

## API

All endpoints require `Authorization: Bearer $KODER_TOKEN`.

### GET /state

Returns `{ rev, updatedAt, board }` where `board` is the client's full
`{ projects, life, lifeMeta }` document. First run returns `rev: 0` and an
empty board.

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/state"
```

Pass `?rev=N` to fetch a past snapshot instead of the current board (see
history below). `404` if that rev has been pruned.

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/state?rev=57"
```

### PUT /state

Full-board write, used by the PWA. Body: `{ baseRev, board }`. `baseRev` must
equal the current server rev, otherwise you get `409 { rev }` — re-GET, merge,
retry. Success: `{ rev, updatedAt }`.

### History / undo

Every write snapshots the resulting board under `["board", rev]` and prunes the
one 20 revisions back, so the **last 20 boards** are recoverable. This turns a
bad push (e.g. a stale `pagehide` beacon clobbering the board) into a restore
instead of permanent data loss.

**`GET /revisions`** — the kept restore points, newest first:

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/revisions"
# → { "revisions": [ { "rev": 61, "updatedAt": "..." }, { "rev": 60, ... }, ... ] }
```

Inspect a snapshot with `GET /state?rev=N`, then **`POST /state/restore`** with
`{ rev }` to bring it back. Restore doesn't rewind `rev`: it re-lands that
snapshot's board as a *new* head rev, so open tabs pull it in like any other
change. `404` if the rev has been pruned.

```bash
curl -X POST -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"rev":57}' "$KODER_API/state/restore"
# → { "rev": 62, "restoredFrom": 57, "updatedAt": "..." }
```

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
