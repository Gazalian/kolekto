#!/usr/bin/env bash
# One guarded lane run, with its output, exit code, times and independent readings kept. Usage: run-lane.sh <label> <lane flag>
# The lane reads .env.itest itself. This script reads nothing secret, and its readings are read-only.
set -u
label="$1"; flag="$2"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
lane="$repo/docs/database/evidence/m13.2-phase-8/lane"
state="$repo/docs/database/evidence/m13.2-phase-8/method/state.sql"
reading() {
  docker exec -i supabase_db_kolekto-itest psql -X -U supabase_admin -d postgres < "$state" > "$lane/$label.$1-state.txt" 2>&1
  curl -s http://127.0.0.1:55424/api/v1/info > "$lane/$label.$1-mailpit.json"
}
reading before
start="$(date -u +'%F %T')"
(cd "$repo/apps/worker" && npm run --silent test:integration -- "$flag") > "$lane/$label.tap.txt" 2>&1
code=$?
printf 'start %s UTC\nend %s UTC\nexit %s\ncommand npm run test:integration -- %s\n' "$start" "$(date -u +'%F %T')" "$code" "$flag" > "$lane/$label.times.txt"
reading after
cat "$lane/$label.times.txt"
grep -E '^# (tests|pass|fail|cancelled|skipped|todo) |^not ok|^    not ok' "$lane/$label.tap.txt"
tail -3 "$lane/$label.tap.txt"
exit "$code"
