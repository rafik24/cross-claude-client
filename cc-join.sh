#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cc-join.sh — SessionStart hook: auto-join the live Cross-Claude chat bus.
#
# OPT-IN PER MACHINE: this no-ops entirely unless ~/.claude/.cross-claude-bus
# exists — so it only fires on machines you have deliberately enrolled (the
# local dev box and the Linux build/test box). Advisory, fail-open, exit 0.
#
# A SessionStart hook cannot call the Skill or Monitor tools itself, so it does
# the things it CAN: (1) mint a UNIQUE default identity for this session and
# persist it where the listen-gate reads it, (2) register presence on the bus,
# and (3) print the session's first three actions — load the skill, name itself,
# arm live-receive. Runs on Windows git-bash AND Linux.
#
# IDENTITY (why host/<branch>-<shortid>, not host/<branch>):
#   two sessions on the same branch used to both become "host/branch" and
#   collided on the bus. The <shortid> (first 8 of the Claude session id) makes
#   the default unique. The session then renames itself to host/<title-slug>
#   via cc-name.mjs. The identity is written to ~/.claude/.cc-listen/<sid>.id and
#   the listen-gate READS that file (it no longer recomputes) — so the gate always
#   agrees with the current name, default or renamed.
# ---------------------------------------------------------------------------
set -u
CFG="${CC_BUS_CONFIG:-$HOME/.claude/.cross-claude-bus}"
[ -f "$CFG" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLL="$HERE/cc-poll.mjs"
SEND="$HERE/cc-send.mjs"
NAME="$HERE/cc-name.mjs"
ACK="$HERE/cc-ack.mjs"
[ -f "$POLL" ] || exit 0

# SessionStart delivers a JSON payload on stdin that includes session_id. Grab it
# (node is guaranteed present — checked above) so we can key the identity by session.
PAYLOAD="$(cat 2>/dev/null || true)"
SID="$(printf '%s' "$PAYLOAD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).session_id||""))}catch{}})' 2>/dev/null || true)"

# On Windows git-bash, convert MSYS paths (/d/…) to node-friendly ones (D:/…) so the printed
# `node …` commands resolve. No-op on Linux (cygpath absent).
if command -v cygpath >/dev/null 2>&1; then
  HERE="$(cygpath -m "$HERE")"; POLL="$(cygpath -m "$POLL")"; SEND="$(cygpath -m "$SEND")"
  NAME="$(cygpath -m "$NAME")"; ACK="$(cygpath -m "$ACK")"
fi

# shellcheck disable=SC1090
. "$CFG"                       # CC_BASE, CC_TOKEN
[ -n "${CC_BASE:-}" ] || exit 0

machine=$(hostname 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._-' '-'); machine="${machine%-}"
[ -n "$machine" ] || machine="unknown"
branch=$(git -C "$PWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
topic="${branch##*/}"
{ [ -z "$topic" ] || [ "$topic" = "HEAD" ]; } && topic="$(basename "$PWD")"
topic=$(printf '%s' "$topic" | tr -c 'A-Za-z0-9._-' '-'); topic="${topic%-}"
[ -n "$topic" ] || topic="misc"
short="$(printf '%s' "$SID" | cut -c1-8)"
if [ -n "$short" ]; then ID="$machine/$topic-$short"; else ID="$machine/$topic"; fi

# persist the identity keyed by session so the listen-gate reads it (never recomputes).
# session ids are UUIDs — already filename-safe — so key the file by the raw sid.
LISTEN_DIR="$HOME/.claude/.cc-listen"
mkdir -p "$LISTEN_DIR" 2>/dev/null || true
[ -n "$SID" ] && printf '%s' "$ID" > "$LISTEN_DIR/$SID.id" 2>/dev/null || true

# register presence now (fail-soft — never wedge a session start), but report the outcome
# HONESTLY: the header line must state whether the bus actually answered, not assume it did.
# curl's %{http_code} is 000 when the connection never lands (server down / wrong host / DNS),
# a 2xx when register succeeds, or 401/403 when the token is wrong. Works the same on Linux and
# on Windows git-bash (both ship curl). If curl is missing entirely, http_code is empty → treated
# as "could not connect" — still honest. Never `exit` non-zero: a SessionStart hook must not wedge.
http_code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$CC_BASE/api/register" \
  -H "Authorization: Bearer ${CC_TOKEN:-}" -H 'content-type: application/json' \
  -d "{\"instance_id\":\"$ID\",\"description\":\"$topic @ $machine\"}" 2>/dev/null || true)"

case "$http_code" in
  2??)     JOIN_LINE="✅ LIVE CHAT BUS — CONNECTED, registered as: $ID   ($CC_BASE)" ;;
  000|"")  JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT to $CC_BASE (server unreachable — is cross-claude.service up?). Would join as: $ID" ;;
  401|403) JOIN_LINE="⛔ LIVE CHAT BUS — COULD NOT CONNECT: $CC_BASE rejected the token (HTTP $http_code — check CC_TOKEN in $CFG). Would join as: $ID" ;;
  *)       JOIN_LINE="⚠️ LIVE CHAT BUS — bus at $CC_BASE answered HTTP $http_code (not a clean register). Would join as: $ID" ;;
esac

cat <<EOF
$JOIN_LINE
   Your FIRST actions this session (in order):
   1. LOAD THE SKILL:  Skill(cross-claude)
        — defines your identity, the always-listen rule, reply-only-if-addressed, and the ack protocol.
   2. NAME yourself after this session's task so peers can @mention you and the PO console is readable:
        node $NAME ${SID:-<session_id>} "<what you're working on>"
        — prints your named id + the exact Monitor line to arm. Do this BEFORE step 3 to arm once.
   3. ARM RECEIVE (MANDATORY — the listen-gate blocks Edit/Write until a live beacon exists):
        Monitor({ command: 'node $POLL $ID', description: 'cross-claude bus ($ID)', persistent: true })
        — if you named yourself in step 2, arm with the id THAT printed, not this default.
   Send:  node $SEND <your-id> <channel|all> 'message' [--type status|request|response|handoff|done]
   ACK a handoff:  node $ACK <your-id> <channel> 'taking X into my lane'
   Console: open $HERE/cc-console.html
EOF
exit 0
