# Spike: PGlite for the Postgres test plan, and vendor limits re-verified

Status: findings for Koda. Ticket KODER-59BC (agent half of KODER-2B82, Phase 0 of
`docs/specs/storage-expansion.md`). Date: 2026-10-08.

Two questions: (1) can PGlite run the future `PgStore` contract suite under Deno, and (2) what do the
vendors' own pages say about the figures `storage-expansion.md` section 14 marked unverified.

## 1. PGlite results

Probe: `server/spike/pglite.probe.ts`, run with `deno task spike:pglite` from `server/`. It is deliberately not
part of `deno task test` or `deno task check` (it downloads ~10 MB of WASM and is evidence, not a regression
suite). Versions: `@electric-sql/pglite` 0.5.8 (reports PostgreSQL 18.3), `@electric-sql/pglite-socket` 0.2.11,
`npm:postgres` 3.4.9, Deno 2.9.6, Windows 11.

The probe executes the ```sql block of section 5 of the spec verbatim (it reads the markdown), so a schema edit
that PGlite can't run fails the probe. Result: 33 checks, 33 pass (two of them assert a documented gap).

| Feature the spec relies on | Works? | Notes |
|---|---|---|
| Whole section 5 DDL (15 tables, `fin` schema, `gen_random_uuid()`, `bytea`, `text[]`, `char(3)`, `COLLATE "C"`) | Yes | Ran unmodified. |
| CHECK constraints | Yes | SQLSTATE `23514`, same as Postgres. |
| UNIQUE / PK / FK violations | Yes | `23505` / `23503`; error codes reach callers, including via `npm:postgres`. |
| Partial indexes (`cards_board_col`, `cards_pr`) | Yes | `EXPLAIN` picks them (seqscan disabled; tiny table). Plan shape on real data is not tested. |
| `COLLATE "C"` rank ordering | Yes | Byte order (`B0 < a0 < a1`). |
| `SELECT ... FOR UPDATE` in a transaction (7.2 step 1) | Yes, with a caveat | Parses and runs, `NOWAIT` and `SKIP LOCKED` too. It is never contended, see section 2. |
| `UPDATE board_head ... WHERE rev=$base RETURNING` CAS | Yes | 0 rows on a stale `baseRev`. |
| Transaction rollback (card + rev bump + `webhook_deliveries` row together) | Yes | The atomic-idempotency claim in 5.1 holds. |
| `SAVEPOINT` / `ROLLBACK TO` | Yes | |
| `INSERT ... ON CONFLICT DO NOTHING RETURNING` (webhook delivery) | Yes | Second insert returns no row. |
| `ON CONFLICT DO UPDATE` upsert (diff-apply) | Yes | |
| `= ANY($1::text[])` (archive) | Yes | Array parameters bind from JS arrays and via `npm:postgres`. |
| jsonb (`extra`, `->>`, `@>`, `||`, `jsonb_set`) | Yes | |
| Data-modifying CTEs | Yes | |
| Immutability trigger (`fin.reject_mutation`, BEFORE UPDATE OR DELETE) | Yes | plpgsql works, `RAISE ... ERRCODE`. Both UPDATE and DELETE rejected (`23001`). |
| Role `GRANT`-based immutability (5.5, 10) | Not testable | One superuser; test the trigger only. Test the grants against the real DB. |
| UNIQUE-based idempotent import | Yes | |
| Aggregates (`sum ... GROUP BY`), `array_agg(... ORDER BY rank)` | Yes | |
| Identity columns and sequences | Yes | The spec uses none; a migration tool might. |
| `now()` transaction-stable, `timestamptz` | Yes | |
| `SET lock_timeout` / `statement_timeout` | Accepted, **not enforced** | `pg_sleep(0.5)` ran to completion under `statement_timeout=50ms`. The WASM build has no timer signal. Security note in section 10 ("`statement_timeout`") can't be tested here. |
| Multi-statement `exec()` for migrations | Yes | |
| Real lock contention, `55P03`, `40001`, `40P01` | **No** | See below. |

### Probe output

```
PGlite probe -- PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten ...
@electric-sql/pglite 0.5.8, pglite-socket 0.2.11, postgres 3.4.9, Deno 2.9.6

PASS  Section 5 schema DDL, verbatim from the spec            (15 tables created)
PASS  CHECK constraints                                        (SQLSTATE 23514)
PASS  COLLATE "C" rank ordering
PASS  Partial index is usable by the planner (cards_board_col)
PASS  Partial index predicate (cards_pr)
PASS  jsonb: extra round-trip, ->>, @>, ||, jsonb_set
PASS  ON CONFLICT DO UPDATE upsert
PASS  rev compare-and-swap
PASS  SELECT ... FOR UPDATE inside a transaction
PASS  FOR UPDATE SKIP LOCKED / NOWAIT parse
PASS  Transaction rollback undoes everything
PASS  Failed statement aborts the tx; SAVEPOINT recovery works
PASS  Webhook idempotency: ON CONFLICT DO NOTHING RETURNING
PASS  Archive idempotency: = ANY($1) AND archived_at IS NULL
PASS  changes log: composite PK, jsonb before/after, CHECK
PASS  Foreign keys
PASS  Ledger immutability trigger                              (UPDATE/DELETE -> 23001)
PASS  Idempotent import: UNIQUE + ON CONFLICT DO NOTHING
PASS  gen_random_uuid(), bigint SUM ... GROUP BY, char(3), date
PASS  bytea, text[]
PASS  Identity column + sequence
PASS  timestamptz, now() is transaction-stable, timeouts settable
PASS  KNOWN GAP: statement_timeout is accepted but NOT enforced
PASS  array_agg(id ORDER BY rank) per column
PASS  Migrations via multi-statement exec()
PASS  Data-modifying CTE
PASS  CONCURRENCY: overlapping db.transaction()s are serialised
        observed order: A:begin A:locked A:commit B:begin B:locked
PASS  CONCURRENCY: same-baseRev race yields exactly one winner  (ok#1,stale#2,stale#3)
PASS  CONCURRENCY: StoreContentionError path NOT reachable via lock contention
        no 55P03 even with lock_timeout=50ms
PASS  CONCURRENCY: 40001 can be produced only by hand
PASS  DRIVER: npm:postgres connects to PGlite through pglite-socket
        bigint comes back as string ("11"); sql.begin(), FOR UPDATE, array params, SQLSTATEs work
PASS  DRIVER: postgres.js pool (max 4), default vs maxConnections: 4
        default server -> failed: read ECONNRESET; maxConnections: 4 -> 4 parallel queries OK
PASS  DRIVER: multiplexer and real row-lock contention between two connections?
        B acquired the lock after 356ms. A real server answers 55P03 at ~100ms

33/33 passed
```

(Notes are condensed from the probe's own output; run the task for the full text.)

## 2. Concurrency: what single-connection means for contention tests

PGlite runs one backend. Observed:

- `db.transaction()` calls issued concurrently are queued whole: B does not even `BEGIN` until A commits. So B never
  blocks on A's `FOR UPDATE`; a `lock_timeout` of 50 ms did not produce `55P03` while A held the lock for 200 ms.
- Through `pglite-socket` with `maxConnections > 1` (a multiplexer over the one backend, which its README warns
  "not all use cases are guaranteed to work"), two `npm:postgres` connections behave the same way: the second
  transaction waited ~356 ms for the first and then succeeded. Still no `55P03`, no `40P01`, no `40001`.

What that means for the test plan:

| Test | PGlite? |
|---|---|
| "Two concurrent PUTs on the same `baseRev` -> exactly one 200" (7.3 item 4) | Yes. Serialised, but the CAS and `FOR UPDATE` re-check still yield exactly one winner (probe: `ok,stale,stale`). This proves the logic, not the lock. |
| Webhook duplicate delivery race, webhook + PUT race | Yes, same reasoning. Correctness of the predicates is tested; true parallelism isn't. |
| `StoreContentionError` (retry loop gives up, handler answers 503) | **By fault injection only.** Wrap the store's `query` so it throws `{ code: "40001" }` / `"55P03"` / `"40P01"` N times (the probe shows these codes can be raised from SQL with `RAISE ... ERRCODE`). That tests the retry/give-up policy, not Postgres. |
| Genuine lock waiting, deadlock, `statement_timeout` | Needs a real Postgres: the CI service container the spec already proposes (7.3 item 3), or the Neon/Deno database. Keep a small `@real-pg` tagged subset and run it there. |

Honest summary: PGlite covers the *semantics* of the contract suite; it cannot exercise *contention*. That is
acceptable because `PgStore` should rely on the CAS predicate and `FOR UPDATE` for correctness, and the real-Postgres CI run
(already in the plan) covers genuine concurrency.

## 3. Driver story: `npm:postgres` and PGlite

- **Yes, `npm:postgres` (porsager) talks to PGlite** through `@electric-sql/pglite-socket` (a TCP or Unix-socket
  server wrapping the PGlite instance). Verified: tagged-template queries, array params, `sql.begin()` transactions,
  `FOR UPDATE`, and SQLSTATE codes (`err.code`) all work. This is the same code path as production, so a contract
  suite can run `PgStore` unmodified against `postgres://postgres:postgres@127.0.0.1:<port>/postgres`.
- Defaults to **one** connection: `postgres.js` with `max > 1` against a default server dies with `ECONNRESET`.
  Either set `max: 1` for tests (the production pool size can be a config knob) or start the socket server with
  `maxConnections: N` (works, with the multiplexer caveat above).
- Run the socket server in-process in the test (`new PGLiteSocketServer({ db, port: 0 })`); no Docker, no external
  binary. `port: 0` picks a free port, so parallel test files don't collide. Needs `--allow-net=127.0.0.1`.
- **Type differences to code for in `PgStore`, not in tests:** `postgres.js` returns `bigint` (`int8`, `rev`,
  `created`, `pr_rev`) as **strings** by default, whereas PGlite's own API returns numbers. Because production runs
  `postgres.js`, always go through it in the contract suite, and convert once (e.g. `types: { bigint: postgres.BigInt }`
  or `Number()` at the mapping layer). `rev` is well inside 2^53.
- SSL is not supported by the socket server; tests connect with `ssl: false`, production with the provider's TLS.
- **No thin adapter is needed** for `npm:postgres`; the cost is the extra devDependency
  (`@electric-sql/pglite-socket`) and the single-connection rule. Going the other way (in-process `PGlite`
  directly, no socket) would need an adapter and would test a different driver, so don't.
- Under `deno task test`, `npm:` specifiers need `deno.json` imports and lockfile entries; the probe pins versions
  inline instead so `deno.json` only gains a task. Pin in `deno.json` when the real suite lands.

## 4. Vendor facts, re-verified 2026-10-08

Method: WebFetch of the vendor's own pages plus WebSearch. WebFetch summarises through a small model, so figures
below are what it returned, not a screenshot; recheck a figure before depending on it. "Not stated" means the
fetched page did not say.

### 4.1 Deno Deploy Postgres (Prisma Postgres)

| Question | Finding | Source |
|---|---|---|
| Connection method | Deno Deploy injects standard env vars into the app: `DATABASE_URL` and `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`. "Most libraries automatically detect and use these standard environment variables." | https://docs.deno.com/deploy/reference/databases/ |
| Driver | The guide's example uses `pg` from npm; it names Prisma Migrate, Drizzle and Kysely as compatible. `npm:postgres` is not named, but Prisma documents any PostgreSQL client (node-postgres, Drizzle, Kysely, psql) so a plain TCP connection string should work. **Not tested against a provisioned DB.** | https://docs.deno.com/deploy/reference/databases/ ; https://www.prisma.io/docs/postgres/introduction/overview |
| Provisioning | Two options: link an existing external Postgres, or have Deno provision "Prisma Postgres ... hosted by Prisma". "Only a couple of instances can be created per organization"; databases per instance are limited. | https://docs.deno.com/deploy/reference/databases/ |
| Regions | Docs say to choose one close to users but list none. Not stated. | same |
| Free tier | **Two conflicting sets of numbers.** Prisma's own pricing page and its 2026 comparison article (updated 2026-10-07) say **200,000 operations/month, 1.01 GB storage**, 50 databases. The Deno docs PR (denoland/docs#2616) and a search snippet say **100K operations, 500 MB, 5 databases**. The spec used the latter. Prisma's current page is more recent, but I could not retrieve the Deno-specific Prisma page (`.../prisma_postgres` and `.../prisma-postgres` returned 404 via WebFetch), so I can't say which plan a Deno-provisioned instance gets. | https://www.prisma.io/pricing ; https://www.prisma.io/blog/prisma-postgres-vs-neon-pricing-2026 ; https://github.com/denoland/docs/pull/2616/files |
| Operations cap and billing granularity | "An operation is a single action against your Prisma Postgres database — a create, read, update, or delete." Prisma's docs (via search) add that an operation is counted per query regardless of compute time, and that if an ORM issues several queries behind the scenes it bills as one. Whether a raw multi-statement transaction through a TCP driver is one operation or one per statement is **not stated**. The Free plan has "no overage charges"; "free forever with fixed limits". What the database does at the cap (throttle, reject, suspend) is **not stated**. | https://www.prisma.io/pricing ; search result for https://www.prisma.io/docs/data-platform/billing/plans-and-quotas |
| Idle behaviour | Not stated for the database. The pricing page only says "An idle app scales to zero and costs nothing" (about Prisma apps/compute). Prisma Postgres is described as "unikernel-based" PostgreSQL v17. Cold-start latency unknown. | https://www.prisma.io/pricing ; https://www.prisma.io/docs/postgres/introduction/overview |
| Deno Deploy plan itself | Free: 1M requests/month, 20 GiB egress, 10 hr active CPU, 10 apps, KV 1 GiB, 1M KV read units and 500K write units per month. **The pricing page lists nothing about Postgres.** | https://deno.com/deploy/pricing |

Changes vs the spec: free-tier size is probably 200K ops / ~1 GB rather than 100K / 500 MB (unreconciled);
connection is plain env vars and TCP (spec said "could not verify"); billing counts queries, not compute time.
The 7.1 poll budget (~58K ops/month for two tabs, one query per poll) fits comfortably under either cap, but
`PUT`/`PATCH`/webhook transactions issue several statements and, if each statement counts, the margin shrinks
to about 3x at the old 100K cap. Measure the real count (see section 6).

### 4.2 Neon free plan

| Question | Finding | Source |
|---|---|---|
| Storage | **1 GB per project, 20 GB per account.** Neither the spec's 0.5 GB nor the earlier-session 3 GiB appears on any Neon page fetched today. | https://neon.com/pricing ; https://neon.com/docs/introduction/plans ; https://www.prisma.io/blog/prisma-postgres-vs-neon-pricing-2026 |
| Compute | 100 CU-hours per project per month ("enough to run a 0.25 CU compute for 400 hours/month"). Suspended compute accrues nothing. | https://neon.com/pricing ; https://neon.com/docs/introduction/plans |
| Autosuspend | After 5 minutes of inactivity, and **cannot be disabled on Free**. | same |
| Cold start | "Activating a Neon compute from an idle state typically takes a few hundred milliseconds" before network/region effects. Neon's own advice includes retries with backoff and `sslnegotiation=direct`. | https://neon.com/docs/connect/connection-latency |
| Restore / egress | 6-hour history window; 5 GB egress per project; up to 100 projects per org. | https://neon.com/pricing |

Neon fits a personal board on compute: a 5-minute idle suspend means the webhook (rare, bursty) usually hits a
cold compute, costing a few hundred ms, well inside GitHub's webhook timeout; the 30 s poll keeps it warm while a
tab is open. Watch the compute cap: a 0.25 CU compute kept awake 24/7 burns ~180 CU-hours/month (0.25 x 720 h),
over the 100 CU-hour cap, whereas ~8 h/day of an open tab is ~60. A poll that never lets Neon suspend is the
cliff to avoid (my arithmetic from the vendor's 0.25 CU / 400 h figure, not a vendor statement).

### 4.3 Turso and D1 (quick check)

- **Cloudflare D1, Workers Free:** 5 million rows read/day, 100,000 rows written/day, 5 GB total
  (https://developers.cloudflare.com/d1/platform/pricing/). Matches the spec.
- **Turso Free:** 5 GB storage, 500 million rows read/month, 10 million rows written/month, 100 databases, 1-day
  point-in-time restore (https://turso.tech/pricing). Matches the spec on rows; the spec did not give a database count.

## 5. Recommendation for Q1 (host)

**Start with Neon for the Phase 0 measurement and as the default if the numbers are close; keep Deno Deploy's
attached Postgres as the thing to beat on convenience.** Reasoning, from facts above only:

1. Neon's limits are published, current and mutually consistent across three Neon/Prisma pages, and it meters
   compute time, which suits a bursty personal board. The Deno-attached option has two unreconciled quota sets,
   no stated region, no stated idle behaviour and no stated cap-hit behaviour. Those are exactly the unknowns that
   hurt a webhook receiver.
2. Neon's known cost is a few hundred ms on the first request after 5 idle minutes. That is tolerable for
   the webhook (idempotent, GitHub retries) and for the board (localStorage-first paint).
3. Deno-attached wins only if it is genuinely lower latency from the Deploy region and the ops counting is
   per query. That is unmeasurable from here.
4. Both are plain Postgres reached over TCP with `npm:postgres`, so the choice is an env var, not a rewrite. The
   decision is cheap to reverse; do not block Phase 1 on it.

This does not change the spec's decision rule in section 4 (lower p95 from the Deploy region, no suspend inside the
webhook retry window); it says which side to expect to win.

### Still for Koda to measure (ticket KODER-2B82; I can't provision or deploy anything)

1. Provision both (Deno Deploy "Provision Postgres" and a Neon free project in the region nearest the Deploy
   region) and run, from a **deployed** server, `SELECT 1` through `npm:postgres` to each. Confirm `npm:postgres` works
   at all with the Deno-injected `DATABASE_URL` and with Neon's TLS settings.
2. p95 of 50-100 sequential `SELECT 1` and one 3-statement transaction, per host, from the Deploy region (10-minute probe).
3. Neon cold start: query after >5 minutes idle, 5 samples; compare with GitHub's webhook timeout.
4. Deno-attached: the region, the plan actually attached (100K or 200K ops; view in the Prisma console after
   claiming), and whether a 3-statement transaction increments the operation counter by 1 or 3.
5. What the Deno-attached database does at the operations cap (error, throttle, suspend), if readable in the console.
6. Connection-count behaviour: `postgres.js` pool `max` against each host's connection limit from Deploy isolates.

## 6. Net effects on the spec

- Section 14's PGlite question: answered above; the fallback to a local `postgres` binary is needed only for
  genuine lock contention, `statement_timeout` and role-grant tests, not for the contract suite.
- Section 3/7.1/12 quotas: update after Koda's measurement. Neon free storage is 1 GB, not 0.5 GB or 3 GiB.
