---
name: koder-work
description: How to work one ticket from Koda's Koder board start to finish: pick it by ref, move it to doing, build it, open ONE PR naming ONE ref, move it to review, and check the board before you stop. Use whenever Koda asks you to build, fix or do something that is, or might be, a ticket on the board ("do the quick wins", "next ticket", "fix 5EFD", "grab a ticket from holitrackr"), even if he never says "ticket" or "board". For several tickets at once with parallel agents, use koder-sprint instead.
---

# Work a ticket on the Koder board

The board is how Koda sees what you are doing. If the card is wrong, he is
looking at a lie. This skill is the lifecycle; the commands are in
**koder-ticket** (`bash "$KT" list|move|edit|add`, same `$KT` as there).

## 1. Find the ticket before you start

Anything Koda asks you to build or fix may already be a card. List the project's
open tickets (`list --project X`) and match it. Name the ref(s) back to him,
e.g. "that's KODER-5EFD". If nothing matches and it is more than a trivial
change, file one (`add`) first; one-line tweaks don't need a card.

## 2. Move it to `doing` first

`move REF doing` **before** you touch code, not at the end. Several quick wins
means several cards, each moved when you actually start it.

## 3. Build, then ONE PR per ticket

- One branch and one PR per ticket.
- **Name exactly one ticket ref in the PR title and body.** The GitHub webhook
  moves the card on PR open, and it **refuses** (HTTP 409, nothing moves) a PR
  whose title or body contains more than one ticket ref. If a PR genuinely
  covers two tickets, name one ref and refer to the other by title.
- A finding outside the ticket's scope becomes a new backlog ticket with a note
  saying where you found it. A stale ticket gets its note fixed with `edit`,
  not re-filed.

## 4. Move it to `review` the moment the PR is up

`move REF review`, in the same step as opening the PR. Don't rely on the
webhook; it can be refused or late.

## 5. Never `done`

`done` means shipped. The webhook moves the card there when the PR merges. If
it can't (several refs, a squash with no ref, a PR you split), say so in your
summary and leave the move to Koda or do it after he confirms the merge. If you
stop partway: `move REF todo` and file a ticket for what is left.

## Before you end the turn

Run `list --project X` and check each card you touched is where the work is:
`doing` while building, `review` once the PR exists. State the final column of
each ref in your summary. Quote refs (`KODER-5EFD`), never `t_…` ids.
