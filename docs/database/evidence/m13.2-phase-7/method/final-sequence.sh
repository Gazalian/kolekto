#!/usr/bin/env bash
# The final sequence: three worker-runtime passes, then one full lane. Stops at the first failure.
# Each step records its TAP output, start and end times, exit code and a fresh read-only state reading.
cd "$(dirname "$0")/../../../../.." || exit 2
E=docs/database/evidence/m13.2-phase-7
L=$E/lane
state() { docker exec -i supabase_db_kolekto-itest psql -X -q -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < "$E/method/state.sql" > "$1" 2>&1; curl -s http://127.0.0.1:55424/api/v1/info > "$2"; }
step() {
  local name=$1 flag=$2 code
  state "$L/$name.state-before.txt" "$L/$name.mailpit-before.json"
  {
    echo "command: npm run test:integration -- $flag (from apps/worker)"
    echo "start $(date -u +'%F %T') UTC"
  } > "$L/$name.times.txt"
  (cd apps/worker && npm run --silent test:integration -- "$flag") > "$L/$name.tap.txt" 2>&1
  code=$?
  { echo "end $(date -u +'%F %T') UTC"; echo "exit $code"; } >> "$L/$name.times.txt"
  state "$L/$name.state-after.txt" "$L/$name.mailpit-after.json"
  echo "$name exit=$code $(grep -E '^# (tests|pass|fail) ' "$L/$name.tap.txt" | tr '\n' ' ')"
  [ "$code" -eq 0 ]
}
step final-pass-1-worker-runtime --worker-runtime || exit 1
step final-pass-2-worker-runtime --worker-runtime || exit 1
step final-pass-3-worker-runtime --worker-runtime || exit 1
# The first file of the full lane refuses while a heartbeat is younger than 60 s.
sleep 75
step final-full-lane --with-smtp || exit 1
echo "sequence complete"
