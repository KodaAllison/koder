#!/usr/bin/env bash
#
# koder-ticket.sh — work with tickets on the Koder board from the terminal.
#
# Usage:
#   ./scripts/koder-ticket.sh "Fix login bug" [options]     add a ticket
#   ./scripts/koder-ticket.sh list [options]                list tickets
#   ./scripts/koder-ticket.sh move <id> <column>            move a ticket
#
# Options (add / list):
#   --project <id>       project id (a folder name under Code/)
#   --column <id>        backlog | todo | doing | review | done   (add default: backlog)
#   --priority <level>   low | med | high                (add default: med)
#   --note "<text>"      optional details (add only)
#
# Examples:
#   ./scripts/koder-ticket.sh list --project holitrackr --column todo
#   ./scripts/koder-ticket.sh move t_abc123_x1y2z doing
#
# Config: KODER_API (server base URL) and KODER_TOKEN, from the environment
# or from scripts/.koder.env (gitignored).
#
# Any agent without this script can call the API directly — see server/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/.koder.env" ] && . "$SCRIPT_DIR/.koder.env"

: "${KODER_API:?set KODER_API in the environment or scripts/.koder.env}"
: "${KODER_TOKEN:?set KODER_TOKEN in the environment or scripts/.koder.env}"
BASE="${KODER_API%/}"

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

# request <method> <path> [json-body] → body on stdout; exits 1 on HTTP error.
request() {
  local method="$1" path="$2" data="${3:-}" resp http
  resp="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$resp'" RETURN
  if [ -n "$data" ]; then
    http="$(curl -sS -o "$resp" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $KODER_TOKEN" -H 'Content-Type: application/json' \
      -d "$data" "$BASE$path")"
  else
    http="$(curl -sS -o "$resp" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $KODER_TOKEN" "$BASE$path")"
  fi
  if [ "${http:0:1}" != "2" ]; then
    echo "error (HTTP $http): $(cat "$resp")" >&2
    return 1
  fi
  cat "$resp"
}

# JSON-escape backslashes, quotes, and embedded newlines.
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR>1 {printf "\\n"} {printf "%s", $0}'
}

cmd="${1:-}"
[ -n "$cmd" ] || usage

case "$cmd" in

  list)
    shift
    PROJECT="" COLUMN=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --project) PROJECT="${2:?}"; shift 2 ;;
        --column)  COLUMN="${2:?}"; shift 2 ;;
        *) echo "unknown option: $1" >&2; usage ;;
      esac
    done
    QS=""
    [ -n "$PROJECT" ] && QS="project=$PROJECT"
    [ -n "$COLUMN" ]  && QS="${QS:+$QS&}column=$COLUMN"
    OUT="$(request GET "/tickets${QS:+?$QS}")"
    # One ticket per line: id | column | priority | [project] title — agents and
    # humans both read this; the raw JSON is available with the API directly.
    # Parsed with node (already a dependency, for `node --test`) rather than sed:
    # the old regex split records on `},{` and pulled fields out with greedy
    # patterns, so any title or note containing a quote or `},{` silently lost
    # its column/priority. node also does the padding, so the format is unchanged
    # (`%-7s`/`%-4s` → padEnd(7)/padEnd(4)) and it emits a trailing newline per
    # line, which the old `read` loop needed printf '%s\n' to get right.
    printf '%s' "$OUT" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const tickets = JSON.parse(raw).tickets || [];
        for (const t of tickets) {
          const col = String(t.column ?? "").padEnd(7);
          const pri = String(t.priority ?? "").padEnd(4);
          const proj = t.project ? "[" + t.project + "] " : "";
          console.log(t.id + " | " + col + " | " + pri + " | " + proj + (t.title ?? ""));
        }
      });
    '
    ;;

  move)
    ID="${2:?usage: koder-ticket.sh move <id> <column>}"
    COLUMN="${3:?usage: koder-ticket.sh move <id> <column>}"
    request PATCH "/tickets/$ID" "{\"column\":\"$(json_escape "$COLUMN")\"}" > /dev/null
    echo "moved $ID to $COLUMN"
    ;;

  -h|--help)
    usage
    ;;

  *)
    # Default command: add a ticket. $1 is the title.
    TITLE="$1"
    shift
    PROJECT="" COLUMN="" PRIORITY="" NOTE=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --project)  PROJECT="${2:?--project needs a value}";  shift 2 ;;
        --column)   COLUMN="${2:?--column needs a value}";    shift 2 ;;
        --priority) PRIORITY="${2:?--priority needs a value}"; shift 2 ;;
        --note)     NOTE="${2:?--note needs a value}";        shift 2 ;;
        *) echo "unknown option: $1" >&2; usage ;;
      esac
    done
    BODY="{\"title\":\"$(json_escape "$TITLE")\""
    [ -n "$PROJECT" ]  && BODY="$BODY,\"project\":\"$(json_escape "$PROJECT")\""
    [ -n "$COLUMN" ]   && BODY="$BODY,\"column\":\"$(json_escape "$COLUMN")\""
    [ -n "$PRIORITY" ] && BODY="$BODY,\"priority\":\"$(json_escape "$PRIORITY")\""
    [ -n "$NOTE" ]     && BODY="$BODY,\"note\":\"$(json_escape "$NOTE")\""
    BODY="$BODY}"
    OUT="$(request POST /tickets "$BODY")"
    ID="$(printf '%s' "$OUT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
    echo "created ticket ${ID:-?} in ${COLUMN:-backlog}${PROJECT:+ (project: $PROJECT)}"
    ;;
esac
