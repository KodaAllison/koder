#!/usr/bin/env bash
#
# koder-ticket.sh — add a ticket to the Koder board from the terminal.
#
# Usage:
#   ./scripts/koder-ticket.sh "Fix login bug" [options]
#
# Options:
#   --project <id>       project id (a folder name under Code/); default: unassigned
#   --column <id>        backlog | todo | doing | done   (default: backlog)
#   --priority <level>   low | med | high                (default: med)
#   --note "<text>"      optional details
#
# Config: KODER_API (server base URL) and KODER_TOKEN, from the environment
# or from scripts/.koder.env (gitignored), e.g.:
#   KODER_API=https://your-app.deno.dev
#   KODER_TOKEN=...
#
# Any agent without this script can POST directly — see server/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/.koder.env" ] && . "$SCRIPT_DIR/.koder.env"

: "${KODER_API:?set KODER_API in the environment or scripts/.koder.env}"
: "${KODER_TOKEN:?set KODER_TOKEN in the environment or scripts/.koder.env}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

TITLE="${1:-}"
[ -n "$TITLE" ] || usage
shift

PROJECT="" COLUMN="" PRIORITY="" NOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="${2:?--project needs a value}";  shift 2 ;;
    --column)   COLUMN="${2:?--column needs a value}";    shift 2 ;;
    --priority) PRIORITY="${2:?--priority needs a value}"; shift 2 ;;
    --note)     NOTE="${2:?--note needs a value}";        shift 2 ;;
    -h|--help)  usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

# JSON-escape backslashes, quotes, and embedded newlines.
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR>1 {printf "\\n"} {printf "%s", $0}'
}

BODY="{\"title\":\"$(json_escape "$TITLE")\""
[ -n "$PROJECT" ]  && BODY="$BODY,\"project\":\"$(json_escape "$PROJECT")\""
[ -n "$COLUMN" ]   && BODY="$BODY,\"column\":\"$(json_escape "$COLUMN")\""
[ -n "$PRIORITY" ] && BODY="$BODY,\"priority\":\"$(json_escape "$PRIORITY")\""
[ -n "$NOTE" ]     && BODY="$BODY,\"note\":\"$(json_escape "$NOTE")\""
BODY="$BODY}"

RESP_FILE="$(mktemp)"
trap 'rm -f "$RESP_FILE"' EXIT

HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $KODER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "${KODER_API%/}/tickets")"

if [ "$HTTP_CODE" = "201" ]; then
  ID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' "$RESP_FILE")"
  echo "created ticket ${ID:-?} in ${COLUMN:-backlog}${PROJECT:+ (project: $PROJECT)}"
else
  echo "error (HTTP $HTTP_CODE): $(cat "$RESP_FILE")" >&2
  exit 1
fi
