# Runbook: cut over from the Deno server to the Node + Postgres server

DRAFT. Written for KODER-EE05 (port the server off Deno to Node + Postgres in `api/`). Nothing
here has been run. Steps that depend on a decision still open are marked `TODO(decide)`.

This is deliberately a simpler freeze-and-copy plan and departs from
`docs/specs/storage-expansion.md` section 8 (dual-write, a read-only switch, reverse-write
rollback) on purpose: no dual-write code exists, the Deno app has no read-only switch, and
rollback while the Deno app is still live is the safety net.

Today `server/` (Deno Deploy + Deno KV) is the live production board. `api/` is a complete,
tested replacement that ships as a container image (`Dockerfile` at the repo root). The
cutover moves the board's data from KV into Postgres, points every client at the new origin,
and later deletes `server/`.

Open tickets this depends on:

- KODER-5C08: this cutover, including choosing the host for the container (this runbook is
  host-agnostic) and the final cleanup PR in step 10.
- KODER-E214: write the KV -> Postgres import (and the verifier). It does not exist yet;
  the requirements it must meet are in step 4.
- KODER-948E (optional, not a blocker): run the api contract suite against a real Postgres in
  CI. Until it lands, real lock waits and deadlocks are only exercised by the docker smoke job.

Why the order matters: `rev` is a single, monotonically increasing integer that the PWA
compares against (`doc.rev <= SYNC.rev` means "ignore"). The new database MUST start at
exactly the KV head rev and never go backwards, or every installed PWA would ignore the new
server's data.

## 0. Preconditions

- [ ] KODER-5C08 decided; the host can run a container image, give it env vars, terminate
      HTTPS and (ideally) restart it on failure. TODO(decide): host.
- [ ] KODER-E214 merged: an import script that satisfies step 4, plus a verifier that diffs
      the KV doc against the Postgres-assembled doc.
- [ ] The slice 1-4 PRs of KODER-EE05 are merged and CI is green on `main` (frontend, api on
      Node 22 and 24, docker-smoke).
- [ ] You can read KV: Deno Deploy access, or a way to run a script with the KV database
      attached. TODO(decide): how the export/import script reads KV (a one-off Deno script
      with the KV database, or a temporary read-only endpoint on the old app).
- [ ] The GitHub webhook secret, the sync token and the GitHub token are at hand (password
      manager); you will reuse them on the new host so clients and GitHub need no change
      other than the URL.
- [ ] A quiet hour. The freeze in step 6 should last minutes.

## 1. Provision Postgres (Neon)

1. Create a Neon project (or reuse the one from the storage spike) and a database for Koder.
2. Copy the **direct** connection string (host without `-pooler`) as `NEON_DATABASE_URL`.
   The pooled endpoint works but costs about 15 round trips per write instead of 4.
3. Keep `sslmode=require` in the URL. Do not put the URL in the repo, in `js/` or in CI.
4. Neon's free tier suspends idle compute; the first request after a pause is slow.
   TODO(decide): accept that, or pick a plan/host that keeps it warm.
5. Backups: Neon's instant-restore window on free tiers is short. TODO(decide): schedule a
   `pg_dump` to private storage (see the storage spec, security notes) before relying on it.

Never attach this database inside the Deno Deploy dashboard: an app can have one attached
database and attaching Postgres detaches KV, which would take down the live board.

## 2. Provision the host and deploy the image

1. Build and push the image to the host's registry, or let the host build from the repo's
   `Dockerfile`. TODO(decide): per 5C08.
   ```bash
   docker build -t koder-api .
   ```
2. Set the environment on the host (values from your password manager, never committed):
   `NEON_DATABASE_URL`, `KODER_TOKEN` (the same token the clients already use),
   `KODER_WEBHOOK_SECRET` (the same secret GitHub signs with), `GITHUB_TOKEN`,
   `KODER_ORIGIN` if you lock CORS, optionally `PORT` and `KODER_PG_MAX`.
3. Point the host's health check at `GET /` (port 8000 by default).
4. Start it. On first boot it creates the schema (migrations under an advisory lock) in the
   empty database; the logs should show `Listening on ...` and nothing else.
5. TODO(decide): custom domain vs the host's default URL. A new origin means a new
   `base` in every client; keeping the old hostname would avoid that but needs DNS control.
6. Smoke-test the EMPTY deployment (it writes to the board; rev 0 is required):
   ```bash
   api/scripts/smoke.sh https://<new-host> '<KODER_TOKEN>'
   ```
   Then wipe the smoke data: drop and recreate the Koder database (or the schema) so the
   import in step 4 starts from an empty database. TODO(decide): whether the import script
   refuses a non-empty database (recommended) or the wipe is manual.

## 3. Safety export from KV (before touching anything)

Keep these outside the repo (they are personal data), dated, in private storage:

- `GET /state`, `GET /archive`, `GET /revisions` from the old server, and `GET /state?rev=N`
  for each listed rev.
- A raw KV dump of every prefix: `["board"]`, `["board", rev]`, `["archive", n]` and
  `["github-delivery", *]`.

## 4. Import KV into Postgres (KODER-E214)

Run against the new, empty database. The import must:

- Set `board_head.rev` to the KV doc's exact head `rev`. Never reset it, never add one.
- In the same transaction insert the `revisions` row for that rev: actor `migration`,
  `updated_at` = the KV doc's `updatedAt`, no `changes` rows. History and restore only serve
  revs that have a `revisions` row, so without it the board as it stood at cutover can never
  be served by `GET /state?rev=N` or restored.
- Insert cards in array order (rank), the `lifeMeta` items and the life notes, with
  `pr`/`prRev`/`created`/unknown fields intact.
- Import every `["archive", n]` chunk into `archived_cards` (`archivedAt` ms to `archived_at`,
  `board` to `archived_from`).
- Import ALL `["github-delivery", *]` ids into `webhook_deliveries` (outcome `migrated`), or
  GitHub redeliveries would be applied twice.
- Not import the 20 `["board", rev]` KV snapshots: history starts at the cutover.
- Be re-runnable on an empty database, and refuse (or clearly report) a non-empty one.

Then run the verifier: rev equal, card counts per column, per-card canonical JSON equal,
order within each column, `lifeMeta`, archive id set and delivery id set equal. Any diff
stops the cutover. The documented, intentional differences (duplicate ids, U+FFFD
normalisation, null `projects` becoming `{}`) are in `api/README.md`, "What differs".

This first import is a rehearsal: the old app keeps taking writes, so the copy goes stale.
The real import is the one in step 6.3, into a freshly wiped database. Rehearse steps 1-4
once on a throwaway Neon branch before the real run.

## 5. Dry-run the new server with the imported data

Before any client moves, against the new host:

1. `GET /state` with the bearer token: same `rev` as the KV doc; compare the body with the
   old server's (`curl` both, diff).
2. `GET /state?rev=<imported head>` is served (200) and equals the KV doc.
3. `GET /archive` count equals the KV archive count.
4. Do NOT run `smoke.sh` here (it needs rev 0 and would write). Make no writes: the
   database is wiped again in step 6.3, and the first real write comes after the switch.

## 6. Freeze, re-import, switch

1. Announce the freeze to yourself: close board tabs and stop agents/CLI runs.
2. Block writes on the old server. TODO(decide): the Deno server has no read-only flag.
   Options: rotate its `KODER_TOKEN` to a throwaway value (all writes 401; the webhook still
   works, so also disable GitHub deliveries or accept that a redelivery is needed), or
   deploy a small read-only patch to `server/` (touches the live app; avoid).
3. Redo the import from scratch; there is no incremental import. The step 4 and 5 copy was
   a rehearsal and is already stale, because the old app took writes after it. Take a fresh
   KV export (step 3, new date), WIPE the Postgres database the same way as step 2.6, then
   import into the empty database (exact head rev, the `revisions` row for the imported
   head, all delivery ids) and re-run the verifier. Only when it is clean, go on.
4. Switch the clients (step 7). The first write through the new server must be `rev` head + 1.
5. Re-enable the webhook on GitHub (step 7) and redeliver any delivery that failed during the
   freeze from GitHub's UI (delivery ids make a replay safe).

## 7. Point clients at the new host

- PWA: each device uses the "connect a device" flow (`js/connect.js`) or `js/config.local.js`.
  Update `KODER_API.base` (and the token if you rotated it). The service worker never caches
  API routes, so no cache bump is needed; if the PWA itself is now served from the new origin
  (the Node server serves it), the installed copy on the old origin needs reinstalling
  from the new URL. TODO(decide): which origin serves the PWA after the cutover.
- CLI and agents: update `KODER_API` (and `KODER_TOKEN`) in `scripts/.koder.env` and the
  sibling repos' copies of it.
- GitHub: repo settings, Webhooks, change the Payload URL to `https://<new-host>/webhooks/github`
  (content type `application/json`, same secret, "Pull requests" events). Use "Recent
  deliveries" to redeliver one and confirm a 200.
- If a lock-down is in use, set `KODER_ORIGIN` on the new host to the board's origin.

## 8. Verify

- Open the board on the phone and the laptop: same cards, no sync error, no re-pull loop.
- Edit a card in one, see it in the other (a push and a 409/merge round trip).
- `koder-ticket` CLI: list tickets, add one, move it.
- Open and merge a throwaway PR in an allowlisted repo; the card moves to Review, then Done.
- `GET /revisions` shows the new writes after the `migration` head; restoring one works.
- Logs on the host: no stack traces.

## 9. Rollback (valid while the Deno app is still live)

The old server keeps running untouched, so rollback is switching clients back:

1. Restore the old `KODER_TOKEN` on Deno Deploy if you rotated it in step 6.
2. Point `KODER_API` / the webhook URL / the PWA config back at the Deno app.
3. Writes made on the new server since the switch are NOT in KV. If there were any, export
   them (`GET /tickets`, `GET /state` on the new host) and re-file or merge them by hand
   before rolling back; there is no reverse sync. `rev` on KV is lower than the new
   server's, and the PWA ignores any server rev at or below what it has seen, so a rolled-back
   device must reconnect fresh (clear its sync state) rather than expect to pick up KV's board.
   TODO(decide): is a reverse export script (Postgres -> KV) worth writing, or is
   "roll back only within minutes of the switch" good enough for a personal board.
4. After a rollback, the Postgres database is stale; wipe it (as in step 2.6). The next
   attempt re-imports from empty in step 6.3 anyway.

## 10. Watch period, then cleanup

Watch for about 30 days (TODO(decide): length): the host's logs and restarts, Neon usage,
webhook deliveries (GitHub shows failures), and the daily use of the board. Keep the KV
database and the Deno app untouched, but idle, during that time. Do not write to KV.

Then, in one final cleanup PR (KODER-5C08):

- Delete `server/`, `deno.json` and `deno.lock`, and the Deno parts of the docs
  (`server/README.md`, the "Deploy" and "Host the frontend" sections, the Deno lines in the
  root `README.md` and `CLAUDE.md`).
- Keep `api/tests/contract.test.ts` (it is the contract suite now; `server/webhook.deno.ts` goes).
- Remove the Deno Deploy app from the Deno Deploy dashboard and, after another quiet period,
  delete the KV database. Delete the safety exports only when you no longer want them.
- Update `CLAUDE.md` so `api/` is described as the server, and drop the "legacy" wording.
