#!/usr/bin/env bash
# One guarded lane run, with its output, exit code, times and independent readings kept in a NEW evidence folder.
# Replaces docs/database/evidence/m13.2-phase-8/method/run-lane.sh for new runs: that copy is sealed with its
# folder, and it writes into that folder.
#
# Usage: scripts/itest/run-lane.sh <new evidence folder name> <label> <lane flag>
#   e.g. scripts/itest/run-lane.sh m13.2-regression without-smtp --without-smtp
#
# Running this touches the test stack and spends test budget, so it needs its own approval. The lane reads
# .env.itest itself. This script reads nothing secret, and its readings are read-only.
set -u
if [ "$#" -ne 3 ]; then echo "usage: $0 <new evidence folder name> <label> <lane flag>" >&2; exit 2; fi
folder="$1"; label="$2"; flag="$3"
case "$folder" in
  m13.2-phase-6b-2|m13.2-phase-7|m13.2-phase-8) echo "refusing: $folder is sealed" >&2; exit 2 ;;
  *[!A-Za-z0-9._-]*|.*|"") echo "refusing: give a plain folder name" >&2; exit 2 ;;
esac
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
lane="$repo/docs/database/evidence/$folder/lane"
# Read, never written: the statement list the sealed runs used, so before and after stay comparable.
state="$repo/docs/database/evidence/m13.2-phase-8/method/state.sql"
if [ -e "$lane/$label.tap.txt" ]; then echo "refusing: $label already has evidence in $folder" >&2; exit 2; fi
mkdir -p "$lane"
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
