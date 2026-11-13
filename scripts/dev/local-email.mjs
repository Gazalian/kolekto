#!/usr/bin/env node
/**
 * `npm run email:local -- on|off|status`
 *
 * LOCAL DEVELOPMENT ONLY. Turns member email delivery on or off in the local
 * Supabase stack (docker container `supabase_db_kolekto`) so notifications can
 * be seen end to end in Mailpit (http://127.0.0.1:54324):
 *
 *   on     - app.set_email_sending_enabled(true)  (the pause switch)
 *          - opens the 'bulk' send class (L4/L5) in THIS database only, so
 *            collection announcements / updates / reminders actually send.
 *          - raises L1 (per-address cap) for 'bulk' to 1000/24h, so repeated
 *            local testing against the same 1-2 seed member addresses does
 *            not trip "recipient_rate_limited" (the shipped default is 3/24h,
 *            a real anti-spam guard, unchanged for 'transactional').
 *   off    - pause switch false, bulk caps (L1/L4/L5) back to the shipped values.
 *   status - prints the switch, bulk caps and delivery counts by status.
 *
 * Why bulk is not opened by a migration: the shipped value is zero on purpose
 * (pgTAP 44 and 51 pin it) and opening it in staging/production is a reviewed
 * migration tied to the SES account quota (docs/product/M13.3-COMPLETION-PLAN.md
 * Phase 6). This script never touches anything but the local container, and
 * it refuses any other container name, including the isolated itest stack.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";

const CONTAINER = "supabase_db_kolekto";
const command = process.argv[2];

if (!["on", "off", "status"].includes(command ?? "")) {
  console.error("Usage: npm run email:local -- on|off|status");
  process.exit(2);
}

if (spawnSync("docker", ["exec", CONTAINER, "true"], { stdio: "ignore" }).status !== 0) {
  console.error(`Local database container ${CONTAINER} is not running. Start it with: npm run db:start`);
  process.exit(1);
}

function psql(sql) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q"],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  return result.stdout;
}

/** Same body as 20261024200000_notification_quota_controls.sql; only the bulk L1/L4/L5 numbers vary. */
function limitsFunction(bulkL1, bulkDaily, bulkPerSecond) {
  return `
create or replace function app.notification_send_limits(p_class text)
returns table (
  l1_address integer, l1_window_hours integer,
  l2_community integer, l2_window_hours integer,
  l3_platform integer, l3_window_hours integer,
  l4_daily integer, l4_window_hours integer,
  l5_per_second integer, l5_window_seconds integer,
  backlog_max integer, max_attempts integer
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_class = 'transactional' then
    return query select
      3, 24, 100, 1, 1000, 1, 180, 24, 1, 1, 500, 3;
  elsif p_class = 'bulk' then
    return query select
      ${bulkL1}, 24, 100, 1, 1000, 1, ${bulkDaily}, 24, ${bulkPerSecond}, 1, 500, 3;
  else
    raise exception 'UNKNOWN_SEND_CLASS: % (expected transactional or bulk)', p_class
      using errcode = '22023';
  end if;
end;
$fn$;
revoke all on function app.notification_send_limits(text) from public;
revoke execute on function app.notification_send_limits(text) from anon, authenticated;
`;
}

const STATUS_SQL = `
select 'email_sending_enabled' as item, app.email_sending_enabled()::text as value
union all
select 'bulk l4_daily / l5_per_second', l4_daily || ' / ' || l5_per_second from app.notification_send_limits('bulk')
union all
select 'deliveries ' || channel || ' ' || status || coalesce(' (' || error_code || ')', ''), count(*)::text
from public.notification_deliveries
group by channel, status, error_code;
`;

if (command === "on") {
  psql(`begin;\n${limitsFunction(1000, 1000, 5)}\nselect app.set_email_sending_enabled(true);\ncommit;`);
  console.log("Local member email ON (pause switch true, bulk class open, L1 raised to 1000/24h). Start the worker: npm run start --workspace apps/worker");
} else if (command === "off") {
  psql(`begin;\n${limitsFunction(3, 0, 0)}\nselect app.set_email_sending_enabled(false);\ncommit;`);
  console.log("Local member email OFF (pause switch false, bulk caps back to shipped values).");
}
console.log(psql(STATUS_SQL));
