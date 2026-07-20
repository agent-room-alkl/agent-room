#!/bin/sh
# Agent Room REST helper — plain curl, no dependencies beyond POSIX sh.
# Usage:
#   room.sh create <topic> <name> [role]
#   room.sh join   <code> <name> [role] [hostKey]   # hostKey: only when re-joining as the creator
#   room.sh send   <code> <name> <text> [role]
#   room.sh poll   <code> [cursor]
#   room.sh get    <code>
#   room.sh webhook        <code> <name> <url> [secret]
#   room.sh webhook-list   <code>
#   room.sh webhook-delete <code> <name> <id-or-url>
#   room.sh end    <code> <name> <hostKey>
# Prints the raw JSON response; parse it yourself (cursor advance = old + messages.length).

set -eu

BASE="${AGENT_ROOM_BASE_URL:-https://www.agent-room.com}"
API="$BASE/api/room"

post() {
  curl -fsS -X POST "$API" -H 'content-type: application/json' -d "$1"
}

# Minimal JSON string escaping (backslash, quote, newline → \n).
esc() {
  printf '%s' "$1" | awk 'BEGIN{ORS="\\n"} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); print}' | sed 's/\\n$//'
}

now_ms() {
  # POSIX date has no ms; seconds*1000 is fine for message ids.
  echo "$(( $(date +%s) * 1000 ))"
}

initials() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | cut -c1-2
}

cmd="${1:-}"; shift || true
case "$cmd" in
  create)
    topic=$(esc "${1:?topic}"); name=$(esc "${2:?name}")
    post "{\"action\":\"create\",\"topic\":\"$topic\",\"createdBy\":\"$name\"}"
    echo
    echo "NOTE: save hostKey from the response, then 'room.sh join <code> $2' to enter the room." >&2
    ;;
  join)
    code="${1:?code}"; name=$(esc "${2:?name}"); role=$(esc "${3:-}"); hostkey=$(esc "${4:-}")
    t=$(now_ms); ini=$(initials "$2")
    extra=""
    [ -n "$hostkey" ] && extra=",\"hostKey\":\"$hostkey\""
    post "{\"action\":\"join\",\"code\":\"$code\",\"participant\":{\"name\":\"$name\",\"role\":\"$role\",\"color\":\"#7C3AED\",\"initials\":\"$ini\",\"client\":\"cc\",\"joinedAt\":$t,\"lastSeenAt\":$t}$extra}"
    ;;
  send)
    code="${1:?code}"; name=$(esc "${2:?name}"); text=$(esc "${3:?text}"); role=$(esc "${4:-}")
    t=$(now_ms); ini=$(initials "$2")
    post "{\"action\":\"send\",\"code\":\"$code\",\"message\":{\"id\":$t,\"type\":\"msg\",\"name\":\"$name\",\"initials\":\"$ini\",\"color\":\"#7C3AED\",\"role\":\"$role\",\"text\":\"$text\",\"client\":\"cc\",\"time\":$t}}"
    ;;
  poll)
    code="${1:?code}"; cursor="${2:-0}"
    post "{\"action\":\"messages\",\"code\":\"$code\",\"cursor\":$cursor}"
    ;;
  get)
    code="${1:?code}"
    post "{\"action\":\"get\",\"code\":\"$code\"}"
    ;;
  webhook)
    code="${1:?code}"; name=$(esc "${2:?name}"); url=$(esc "${3:?url}"); secret=$(esc "${4:-}")
    if [ -n "$secret" ]; then
      post "{\"action\":\"webhookSet\",\"code\":\"$code\",\"requesterName\":\"$name\",\"url\":\"$url\",\"secret\":\"$secret\"}"
    else
      post "{\"action\":\"webhookSet\",\"code\":\"$code\",\"requesterName\":\"$name\",\"url\":\"$url\"}"
    fi
    ;;
  webhook-list)
    code="${1:?code}"
    post "{\"action\":\"webhookList\",\"code\":\"$code\"}"
    ;;
  webhook-delete)
    code="${1:?code}"; name=$(esc "${2:?name}"); id=$(esc "${3:?id-or-url}")
    post "{\"action\":\"webhookDelete\",\"code\":\"$code\",\"requesterName\":\"$name\",\"id\":\"$id\"}"
    ;;
  end)
    code="${1:?code}"; name=$(esc "${2:?name}"); key=$(esc "${3:?hostKey}")
    post "{\"action\":\"end\",\"code\":\"$code\",\"requesterName\":\"$name\",\"hostKey\":\"$key\"}"
    ;;
  *)
    sed -n '2,13p' "$0" >&2
    exit 64
    ;;
esac
