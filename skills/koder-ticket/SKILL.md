---
name: koder-ticket
description: Read, add, and move tickets on Koda's personal kanban board (Koder). Use whenever Koda asks to file/track/log a ticket or todo on "the board", "koder", or "my kanban" — or asks to look at, pick up, or work on tickets for a project (e.g. "grab a ticket from holitrackr and work on it").
---

# Work with tickets on the Koder board

Koda's kanban board syncs through a small API. Use the bundled CLI (works from
any directory):

```bash
~/Code/koder/scripts/koder-ticket.sh <command>
```

## Commands

**List tickets** (one per line: `id | column | priority | [project] title`):

```bash
~/Code/koder/scripts/koder-ticket.sh list --project holitrackr --column todo
```

Both filters optional. Valid project ids are the folder names under `~/Code`
(e.g. `holitrackr`, `SART`, `strava-worker`). Columns: `backlog`, `todo`,
`doing`, `review`, `done`.

**Add a ticket:**

```bash
~/Code/koder/scripts/koder-ticket.sh "Fix flaky auth test" \
  --project holitrackr --column backlog --priority med \
  --note "test_login_retry intermittently fails; suspect clock mock."
```

Defaults: column `backlog`, priority `med`, project unassigned. When working
inside one of the `~/Code` repos, default `--project` to that folder's name.

**Move a ticket:**

```bash
~/Code/koder/scripts/koder-ticket.sh move t_abc123_x1y2z doing
```

## The "pick up work" workflow

When Koda says "look at the tickets on X and work on one":

1. `list --project X --column todo` (fall back to `--column backlog` if empty)
2. Pick the highest-priority ticket you can actually complete; tell Koda which
   and why before starting
3. Move it to `doing`
4. Do the work in the project repo, then commit, push, and open a PR
5. Once the PR is up, move the ticket to `review` — **not** `done`. `done` is
   reserved for after merge; a ticket in `done` should always mean the work
   actually shipped. Koda (or another agent given the review) merges the PR
   and moves the card to `done`.

If you had to stop partway, move the ticket back to `todo` and add a new
ticket noting remaining work.

## Conventions

- Titles short and imperative; context goes in `--note`
- New work → `backlog`; things Koda will do next → `todo`
- One ticket per distinct piece of work; don't bundle

## Fallback: raw API

Credentials live in `~/Code/koder/scripts/.koder.env` (`KODER_API`,
`KODER_TOKEN`); all requests need `Authorization: Bearer $KODER_TOKEN`.

```bash
source ~/Code/koder/scripts/.koder.env
curl -sS -H "Authorization: Bearer $KODER_TOKEN" "${KODER_API%/}/tickets?project=holitrackr"
curl -sS -X POST -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"...","project":"...","column":"backlog"}' "${KODER_API%/}/tickets"
curl -sS -X PATCH -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"column":"doing"}' "${KODER_API%/}/tickets/<id>"
```

Full API docs: `~/Code/koder/server/README.md`.
