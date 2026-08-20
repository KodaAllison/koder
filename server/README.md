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

PowerShell doesn't take the `VAR=value cmd` prefix — set it first:

```powershell
cd server
$env:KODER_TOKEN = "dev"
deno task dev
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

```powershell
# PowerShell: no VAR=value prefix, and env vars read back as $env:NAME
cd server
$env:KODER_TOKEN = "dev"
deno task dev
```

Without `KODER_TOKEN` in the *server's* environment every request answers
`{"error":"server misconfigured: KODER_TOKEN not set"}` with a 500 — that's
the server describing itself, before it ever looks at your `Authorization`
header, so it means the token is missing where `deno task dev` ran rather
than in your request.

Calling it, with the same difference:

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" localhost:8000/tickets
```

```powershell
curl.exe -H "Authorization: Bearer $env:KODER_TOKEN" localhost:8000/tickets
```

The local KV is its own store, separate from the deployed board, so it starts
empty — `/tickets` returns `{"tickets":[]}` until you file something into it.

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

A body over **60,000 characters** is rejected with `413`, because the whole
board is one Deno KV value and KV caps a value at 64KB. See *Archive* below for
what keeps it under that.

### Archive

The board only grows in one place: Done. Left alone it eventually crosses the
60KB line, and then every push 413s and the board sits dirty forever behind a
badge. The archive is where finished cards go so they stop counting against
that budget — separate, append-only KV keys under `["archive", n]`, each chunk
sealed well short of the value cap.

The PWA drives this from the **Archive** button on the Done column (it appears
only when sync is configured — with no server there's nowhere to archive *to*).
It posts the cards first and removes them from the board only once this returns
ok, so a failed request loses nothing.

**`POST /archive`** — body `{ cards: [...] }`. Cards need at minimum a string
`id` and `title`; the PWA also tags each with `board` and `archivedAt`. Ids
already in the archive are skipped rather than duplicated, so retrying a
request that actually landed is safe:

```bash
curl -X POST -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"cards":[{"id":"t_abc123_x1y2z","title":"Ship the thing"}]}' "$KODER_API/archive"
# → { "archived": 1, "duplicates": 0, "chunk": 0 }
```

**`GET /archive`** — everything archived so far, newest first:

```bash
curl -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/archive"
# → { "count": 34, "chunks": 1, "cards": [ ... ] }
```

There is no un-archive: archiving is one-way, and the confirm dialog says so.
Getting a card back means reading it out of `GET /archive` and re-filing it.

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
`backlog | todo | doing | review | done` (default `backlog`); priority `low | med | high`
(default `med`); `project` should be a folder name under `Code/` (defaults to
unassigned). The server assigns the id and appends the card atomically —
callers never need to read or send the whole board.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $KODER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix login bug","project":"holitrackr","column":"todo","priority":"high"}' \
  "$KODER_API/tickets"
# → 201 { "card": { "id": "t_...", ... }, "ref": "HOLIT-1B2C", "rev": 42 }
```

`ref` is the ticket's human-readable name — the same one shown on the card on
the board. Quote it to Koda; an id names nothing they can see.

The `rev` here is the *board's* new head revision after this write landed — not a
version number on the ticket itself (tickets don't have one). You can ignore it
unless you're also polling `/state` and want to know a write has been folded in.

### GET /tickets — read tickets

Flattens the projects board into one list; each ticket gains a `column` field
and its derived `ref`. Optional filters: `?project=<id>` and/or `?column=<id>`.

```bash
curl -sS -H "Authorization: Bearer $KODER_TOKEN" "$KODER_API/tickets?project=holitrackr&column=todo"
# → { "tickets": [ { "id": "t_...", "ref": "HOLIT-1B2C", "title": "...", "column": "todo", ... } ] }
```

### Refs

A ref is `<PROJECT-PREFIX>-<last 4 of the id>`, e.g. `HOLIT-1B2C`. It is
**derived on read, never stored** — `js/ref.js` holds the rule and both this
server and the board import it, so the name on a card and the name in an API
response can't drift apart. The id stays the ticket's real identity: it's the
key `mergeBoards` uses to decide what a sync conflict keeps, so it never
changes.

Because the ref truncates the id, two tickets in one project could in
principle derive the same one. `PATCH` refuses that case rather than guessing
(see below); `GET` just reports whatever each ticket derives.

### PATCH /tickets/:id — move and/or edit a ticket

`:id` is **either the raw id or the ref** (`t_abc123_x1y2z` or `HOLIT-1B2C`).
An exact id match always wins, so a ref can never shadow a real id and every
existing caller keeps working unchanged.

Body: any subset of `{ title, note, priority, project, column }`. Finds the
ticket anywhere on the projects board and applies the change atomically;
fields you omit are left alone. 404 if neither an id nor a ref matches, 409 if
a ref matches more than one ticket (the response lists the ids — pass one of
them), 400 on an empty body (nothing to patch). Response:
`{ card, ref, column, rev }`, where `column` is where the ticket ended up.

`column` moves the card — one of `backlog | todo | doing | review | done`. The
other four edit it in place, so a wrong title, note, priority or project can be
fixed without a whole-board `PUT /state`. Values are validated exactly as
`POST /tickets` validates them (title max 300 chars, note max 5000, priority
one of `low | med | high`); `project: null` or `""` unassigns.

```bash
# move it — by ref
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"column":"doing"}' "$KODER_API/tickets/HOLIT-1B2C"

# edit it (and move it, if you like)
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Fix login bug on mobile","priority":"high"}' "$KODER_API/tickets/t_abc123_x1y2z"
```

Or use the wrapper for all of the above:

```bash
./scripts/koder-ticket.sh "Fix login bug" --project holitrackr --priority high
./scripts/koder-ticket.sh list --project holitrackr --column todo
./scripts/koder-ticket.sh move t_abc123_x1y2z doing
./scripts/koder-ticket.sh edit t_abc123_x1y2z --title "Fix login bug on mobile" --priority high
```

## Security note

The PWA is a static site, so the token in `js/config.local.js` ships to any
browser that loads the board — treat it as low-stakes, not secret. That's
acceptable for a personal board on a private origin. Mitigations: set
`KODER_ORIGIN`, keep the board URL unguessable, rotate `KODER_TOKEN` in the
Deno Deploy settings if it leaks. Real per-user auth is the upgrade path if
the board ever goes multi-user.
