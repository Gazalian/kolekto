/**
 * itest-acceptance.ts — the checklist §9 criterion-1 lexical guard (M13.2 Phase 1c).
 *
 * Pure: scans source text it is handed. test/itest-acceptance.test.ts runs it
 * over every file under apps/worker/test/.
 *
 * Forbidden in worker test code (approval checklist §9.1, review SR-13):
 *   - disabling or enabling a trigger;
 *   - deleting rows of the ledger (notification_send_attempts) or of the event log
 *     (notification_events);
 *   - the ledger purge flag (app.send_attempts_purg…);
 *   - session_replication_rol… (replica mode silently skips triggers) — an addition;
 *   - any pause-switch write (the same rules as findForbiddenSwitchWrites);
 *   - an HTTP DELETE (the only one a worker test has ever sent is Mailpit's
 *     delete-all on /api/v1/messages);
 *   - an inbox-wide total assertion;
 *   - inserting into the ledger table. The checklist allows fillers only
 *     "inside the rollback helpers"; no rollback helper exists yet (it arrives
 *     with the Phase 4 conversion), so today every such insert is reported. The
 *     exception is defined when that helper exists, not before;
 *   - set_config, with exactly one narrow exception, below;
 *   - (Phase 6A, an addition) calling a pgmq queue function that writes to or
 *     consumes a queue (send, archive, delete, pop, read, set_vt, purge, drop,
 *     create, …) or writing a pgmq table directly, with exactly one narrow
 *     exception: the owned-message archive in support/itest-queue.ts (below).
 *
 * The pgmq exception (Phase 6A, decision Q6-1): support/itest-queue.ts may hold
 * exactly one queue call, and it must be the literal
 *     select <pgmq>.archive('notification_events', $1::bigint) as archived
 * (archive, never delete; one bound msg_id; the one notification queue), preceded
 * in the same function by `assertOwnedQueueMessage(owner, message);` — the runtime
 * check that the message was read for the current test's owner and that the owner
 * still owns its community. Every other pgmq write anywhere is still a violation.
 *
 * The set_config exception (resolves Phase 1b report §9.8):
 *   The processor integration test impersonates an officer inside its
 *   rolled-back transaction with
 *       await tx`select set_config('request.jwt.claims', ${JSON.stringify({ … })}, true)`
 *   That is the only allowed form. A set_config call is allowed only when ALL
 *   of these hold, otherwise it is a violation:
 *     1. it is the whole statement of a tagged template on a handle named `tx`
 *        (the transaction handle of sql.begin);
 *     2. the setting name is the literal 'request.jwt.claims' — not any other
 *        name, not a ${…} parameter, not a concatenation;
 *     3. the value is one ${…} template parameter (bound by the driver, never
 *        spliced into SQL), with no nested template literal inside it;
 *     4. is_local is the literal `true` (transaction-scoped; reverts at
 *        commit/rollback). `false`, a parameter or anything else is refused.
 *   Rejected (see the unit tests): any other setting name, including the purge
 *   flag; is_local false or a parameter; a ${…} setting name; a call through
 *   sql.unsafe; a literal JSON value instead of a parameter; `sql` instead of
 *   `tx` as the handle; extra statement text in the same template.
 *   Lexical limit: `tx` is recognised by name; that it really is a transaction
 *   is a convention of the existing tests (sql.begin(async (tx) => …)), proven
 *   only when they run in Phase 4.
 *
 * Lexical guards are guards against accident, not a boundary (Phase 1b §9.7).
 * Tokens are written so that this file does not match its own rules (a unit
 * test scans it).
 */

import { findForbiddenSwitchWrites } from "./itest-gate.ts";

const TABLE = (name: string) => String.raw`(?:"?public"?\s*\.\s*)?"?` + name + String.raw`\b`;

const RULES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "disables or enables a trigger", pattern: /\b(?:disable|enable)\s+trigger\b/gi },
  { label: "deletes ledger rows (notification_send_attempts)", pattern: new RegExp(String.raw`\bdelete\s+from\s+` + TABLE("notification_send_attempts"), "gi") },
  { label: "deletes event rows (notification_events)", pattern: new RegExp(String.raw`\bdelete\s+from\s+` + TABLE("notification_events"), "gi") },
  { label: "inserts ledger rows (fillers belong in a rollback helper, Phase 4)", pattern: new RegExp(String.raw`\binsert\s+into\s+` + TABLE("notification_send_attempts"), "gi") },
  { label: "uses the ledger purge flag", pattern: /send_attempts_purg(?:ing)/gi },
  { label: "changes the session replication role", pattern: /session_replication_rol(?:e)/gi },
  { label: "sends an HTTP DELETE (Mailpit delete-all)", pattern: /\bmethod\s*:\s*["'`]DELETE["'`]/gi },
  { label: "asserts on an inbox-wide total", pattern: /\binbox\s*\.\s*total\b/g },
];

// ── Phase 6A: pgmq writes ─────────────────────────────────────────────────────

const PGMQ = "pg" + "mq";
export const QUEUE_CALL_LABEL = "calls a pgmq queue function (only the owned-message archive helper may)";
export const QUEUE_TABLE_WRITE_LABEL = "writes a pgmq table directly";
const QUEUE_CALL = new RegExp(
  String.raw`\b` + PGMQ + String.raw`\s*\.\s*"?(?:send|send_batch|archive|delete|pop|read|read_with_poll|set_vt|purge_queue|drop_queue|create\w*|detach_archive|convert_archive_partitioned)"?\s*\(`,
  "gi",
);
const QUEUE_TABLE_WRITE = new RegExp(String.raw`\b(?:delete\s+from|insert\s+into|update|truncate(?:\s+table)?)\s+"?` + PGMQ + String.raw`"?\s*\.`, "gi");
const QUEUE_RULES: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: QUEUE_CALL_LABEL, pattern: QUEUE_CALL },
  { label: QUEUE_TABLE_WRITE_LABEL, pattern: QUEUE_TABLE_WRITE },
];

export const QUEUE_ARCHIVE_HELPER = "support/itest-queue.ts";
const OWNED_ARCHIVE_STATEMENT = "select " + PGMQ + ".archive('notification_events', $1::bigint) as archived";
const OWNED_ARCHIVE_ASSERT = "assertOwnedQueueMessage(owner, message);";

/**
 * True when `source` holds exactly one pgmq queue call, that call is the owned
 * archive statement, and it is preceded within the same function by the
 * ownership assertion.
 */
export function queueArchiveIsOwnershipGuarded(source: string): boolean {
  const calls = [...source.matchAll(QUEUE_CALL)];
  if (calls.length !== 1) return false;
  const at = calls[0]!.index;
  const statement = source.indexOf(OWNED_ARCHIVE_STATEMENT);
  if (statement < 0 || statement + "select ".length !== at || source.indexOf(OWNED_ARCHIVE_STATEMENT, statement + 1) >= 0) return false;
  const guard = source.lastIndexOf(OWNED_ARCHIVE_ASSERT, at);
  if (guard < 0) return false;
  const between = source.slice(guard + OWNED_ARCHIVE_ASSERT.length, at);
  return !/\bfunction\b|=>\s*\{|\bexport\b/.test(between);
}

export const SET_CONFIG_LABEL = "calls set_config outside the transaction-local request.jwt.claims form";

const SET_CONFIG_CALL = /\bset_config\s*\(/gi;
const TX_TEMPLATE_PREFIX = /\btx\s*`\s*select\s+$/i;
const JWT_CLAIMS_HEAD = /^\s*'request\.jwt\.claims'\s*,\s*\$\{/;
const LOCAL_TRUE_TAIL = /^\s*,\s*true\s*\)\s*`/i;

/** True only for `` tx`select set_config('request.jwt.claims', ${…}, true)` `` starting at `index`. */
export function isAllowedSetConfig(source: string, index: number, callLength: number): boolean {
  if (!TX_TEMPLATE_PREFIX.test(source.slice(Math.max(0, index - 64), index))) return false;
  let i = index + callLength;
  const head = JWT_CLAIMS_HEAD.exec(source.slice(i));
  if (head === null) return false;
  i += head[0].length;
  let depth = 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === "`") return false; // a nested template could hide SQL
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  if (depth !== 0) return false;
  return LOCAL_TRUE_TAIL.test(source.slice(i));
}

/**
 * Phase 4: the one exception to the ledger-insert rule (checklist §9.1, "outside
 * the rollback helpers"). The filler helper in this file may hold exactly one
 * ledger insert, and that insert must sit in the same function as, and after, an
 * `assertRollbackHandle(tx);` call — the runtime check that refuses any handle
 * that is not a live inRollback transaction, so a filler can never commit.
 * Everywhere else every ledger insert is still a violation.
 */
export const LEDGER_FILLER_HELPER = "support/itest-isolation.ts";
export const LEDGER_INSERT_LABEL = "inserts ledger rows (fillers belong in a rollback helper, Phase 4)";

const LEDGER_INSERT = new RegExp(String.raw`\binsert\s+into\s+` + TABLE("notification_send_attempts"), "i");
const ROLLBACK_ASSERT = "assertRollbackHandle(tx);";

/** True when the single ledger insert in `source` is preceded, within the same function, by the rollback assertion. */
export function ledgerInsertIsRollbackGuarded(source: string): boolean {
  const m = LEDGER_INSERT.exec(source);
  if (m === null) return false;
  const guard = source.lastIndexOf(ROLLBACK_ASSERT, m.index);
  if (guard < 0) return false;
  const between = source.slice(guard + ROLLBACK_ASSERT.length, m.index);
  return !/\bfunction\b|=>\s*\{|\bexport\b/.test(between);
}

/**
 * Phase 7: the owned queue seed. support/itest-queue-seed.ts may hold exactly one queue
 * call, the literal below, preceded in the same function by the ownership assertion.
 */
export const QUEUE_SEED_HELPER = "support/itest-queue-seed.ts";
const OWNED_SEED_STATEMENT = "select " + PGMQ + ".send('notification_events', $1::text::jsonb)::text as msg_id";
const OWNED_SEED_ASSERT = "assertSeedOwned(owner, message);";

export function queueSeedIsOwnershipGuarded(source: string): boolean {
  const calls = [...source.matchAll(QUEUE_CALL)];
  if (calls.length !== 1) return false;
  const at = calls[0]!.index;
  const statement = source.indexOf(OWNED_SEED_STATEMENT);
  if (statement < 0 || statement + "select ".length !== at) return false;
  const guard = source.lastIndexOf(OWNED_SEED_ASSERT, at);
  if (guard < 0) return false;
  return !/\bfunction\b|=>\s*\{|\bexport\b/.test(source.slice(guard + OWNED_SEED_ASSERT.length, at));
}

/**
 * Phase 8: the operator's release of a parked message. support/itest-queue-release.ts may hold
 * exactly one queue call, the literal below (one bound msg_id, visibility now, the one queue),
 * preceded in the same function by the ownership assertion.
 */
export const QUEUE_RELEASE_HELPER = "support/itest-queue-release.ts";
const OWNED_RELEASE_PREFIX = "select msg_id::text as msg_id from ";
const OWNED_RELEASE_STATEMENT = OWNED_RELEASE_PREFIX + PGMQ + ".set_vt('notification_events', $1::bigint, 0)";

export function queueReleaseIsOwnershipGuarded(source: string): boolean {
  const calls = [...source.matchAll(QUEUE_CALL)];
  if (calls.length !== 1) return false;
  const at = calls[0]!.index;
  const statement = source.indexOf(OWNED_RELEASE_STATEMENT);
  if (statement < 0 || statement + OWNED_RELEASE_PREFIX.length !== at) return false;
  const guard = source.lastIndexOf(OWNED_ARCHIVE_ASSERT, at);
  if (guard < 0) return false;
  return !/\bfunction\b|=>\s*\{|\bexport\b/.test(source.slice(guard + OWNED_ARCHIVE_ASSERT.length, at));
}

/**
 * Phase 7: the narrowly authorised pause-switch experiment. support/itest-switch.ts may
 * hold exactly the two literal setter statements, one true and one false, both inside
 * withSendingEnabled and after the authorisation check. Every other switch write,
 * in every other file, is still a violation.
 */
export const SWITCH_HELPER = "support/itest-switch.ts";
export const SWITCH_SETTER_LABEL = "pause-switch write (switch setter call)";
const SWITCH_ON_STATEMENT = "select app.set_email_" + "sending_enabled(true) as enabled";
const SWITCH_OFF_STATEMENT = "select app.set_email_" + "sending_enabled(false) as enabled";
const SWITCH_AUTHORIZE = "await assertSwitchWriteAuthorized(ctx);";

export function switchWriteIsGuarded(source: string): boolean {
  const setters = [...source.matchAll(/set_?email_?sending_?enabled/gi)];
  if (setters.length !== 2) return false;
  const on = source.indexOf(SWITCH_ON_STATEMENT);
  const off = source.indexOf(SWITCH_OFF_STATEMENT);
  if (on < 0 || off < 0 || off < on) return false;
  const guard = source.lastIndexOf(SWITCH_AUTHORIZE, on);
  if (guard < 0) return false;
  if (/\bfunction\b|=>\s*\{|\bexport\b/.test(source.slice(guard + SWITCH_AUTHORIZE.length, on))) return false;
  // The disable must sit in the finally block of the same function.
  const finallyAt = source.indexOf("finally", on);
  return finallyAt > on && finallyAt < off;
}

/** findAcceptanceViolations for a file under apps/worker/test/, given its path relative to that directory. */
export function findAcceptanceViolationsInFile(relPath: string, source: string): AcceptanceViolation[] {
  const found = findAcceptanceViolations(source);
  const rel = relPath.replaceAll("\\", "/");
  if (rel === QUEUE_ARCHIVE_HELPER) {
    return found.filter((v) => !(v.label === QUEUE_CALL_LABEL && v.count === 1 && queueArchiveIsOwnershipGuarded(source)));
  }
  if (rel === QUEUE_SEED_HELPER) {
    return found.filter((v) => !(v.label === QUEUE_CALL_LABEL && v.count === 1 && queueSeedIsOwnershipGuarded(source)));
  }
  if (rel === QUEUE_RELEASE_HELPER) {
    return found.filter((v) => !(v.label === QUEUE_CALL_LABEL && v.count === 1 && queueReleaseIsOwnershipGuarded(source)));
  }
  if (rel === SWITCH_HELPER) {
    return found.filter((v) => !(v.label === SWITCH_SETTER_LABEL && v.count === 1 && switchWriteIsGuarded(source)));
  }
  if (rel !== LEDGER_FILLER_HELPER) return found;
  return found.filter((v) => !(v.label === LEDGER_INSERT_LABEL && v.count === 1 && ledgerInsertIsRollbackGuarded(source)));
}

export interface AcceptanceViolation {
  readonly label: string;
  readonly count: number;
}

/** Every criterion-1 rule the source breaks, with occurrence counts, sorted by label. */
export function findAcceptanceViolations(source: string): AcceptanceViolation[] {
  const counts = new Map<string, number>();
  const add = (label: string, n = 1) => counts.set(label, (counts.get(label) ?? 0) + n);
  for (const { label, pattern } of [...RULES, ...QUEUE_RULES]) {
    const n = [...source.matchAll(pattern)].length;
    if (n > 0) add(label, n);
  }
  for (const m of source.matchAll(SET_CONFIG_CALL)) {
    if (!isAllowedSetConfig(source, m.index, m[0].length)) add(SET_CONFIG_LABEL);
  }
  for (const label of findForbiddenSwitchWrites(source)) add(`pause-switch write (${label})`);
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label));
}
