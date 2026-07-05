---
name: koder-ticket
description: Add a ticket to Koda's personal kanban board (Koder). Use whenever Koda asks to file, track, log, or add a ticket/task/todo to "the board", "koder", or "my kanban" — including logging follow-up work discovered while coding in any project.
---

# Add a ticket to the Koder board

Koda's kanban board syncs through a small API. The easiest way to create a
ticket is the bundled CLI (works from any directory):

```bash
~/Code/koder/scripts/koder-ticket.sh "Ticket title" [options]
```

Options:

- `--project <id>` — which project the ticket belongs to. Valid ids are the
  folder names under `~/Code` (e.g. `holitrackr`, `SART`, `strava-worker`).
  When working inside one of those repos, default to that repo's folder name.
  Omit for a general/unassigned ticket.
- `--column <id>` — `backlog` (default) | `todo` | `doing` | `done`
- `--priority <level>` — `low` | `med` (default) | `high`
- `--note "<text>"` — details/context. Multiline is fine.

Example — logging follow-up work found during a session in holitrackr:

```bash
~/Code/koder/scripts/koder-ticket.sh "Fix flaky auth test" \
  --project holitrackr --column backlog --priority med \
  --note "test_login_retry intermittently fails; suspect clock mock. Found during session on 2026-07-05."
```

On success it prints `created ticket <id> in <column>`. A non-zero exit prints
the server's error (e.g. invalid column).

## Conventions

- Keep titles short and imperative; put context in `--note`.
- Don't ask which column unless it's ambiguous — new work goes to `backlog`,
  things Koda says they'll do next go to `todo`.
- One ticket per distinct piece of work; don't bundle.

## Fallback: raw API

If the script is unavailable, POST directly. Credentials live in
`~/Code/koder/scripts/.koder.env` (defines `KODER_API` and `KODER_TOKEN`):

```bash
source ~/Code/koder/scripts/.koder.env
curl -sS -X POST -H "Authorization: Bearer $KODER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"...","project":"...","column":"backlog","priority":"med","note":"..."}' \
  "${KODER_API%/}/tickets"
```

Full API docs: `~/Code/koder/server/README.md`.
