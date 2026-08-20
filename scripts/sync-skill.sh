#!/usr/bin/env bash
#
# sync-skill.sh — propagate the koder-ticket skill from this repo (the master)
# to everywhere it needs to live:
#
#   * ~/.claude/skills/koder-ticket/          (personal — loads in any local session)
#   * <sibling repo>/.claude/skills/koder-ticket/  for every git repo under the
#     parent Code folder that has an "origin" remote (cloud/mobile sessions
#     only see what's pushed to GitHub)
#
# What gets synced: SKILL.md (master: .claude/skills/koder-ticket/SKILL.md here)
# and the CLI (master: scripts/koder-ticket.sh here). Credentials (.koder.env)
# are NEVER copied into repos; a .gitignore guard is added to each repo so a
# stray .koder.env can't be committed by accident.
#
# This script only writes files — committing and pushing is left to you.
# Run it after any edit to the skill or the CLI.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_MD="$ROOT/.claude/skills/koder-ticket/SKILL.md"
SRC_SH="$ROOT/scripts/koder-ticket.sh"

[ -f "$SRC_MD" ] || { echo "master SKILL.md not found: $SRC_MD" >&2; exit 1; }
[ -f "$SRC_SH" ] || { echo "master CLI not found: $SRC_SH" >&2; exit 1; }

sync_to() {
  local dest="$1"
  mkdir -p "$dest"
  [ "$SRC_MD" -ef "$dest/SKILL.md" ] 2>/dev/null || cp "$SRC_MD" "$dest/SKILL.md"
  cp "$SRC_SH" "$dest/koder-ticket.sh"
}

guard_gitignore() {
  local repo="$1"
  if ! grep -qs '\.claude/skills/koder-ticket/\.koder\.env' "$repo/.gitignore"; then
    printf '\n# koder skill credentials must never be committed\n.claude/skills/koder-ticket/.koder.env\n' >> "$repo/.gitignore"
  fi
}

sync_to "$HOME/.claude/skills/koder-ticket"
echo "synced: ~/.claude/skills/koder-ticket"

CODE_DIR="$(dirname "$ROOT")"
for d in "$CODE_DIR"/*/; do
  repo="${d%/}"
  [ -d "$repo/.git" ] || continue
  git -C "$repo" remote get-url origin >/dev/null 2>&1 || continue
  sync_to "$repo/.claude/skills/koder-ticket"
  guard_gitignore "$repo"
  if [ -n "$(git -C "$repo" status --porcelain -- .claude/skills/koder-ticket .gitignore)" ]; then
    echo "synced (needs commit): $repo"
  else
    echo "up to date: $repo"
  fi
done
