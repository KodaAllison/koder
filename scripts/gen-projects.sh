#!/usr/bin/env bash
#
# gen-projects.sh — regenerate js/projects.json from the folders in Code/.
#
# The Kanban board treats each subfolder of C:/Users/Koda/Code as a "project".
# This script scans that folder and writes the project list the app loads at
# startup. Re-run it whenever you add/rename/remove a project folder:
#
#     ./scripts/gen-projects.sh
#
# Each project gets a stable pastel colour derived from a hash of its name, so
# a project keeps the same colour even as others are added or removed.

set -euo pipefail

# scripts/ lives inside the board (Code/koder/scripts), so Code/ is two levels up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_FILE="$SCRIPT_DIR/../js/projects.json"

# Pastel background / dark text pairs, in the app's palette family.
COLORS=(  '#eef1fe' '#d1fae5' '#fef3c7' '#fee2e2' '#e0f2fe' '#f3e8ff' '#ffe4e6' '#ccfbf1' '#fef9c3' '#ede9fe' '#fce7f3' '#dcfce7' )
TEXTS=(   '#3b4bb8' '#047857' '#b45309' '#b91c1c' '#0369a1' '#7e22ce' '#be123c' '#0f766e' '#a16207' '#6d28d9' '#be185d' '#15803d' )

# Deterministic palette index from a name (sum of char codes % palette size),
# so colours stay stable across runs.
palette_index() {
  local s="$1" sum=0 i ch
  for (( i=0; i<${#s}; i++ )); do
    ch="${s:$i:1}"
    sum=$(( sum + $(printf '%d' "'$ch") ))
  done
  echo $(( sum % ${#COLORS[@]} ))
}

# JSON-escape backslashes and double quotes (folder names rarely need it).
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Collect subfolder names (glob skips dotfolders), case-insensitive sort.
# SKIP excludes the board itself and non-project dirs.
SKIP="node_modules koder koder-phase1"
mapfile -t names < <(
  for d in "$CODE_DIR"/*/; do
    n="$(basename "$d")"
    case " $SKIP " in *" $n "*) continue ;; esac
    printf '%s\n' "$n"
  done | sort -f
)

entries=""
for name in "${names[@]}"; do
  idx="$(palette_index "$name")"
  esc="$(json_escape "$name")"
  entry="    { \"id\": \"$esc\", \"name\": \"$esc\", \"color\": \"${COLORS[$idx]}\", \"text\": \"${TEXTS[$idx]}\" }"
  if [ -z "$entries" ]; then entries="$entry"; else entries="$entries,
$entry"; fi
done

{
  printf '{\n'
  printf '  "generated": "%s",\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf '  "projects": [\n'
  printf '%s\n' "$entries"
  printf '  ]\n'
  printf '}\n'
} > "$OUT_FILE"

echo "wrote js/projects.json (${#names[@]} projects)"
