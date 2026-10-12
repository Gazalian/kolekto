#!/usr/bin/env node
/**
 * The notification-suppression setting must end with its transaction (M13.2 P3, test C9).
 *
 * WHY THIS IS NOT A pgTAP TEST. pgTAP runs in ONE session inside ONE transaction, so it
 * can never observe what happens after a transaction ends. "Transaction-local" is a
 * claim about time, and the only way to test it is to commit and look again, on the same
 * connection and on a different one. (decision record 10.7; pgTAP only asserts that the
 * helper passes is_local = true.)
 *
 * WHAT IT DOES
 *   1. connection A: begin; app.begin_notification_suppression(...); the setting is
 *      visible inside the transaction; commit.
 *   2. connection A again, after the commit: the setting is gone.
 *   3. connection B, a different session: the setting was never visible to it.
 *   4. connection A: a rolled-back transaction that set it leaves nothing behind either.
 *   5. the setting set by hand with is_local = false (a session-level leak) is honoured
 *      only inside its window: an already-expired value, and a value more than 15 minutes
 *      out, are reported as LAPSED (well-formed but outside the window). The trigger HOLDS
 *      events for a lapsed value (migration 20261009120000) rather than notifying or
 *      honouring it. The 15-minute cap is what bounds a leak.
 *
 * It writes NO audit row, no queue message and no business row: it only reads settings
 * and calls the state parser, so it leaves nothing in the database it runs against.
 *
 * Usage: node scripts/verify/notification-suppression-lifetime.mjs
 * LOCAL stack only: it refuses any database that is not on this machine.
 */

import postgres from "postgres";
import process from "node:process";

const URL_ = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const host = (() => {
  try {
    return new URL(URL_).hostname;
  } catch {
    return "";
  }
})();
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`refusing to run against a non-local database (${host || "unparseable URL"})`);
  process.exit(2);
}

const SETTING = "kolekto.suppress_notifications";
const a = postgres(URL_, { max: 1, onnotice: () => {} });
const b = postgres(URL_, { max: 1, onnotice: () => {} });

let failures = 0;
function check(condition, description, detail) {
  if (condition) console.log(`  ok   ${description}`);
  else {
    failures += 1;
    console.log(`  FAIL ${description}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}
const blank = (v) => v === null || v === undefined || v === "";

try {
  // 1. inside the transaction the setting exists; after the commit it does not.
  let inside;
  await a.begin(async (tx) => {
    await tx`select app.begin_notification_suppression('lifetime check')`;
    [{ v: inside }] = await tx`select current_setting(${SETTING}, true) as v`;
    const [{ present, trusted, valid }] = await tx`select * from app.notification_suppression_state()`;
    check(present && trusted && valid, "inside the transaction the setting is present, trusted and valid", JSON.stringify({ present, trusted, valid }));
  });
  check(/^v1\|\d{10}\|lifetime check$/.test(inside ?? ""), "the helper set v1|<expiry>|<reason>", inside);

  // 2. same connection, after commit.
  const [{ v: after }] = await a`select current_setting(${SETTING}, true) as v`;
  check(blank(after), "after COMMIT the setting is gone on the same connection", JSON.stringify(after));
  const [state] = await a`select * from app.notification_suppression_state()`;
  check(state.present === false, "and the state parser reports it absent", JSON.stringify(state));

  // 3. a different session never saw it.
  const [{ v: other }] = await b`select current_setting(${SETTING}, true) as v`;
  check(blank(other), "a different session never saw the setting", JSON.stringify(other));

  // 4. a rolled-back transaction leaves nothing.
  await a
    .begin(async (tx) => {
      await tx`select app.begin_notification_suppression('rolled back')`;
      throw new Error("force rollback");
    })
    .catch(() => undefined);
  const [{ v: afterRollback }] = await a`select current_setting(${SETTING}, true) as v`;
  check(blank(afterRollback), "after ROLLBACK the setting is gone too", JSON.stringify(afterRollback));

  // 5. a session-level leak is bounded by the expiry rules.
  const now = Math.floor(Date.now() / 1000);
  for (const [label, expiry, expectValid, expectLapsed] of [
    ["an already-expired session-level value", now - 30, false, true],
    ["a session-level value 16 minutes ahead", now + 960, false, true],
    ["a session-level value 5 minutes ahead (still honoured: this is what the cap bounds)", now + 300, true, false],
  ]) {
    await a`select set_config(${SETTING}, ${`v1|${expiry}|leaked value`}, false)`;
    const [s] = await a`select * from app.notification_suppression_state()`;
    check(s.valid === expectValid && s.lapsed === expectLapsed, `${label}: valid = ${expectValid}, lapsed = ${expectLapsed}`, JSON.stringify(s));
  }
  // A malformed value is neither valid nor lapsed: it is not an activation attempt (the helper never produces one).
  await a`select set_config(${SETTING}, ${"v1|abc|leaked value"}, false)`;
  const [bad] = await a`select * from app.notification_suppression_state()`;
  check(bad.present === true && bad.valid === false && bad.lapsed === false, "a malformed value is present but neither valid nor lapsed", JSON.stringify(bad));
  await a`select set_config(${SETTING}, '', false)`;
} finally {
  await a.end({ timeout: 2 });
  await b.end({ timeout: 2 });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe suppression setting is transaction-local and bounded.");
