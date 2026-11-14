/**
 * itest-switch.ts — the ONE place test code may change the pause switch (M13.2 Phase 7, narrowly
 * authorised experiment). Everywhere else the acceptance guard still refuses a switch write.
 *
 * withSendingEnabled(ctx, fn) enables email_sending_enabled, runs fn, and disables it again in a
 * `finally`, even if fn throws, then reads it back on a NEW connection. If that does not read false
 * it marks the process so that no further worker can start (itest-worker.ts), and throws.
 *
 * Refused unless ALL of these hold immediately before the write:
 *   1. the lane granted it: KOLEKTO_ITEST_ALLOW_SWITCH_ON=1, set by the lane for the worker-runtime
 *      group only (the env-file loader refuses that variable if it is set in the shell);
 *   2. the environment was issued by a successful gate.verify();
 *   3. a FRESH identity probe, on this connection, matches the stack ID and host port, and the role
 *      is the test role;
 *   4. the switch currently reads false: exactly one row, boolean;
 *   5. the suite mutex is held by this file;
 *   6. every open email row belongs to this run, so the real worker's global claim can see only them;
 *   7. at most one worker session exists, connected as the least-privilege role.
 *
 * If the whole test process dies with the switch on, nothing auto-corrects: the next gate.verify()
 * refuses with PAUSE_SWITCH_ON, and no worker runs. That is deliberate.
 *
 * Lexical guards are guards against accident, not a boundary (Phase 1b §9.7).
 */

import { WORKER_DB_ROLE, connectVerified, type ItestSql } from "./itest-db.ts";
import { ITEST_DB_ROLE, ITEST_HOST_PORT_SETTING, ITEST_STACK_SETTING, refuse } from "./itest-environment.ts";
import { assertVerifiedEnvironment, type VerifiedIntegrationEnvironment } from "./itest-gate.ts";
import { markSwitchStuck, readWorkerSessions } from "./itest-worker.ts";

export const ALLOW_SWITCH_VARIABLE = "KOLEKTO_ITEST_ALLOW_SWITCH_ON";

/** Reads with no side effects, on a connection separate from the one that wrote. */
export async function readPauseSwitchIndependently(env: VerifiedIntegrationEnvironment): Promise<{ readonly rows: number; readonly column: unknown; readonly fn: unknown }> {
  const reader = connectVerified(env, { max: 1 });
  try {
    const rows = await reader.unsafe<{ email_sending_enabled: unknown }[]>("select email_sending_enabled from public.notification_sender_state");
    const fn = await reader.unsafe<{ enabled: unknown }[]>("select app.email_sending_enabled() as enabled");
    return { rows: rows.length, column: rows[0]?.email_sending_enabled, fn: fn[0]?.enabled };
  } finally {
    await reader.end({ timeout: 2 }).catch(() => {});
  }
}

export interface SwitchContext {
  readonly env: VerifiedIntegrationEnvironment;
  readonly sql: ItestSql;
  /** Throws unless this file still holds the suite mutex. */
  readonly assertMutexHeld: () => Promise<void>;
  /** True only for a community this run created. */
  readonly ownsCommunity: (communityId: string) => boolean;
}

async function assertSwitchWriteAuthorized(ctx: SwitchContext): Promise<void> {
  if (process.env[ALLOW_SWITCH_VARIABLE] !== "1") {
    throw refuse("SWITCH_WRITE_REFUSED", `${ALLOW_SWITCH_VARIABLE} is not 1. Only the worker-runtime lane group may change the pause switch.`);
  }
  assertVerifiedEnvironment(ctx.env);
  const [identity] = await ctx.sql.unsafe<{ stack: unknown; port: unknown; role: unknown; db: unknown }[]>(
    `select current_setting('${ITEST_STACK_SETTING}', true) as stack, current_setting('${ITEST_HOST_PORT_SETTING}', true) as port, ` +
      "current_user::text as role, current_database()::text as db",
  );
  if (identity?.stack !== ctx.env.stackId.reveal() || identity.port !== String(ctx.env.db.port) || identity.role !== ITEST_DB_ROLE || identity.db !== ctx.env.db.database) {
    throw refuse("SWITCH_WRITE_REFUSED", "The fresh identity probe did not match the verified test stack; the pause switch was not changed.");
  }
  const before = await readPauseSwitchIndependently(ctx.env);
  if (before.rows !== 1 || before.column !== false || before.fn !== false) {
    throw refuse("SWITCH_WRITE_REFUSED", "The pause switch does not currently read exactly false; it was not changed.");
  }
  await ctx.assertMutexHeld();
  const open = await ctx.sql.unsafe<{ community_id: string }[]>(
    "select distinct community_id::text as community_id from public.notification_deliveries where channel = 'email' and status in ('pending', 'sending')",
  );
  if (open.some((row) => !ctx.ownsCommunity(row.community_id))) {
    throw refuse("SWITCH_WRITE_REFUSED", "An open email row belongs to another run; the real worker could claim it, so the switch was not changed.");
  }
  const sessions = await readWorkerSessions(ctx.sql);
  if (new Set(sessions.map((s) => s.usename)).size > 1 || sessions.some((s) => s.usename !== WORKER_DB_ROLE)) {
    throw refuse("SWITCH_WRITE_REFUSED", "A worker session is connected as an unexpected role; the switch was not changed.");
  }
}

export async function withSendingEnabled<T>(ctx: SwitchContext, fn: () => Promise<T>): Promise<T> {
  await assertSwitchWriteAuthorized(ctx);
  await ctx.sql.unsafe("select app.set_email_sending_enabled(true) as enabled");
  let restored = false;
  try {
    return await fn();
  } finally {
    try {
      await ctx.sql.unsafe("select app.set_email_sending_enabled(false) as enabled");
      const after = await readPauseSwitchIndependently(ctx.env);
      restored = after.rows === 1 && after.column === false && after.fn === false;
    } catch {
      restored = false;
    }
    if (!restored) {
      markSwitchStuck();
      // eslint-disable-next-line no-unsafe-finally -- stop condition: this outranks whatever fn did
      throw refuse("SWITCH_RESTORE_FAILED", "The pause switch could not be confirmed false after the experiment. Stop all worker and sender execution and report.");
    }
  }
}
