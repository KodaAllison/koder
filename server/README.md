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

1. https://dash.deno.com → New Project → link this GitHub repo.
2. Entrypoint: `server/main.ts`.
3. Settings → Environment Variables → add `KODER_TOKEN` (e.g. `openssl rand -hex 24`).
   Optionally `KODER_ORIGIN=https://<your-board-origin>` to lock down CORS.
4. KV is provisioned automatically — nothing to configure.
5. Put the deployment URL + token into `js/config.local.js` (copy
   `js/config.example.js`) and `scripts/.koder.env`:

   ```
   KODER_API=https://<project>.deno.dev
   KODER_TOKEN=<token>
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

Or use the wrapper: `./scripts/koder-ticket.sh "Fix login bug" --project holitrackr --priority high`.

## Security note

The PWA is a static site, so the token in `js/config.local.js` ships to any
browser that loads the board — treat it as low-stakes, not secret. That's
acceptable for a personal board on a private origin. Mitigations: set
`KODER_ORIGIN`, keep the board URL unguessable, rotate `KODER_TOKEN` in the
Deno Deploy settings if it leaks. Real per-user auth is the upgrade path if
the board ever goes multi-user.
