---
name: koder-sprint
description: Run a sprint on Koda's Koder board as the orchestrator — agree a goal, pick the tickets, run build and review agents in parallel worktrees, verify UI in a browser, open PRs with tagged review comments, and keep every card in the right column. Use when Koda asks you to orchestrate, run a sprint, "be in charge of the tickets", or work through several tickets for a project end to end.
---

# Run a sprint on the Koder board

You are the orchestrator. Koda sets the goal; you own everything from picking
tickets up to a PR that is ready for Koda to review. Koda merges, and Koda moves
cards to `done`.

This is the in-session version of the board-driven runs planned in koder's
`docs/specs/agent-orchestration.md`. Koder's GitHub webhook may also move a
card to Review on PR open and Done on merge; don't rely on it — move cards
yourself.

This skill builds on **koder-ticket** (load it for the CLI, refs vs ids, and
credentials). Throughout, `KT` is that skill's CLI:

```bash
KT="$HOME/.claude/skills/koder-ticket/koder-ticket.sh"   # Koda's PC
KT=".claude/skills/koder-ticket/koder-ticket.sh"         # in a repo checkout
```

## Roles and models

| Role | Model (`Agent` tool `model`) | Job |
|---|---|---|
| Orchestrator | this session | Goal, preflight, briefs, relaying findings, PRs, card moves, new tickets |
| Builder | `sonnet` for small, well-specified tickets; `opus` for large or architectural ones | One ticket in its own worktree. Commits; never pushes |
| Reviewer | `sonnet` by default; `opus` when the ticket is about state, timing, concurrency or event order, or as a tie-break when round 2 still disagrees | Read-only review of the diff, posted on the PR |
| Verifier | `sonnet` | Drives the running app in a browser for UI tickets |

There is no PR-description agent. The builder drafts the description at the
end of its report (it has full context); you finish it.

## Board rules

- **Move a card the instant its state changes**, in the same command as the
  action that changed it. Koda works off the board in parallel; don't batch
  moves and don't wait for the GitHub webhook.
- **Never move a card to `done`.** Your last move is to `review`.
- **Quote refs** (`HOLIT-3F7C`) to Koda, never `t_…` ids.
- **A finding outside a ticket's scope becomes a new backlog ticket**, with a
  note naming where it was found. If the fix is a line or two inside a PR that
  is already open, fold it in, move that ticket alongside, and say so in the PR.
- **A stale ticket gets its note corrected** with `edit`, not re-filed.
- **Stopping partway:** move the card back to `todo` and file a ticket for
  what's left.

## The loop

### 1. Agree the goal

1. Fetch the project's tickets *with notes* — `list` hides them, so use the raw
   API (`GET /tickets?project=<p>`, see koder-ticket).
2. Group them into themes. Propose 3–4 goals as a table: tickets, size, risk.
   Point out tickets that absorb or depend on each other.
3. Ask Koda (one `AskUserQuestion` call): the goal, parallel or sequential
   builds, and what happens on review findings (default: fix and re-review,
   max 2 rounds).

A ticket whose note says to grill or design first is not built in a sprint
until that session with Koda has happened.

### 2. Preflight

- `git fetch` and note the local checkout's state. Never touch it: every
  ticket works from `origin/main` in its own worktree.
- Read the code each ticket names and check its claims still hold. Fix stale
  notes before briefing.
- **Map file ownership.** For each ticket, list the files it will touch. Where
  two tickets overlap, assign the shared code to one and tell the other to stay
  out (e.g. "fix it in CountrySearch only; do not touch toggleCountry").
- Classify each ticket: size (builder model), whether it touches
  state/timing/event order (reviewer model), whether it changes UI (verifier).
- Move every sprint ticket to `doing` as its builder starts.

### 3. Build

Spawn one builder per ticket with `isolation: "worktree"`, in parallel unless
Koda chose sequential. Use the builder brief below. Builders commit and stop;
they do not push.

### 4. Open a draft PR

As soon as a build lands, from its worktree:

```bash
git push -u origin <branch>
gh pr create --draft --base main --head <branch> --title "<conventional title>" --body "<builder's draft, tagged>"
bash "$KT" move <REF> review
```

The card goes to `review` now: the PR is real work Koda can watch.

### 5. Review on the PR

- Spawn the reviewer with the reviewer brief. It posts its review on the PR
  (see "PR comments") and also returns the verdict to you.
- On CHANGES_REQUESTED, send the findings to the **same builder** with
  `SendMessage`. It fixes, commits, **pushes to the PR branch**, and replies on
  each thread it addressed.
- Round 2 goes to the **same reviewer**, so it checks its own findings.
- **Max 2 fix rounds.** Anything left goes in the PR description under
  "Known nits"; anything worth tracking also becomes a backlog ticket.
- Send extra concerns to an agent *before* it reports. A message to an agent
  that has already finished arrives after its report; fold it into the next
  round instead.

### 6. Verify UI in a browser

For any ticket that changes what users see or do, after the review approves:

- Spawn a verifier (or do it yourself) that starts the app from the PR's
  worktree (the project's `run` skill or its dev command) and drives it with
  the browser tools available — `claude-in-chrome`, a Playwright/browser MCP —
  through the ticket's scenarios, at desktop and phone widths where relevant.
- It posts the result on the PR as a tagged comment: each scenario, pass/fail,
  and screenshots where the tool can attach them.
- A failure goes back to the builder as a fix round.
- If the app can't be driven (sign-in the browser session can't complete, no
  browser tool, a backend that won't start), say exactly what wasn't verified
  in the PR description. Never claim a check that didn't run.
- A repo's CLAUDE.md wins over this step: if it limits how UI may be checked,
  follow it, and list any scenarios left for Koda in the PR.

### 7. Ship

- Finish the description: the review outcome, rounds, verification result,
  known nits, and anything unverified.
- `gh pr ready <n>`.
- **Clean up:** once the branch is pushed and the PR is ready, remove the
  worktree (`git worktree remove <path>`) and delete the agent's local
  `worktree-agent-*` branch. Check `git status` in the worktree is clean
  first; if it isn't, stop and tell Koda.

### 8. Wrap up

Report to Koda: a table of ticket → PR → rounds → verified?, the bugs the
reviews caught, a merge order (call out PRs that touch the same files and
whether they test-merged cleanly), decisions left for Koda, new tickets filed,
and the next natural goal.

## PR comments

Agents post through Koda's `gh` login, so GitHub won't accept approve or
request-changes on Koda's own PR. Post reviews as **comments** with the
verdict written in the body.

**Every agent comment starts with a fixed tag** so Koda can tell at a glance
which comments aren't theirs. Koda never starts a comment with `🤖`.

| Who | Where | Starts with |
|---|---|---|
| Reviewer | Review summary | `🤖 **Claude reviewer** · <model> · round <n>` then `**Verdict: APPROVE**` or `**Verdict: CHANGES_REQUESTED**` |
| Reviewer | Inline finding | `🤖 Claude reviewer · <blocker\|should-fix\|nit>:` |
| Builder | Thread reply | `🤖 Claude builder · fixed in <sha>:` (or `· not changed:` with the reason) |
| Verifier | PR comment | `🤖 Claude verifier · <tool>:` |
| Orchestrator | Description, notes | `🤖 Claude orchestrator:` |

Post a review with inline threads in one call:

```bash
gh api repos/{owner}/{repo}/pulls/<n>/reviews --input review.json
# review.json:
# { "event": "COMMENT",
#   "body": "🤖 **Claude reviewer** · sonnet · round 1\n\n**Verdict: CHANGES_REQUESTED**\n\n<summary>",
#   "comments": [ { "path": "src/App.tsx", "line": 259, "side": "RIGHT",
#                   "body": "🤖 Claude reviewer · should-fix: <finding and concrete fix>" } ] }
```

Reply on a thread: `gh api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body="🤖 Claude builder · fixed in <sha>: …"`.

Comments go out under Koda's name, often on public repos: keep them short,
factual and about the code.

## Builder brief

Each agent starts cold; the brief carries everything.

```
You are implementing one ticket in <repo>. You are in an isolated git worktree.

Setup
  git fetch origin && git checkout -b <fix|feat|refactor>/<slug> origin/main
  Read CLAUDE.md / AGENTS.md. Run the install command if dependencies are missing.

Ticket <REF>: <title>
  <full ticket note, corrected in preflight>

Constraints
  - Files you own: <list>. Do not touch <files another agent owns>.
  - Keep existing behaviour: <list>.
  - Add tests at the level the repo supports (check existing tests; don't add
    a new test framework).
  - Lint, tests and build must pass.
  - Conventional Commits, ending with the Co-Authored-By trailer.
  - Do NOT push or open a PR (until the orchestrator tells you to push fixes).

Report back
  branch, worktree path, sha, summary and why, tests added, lint/test/build
  results, anything unverified, then a draft PR description.
```

For fix rounds, the message also says: push to the PR branch, and reply on
each PR thread you addressed using the builder tag.

## Reviewer brief

```
You are a code reviewer. Read only: no edits, commits or pushes to code.

PR #<n>, worktree <path>, branch <name>. Review `git diff origin/main...HEAD`.

Ticket <REF>: <full note>
Scope the builder was given: <fences>
Builder's claims: <summary of its report>

Check carefully
  1. Does it fully fix the ticket? Trace every path to the changed code.
  2. Edge cases and races specific to this change: <list>.
  3. Parity with origin/main for: <behaviours>.
  4. Test quality: behaviour, not implementation; meaningful gaps.
  5. Style and scope; no unrelated changes.
  6. If another open sprint branch touches the same files, test-merge it.
  7. Run lint, tests and build.

Post your review on the PR (format in koder-sprint "PR comments"), one inline
thread per finding. Then report back: APPROVE or CHANGES_REQUESTED, findings
with severity (blocker / should-fix / nit), file:line and a concrete fix.
Verify each finding by tracing the code. Don't pad the list.
```

## Gotchas

- Git on Koda's PC is 2.33: no `merge-tree --write-tree`. Test-merge with the
  three-way form: `git merge-tree $(git merge-base A B) A B` and look for
  conflict markers.
- holitrackr's `main` is PR-protected and its `.gitignore` ignores `.claude/`,
  so agent worktrees under `.claude/worktrees/` never show up in `git status`.
- Builds cost the most usage (a focus-handling build used ~150k tokens). Pick
  the builder model per ticket; don't default everything to `opus`.
- Builders and reviewers only see unit tests. "Lint, tests and build pass" is
  not "works in the app" — that's what step 6 is for.
