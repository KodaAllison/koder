#!/usr/bin/env bash
#
# sync-skill.sh — propagate the Koder skills from this repo (the master) to
# everywhere they need to live:
#
#   * ~/.claude/skills/<skill>/          (personal — loads in any local session)
#   * <sibling repo>/.claude/skills/<skill>/  for every git repo under the
#     parent Code folder that has an "origin" remote (cloud/mobile sessions
#     only see what's pushed to GitHub), except the archived repos in SKIP_REPOS
#
# Skills synced (SKILLS below), each from .claude/skills/<skill>/SKILL.md here:
#   * koder-ticket — plus its CLI (master: scripts/koder-ticket.sh here)
#   * koder-sprint — SKILL.md only; it drives the koder-ticket CLI. Listed in
#     LOCAL_ONLY while it's being refined, so it goes to ~/.claude/skills only.
# Credentials (.koder.env) are NEVER copied into repos; a .gitignore guard is
# added to each repo so a stray .koder.env can't be committed by accident.
#
# This script only writes files — committing and pushing is left to you. Some
# repos gitignore .claude/ (e.g. holitrackr), so new skill files there need
# `git add -f`. Run this after any edit to a skill or the CLI.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SH="$ROOT/scripts/koder-ticket.sh"
SKILLS="koder-ticket koder-sprint"
# Skills still being refined: synced to ~/.claude/skills only, not into repos.
LOCAL_ONLY=" koder-sprint "

# Archived projects that no longer get the skills. Folder names under Code/.
SKIP_REPOS=" SART SwiftPlan weatherapp "

for skill in $SKILLS; do
  [ -f "$ROOT/.claude/skills/$skill/SKILL.md" ] || { echo "master SKILL.md not found for $skill" >&2; exit 1; }
done
[ -f "$SRC_SH" ] || { echo "master CLI not found: $SRC_SH" >&2; exit 1; }

# sync_to <skills dir> [repo]: copy each skill into <skills dir>/<skill>/;
# with "repo", skip the LOCAL_ONLY skills.
sync_to() {
  local base="$1" mode="${2:-}" skill src dest
  for skill in $SKILLS; do
    if [ "$mode" = repo ]; then case "$LOCAL_ONLY" in *" $skill "*) continue ;; esac; fi
    src="$ROOT/.claude/skills/$skill/SKILL.md"
    dest="$base/$skill"
    mkdir -p "$dest"
    [ "$src" -ef "$dest/SKILL.md" ] 2>/dev/null || cp "$src" "$dest/SKILL.md"
    if [ "$skill" = koder-ticket ]; then cp "$SRC_SH" "$dest/koder-ticket.sh"; fi
  done
}

guard_gitignore() {
  local repo="$1"
  if ! grep -qs '\.claude/skills/koder-ticket/\.koder\.env' "$repo/.gitignore"; then
    printf '\n# koder skill credentials must never be committed\n.claude/skills/koder-ticket/.koder.env\n' >> "$repo/.gitignore"
  fi
}

sync_to "$HOME/.claude/skills"
echo "synced: ~/.claude/skills ($SKILLS)"

CODE_DIR="$(dirname "$ROOT")"
for d in "$CODE_DIR"/*/; do
  repo="${d%/}"
  [ -d "$repo/.git" ] || continue
  case "$SKIP_REPOS" in *" $(basename "$repo") "*) echo "skipped (archived): $repo"; continue ;; esac
  git -C "$repo" remote get-url origin >/dev/null 2>&1 || continue
  sync_to "$repo/.claude/skills" repo
  guard_gitignore "$repo"
  paths=(.gitignore)
  for skill in $SKILLS; do
    case "$LOCAL_ONLY" in *" $skill "*) continue ;; esac
    paths+=(".claude/skills/$skill")
  done
  # --ignored so repos that gitignore .claude/ still report new skill files
  if [ -n "$(git -C "$repo" status --porcelain --ignored -- "${paths[@]}" | grep -v '\.koder\.env$')" ]; then
    echo "synced (needs commit): $repo"
  else
    echo "up to date: $repo"
  fi
done
