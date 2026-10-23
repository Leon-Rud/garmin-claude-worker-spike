#!/bin/sh
# Smoke test against a running worker. Usage: ./test.sh <base-url> <mcp-token>
# Checks: auth rejected without token, initialize, notification=202, tools/list, both tools via header auth, path-token auth.
set -u
BASE=${1:-http://127.0.0.1:8787}; TOK=${2:?token}
H="content-type: application/json"
fail() { echo "FAIL: $1"; exit 1; }
post() { curl -s -o "$2" -w '%{http_code}' -X POST "$BASE$1" -H "$H" -H "authorization: Bearer $TOK" -d "$3"; }
T=$(mktemp -d)

for i in $(seq 1 90); do curl -s -o /dev/null --max-time 2 "$BASE/" && break; sleep 2; done

c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$H" -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')
[ "$c" = "403" ] || fail "no token should be 403, got $c"

c=$(post /mcp "$T/init" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}')
[ "$c" = "200" ] && grep -q '"serverInfo"' "$T/init" || fail "initialize: $c $(cat $T/init)"

c=$(post /mcp "$T/n" '{"jsonrpc":"2.0","method":"notifications/initialized"}')
[ "$c" = "202" ] || fail "notification should be 202, got $c"

c=$(post /mcp "$T/list" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
grep -q '"get_sleep"' "$T/list" && grep -q '"get_hrv"' "$T/list" || fail "tools/list: $(cat $T/list)"

c=$(post /mcp "$T/sleep" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_sleep","arguments":{}}}')
grep -q 'score' "$T/sleep" && ! grep -q 'isError' "$T/sleep" || fail "get_sleep: $(cat $T/sleep)"
echo "get_sleep  -> $(sed 's/\\"/"/g' $T/sleep | grep -o '"score":[0-9]*,"quality":"[A-Z]*","total_hours":[0-9.]*')"

c=$(post /mcp "$T/hrv" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_hrv","arguments":{}}}')
grep -q 'last_night_avg' "$T/hrv" || fail "get_hrv: $(cat $T/hrv)"
echo "get_hrv    -> $(sed 's/\\"/"/g' $T/hrv | grep -o '"last_night_avg":[0-9]*,"weekly_avg":[0-9]*,"status":"[A-Z]*"')"

c=$(curl -s -o "$T/path" -w '%{http_code}' -X POST "$BASE/t/$TOK/mcp" -H "$H" -d '{"jsonrpc":"2.0","id":5,"method":"ping"}')
[ "$c" = "200" ] || fail "path token auth: $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/t/wrong/mcp" -H "$H" -d '{"jsonrpc":"2.0","id":6,"method":"ping"}')
[ "$c" = "403" ] || fail "wrong path token should be 403, got $c"

# Every header form claude.ai's Request-headers dropdown can produce
for hdr in "x-auth-token: $TOK" "x-api-key: $TOK" "authorization: $TOK" "x-auth-token: Bearer $TOK"; do
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$H" -H "$hdr" -d '{"jsonrpc":"2.0","id":7,"method":"ping"}')
  [ "$c" = "200" ] || fail "header form '${hdr%%:*}' should be 200, got $c"
done
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H "$H" -H "x-auth-token: wrong" -d '{"jsonrpc":"2.0","id":8,"method":"ping"}')
[ "$c" = "403" ] || fail "wrong x-auth-token should be 403, got $c"

echo "worker checks: all passed"
