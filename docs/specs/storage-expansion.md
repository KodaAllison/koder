# Spec: Storage expansion (beyond the single-document board)

Status: draft for Koda's review. Author: Claude. Date: 2026-10-01.
Related: `docs/specs/agent-orchestration.md` (run records; referenced, not duplicated. It did not exist in the
repo when this was written, so the `agent_runs` shape below is a placeholder to be reconciled with it).
Ticket context: KODER-DBA0 (Finances module). I could not read that ticket's body from here; the finance
requirements below come from the brief (integer pence, immutable ledger, idempotent imports).

## 1. Problem statement

The whole board is one Deno KV value `{rev, updatedAt, board}` under key `["board"]` (`server/main.ts:86`,
`server/main.ts:148-152`). KV caps a value at 64 KiB, so everything that touches the board is shaped around that
ceiling:

| Evidence | Where |
|---|---|
| `PUT /state` rejects bodies over 60,000 chars with 413 | `server/main.ts:728-731` |
| Client mirrors the ceiling: `BOARD_SIZE_LIMIT = 60_000`, warn at 80% | `js/store.js:171-175` |
| Done cards must be lifted into a chunked append-only archive "to stop counting against that budget" | `server/main.ts:54-59`, `:98-105`, `:756-802`, `js/archive.js:10-17` |
| Every write rewrites the entire board AND a full copy as a snapshot, pruning the one 20 behind | `server/main.ts:92-96`, `:170-180` |
| `GET /tickets`, `PATCH`, `DELETE`, webhook all read-modify-write the whole doc, retried up to 5x on contention | `server/main.ts:563-629`, `:815-950` |
| Archive append re-reads every chunk and re-serializes to test the seal threshold | `server/main.ts:272-280`, `:773-787` |
| Per-note cap is 5,000 chars purely to protect the shared budget | `server/main.ts:120`, `js/store.js:188` |

What this means in practice:

1. The limit is the data model, not storage. Deno Deploy's KV allowance is far larger than a personal board will
   ever fill; only the one-document-per-board design hits 64 KiB. A board of roughly 150-250 live cards (titles +
   notes + lifeMeta) is already at the warning line.
2. The archive is a workaround that has already become a second storage system with its own semantics (append-only,
   chunked, deduped by scanning all chunks, no edit/restore/search).
3. Revisions are 20 full copies of a near-limit doc, and "restore" can only reach 20 writes back (`:675`, `:708`).
4. Contention: every actor (browser tab, CLI, webhook) writes the same key, so unrelated edits conflict. The 409
   merge (`js/store.js:348`, `js/sync.js:165-179`) papers over this client-side.
5. New domains cannot live in this document: a Finances ledger (thousands of rows, immutable, queried by
   date/account), agent run records, and passkey credentials do not fit a 64 KiB blob and need real queries.

## 2. Goals and non-goals

Goals
- G1. Remove the 64 KiB board ceiling; no workaround layers (archive chunks) needed for capacity.
- G2. Keep the public REST contract byte-compatible so the PWA, `scripts/koder-ticket.sh`, the koder-ticket skill
  (synced to sibling repos) and the GitHub webhook keep working unmodified through the migration.
- G3. Preserve every current safety property: optimistic concurrency via `baseRev`/409, server-owned `pr`/`prRev`,
  permanent webhook delivery idempotency, restore-as-new-rev, archive idempotency by card id.
- G4. Leave room for Finances (integer pence, immutable ledger, idempotent imports), passkey auth, an MCP endpoint,
  and agent run records, without a second storage migration.
- G5. Real learning and CV value: relational modelling, migrations, transactions, an event log, a repository
  abstraction with contract tests.
- G6. Stay in free tiers at personal scale; document what happens when a limit is hit.

Non-goals
- Multi-user / multi-tenant. (Schema carries an `owner_id` so it is not painted into a corner; no sharing UI.)
- Replacing the PWA's localStorage-first behaviour, or rewriting the frontend framework.
- Real-time push (WebSocket/SSE). The 30s visible-tab poll (`js/sync.js:342-344`) stays; it just must become cheap.
- A local-first sync engine as the primary path (see option E; later experiment only).
- Designing the orchestration protocol (other spec) or the Finances UI (KODER-DBA0).

## 3. Options compared

Numbers are from web searches on 2026-10-01 unless marked. Pricing pages change; re-check before committing.
Many vendor docs (e.g. mastra.ai, some Deno docs) were not reachable from the egress proxy, so items marked
(unverified) rest on search snippets or memory only.

| | A. Deno KV, key per card + index keys | B. Postgres (Deno Deploy Postgres / Neon) + Drizzle | C. Cloudflare Workers + D1 (or DO SQLite) | D. Turso / libSQL | E. Local-first engine (Zero, PowerSync, ElectricSQL) |
|---|---|---|---|---|---|
| Fixes 64 KiB ceiling | Yes (per-card values ~ <10 KiB) | Yes | Yes | Yes | Yes (but Postgres/SQLite underneath anyway) |
| Cost at personal scale | Free | Free. Deno Deploy's Prisma Postgres free tier: 100K ops/mo, 500 MB, 5 DBs (docs.deno.com, search snippet). Neon free: 0.5 GB/project, 100 CU-hours/mo, compute suspends at limit (neon.com/pricing, snippet) | Free. D1 Workers Free: 5M rows read/day, 100K rows written/day, 5 GB (Cloudflare docs, snippet) | Free. 500M rows read/mo, 10M written/mo, 5 GB (Turso pricing snippets, tier names change often) | Free for self-hosted OSS parts; hosted tiers (unverified) |
| Learning value | Medium: hand-rolled indexes, no joins, manual consistency | High: SQL, migrations, transactions, constraints, an ORM | High, plus new runtime (Workers bindings, wrangler) | Medium-high: SQLite semantics, edge replicas | Very high, but conceptually heavy |
| CV value | Low-medium (niche) | High (Postgres is the lingua franca) | Medium-high (Cloudflare common) | Medium (niche) | Medium; "novel" but risky signal if half-working |
| Rewrite risk | Low: stay in `main.ts`, same host | Low-medium: swap persistence only; host unchanged; new driver on Deno | High: move runtime + host + webhook URL, re-do static serving (`server/main.ts:634-651`), CORS, secrets | Medium: persistence swap, host unchanged; libSQL client works from Deno | High: client data layer replaced (`state.js`, `sync.js`, `store.js` merge logic) |
| Finance fit (ledger, constraints) | Poor: no multi-key unique constraints or aggregates; sums done in app code | Excellent: CHECK, FK, unique idempotency keys, triggers, `SUM ... GROUP BY`, numeric types | Good (SQLite; fewer types, no native decimal but integer pence is fine) | Good (same as D1) | Depends on backing DB |
| Atomic multi-row writes | KV atomic: up to 1000 mutations / 800 KiB per commit (unverified, recheck docs) | Full transactions | D1 batch / DO transactions | Transactions | Engine-specific |
| Free-tier cliff to watch | KV read/write units (unverified) | Prisma 100K "operations"/mo: a 30s poll that does 1-2 queries is ~2.9K-5.8K/day per always-open tab, so poll must be a single cheap query (see 7.1). Neon cold start after idle suspend (adds latency to webhook) | Daily row-read cap resets 00:00 UTC | Monthly row caps | n/a |
| Lock-in | Deno only | Low: standard SQL, portable between Neon/Prisma/RDS | Cloudflare-specific bindings | libSQL ecosystem | High |

Honest takeaways
- A is the smallest change and the worst long-term fit: it re-implements what a database gives for free (secondary
  indexes, uniqueness, aggregates), and Finances will push it past usefulness. It is a reasonable stopgap only if
  Koda wants zero new infrastructure for a month.
- C is attractive as a CV item but is effectively a rewrite of the server (host, static serving, webhook URL on
  GitHub, secrets) for no capability B lacks. Do it later as a deliberate "port" exercise if wanted.
- D is a fine technical choice and near-equal to B on function; it loses on CV value and on ledger-grade Postgres
  features. Reasonable fallback if Postgres operational limits (idle suspend, ops cap) bite.
- E solves a problem Koder does not have yet (multi-device realtime conflict-free editing). The current
  `baseRev`+`mergeBoards` model works. Treat as a spike after Phase 4.

## 4. Recommendation

Adopt B: Postgres, accessed through a thin repository interface, with the REST contract unchanged.

- Host: keep Deno Deploy for the server (webhook URL, static serving, env secrets stay put). Provision Postgres via
  Deno Deploy's built-in database integration if it fits the ops cap; otherwise Neon. Decision rule in Phase 0:
  whichever gives lower p95 latency from the Deploy region in a 10-minute probe and does not suspend inside the
  webhook's retry window. (I could not verify the exact connection/driver instructions for Deno Deploy Postgres;
  the docs page title is `docs.deno.com/deploy/reference/prisma_postgres`. Verify in Phase 0.)
- Access layer: `npm:postgres` (porsager) or `npm:pg` with hand-written SQL in a `Store` interface first; adopt
  Drizzle (schema in TS, `drizzle-kit` migrations) once the schema stabilises. Rationale: SQL fluency is the CV
  value; Drizzle is a thin typed layer over it. Open question Q2.
- Introduce `Store` (repository) interface with two implementations, `KvStore` (today's behaviour, extracted) and
  `PgStore`. One contract test-suite runs against both. This is what makes dual-write, rollback and tests cheap.
- Do not expand the client protocol yet. First make the server relational behind the identical API; only then (Phase 4)
  add delta endpoints the PWA opts into.

Why this overturns nothing, but one nuance on the lead recommendation: B is right, with the caveat that the hard
part is not the database but the "full-board `PUT /state`" endpoint. That endpoint is a whole-document replace
(`server/main.ts:725-754`); on a relational store it must be implemented as a diff-apply inside one transaction.
That is the main engineering risk and gets its own section (7.2).

## 5. Proposed schema (SQL sketch)

Conventions: `text` ids (client ids like `t_msa8scco_632be` are generated by `uid()` in `js/store.js:118` and are the
merge key, so they must be stored verbatim); `timestamptz`; money as `bigint` pence; single owner for now.

```sql
-- 5.1 Core identity & concurrency ------------------------------------------
CREATE TABLE owners (
  id         text PRIMARY KEY,                 -- 'koda' for now
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per logical document family. 'board' is today's {rev, updatedAt}.
-- rev is the HEAD revision; +1 on every successful write, never rewinds.
CREATE TABLE board_head (
  owner_id   text PRIMARY KEY REFERENCES owners(id),
  rev        bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz
);

-- 5.2 Board -----------------------------------------------------------------
-- Maps Card (js/store.js:7-17). board_id/column_id replace the
-- {projects|life}[columnId][] nesting. life cards have project_id NULL.
CREATE TABLE cards (
  id          text PRIMARY KEY,
  owner_id    text   NOT NULL REFERENCES owners(id),
  board_id    text   NOT NULL CHECK (board_id IN ('projects','life')),
  column_id   text   NOT NULL,
  rank        text   NOT NULL COLLATE "C",     -- fractional index; preserves in-column order
  title       text   NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  note        text   NOT NULL DEFAULT '' CHECK (length(note) <= 20000),
  priority    text   NOT NULL DEFAULT 'med' CHECK (priority IN ('low','med','high')),
  created     bigint NOT NULL,                 -- epoch ms, as the client stores it
  project_id  text,                            -- Card.project; NULL = unassigned/life
  -- Server-owned workflow state (never writable from PUT /state):
  pr          text,                            -- 'owner/repo#123'
  pr_rev      bigint,                          -- nextWebhookRevision() semantics
  -- Lifecycle:
  archived_at timestamptz,                     -- NULL = on the board
  archived_from text,                          -- 'projects'|'life' as tagged by js/archive.js
  deleted_at  timestamptz,                     -- soft delete (DELETE /tickets/:id)
  row_version bigint NOT NULL DEFAULT 1,       -- per-row, for future delta API; NOT the public rev
  extra       jsonb  NOT NULL DEFAULT '{}'     -- unknown client fields round-trip (forward compat)
);
CREATE INDEX cards_board_col ON cards (owner_id, board_id, column_id, rank) WHERE archived_at IS NULL AND deleted_at IS NULL;
CREATE INDEX cards_project   ON cards (owner_id, project_id)              WHERE deleted_at IS NULL;
CREATE INDEX cards_pr        ON cards (pr) WHERE pr IS NOT NULL;
-- ref (KODER-xxxx) is derived by js/ref.js and never stored; resolution stays
-- in app code (ticketRef) so there is a single definition. Optional later: a
-- generated column once ref.js's rule is frozen.

-- Maps LifeMeta (js/store.js:27-40). Three item lists + legacy notes string.
CREATE TABLE life_items (
  id       text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owners(id),
  kind     text NOT NULL CHECK (kind IN ('focus','dates','stickies')),
  rank     text NOT NULL COLLATE "C",
  data     jsonb NOT NULL,                     -- {text,done} | {title,date} | {text,color}
  deleted_at timestamptz
);
CREATE TABLE life_notes (                      -- LifeMeta.notes (legacy scratchpad)
  owner_id text PRIMARY KEY REFERENCES owners(id),
  notes    text NOT NULL DEFAULT ''
);

-- Projects today come from js/projects.json (static, generated). Keep that
-- as source of truth for now; only mirror ids so FK is possible later.
-- (Open question Q4: move projects into the DB?)

-- 5.3 History, restore, idempotency -----------------------------------------
-- Replaces 20 full snapshots (server/main.ts:96, :174-175). One row per
-- changed entity per rev; reconstruct board@N by reverse-applying from head.
CREATE TABLE changes (
  rev        bigint NOT NULL,
  owner_id   text   NOT NULL,
  seq        int    NOT NULL,                  -- order within a rev
  entity     text   NOT NULL CHECK (entity IN ('card','life_item','life_notes')),
  entity_id  text   NOT NULL,
  op         text   NOT NULL CHECK (op IN ('insert','update','delete')),
  before     jsonb,                            -- NULL on insert
  after      jsonb,                            -- NULL on delete
  actor      text   NOT NULL,                  -- 'browser'|'cli'|'webhook'|'restore'|'migration'|'agent:<run>'
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, rev, seq)
);
CREATE TABLE revisions (                       -- GET /revisions
  owner_id   text   NOT NULL,
  rev        bigint NOT NULL,
  updated_at timestamptz NOT NULL,
  actor      text   NOT NULL,
  summary    text,                             -- "3 cards moved" (nice-to-have)
  PRIMARY KEY (owner_id, rev)
);

-- Permanent idempotency (today: ["github-delivery", id] = true, never pruned,
-- server/main.ts:87, :452-459, :499-503, :565-570).
CREATE TABLE webhook_deliveries (
  delivery_id text PRIMARY KEY,                -- lowercased X-GitHub-Delivery
  source      text NOT NULL DEFAULT 'github',
  outcome     text NOT NULL,                   -- 'updated'|'ignored:<why>'|'error:<code>'
  rev         bigint,                          -- rev it produced, if any
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 5.4 Archive ---------------------------------------------------------------
-- Not a separate table: archive becomes cards.archived_at IS NOT NULL.
-- POST /archive: UPDATE ... SET archived_at=now() WHERE id = ANY($1) AND archived_at IS NULL
-- (idempotent by id exactly like today, :775-776). Archived cards drop out of
-- GET /state's board; GET /archive selects them. This is the point where the
-- 60 KB budget stops mattering, and archive becomes restorable/searchable.

-- 5.5 Future modules (shape only; each gets its own spec/ticket) ------------
-- Finances (KODER-DBA0): integer pence, immutable ledger, idempotent imports.
CREATE SCHEMA fin;
CREATE TABLE fin.accounts (
  id text PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('current','savings','credit','cash')),
  currency char(3) NOT NULL DEFAULT 'GBP', opened_on date, closed_on date
);
CREATE TABLE fin.transactions (                -- append-only ledger
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   text   NOT NULL REFERENCES fin.accounts(id),
  posted_on    date   NOT NULL,
  amount_pence bigint NOT NULL CHECK (amount_pence <> 0),   -- signed; never float
  currency     char(3) NOT NULL DEFAULT 'GBP',
  description  text   NOT NULL,
  category_id  text,                           -- mutable via annotation table, not UPDATE
  import_source text,                          -- 'monzo-csv','manual',...
  external_id  text,                           -- bank's id or row hash
  reverses_id  uuid REFERENCES fin.transactions(id),        -- corrections = new rows
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, import_source, external_id)           -- idempotent re-import
);
-- Immutability enforced in the DB, not just app code:
--   CREATE TRIGGER no_update BEFORE UPDATE OR DELETE ON fin.transactions
--   FOR EACH ROW EXECUTE FUNCTION fin.reject_mutation();
-- plus a role without UPDATE/DELETE grants for the app user.
CREATE TABLE fin.budgets (id text PRIMARY KEY, owner_id text NOT NULL, category_id text NOT NULL,
  period text NOT NULL, limit_pence bigint NOT NULL CHECK (limit_pence >= 0), UNIQUE (category_id, period));

-- Auth (passkeys). Replaces the browser-shipped token (server/README.md:391-396).
CREATE TABLE credentials (
  id bytea PRIMARY KEY, owner_id text NOT NULL, public_key bytea NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0, transports text[], label text,
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz
);
CREATE TABLE api_tokens (                      -- CLI / agents / MCP; SHA-256 hashed, scoped, revocable
  id text PRIMARY KEY, owner_id text NOT NULL, token_hash bytea NOT NULL UNIQUE,
  scopes text[] NOT NULL, label text, created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz, revoked_at timestamptz
);
CREATE TABLE sessions (id text PRIMARY KEY, owner_id text NOT NULL, credential_id bytea,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Agent runs: placeholder; the authoritative shape lives in
-- docs/specs/agent-orchestration.md. Key requirement from this spec: a run
-- can reference cards(id) and changes(actor='agent:<run_id>').
CREATE TABLE agent_runs (
  id text PRIMARY KEY, owner_id text NOT NULL, card_id text REFERENCES cards(id),
  status text NOT NULL, started_at timestamptz, finished_at timestamptz, data jsonb NOT NULL DEFAULT '{}'
);
```

### 5.1 How each existing semantic is preserved

| Today | Postgres equivalent |
|---|---|
| `rev` bumps by exactly 1 per write (`main.ts:746`) | `UPDATE board_head SET rev = rev + 1, updated_at = now() WHERE owner_id=$1 AND rev=$base RETURNING rev` inside the write transaction; 0 rows = stale = 409. Same number space, same terminology note (`main.ts:20-31`) |
| `kv.atomic().check(entry)` (`:171`) | The `rev = $base` predicate above, plus `SELECT ... FOR UPDATE` on `board_head` for server-initiated read-modify-write (PATCH, DELETE, webhook), which removes the 5-attempt retry loops (`:563`, `:710`, `:773`) |
| 409 body `{error, rev}` (`:744`) | Identical JSON and status. Client `mergeBoards` (`js/store.js:348`) is untouched: it still receives a full doc from `GET /state` |
| `PUT /state` whole-doc replace (`:741-753`) | Diff-apply (7.2): upsert incoming cards, soft-delete missing cards, rewrite `rank`, upsert `life_items`; one transaction; one rev bump; one `changes` batch |
| `preserveWorkflowMetadata` (`:318-342`): `pr`/`prRev` forced to server values | Diff-apply never writes `pr`/`pr_rev` from the body. Only the webhook handler and (optionally) an admin path set them. New cards cannot acquire them |
| `prRev = nextWebhookRevision(prev)` (`workflow.ts`, `main.ts:614`) | `pr_rev` column; same function used in TS and written with the card update in the webhook transaction. `mergeBoards` still keys off `pr`/`prRev` differences (`js/store.js:366-371`) so the card must round-trip both fields in `GET /state` |
| Webhook delivery guard, permanent, atomic with the board write (`:172-178`, `:565-624`) | `INSERT INTO webhook_deliveries ... ON CONFLICT (delivery_id) DO NOTHING RETURNING` in the SAME transaction as the card update and rev bump. Conflict = redelivery response `{updated:false, redelivered:true, rev}` (`:570`). No-op outcomes (ignored/untrusted/etc., `:447-460`) record the delivery too, as today |
| 20-snapshot revisions, 404 if pruned (`:675`) | `changes` log makes every rev reachable until retention is chosen (default keep all; it is tiny). `GET /state?rev=N` reconstructs board@N by reverse-applying `changes` from head (or from periodic checkpoints, see Q5). 404 only if N > head or retention pruned it |
| `POST /state/restore` re-lands snapshot as new head (`:700-722`) | Reconstruct board@N, diff against current, apply as a normal write with `actor='restore'`; rev never rewinds. `pr`/`pr_rev` on restored cards: keep CURRENT server values (matches the spirit of `preserveWorkflowMetadata`; today restore copies the snapshot verbatim, a small divergence to flag in Q6) |
| Archive append-only, idempotent by id (`:766-802`) | `archived_at` flag; repeat POST is a no-op and returns `{archived:0, duplicates:n}` (shape kept). `chunks`/`chunk` fields: return `chunks: 1` / `chunk: 0` constants for compatibility |
| `DELETE /tickets/:id` hard-delete, recoverable via snapshots (`:845-950`) | Soft delete (`deleted_at`) plus a `changes` row; the response `{card, ref, column, rev, board}` is unchanged |
| `resolveTicketId` id-or-ref with 409 on ambiguous ref (`:292-313`) | Unchanged logic over `SELECT` of live cards; stays in app code using `ticketRef` from `js/ref.js` (single definition shared with the board) |

## 6. API compatibility plan

Rule: no response shape, status code or field name changes in Phases 1-3. The PWA and CLI cannot tell.

| Endpoint | Compatibility | Notes |
|---|---|---|
| `GET /state` | Byte-compatible `{rev, updatedAt, board:{projects,life,lifeMeta}}` | Assemble from `cards` + `life_items`; column arrays ordered by `rank`; `lifeMeta` always has all four keys (matches `normalize`, `js/store.js:259-262`). Archived/deleted cards excluded. Key order should match to keep golden-file tests simple |
| `GET /state?rev=N` | Compatible | Reconstructed; see 5.1 |
| `PUT /state` | Compatible request/response; 413 threshold raised (see below) | Diff-apply. 409 shapes unchanged |
| `GET /revisions` | Compatible `{revisions:[{rev,updatedAt}]}` | Newest first; list capped (say 200) with `?limit`; additive `actor` field is the only change (additive, safe) |
| `POST /state/restore` | Compatible | |
| `POST/GET /tickets`, `PATCH/DELETE /tickets/:id` | Compatible, including `ref`, id-or-ref resolution, validation caps (`cleanTicketFields`, `:221-267`) | These become single-row SQL, no more whole-doc rewrites. `rev` returned is still the board head |
| `POST/GET /archive` | Compatible | See 5.1; `GET` returns `{count, chunks, cards}` |
| `GET /pr-status` | Untouched (no storage) | |
| `POST /webhooks/github` | Compatible | HMAC verification, 256 KiB cap, body semantics untouched; only the persistence calls change |
| CORS, static serving, SPA GET fallthrough (`:434-437`, `:643`) | Untouched | |

413 policy: the 60,000-char reject (`:729`) is replaced by a generous request cap (propose 2 MB) enforced before JSON
parse. Important knock-on: the PWA still sends the entire board on every sync and still holds it in localStorage
(typically ~5 MB quota), and still warns at 48,000 chars (`js/store.js:171-175`). Raising the server cap alone does
not make the client scale; Phase 4 adds delta endpoints and a client change that retires `BOARD_SIZE_LIMIT`. Until
then the client-side warning stays, and the practical headroom is: archive stays useful, but is no longer
mandatory. Do not remove the client warning in the same PR as the server cap change.

Additive endpoints (new, opt-in, introduced in Phase 4; all under `/v2/` or `?since=`, never changing old routes):
- `GET /state/head` -> `{rev}`: one indexed point query. Makes the 30s poll (`js/sync.js:342-344`) a ~1-query call
  instead of loading and assembling the board; also keeps the Prisma "operations" budget healthy.
- `GET /changes?since=rev` -> list of `changes`; foundation for incremental sync, MCP resources, audit.
- `POST /v2/ops` -> batch of card ops with `baseRev`, per-op results (card-level conflict instead of whole-board
  409). The PWA can adopt it behind a flag; `mergeBoards` remains the fallback.

## 7. Implementation notes

### 7.1 Poll cost
Today every open tab pulls the full doc every 30s while visible (`js/sync.js:342-344`). With a per-operation quota
(Prisma free tier 100K ops/mo, unverified details) a pull that issues several queries is wasteful. First
optimisation, still byte-compatible: `GET /state` first reads only `board_head.rev`; the client already ignores a
doc whose `rev <= SYNC.rev` (`js/sync.js:295`), so add `GET /state/head` (additive) and have the client call it
before the full read. Budget: 2 tabs x 8 h/day x 120 polls/h x 1 query is about 2K/day, roughly 58K/mo: within 100K but
not by much, hence Neon (compute-hours quota instead of per-op) is the fallback.

### 7.2 PUT /state as diff-apply (the hard part)
In one transaction:
1. `SELECT rev FROM board_head WHERE owner_id=$1 FOR UPDATE`; compare to `baseRev`; mismatch -> 409 `{error:"conflict: baseRev is stale", rev}`.
2. Load current live cards (`id, board_id, column_id, rank, title, note, priority, project_id, pr, pr_rev`).
3. For each incoming card, in column order: compute new rank from neighbours (fractional index; only rewrite
   ranks that changed to keep `changes` small); upsert changed fields only; ignore `pr`/`pr_rev`.
4. Cards present now but absent from the body: soft-delete (`actor='browser'`). This reproduces whole-doc-replace
   semantics, including the existing "deletion wins" client rule (`reconcileDeletedTicket`, `js/store.js:305`).
5. Same for `life_items` and `life_notes`.
6. If nothing changed, do NOT bump rev (today every PUT bumps; keep bumping to stay byte-identical in Phase 1, flag as
   optimisation in Phase 4: clients rely on `res.rev` to set `SYNC.rev`, `js/sync.js:203`).
7. Insert `changes` + `revisions` rows; bump rev; commit.
Property to test: for any board B, `PUT B` then `GET` returns B (modulo `pr`/`prRev` and normalisation). This
round-trip invariant is the single most valuable test (7.3).

### 7.3 Test strategy

Existing suites that must stay green, unchanged:
- `node --test` (repo root): `tests/store.test.mjs` etc. cover pure `js/store.js`. This spec adds no DOM/localStorage/
  network to store.js, so nothing changes (CLAUDE.md constraint holds). The `mergeBoards` contract is the reason the
  server keeps returning whole-board `GET /state`.
- `deno task check` and `deno task test` from `server/`: `webhook.deno.ts` spawns the real server and drives it over
  HTTP with the public seam (`seedBoard`, `putBoard`, `postWebhook`, signature helpers; `server/webhook.deno.ts:35-148`),
  using a temp KV file via `KODER_KV_PATH`. Because those tests only use HTTP, they become the backend-agnostic
  contract suite. `deno.json` `check` lists files explicitly; any new `.ts` under `server/` must be added there.

Changes needed:
1. Extract `Store` interface (`server/store.ts`): `getHead()`, `readBoard()`, `applyBoardPut(baseRev, board, actor)`,
   `patchTicket`, `deleteTicket`, `restore(rev)`, `archive(cards)`, `recordDelivery`, `commitWebhookMove(...)`,
   `listRevisions`, `boardAt(rev)`. `KvStore` is a mechanical extraction of today's code (reviewable diff,
   zero behaviour change, Phase 1).
2. Parametrise server startup by `KODER_STORE=kv|pg|dual` and `KODER_DATABASE_URL`. Existing tests default to `kv`
   so nothing breaks; CI additionally runs the suite with `KODER_STORE=pg`.
3. Test DB: run Postgres in CI via a service container, and locally via PGlite (`npm:@electric-sql/pglite`, in-process
   WASM Postgres, real Postgres semantics, no Docker; unverified that it covers `FOR UPDATE`, triggers and partial
   indexes sufficiently for all tests. Fall back to a local `postgres` binary if not).
4. New tests (new file, e.g. `server/store.contract.deno.ts`, added to `deno.json` tasks):
   - round-trip: random boards (property-style, seeded) `PUT` then `GET` equal; ordering preserved.
   - 409: stale `baseRev`; two concurrent PUTs on same rev -> exactly one 200.
   - `pr`/`prRev` immutability from PUT, including attempts to forge on new cards.
   - webhook idempotency: same delivery id twice -> second is `redelivered`, one rev bump; concurrent duplicate deliveries -> one winner.
   - webhook + PUT race: the 409 path preserves the webhook's move.
   - revisions: `?rev=N` reconstruction equals the board that was PUT at N; restore re-lands as N+k and keeps `pr`.
   - archive: idempotent by id; archived cards absent from `GET /state`, present in `GET /archive`.
   - migration verifier (7 below) as a pure function with fixtures.
   - ledger (Phase 5): immutability trigger rejects UPDATE/DELETE; duplicate import is a no-op; sum(pence) invariants.
5. Golden-file tests: store a few real-shaped `GET /state` documents (scrubbed) and assert JSON-equal under both stores.
6. `tests/koder-ticket.test.mjs` keeps validating the CLI against whichever backend the test harness points to;
   no CLI change expected.

## 8. Migration plan (KV blob -> Postgres)

Principles: reversible at every step; KV stays authoritative until verification passes; no data loss window.

Phase M0 (prep, no behaviour change)
- Extract `Store`; ship `KvStore` only. Deploy. Confirm webhook and CLI unchanged.
- Export a safety copy: `GET /state`, `GET /archive`, `GET /revisions` + each `?rev=N` to a dated JSON file kept outside
  the repo (not committed: it is personal data). Also keep a KV dump (`kv.list` of all prefixes incl.
  `["github-delivery", *]`; those delivery ids must be migrated or replay protection is lost).

Phase M1 (backfill, shadow DB)
- `scripts/migrate-kv-to-pg.ts` (idempotent, re-runnable): create schema; read `["board"]`; insert cards with rank
  assigned in array order; `life_items`; `life_notes`; set `board_head.rev = doc.rev`; read all `["archive", n]` chunks
  -> cards with `archived_at` (from `archivedAt` ms) and `archived_from` (from `board`); import `["github-delivery", *]`
  into `webhook_deliveries(outcome='migrated')`; import up to 20 `["board", rev]` snapshots into `changes`/`revisions`
  as synthetic `update` batches (or store them in a `revision_snapshots` table until retired; cheaper and exact;
  decide in Q5).
- Verifier (`scripts/verify-migration.ts`): load KV doc and PG-assembled doc and compare canonical JSON (sorted keys,
  column order preserved): rev equal, per-board card count equal, per-card field equality including `pr`/`prRev`/
  `created`/unknown fields (`extra`), lifeMeta equality, archive count and ids equal, delivery id set equal. Exit
  non-zero on any diff; prints a diff summary.

Phase M2 (dual-write, KV authoritative)
- `KODER_STORE=dual`: every mutation commits to KV first (as today). On success, replays the same logical operation
  to PG best-effort; failures are logged to `dual_write_failures` (or a KV key) and do not fail the request.
  Reads still come from KV. A nightly (or on-demand) verifier run reports drift. Webhook idempotency is
  checked in KV only in this phase; PG deliveries are recorded after the fact.
- Exit criterion: 7 consecutive days with zero drift and zero dual-write failures, with at least one real webhook
  and one concurrent-tabs 409 observed. (Personal scale means few events; the contract suite carries more of the
  proof than traffic does.)

Phase M3 (cutover)
- Brief write freeze (set `KODER_READONLY=1`: mutating endpoints and the webhook return 503; GETs keep working), run the backfill delta + verifier, then switch `KODER_STORE=pg` (env change + redeploy). Reads/writes
  now use PG. KV keeps being dual-written in REVERSE (PG-authoritative, KV best-effort) for the rollback window.
- Webhook during freeze: GitHub retries failed deliveries for a window, but do not rely on that; returning 503 means
  GitHub marks it failed and Koda can redeliver from the GitHub UI (delivery ids make that safe). Prefer scheduling
  the freeze at a quiet hour and keep it under a minute.

Phase M4 (rollback and retirement)
- Rollback: set `KODER_STORE=kv` and redeploy (seconds). Valid as long as reverse dual-write has kept KV current;
  if it has diverged, run PG -> KV reverse export (the verifier doubles as the reverse-diff tool).
- After 30 days stable: stop writing KV, keep the KV database untouched for another 30 days, then delete.
  Remove `KvStore`, the archive chunk code and `BOARD_SIZE_*` only in a later cleanup PR.

Data verification checklist (run at M1, nightly in M2, at M3 before and after switching)
1. rev equal. 2. Card counts per board/column. 3. Sha-256 of canonical JSON per card equal. 4. Order within each
column equal. 5. Archive id set equal. 6. Delivery id set equal. 7. `GET /state` byte-diff via `curl` against both stores
on a fixed rev (golden). 8. Restore dry-run of the latest 3 revisions reconstructs the KV snapshots exactly.

## 9. Service worker, offline-first and localStorage

Phases 1-3 require no client change:
- `sw.js` never caches API routes (`sw.js:96-109`), so a backend swap is invisible. The API route list there must be
  extended only if new top-level paths are added (`/state/head`, `/changes`, `/v2/*`, `/auth/*`, `/mcp`). Add them to
  that exclusion list in the same PR as the endpoint, else the cache-first block would freeze them. Any new JS module
  must be listed in `SHELL_ASSETS` (CLAUDE.md). Do not touch `CACHE_NAME`; it is stamped on `main` (CLAUDE.md,
  README "Deploying").
- localStorage stays the offline cache and instant first paint (`js/state.js:9-24`); `kanban-hub-v1:rev`, `:dirty`,
  `:syncedIds` semantics unchanged (`js/sync.js:58-59`, `:108-123`). Because `rev` stays a single monotonically increasing
  integer, an installed PWA with an old cache keeps working through the cutover; the first pull after cutover sees the
  same rev and no change.
- Gotcha: a rollback or restore that lowers the observable `rev` would make clients ignore newer data
  (`doc.rev <= SYNC.rev`, `js/sync.js:295`). The migration MUST import the exact head `rev` and never reset it.
- Phase 4 (delta sync) is the only client change: move the cache from one localStorage JSON blob to IndexedDB
  (already a stated stretch goal in `js/state.js:11-13`), store `{rev, cards[]}` rows, apply `GET /changes?since=`.
  Keep `store.js` pure and keep the localStorage reader as a migration path. Finances data is NOT cached offline in v1
  (read-only online view); decide in Q7.

## 10. Security notes

- The sync token ships to every browser (documented low-stakes, `server/README.md:391-396`). Moving to a database
  that will hold finance data changes the stakes: Finances endpoints must NOT accept the browser-shipped token.
  Gate them behind passkey sessions (Phase 6) with a separate scope; until passkeys exist, do not ship Finances to the
  public origin.
- Auth plan: WebAuthn passkeys (registration + assertion; sessions as HttpOnly, Secure, SameSite=Strict cookies;
  CSRF defence by SameSite + custom header) for the PWA; scoped, hashed, revocable `api_tokens` for the CLI, webhook-
  adjacent automation, agents and MCP (scopes such as `tickets:rw`, `board:read`, `fin:read`, `runs:write`). The legacy
  `KODER_TOKEN` stays accepted with scope `tickets:rw`+`board:rw` during the transition and is retired once the PWA
  uses sessions. Cookie auth makes the `*` CORS default (`main.ts:434`) unacceptable: set `KODER_ORIGIN`.
- Webhook path is unchanged: HMAC check before any DB access, body cap before parse (`main.ts:360-395`), constant-time
  compare (`:357`). Add: only parametrised queries (no string-built SQL), `statement_timeout` and a small pool.
- DB credentials in Deno Deploy env, never in the repo or `js/`. Use a least-privilege app role: no DDL, and for
  `fin.transactions` no UPDATE/DELETE grant (immutability enforced twice: trigger + grants). Run migrations with a
  separate migration role/CI job.
- Encryption/backups: provider encryption at rest and TLS in transit (verify per provider). Take a scheduled
  `pg_dump` (GitHub Action to private storage) before Finances holds real data; Neon/Prisma point-in-time windows on
  free tiers are short (Neon free: 6h instant restore, snippet), so do not treat them as the backup.
- Finance PII: store no card numbers or bank credentials; imports are CSV files parsed locally or server-side with a
  size cap; redact descriptions from logs.
- MCP endpoint: Streamable HTTP, bearer `api_tokens` only, per-tool scopes, rate limits, and every mutating tool call
  writes `changes.actor = 'mcp:<token_id>'`. Prompt-injection note: card text is untrusted input to agents; the
  orchestration spec owns mitigation, this spec only guarantees provenance in `changes`.
- Row-level security is not needed single-owner; keep `owner_id` on every table so enabling RLS later is mechanical.

## 11. Phased milestones (rough sizing, solo, evenings/weekends)

| Phase | Deliverable | Size | Exit criteria |
|---|---|---|---|
| 0. Spike | Provision Deno Deploy Postgres and Neon; connect from Deno Deploy with `npm:postgres`; measure cold-start and p95 from deploy region; PGlite proof for tests | 1 evening | Decision recorded (Q1); a `SELECT 1` from deployed server |
| 1. Seam | Extract `Store`; `KvStore` only; contract suite refactor; no behaviour change | 2-3 evenings | `deno task check/test` and `node --test` green; diff is mechanical |
| 2. PgStore | Schema + migrations; `PgStore`; diff-apply PUT; webhook tx; `changes`-based revisions; contract suite green on both stores | 1.5-2 weekends | Same suite passes with `KODER_STORE=pg` |
| 3. Migrate | Backfill + verifier; dual-write; cutover; rollback drill | 1 weekend + 1 week soak | 8-point verification clean; rollback rehearsed once on a copy |
| 4. Efficiency | `GET /state/head`, `/changes`, optional `/v2/ops`; poll switch; retire `BOARD_SIZE_LIMIT`, archive-as-necessity; IndexedDB cache | 1-2 weekends | 1,000-card synthetic board syncs; client no longer warns at 48 KB |
| 5. Finances | `fin` schema, import pipeline, read UI (separate spec/ticket KODER-DBA0) | 2+ weekends | Idempotent import test; immutability trigger test |
| 6. Auth + MCP | Passkeys (WebAuthn), scoped tokens, `/mcp`; retire shipped token | 2 weekends | Browser uses session cookie; legacy token disabled |
| 7. Runs | `agent_runs` per orchestration spec | per that spec | Reconciled schema |
| 8. Optional | Local-first spike (Zero/PowerSync/Electric) or D1 port as a learning branch | open-ended | Written findings only |

Phases 0-3 are the commitment (about 4 weekends of work); everything after is independently shippable.

## 12. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Diff-apply `PUT /state` subtly differs from whole-doc replace (ordering, deletions, unknown fields) | Medium-high | Round-trip property tests; `extra jsonb` to carry unknown fields; golden files; dual-write drift detection |
| Free-tier ops/compute cliffs (Prisma 100K ops/mo; Neon suspend + cold start inside webhook timeouts) | Medium | `GET /state/head` cheap poll; connection reuse; monitor; D (Turso) as fallback; webhook is retried by GitHub and idempotent |
| Latency regression (KV is colocated; Postgres is a network hop, possibly cross-region) | Medium | Phase 0 measurement; keep single-query reads; pick region-matched DB |
| Webhook redelivery or concurrent PUT during cutover | Low-medium | Idempotency key moves atomically with write; freeze window; reverse dual-write |
| `rev` regression breaks clients (`js/sync.js:295`) | Low, severe | Import exact head rev; never reset; test with an old cached client |
| Two storage systems and a CLI/skill drift (skill is synced to sibling repos via `scripts/sync-skill.sh`) | Low | API unchanged so skill unchanged; if it ever changes, edit master then sync, never in place (CLAUDE.md) |
| Scope creep: Finances/auth/MCP pulled into the migration | High | Phases 0-3 only touch board storage; later modules are separate specs |
| Driver/ORM friction on Deno (npm compat, Drizzle on Deno Deploy) | Medium | Phase 0 spike; start with plain SQL; Drizzle optional |
| Losing the "zero-dependency" ethos | n/a | Frontend stays zero-dependency, no build step; server gains npm deps only; call out in README |
| Backup gap for finance data | Medium | Scheduled `pg_dump` before Phase 5 |

## 13. Open questions for Koda

1. Host DB: Deno Deploy's built-in Postgres (simplest, 100K ops/mo cap, hosted by Prisma) or Neon (compute-hours
   cap, cold starts)? I lean Deploy-attached for ops simplicity if Phase 0 latency is fine.
2. **Answered: "plain SQL first with npm:postgres (decided 2026-10-08)".** (Was: plain SQL first then Drizzle, or Drizzle from day one?)
3. Is a 2 MB request cap and keeping the client-side 48 KB warning for now acceptable until Phase 4, or should Phase 4
   come before Phase 3 so the ceiling truly disappears for users first?
4. Move `projects.json` (generated by `scripts/gen-projects.sh`) into the DB, or leave it static? Leaving it avoids
   touching the offline shell and the gen script; moving it enables project metadata edits from the UI.
5. **Answered (2026-10-08): keep all `changes`, no retention cap; drop the 20 KV snapshots at migration** (PgStore
   history starts at cutover; the §8 safety export to dated JSON still runs first, so nothing is destroyed). (Was:
   keep all or cap at N days? Keep exact-snapshot fidelity for the migrated snapshots, or accept synthetic diffs?)
6. **Answered (2026-10-08): restore keeps the current `pr`/`prRev`**, applied to `KvStore` too and asserted in the
   contract suite (KODER-522B). (Was: keep current, or copy from the snapshot as today?)
7. Finances offline: online-only for v1 (my proposal) or cached in IndexedDB?
8. Do you want the C (Cloudflare D1/DO) or E (local-first) comparison as a deliberate side branch later, purely for
   learning/CV, after B is stable?
9. Single owner forever, or should `owner_id` become real (family sharing)? It affects auth design only, not the schema.
10. Tolerable freeze window at cutover (I propose under 1 minute at a quiet hour)?

## 14. What I could not verify

- KODER-DBA0 ticket body; `docs/specs/agent-orchestration.md` (absent from the repo at time of writing).
- Exact Deno Deploy Postgres connection method, driver support, region and idle behaviour; Prisma "operation" billing
  granularity (only a search snippet of docs.deno.com was seen).
- Current Deno KV batch/size limits and free-tier unit quotas (stated from memory in the table, marked unverified).
- Whether PGlite supports every feature the tests need. (Answered, along with a re-check of the vendor figures
  below as of 2026-10-08, in `docs/specs/storage-spike.md`.)
- Turso / Neon / D1 numbers come from search-result snippets and aggregator sites, not the vendors' live pricing pages
  (neon.com/pricing, developers.cloudflare.com/d1/platform/pricing, turso.tech/pricing were returned as search hits
  but not fetched in full). Re-check before choosing.

## 15. Review notes (added after evaluation)

Verdict: accept. Citations were spot-checked against the code and hold. Amendments below.

1. **Poll cost bites before Phase 4.** 7.1 says the cheap poll is byte-compatible, but it relies on the additive
   `GET /state/head` endpoint, which is a Phase 4 deliverable and needs a client change. During Phases 2-3 every
   30s poll assembles the whole board (several queries), which can exceed Prisma's 100K ops/month before Phase 4
   ships. Fix with no client change: serve `ETag: "<rev>"` and `Cache-Control: no-cache` on `GET /state` and answer
   `If-None-Match` with 304 after a single `board_head` query. Browsers revalidate automatically, and the service
   worker never caches `/state`. Move this into Phase 2. Verify the browser actually sends the conditional header
   on a manual check.
2. **Free-tier numbers conflict.** Section 3 says Neon free is 0.5 GB per project; an earlier search this session
   said 3 GiB per branch. Treat all free-tier figures as unverified and settle them in the Phase 0 spike from the
   vendor pricing pages.
3. **Do not create `fin.*`, `credentials`, `api_tokens`, `sessions` or `agent_runs` in Phase 2 migrations.** They are
   shape sketches (5.5). Creating them early locks in designs before their own specs exist. Phases 0-3 should
   migrate board storage only.
4. **Note length.** The schema allows 20,000 chars per note, while the API validation stays at 5,000 (`main.ts:120`).
   Keep API validation unchanged in Phases 1-3 and revisit the cap in Phase 4.
5. **`agent_runs` is a placeholder** until `docs/specs/agent-orchestration.md` is reconciled with this spec.
