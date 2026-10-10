# Koder API (Node.js + Postgres)

The Koder sync server ported off Deno: Node.js + TypeScript, with Postgres (Neon in
production) as the only store. It is the replacement for `server/` (Deno Deploy + Deno KV),
built under KODER-EE05, and it answers the same HTTP API, with the deliberate differences listed
under "What differs" below: same routes, statuses, headers, bodies, validation caps,
bearer auth and GitHub webhook HMAC, and it serves the PWA from the repo root, same
origin.

**`server/` is still the live board.** The production app is the Deno Deploy app whose
entrypoint is `server/main.ts`, redeployed from `main`. Nothing here is deployed yet, and
nothing in `server/` changes until the cutover (KODER-EE05 slice 4).

## Not finished yet

This is slice 2 of 4. What works: `GET /state` (with the `ETag`/`304` validators), `PUT
/state` (diff-applied into rows, with the `409`/`413` behaviour of the old server), `POST
/tickets`, `PATCH`/`DELETE /tickets/:id`, `GET /tickets`, `POST`/`GET /archive`, `GET
/pr-status`, the webhook's authentication and size checks, all request validation, CORS,
auth and the static PWA. These `Store` methods in `src/pg-store.ts` still throw
`PgStore.<method> is not implemented yet`, so the routes that need them answer a bare 500:

| Method | Routes |
|---|---|
| `boardAt`, `listRevisions`, `restore` | `GET /state?rev=N`, `GET /revisions`, `POST /state/restore` (slice 3) |
| `hasDelivery`, `recordDelivery`, `commitWebhookMove` | `POST /webhooks/github` past its signature check (slice 3) |

The contract suite reports every step that needs one of these as skipped, with the
methods it is waiting for (`PG_PENDING` in `tests/contract.test.ts`); slice 3 empties
that list.

## Run it

Node 22.18 or newer: Node runs the `.ts` files directly by stripping their types, so
there is no build step.

```bash
cd api
npm install
KODER_TOKEN=dev NEON_DATABASE_URL='postgres://user:pass@host/db?sslmode=require' npm start
# open http://localhost:8000 — frontend + API from one process
```

```powershell
cd api
npm install
$env:KODER_TOKEN = "dev"
$env:NEON_DATABASE_URL = "postgres://user:pass@host/db?sslmode=require"
npm start
```

The schema is created (and later migrated) on startup: `src/pg-schema.ts` holds ordered
plain-SQL migrations, applied once each under an advisory lock and recorded in
`schema_migrations`. Any Postgres works for local dev; for a throwaway one with no
install, the test suite's PGlite setup (below) is the model.

Environment:

| Variable | |
|---|---|
| `KODER_TOKEN` | Required. The bearer token every API request must carry. |
| `NEON_DATABASE_URL` | Required. Postgres connection string; startup fails without it, or if the database can't be reached or migrated (the password is scrubbed from the message). |
| `KODER_WEBHOOK_SECRET` | Required for `POST /webhooks/github` (GitHub's HMAC secret). |
| `GITHUB_TOKEN` | Optional. Read-only GitHub token for `GET /pr-status`; without it a board with PR links answers 503. |
| `KODER_ORIGIN` | Optional. Locks CORS to one origin instead of `*`. |
| `PORT` | Optional; default 8000 (`0` picks a free port, and the server prints the one it took). |
| `KODER_PG_MAX` | Optional pool size; default 3. |

Connection details (`src/pg-store.ts`): TLS is off for `localhost`/`127.0.0.1` or
`sslmode=disable`; otherwise the URL's `sslmode` is honoured, and with none TLS is required
and verified. A host containing `-pooler` (Neon's PgBouncer endpoint) gets
`prepare: false`. **Prefer Neon's direct endpoint for this long-running server**: with
prepared statements a `PUT /state` is four round trips (BEGIN, the locked loads, the
writes, COMMIT; three when stale) and a `GET /state` one, but without them postgres.js
describes every parameterised statement before running it, which roughly doubles the
round trips per statement and stops it pipelining (about 14 for a small `PUT`). Neon's
`channel_binding` parameter is dropped from the URL (postgres.js doesn't support it and
would pass it to the server as an unknown setting).

What differs from the Deno server on purpose:

- Only the PWA's own files are served (`/`, `index.html`, `sw.js`, `manifest.webmanifest`,
  `css/`, `js/`, `icons/`), not the whole repo.
- `PUT /state` accepts up to 2 MiB (was 256K characters against a 64KB store).
- The archive is its own append-only table (`archived_cards`), not a flag on the card, so
  `POST /archive` leaves `GET /state` and `rev` alone, as on KV: the client archives cards
  that are still on the board and drops them with a later `PUT`. Cards are stored as sent
  (a `json` column, so key order is kept too), the first of two equal ids in one batch wins
  (KV kept both), a batch over 2 MiB is a 413, and there are no chunks: `chunk` is always
  0 and `chunks` is 1 once anything is archived.
- `POST`/`PATCH`/`DELETE /tickets` lock `board_head` and rewrite from the current board in
  one transaction, instead of retrying a compare-and-swap five times. A lock wait over 5
  seconds, a deadlock or a serialization failure is the same 503 `write contention, retry`.
  Their `changes` rows are attributed to `cli`. A deleted ticket is soft-deleted, and a
  title or note with U+0000 or a lone surrogate is stored (and later read) with U+FFFD, as
  for `PUT`, though the create response still echoes what was sent.
- What `GET /state` gives back after a `PUT` differs from what was sent in a few corner
  cases of storing a board as rows; each is listed, with its reason, at the top of
  `src/pg-store.ts`:
  - a duplicated card or lifeMeta item id keeps only its first occurrence;
  - `lifeMeta` always comes back with all four keys (`focus`, `dates`, `notes`,
    `stickies`), and items without a string id are dropped;
  - nested values of unknown card fields don't keep their key order (jsonb);
  - U+0000 and lone UTF-16 surrogates, anywhere in the board (keys included), come back
    as U+FFFD: Postgres can't store them, and refusing the `PUT` would leave the PWA
    retrying a 500 forever;
  - a null or absent `projects`/`life` comes back as `{}`, and an array-shaped one as an
    object keyed `"0"`, `"1"`, … (the client's `normalize()` reads both the same way).

## Test it

```bash
npm run test:api        # from the repo root: type check + tests
# or, in api/:
npm run check           # tsc --noEmit (types only; nothing is emitted)
npm test                # node --test
```

`tests/contract.test.ts` is `server/webhook.deno.ts` ported step for step: it spawns
`node src/main.ts` and drives it only over HTTP. Postgres is PGlite (Postgres compiled to
WASM, in the test process) behind `@electric-sql/pglite-socket`, so the server talks to it
with the same driver and wire protocol it uses against Neon; every server gets a fresh
database, so nothing outside `api/` is needed. Set `KODER_TEST_SEED` to replay the
round-trip property step with the seed a failure printed. PGlite runs one transaction at a
time, so the concurrency step proves the compare-and-swap on `baseRev`, not real lock
contention.

The root `npm test` stays the frontend's (type check of `js/` plus `tests/`); it doesn't
look in `api/`.
