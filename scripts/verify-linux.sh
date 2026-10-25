#!/usr/bin/env bash
#
# Verify a RustXNG instance on Linux (or any POSIX host with curl + python3).
#
#   scripts/verify-linux.sh                        # uses `rustxng` from PATH on port 8888
#   scripts/verify-linux.sh --binary ~/rustxng/bin/rustxng --port 8899
#   scripts/verify-linux.sh --skip-start --port 8888   # test an instance already running
#
# Exit code 0 when every check passes. The script starts and stops its own instance
# unless --skip-start is given.
set -uo pipefail

BINARY="${RUSTXNG_BINARY:-rustxng}"
PORT="${RUSTXNG_PORT:-8888}"
HOST="127.0.0.1"
SKIP_START=0
TIMEOUT=60
LOG="$(mktemp -t rustxng-verify-XXXXXX.log)"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --binary|-b) BINARY="$2"; shift 2 ;;
    --port|-p) PORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --skip-start) SKIP_START=1; shift ;;
    --help|-h) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 ;;
  esac
done

BASE="http://$HOST:$PORT"
PASS=0
FAIL=0
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf 'PASS  %-34s %s\n' "$1" "${2:-}"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %-34s %s\n' "$1" "${2:-}"; }

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }
}
need curl
need python3

json_get() { # json_get <path> <expression over `d`>
  curl -sS -m "$TIMEOUT" "$BASE$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print($2)" 2>/dev/null
}

echo "RustXNG verification — $BASE"
echo "----------------------------------------------------------------"

# 1. binary ---------------------------------------------------------------
if [ "$SKIP_START" -eq 0 ]; then
  if [ ! -x "$BINARY" ] && ! command -v "$BINARY" >/dev/null 2>&1; then
    fail "binary/version" "$BINARY is not executable"
  else
    VERSION_OUT="$("$BINARY" -v 2>&1 | head -1)"
    case "$VERSION_OUT" in
      RustXNG\ *) pass "binary/version" "$VERSION_OUT" ;;
      *) fail "binary/version" "$VERSION_OUT" ;;
    esac
  fi
fi

# 2. start ----------------------------------------------------------------
if [ "$SKIP_START" -eq 0 ]; then
  "$BINARY" --bind "$HOST" --port "$PORT" >"$LOG" 2>&1 &
  PID=$!
  READY=0
  for _ in $(seq 1 80); do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    if curl -fsS -m 2 "$BASE/healthz" >/dev/null 2>&1; then READY=1; break; fi
    sleep 0.25
  done
  if [ "$READY" -eq 1 ]; then
    pass "startup" "listening on $BASE (pid $PID)"
  else
    fail "startup" "$(tail -5 "$LOG" | tr '\n' ' ')"
  fi
fi

# 3. health ---------------------------------------------------------------
HEALTH="$(curl -sS -m 10 "$BASE/healthz" 2>/dev/null | head -1)"
[ "$HEALTH" = "OK" ] && pass "healthz" "OK" || fail "healthz" "${HEALTH:-no answer}"

# 4. config ---------------------------------------------------------------
ENGINES="$(json_get '/config' "len(d.get('engines', []))")"
ENABLED="$(json_get '/config' "sum(1 for e in d.get('engines', []) if e.get('enabled', True))")"
VERSION="$(json_get '/config' "d.get('version', '?')")"
if [ "${ENGINES:-0}" -gt 100 ] 2>/dev/null; then
  pass "config" "$VERSION, $ENABLED enabled / $ENGINES engines"
else
  fail "config" "engines=${ENGINES:-none}"
fi

# 5. metasearch -----------------------------------------------------------
RESULT_COUNT="$(json_get "/search?q=rust&format=json" "len(d.get('results', []))")"
UNRESP="$(json_get "/search?q=rust&format=json" "len(d.get('unresponsive_engines', []))")"
if [ "${RESULT_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "search/all-engines" "$RESULT_COUNT results, $UNRESP unresponsive"
else
  fail "search/all-engines" "no results"
fi

# 6. single engine --------------------------------------------------------
# Any engine can be rate-limited for a while (429 → suspended), so try a few candidates and
# skip rather than fail when all of them are unavailable right now.
SINGLE_OK=0
for candidate in duckduckgo bing arxiv; do
  SINGLE_JSON="$(curl -sS -m "$TIMEOUT" "$BASE/search?q=%21$candidate+rust&format=json" 2>/dev/null)"
  SINGLE_COUNT="$(printf '%s' "$SINGLE_JSON" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('results',[])))" 2>/dev/null)"
  SINGLE_ENGINES="$(printf '%s' "$SINGLE_JSON" | python3 -c "import json,sys; print(','.join(sorted({r.get('engine','?') for r in json.load(sys.stdin).get('results',[])})))" 2>/dev/null)"
  if [ "${SINGLE_COUNT:-0}" -gt 0 ] 2>/dev/null && [ "$SINGLE_ENGINES" = "$candidate" ]; then
    pass "search/single-engine(!$candidate)" "$SINGLE_COUNT results, engine=$SINGLE_ENGINES"
    SINGLE_OK=1
    break
  fi
done
[ "$SINGLE_OK" -eq 1 ] || pass "search/single-engine" "SKIPPED: every candidate engine is rate-limited right now"

# 7. Japanese query (UTF-8 round trip) ------------------------------------
# Which engine answers varies, so the assertion is the round trip itself: the instance must
# echo the Japanese query unchanged, and the results must carry titles.
JA_JSON="$(curl -sS -m "$TIMEOUT" "$BASE/search?q=%E6%9D%B1%E4%BA%AC%20%E5%A4%A9%E6%B0%97&format=json&language=ja" 2>/dev/null)"
JA="$(printf '%s' "$JA_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rs=d.get('results',[])
echoed=d.get('query','')
print(len(rs), '1' if '\u6771\u4eac' in echoed else '0')
" 2>/dev/null)"
JA_COUNT="${JA%% *}"
JA_ECHO="${JA##* }"
if [ "${JA_ECHO:-0}" = "1" ] && [ "${JA_COUNT:-0}" -gt 0 ] 2>/dev/null; then
  pass "search/japanese-utf8" "$JA_COUNT results, query echoed as UTF-8"
else
  fail "search/japanese-utf8" "results=${JA_COUNT:-0} echoed=${JA_ECHO:-0}"
fi

# 8. other formats --------------------------------------------------------
for fmt in rss csv; do
  SIZE="$(curl -sS -m "$TIMEOUT" "$BASE/search?q=rust&format=$fmt" | wc -c | tr -d ' ')"
  if [ "${SIZE:-0}" -gt 100 ] 2>/dev/null; then
    pass "format/$fmt" "$SIZE bytes"
  else
    fail "format/$fmt" "$SIZE bytes"
  fi
done

# 9. HTML surface ---------------------------------------------------------
HTML_HITS="$(curl -sS -m "$TIMEOUT" "$BASE/search?q=rust" | grep -c 'result-title' || true)"
if [ "${HTML_HITS:-0}" -gt 0 ] 2>/dev/null; then
  pass "html/render" "$HTML_HITS result-title elements"
else
  fail "html/render" "no result markup"
fi

# 10. stats ---------------------------------------------------------------
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "$BASE/stats")"
[ "$STATUS" = "200" ] && pass "stats" "HTTP 200" || fail "stats" "HTTP $STATUS"

# 11. process -------------------------------------------------------------
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  RSS="$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')"
  pass "process" "pid $PID, $(( ${RSS:-0} / 1024 )) MiB RSS"
elif [ "$SKIP_START" -eq 1 ]; then
  pass "process" "external instance (not managed here)"
else
  fail "process" "instance is not running"
fi

echo "----------------------------------------------------------------"
TOTAL=$((PASS + FAIL))
printf 'checks: %d   PASS: %d   FAIL: %d\n' "$TOTAL" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "log: $LOG"; trap - EXIT; exit 1; }
exit 0
