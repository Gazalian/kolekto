#!/usr/bin/env bash
# One more worker-runtime pass on the final code, after the developer-port guard was added to test support.
cd "$(dirname "$0")/../../../../.." || exit 2
E=docs/database/evidence/m13.2-phase-7
L=$E/lane
name=final-pass-4-worker-runtime
state() { docker exec -i supabase_db_kolekto-itest psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$E/method/state.sql" > "$1" 2>&1; curl -s http://127.0.0.1:55424/api/v1/info > "$2"; }
state "$L/$name.state-before.txt" "$L/$name.mailpit-before.json"
{
  echo "command: npm run test:integration -- --worker-runtime (from apps/worker)"
  echo "start $(date -u +'%F %T') UTC"
} > "$L/$name.times.txt"
(cd apps/worker && npm run --silent test:integration -- --worker-runtime) > "$L/$name.tap.txt" 2>&1
code=$?
{ echo "end $(date -u +'%F %T') UTC"; echo "exit $code"; } >> "$L/$name.times.txt"
state "$L/$name.state-after.txt" "$L/$name.mailpit-after.json"
echo "$name exit=$code $(grep -E '^# (tests|pass|fail) ' "$L/$name.tap.txt" | tr '\n' ' ')"
exit "$code"
