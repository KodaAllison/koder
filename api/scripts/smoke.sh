#!/usr/bin/env bash
# Black-box smoke test for a running Koder API (any host, any Postgres).
#
#   api/scripts/smoke.sh <BASE_URL> <TOKEN>
#   BASE_URL=http://localhost:8000 TOKEN=dev api/scripts/smoke.sh
#
# It WRITES to the board it is pointed at: it expects a fresh, empty database
# (rev 0), replaces the board with a one-card board, then files a ticket.
# Run it against a throwaway deployment or the CI database, never a live board.
# Needs curl; nothing else.
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
TOKEN="${2:-${TOKEN:-}}"
if [ -z "$BASE_URL" ] || [ -z "$TOKEN" ]; then
  echo "usage: $0 <BASE_URL> <TOKEN>" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fails=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; fails=$((fails + 1)); }

# req <name> <expected-status> <curl args...>: body in $tmp/body, headers in $tmp/head.
req() {
  local name="$1" want="$2" got
  shift 2
  got="$(curl -sS -o "$tmp/body" -D "$tmp/head" -w '%{http_code}' "$@")" || { fail "$name (curl error)"; return 0; }
  if [ "$got" = "$want" ]; then ok "$name -> $got"; else fail "$name -> $got (wanted $want): $(head -c 300 "$tmp/body")"; fi
}
# has <name> <fixed-string> <file>
has() {
  if grep -qF -- "$2" "$3"; then ok "$1"; else fail "$1 (missing $2 in: $(head -c 300 "$3"))"; fi
}
auth=(-H "Authorization: Bearer $TOKEN")

req "GET / serves the PWA" 200 "$BASE_URL/"
has "GET / is html" "<html" "$tmp/body"

req "GET /state without a token is refused" 401 "$BASE_URL/state"

req "GET /state at rev 0" 200 "${auth[@]}" "$BASE_URL/state"
has "database is fresh (rev 0; use an empty one)" '"rev":0' "$tmp/body"

board='{"baseRev":0,"board":{"projects":{"backlog":[{"id":"smoke_1","title":"smoke card","note":"","priority":"med","created":1,"project":null}],"progress":[],"review":[],"done":[]},"life":{},"lifeMeta":{}}}'
req "PUT /state with baseRev 0" 200 "${auth[@]}" -X PUT -H 'Content-Type: application/json' --data "$board" "$BASE_URL/state"
has "PUT /state returns rev 1" '"rev":1' "$tmp/body"

req "GET /state returns the board" 200 "${auth[@]}" "$BASE_URL/state"
has "GET /state has the card" '"smoke card"' "$tmp/body"
tr 'A-Z' 'a-z' < "$tmp/head" | tr -d '\r' > "$tmp/head.lower"
has 'GET /state ETag is "1"' 'etag: "1"' "$tmp/head.lower"
req "GET /state with If-None-Match is 304" 304 "${auth[@]}" -H 'If-None-Match: "1"' "$BASE_URL/state"

req "stale PUT /state is a 409" 409 "${auth[@]}" -X PUT -H 'Content-Type: application/json' --data "$board" "$BASE_URL/state"

req "POST /tickets" 201 "${auth[@]}" -X POST -H 'Content-Type: application/json' --data '{"title":"smoke ticket"}' "$BASE_URL/tickets"
req "GET /tickets" 200 "${auth[@]}" "$BASE_URL/tickets"
has "GET /tickets lists the new ticket" '"smoke ticket"' "$tmp/body"

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "all smoke checks passed"
