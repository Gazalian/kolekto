/**
 * itest-isolation.ts — the database-side isolation harness for integration files (M13.2 Phase 4).
 *
 * Builds on the Phase 1 helpers (itest-db.ts connections, itest-fixtures.ts run
 * scopes, itest-quarantine.ts SQL, itest-mutex.ts polling) and adds only what
 * needs a live connection. No new driver import: every connection comes from
 * connectVerified(), so a file can only reach the stack its gate verified.
 *
 * What a file gets from createFileHarness(() => gate.verified(), "<label>"):
 *
 *   start()       before(): take the suite mutex (918273, 1) on a dedicated,
 *                 reserved connection (bounded pg_try_advisory_lock poll; a
 *                 reserved postgres.js connection is never idled out), then the
 *                 per-file preflight of approval checklist §7.6:
 *                   - no pending or sending email delivery anywhere in the test DB
 *                     (so the real, unscoped claim can only ever see this file's rows);
 *                   - no sender heartbeat younger than 60 s (no live worker);
 *                   - no read-but-unarchived message in pgmq notification_events
 *                     (a heuristic for a queue consumer; see the report for its limit);
 *                   - L4 headroom: at most cap − 40 transactional attempts in 24 h.
 *                   - Phase 6A: the notification_events queue holds no message at all,
 *                     queued or read (itest-queue.ts).
 *   checkpoint()  beforeEach(): the mutex is still held by this session, and no
 *                 pending or sending email row exists anywhere (every earlier test
 *                 quarantined its own rows). Phase 6A: starts a new test window for
 *                 `testOwner` and refuses unless the queue is empty.
 *   testOwner     Phase 6A: the queue owner of the CURRENT test — it owns only the
 *                 communities tracked since the last checkpoint(), so a test can
 *                 acknowledge only messages of communities it created itself.
 *   recoverOwnQueue() afterEach() (end-to-end files): archives, never deletes, any
 *                 message still queued for the current test's communities
 *                 (itest-queue.ts recoverOwnQueueMessages). Errors are recorded and
 *                 reported by checkpoint()/finish(), like quarantine errors.
 *   quarantineOwn() afterEach(): UPDATE this run's own non-terminal email rows to
 *                 dead / itest_quarantined (buildQuarantineStatement, ownership
 *                 checked by the run scope). It never throws over a test's own
 *                 failure: errors are recorded and reported by finish().
 *   finish()      after(): quarantine again, assert the scope holds no open row and
 *                 the database holds no open email row, (Phase 6A) assert the queue
 *                 holds no queued or read message, release the mutex, close.
 *
 * Rollback helpers (review §4.2 class R):
 *   inRollback(sql, fn)      runs fn inside sql.begin and always rolls back; the
 *                            handle is registered as a rollback handle while fn runs.
 *   insertLedgerFillers(tx…) the ONLY place a test writes ledger rows. It refuses any
 *                            handle that is not a live inRollback handle, so filler
 *                            rows can never commit (checklist R8). The acceptance guard
 *                            allows the ledger insert in this file only.
 *   waitForL5Headroom(sql)   polls the server clock until no transactional attempt is
 *                            younger than 1 s — real L5 pacing instead of deleting the
 *                            ledger (plan §4.4).
 *
 * Nothing here deletes a row, toggles a trigger, changes configuration or writes
 * the pause switch; the switch is only read (heartbeat column) by the preflight.
 */

import { refuse, type GateViolation, IntegrationGateError } from "./itest-environment.ts";
import { connectVerified, type ItestReservedSql, type ItestSql, type ItestTx } from "./itest-db.ts";
import type { VerifiedIntegrationEnvironment } from "./itest-gate.ts";
import { createRunScope, type RunScope } from "./itest-fixtures.ts";
import { buildQuarantineStatement, buildScopeResidueCheck, MAX_QUARANTINE_SCOPE } from "./itest-quarantine.ts";
import { assertQueueEmpty, MAX_QUEUE_OWNER_SCOPE, readQueueState, recoverOwnQueueMessages, type QueueOwner } from "./itest-queue.ts";
import {
  acquireSuiteMutex,
  checkMutexHeld,
  MUTEX_HELD_SQL,
  MUTEX_HOLDER_SQL,
  MUTEX_TRY_LOCK_SQL,
  MUTEX_UNLOCK_SQL,
  pollBounded,
  PollTimeout,
  realClock,
} from "./itest-mutex.ts";

/** Either connection kind a fixture builder can write through. */
export type Db = ItestSql | ItestTx;

// ── Rollback helpers ──────────────────────────────────────────────────────────

class RollbackSentinel extends Error {
  constructor() {
    super("itest rollback sentinel");
    this.name = "RollbackSentinel";
  }
}

/** Transaction handles currently inside an inRollback callback. */
const rollbackHandles = new WeakSet<object>();

/**
 * Runs `fn` inside one transaction that is always rolled back, and returns
 * what `fn` returned. An error thrown by `fn` is rethrown unchanged (the
 * transaction is rolled back either way). Nothing `fn` writes is ever visible
 * to another session.
 */
export async function inRollback<T>(sql: ItestSql, fn: (tx: ItestTx) => Promise<T>): Promise<T> {
  let result: { readonly value: T } | null = null;
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as ItestTx;
      rollbackHandles.add(tx);
      try {
        result = { value: await fn(tx) };
      } finally {
        rollbackHandles.delete(tx);
      }
      throw new RollbackSentinel();
    });
  } catch (error) {
    if (!(error instanceof RollbackSentinel)) throw error;
  }
  if (result === null) {
    throw refuse("ROLLBACK_HANDLE_UNISSUED", "inRollback finished without a result; the transaction did not run its callback.");
  }
  return (result as { readonly value: T }).value;
}

export function isRollbackHandle(value: unknown): boolean {
  return (typeof value === "function" || (typeof value === "object" && value !== null)) && rollbackHandles.has(value as object);
}

export function assertRollbackHandle(value: unknown): asserts value is ItestTx {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) {
    throw refuse("ROLLBACK_HANDLE_UNISSUED", "Ledger fillers need the transaction handle of a running inRollback callback.");
  }
  if (!rollbackHandles.has(value as object)) {
    throw refuse("ROLLBACK_HANDLE_UNISSUED", "Ledger fillers need the transaction handle of a running inRollback callback; they may never commit.");
  }
}

export interface LedgerFiller {
  /** The address key the ledger counts (lower-case address). */
  readonly addressKey: string;
  /** attempted_at = now() − secondsAgo (whole seconds, 0 – 172 800). */
  readonly secondsAgo: number;
}

export const MAX_LEDGER_FILLERS = 200;

/**
 * Insert transactional ledger rows inside a rolled-back transaction only
 * (checklist R8). `deliveryId` and `communityId` must be issued by `scope`.
 * Returns the number of rows written (always fillers.length, or it throws).
 */
export async function insertLedgerFillers(
  tx: ItestTx,
  scope: RunScope,
  target: { readonly deliveryId: string; readonly communityId: string },
  fillers: readonly LedgerFiller[],
): Promise<number> {
  assertRollbackHandle(tx);
  if (!scope.owns(target.deliveryId) || !scope.owns(target.communityId)) {
    throw refuse("LEDGER_FILLER_INVALID", "Ledger fillers may only name a delivery and community issued by this run's scope.");
  }
  if (!Array.isArray(fillers) || fillers.length === 0 || fillers.length > MAX_LEDGER_FILLERS) {
    throw refuse("LEDGER_FILLER_INVALID", `A filler set holds 1-${MAX_LEDGER_FILLERS} rows.`);
  }
  for (const f of fillers) {
    const okAddress = typeof f.addressKey === "string" && f.addressKey.length > 0 && f.addressKey.length <= 254 && f.addressKey === f.addressKey.toLowerCase().trim();
    const okAge = Number.isInteger(f.secondsAgo) && f.secondsAgo >= 0 && f.secondsAgo <= 172_800;
    if (!okAddress || !okAge) {
      throw refuse("LEDGER_FILLER_INVALID", "A filler needs a trimmed lower-case address key and a whole number of seconds (0-172800).");
    }
  }
  const rows = await tx<{ delivery_id: string }[]>`
    insert into public.notification_send_attempts (delivery_id, community_id, address_key, send_class, attempted_at)
    select ${target.deliveryId}::uuid, ${target.communityId}::uuid, f.address_key, 'transactional',
           now() - make_interval(secs => f.secs::int)
    from unnest(${tx.array(fillers.map((f) => f.addressKey))}::text[], ${tx.array(fillers.map((f) => String(f.secondsAgo)))}::text[])
      as f(address_key, secs)
    returning delivery_id`;
  if (rows.length !== fillers.length) {
    throw refuse("LEDGER_FILLER_INVALID", `Expected ${fillers.length} filler row(s), wrote ${rows.length}.`);
  }
  return rows.length;
}

// ── L5 pacing ─────────────────────────────────────────────────────────────────

/** Read-only: transactional attempts younger than one second, on the server clock. */
export const L5_RECENT_SQL =
  "select count(*)::int as recent from public.notification_send_attempts " +
  "where send_class = 'transactional' and attempted_at > now() - interval '1 second'";

/**
 * Waits (bounded) until the per-second transactional window is empty, so the
 * next reservation sees real L5 headroom. Never deletes ledger rows.
 */
export async function waitForL5Headroom(sql: ItestSql, timeoutMs = 5_000): Promise<number> {
  try {
    const r = await pollBounded<number>(
      { label: "L5 headroom", timeoutMs, intervalMs: 100, clock: realClock },
      async () => {
        const [row] = await sql.unsafe<{ recent: number }[]>(L5_RECENT_SQL);
        const recent = row?.recent;
        if (typeof recent !== "number") throw refuse("PREFLIGHT_INCONCLUSIVE", "The L5 window count was not a number.");
        return recent === 0 ? { done: true, value: 0 } : { done: false };
      },
    );
    return r.waitedMs;
  } catch (error) {
    if (error instanceof PollTimeout) {
      throw refuse("L5_HEADROOM_TIMEOUT", `The per-second transactional window did not empty within ${timeoutMs} ms; something else is sending.`);
    }
    throw error;
  }
}

// ── Read-only checks ──────────────────────────────────────────────────────────

/** Every email row any sender could claim or is sending, in the whole test DB. */
export const OPEN_EMAIL_ROWS_SQL =
  "select count(*)::int as open_rows from public.notification_deliveries " +
  "where channel = 'email' and status in ('pending', 'sending')";
export const HEARTBEAT_SQL =
  "select (last_heartbeat_at is not null and last_heartbeat_at > now() - interval '60 seconds') as fresh " +
  "from public.notification_sender_state";
export const QUEUE_READ_SQL = "select count(*)::int as read_messages from pgmq.q_notification_events where read_ct > 0";
export const L4_DAY_SQL =
  "select (select count(*)::int from public.notification_send_attempts " +
  "where send_class = 'transactional' and attempted_at > now() - interval '24 hours') as day_count, " +
  "(select l4_daily from app.notification_send_limits('transactional')) as day_cap";
/** Refuse a file when fewer than this many transactional reservations remain today (checklist §7.6: 140 of 180). */
export const L4_HEADROOM_RESERVE = 40;

async function one<T>(sql: Db, text: string, what: string): Promise<T> {
  let rows: readonly T[];
  try {
    rows = (await sql.unsafe(text)) as unknown as readonly T[];
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    const tag = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (code ${code})` : "";
    throw refuse("PREFLIGHT_INCONCLUSIVE", `${what} failed${tag}. Details withheld.`);
  }
  if (rows.length !== 1) throw refuse("PREFLIGHT_INCONCLUSIVE", `${what} returned ${rows.length} rows, expected 1.`);
  return rows[0]!;
}

export async function countOpenEmailRows(sql: Db): Promise<number> {
  const row = await one<{ open_rows: unknown }>(sql, OPEN_EMAIL_ROWS_SQL, "The open-delivery count");
  if (typeof row.open_rows !== "number") throw refuse("PREFLIGHT_INCONCLUSIVE", "The open-delivery count was not a number.");
  return row.open_rows;
}

/** Checklist §7.6, read-only. Collects every failed condition, then refuses once. */
export async function runPreflight(sql: ItestSql): Promise<{ readonly dayCount: number; readonly dayCap: number }> {
  const out: GateViolation[] = [];
  const open = await countOpenEmailRows(sql);
  if (open !== 0) {
    out.push({ code: "PREFLIGHT_OPEN_DELIVERIES", message: `${open} pending or sending email row(s) exist before the file starts; the unscoped claim could take them. Investigate before running.` });
  }
  const hb = await one<{ fresh: unknown }>(sql, HEARTBEAT_SQL, "The sender heartbeat read");
  if (hb.fresh !== false) {
    out.push({ code: "PREFLIGHT_LIVE_WORKER", message: "A sender heartbeat younger than 60 s exists (or the read was not a boolean): a worker may be running against the test stack." });
  }
  const q = await one<{ read_messages: unknown }>(sql, QUEUE_READ_SQL, "The notification queue read-count check");
  if (q.read_messages !== 0) {
    out.push({ code: "PREFLIGHT_QUEUE_CONSUMED", message: "The notification_events queue holds read messages: something may be consuming it on the test stack." });
  }
  // Phase 6A: no message at all — an unread leftover could be processed or acknowledged by a test that does not own it.
  const queue = await readQueueState(sql);
  if (queue.queued !== 0) {
    out.push({ code: "PREFLIGHT_QUEUE_NOT_EMPTY", message: `${queue.queued} message(s) are in the notification_events queue before the file starts. Investigate before running; do not purge the queue.` });
  }
  const l4 = await one<{ day_count: unknown; day_cap: unknown }>(sql, L4_DAY_SQL, "The L4 headroom read");
  if (typeof l4.day_count !== "number" || typeof l4.day_cap !== "number") {
    throw refuse("PREFLIGHT_INCONCLUSIVE", "The L4 headroom read was not numeric.");
  }
  if (l4.day_count > l4.day_cap - L4_HEADROOM_RESERVE) {
    out.push({ code: "PREFLIGHT_L4_HEADROOM", message: `${l4.day_count} of ${l4.day_cap} transactional attempts used in 24 h; fewer than ${L4_HEADROOM_RESERVE} remain. Do not change limits; wait or recreate the test stack (separate approval).` });
  }
  if (out.length > 0) throw new IntegrationGateError(out);
  return { dayCount: l4.day_count, dayCap: l4.day_cap };
}

// ── The per-file harness ──────────────────────────────────────────────────────

export interface FileHarness {
  readonly scope: RunScope;
  start(): Promise<void>;
  checkpoint(): Promise<void>;
  quarantineOwn(): Promise<void>;
  finish(): Promise<void>;
  /** Registers a committed community for quarantine (fixture builders do this). */
  track(communityId: string): void;
  /** Phase 6A: owns only the communities tracked since the last checkpoint() — the current test's. */
  readonly testOwner: QueueOwner;
  /** Phase 6A, afterEach: archive (never delete) messages still queued for the current test's communities. */
  recoverOwnQueue(): Promise<void>;
  /** Phase 7: throws unless this file still holds the suite mutex (the pause-switch helper asks). */
  assertMutexHeld(): Promise<void>;
}

/** Injectable for unit tests only; real files always use connectVerified. */
export interface FileHarnessDeps {
  readonly connect?: (env: VerifiedIntegrationEnvironment, opts: { readonly max: number }) => ItestSql;
}

const MUTEX_TIMEOUT_MS = 90_000;

export function createFileHarness(env: () => VerifiedIntegrationEnvironment, fileLabel: string, deps: FileHarnessDeps = {}): FileHarness {
  const connect = deps.connect ?? connectVerified;
  const scope = createRunScope(fileLabel);
  const tracked: string[] = [];
  /** Index into `tracked` where the current test's communities start (advanced by checkpoint()). */
  let testStart = 0;
  const failures: GateViolation[] = [];
  const testOwner: QueueOwner = Object.freeze({
    owns: (communityId: string): boolean => {
      const i = tracked.indexOf(communityId);
      return i >= 0 && i >= testStart && scope.owns(communityId);
    },
  });
  let lockPool: ItestSql | null = null;
  let lock: ItestReservedSql | null = null;
  let admin: ItestSql | null = null;
  let locked = false;

  const adminSql = () => {
    if (admin === null) throw refuse("NOT_VERIFIED", "The file harness has not started; call start() in before().");
    return admin;
  };

  async function quarantineOwn(): Promise<void> {
    if (admin === null || tracked.length === 0) return;
    for (let i = 0; i < tracked.length; i += MAX_QUARANTINE_SCOPE) {
      const statement = buildQuarantineStatement(scope, tracked.slice(i, i + MAX_QUARANTINE_SCOPE));
      try {
        await admin.unsafe(statement.text, [...statement.values]);
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        const tag = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (code ${code})` : "";
        failures.push({ code: "QUARANTINE_FAILED", message: `Quarantining this run's open deliveries failed${tag}.` });
      }
    }
  }

  async function recoverOwnQueue(): Promise<void> {
    if (admin === null) return;
    const current = tracked.slice(testStart);
    for (let i = 0; i < current.length; i += MAX_QUEUE_OWNER_SCOPE) {
      try {
        await recoverOwnQueueMessages(admin, testOwner, current.slice(i, i + MAX_QUEUE_OWNER_SCOPE));
      } catch (error) {
        const codes = error instanceof IntegrationGateError ? ` [${error.violations.map((v) => v.code).join(", ")}]` : "";
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        const tag = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (code ${code})` : "";
        failures.push({ code: "QUEUE_RECOVERY_FAILED", message: `Archiving the current test's leftover queue messages failed${tag}${codes}.` });
      }
    }
  }

  return {
    scope,
    testOwner,

    track(communityId) {
      if (!scope.owns(communityId)) throw refuse("QUARANTINE_INPUT_INVALID", "Only a community issued by this run's scope can be tracked.");
      if (!tracked.includes(communityId)) tracked.push(communityId);
    },

    recoverOwnQueue,

    async assertMutexHeld() {
      if (lock === null || !locked) throw refuse("MUTEX_LOST", "The suite mutex is not held; the file must stop.");
      const [row] = await lock.unsafe<{ held: unknown }[]>(MUTEX_HELD_SQL);
      checkMutexHeld(row?.held);
    },

    async start() {
      const verified = env();
      lockPool = connect(verified, { max: 1 });
      lock = await lockPool.reserve();
      const holderPool = connect(verified, { max: 1 });
      try {
        await acquireSuiteMutex({
          tryLock: async () => (await lock!.unsafe<{ locked: unknown }[]>(MUTEX_TRY_LOCK_SQL))[0]?.locked,
          describeHolder: async () => (await holderPool.unsafe<{ application_name: unknown }[]>(MUTEX_HOLDER_SQL))[0]?.application_name,
          timeoutMs: MUTEX_TIMEOUT_MS,
          intervalMs: 500,
          clock: realClock,
        });
        locked = true;
      } finally {
        await holderPool.end({ timeout: 2 }).catch(() => {});
      }
      admin = connect(verified, { max: 1 });
      await runPreflight(admin);
    },

    async checkpoint() {
      // A new test starts: from here on, testOwner owns only communities this test creates.
      testStart = tracked.length;
      if (lock === null || !locked) throw refuse("MUTEX_LOST", "The suite mutex is not held; the file must stop.");
      const [row] = await lock.unsafe<{ held: unknown }[]>(MUTEX_HELD_SQL);
      checkMutexHeld(row?.held);
      if (failures.length > 0) throw new IntegrationGateError(failures);
      const open = await countOpenEmailRows(adminSql());
      if (open !== 0) {
        throw refuse("ISOLATION_FOREIGN_ROWS", `${open} pending or sending email row(s) exist before this test; the unscoped claim could take a row this test does not own.`);
      }
      await assertQueueEmpty(adminSql(), "checkpoint");
    },

    quarantineOwn,

    async finish() {
      const out: GateViolation[] = [];
      try {
        if (admin !== null) {
          await quarantineOwn();
          out.push(...failures);
          for (let i = 0; i < tracked.length; i += MAX_QUARANTINE_SCOPE) {
            const check = buildScopeResidueCheck(scope, tracked.slice(i, i + MAX_QUARANTINE_SCOPE));
            const [row] = await admin.unsafe<{ open_rows: unknown }[]>(check.text, [...check.values]);
            if (row?.open_rows !== 0) out.push({ code: "QUARANTINE_RESIDUE", message: "This run's scope still holds pending or sending email rows after quarantine." });
          }
          const open = await countOpenEmailRows(admin);
          if (open !== 0) out.push({ code: "ISOLATION_FOREIGN_ROWS", message: `${open} pending or sending email row(s) remain in the test database after the file.` });
          try {
            await assertQueueEmpty(admin, "finish");
          } catch (error) {
            if (!(error instanceof IntegrationGateError)) throw error;
            out.push(...error.violations);
          }
        }
        if (lock !== null && locked) {
          const [row] = await lock.unsafe<{ unlocked: unknown }[]>(MUTEX_UNLOCK_SQL);
          if (row?.unlocked !== true) out.push({ code: "MUTEX_LOST", message: "The suite mutex was not held at release." });
          locked = false;
        }
      } finally {
        lock?.release();
        await admin?.end({ timeout: 2 }).catch(() => {});
        await lockPool?.end({ timeout: 2 }).catch(() => {});
        admin = null;
        lock = null;
        lockPool = null;
      }
      if (out.length > 0) throw new IntegrationGateError(out);
    },
  };
}

// ── Fixture builders (run-unique ids only) ────────────────────────────────────

export interface CommunityFixture {
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly communityId: string;
  readonly slug: string;
  readonly ownerTermId: string | null;
}

/** Owner (auth.users + public.users), community and, optionally, the owner's officer term. */
export async function createCommunityFixture(
  db: Db,
  harness: Pick<FileHarness, "scope" | "track">,
  opts: { readonly ownerName: string; readonly communityName: string; readonly ownerTerm?: boolean },
): Promise<CommunityFixture> {
  const { scope } = harness;
  const ownerId = scope.uuid();
  const communityId = scope.uuid();
  const ownerEmail = scope.address();
  const slug = scope.slug();
  harness.track(communityId);
  await db`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${ownerId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${ownerEmail}, now())`;
  // The sign-up trigger may already have created the public.users row from auth.users.
  await db`insert into public.users (id, full_name, email) values (${ownerId}, ${opts.ownerName}, ${ownerEmail})
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
  await db`insert into public.communities (id, slug, name, type, is_personal, created_by)
    values (${communityId}, ${slug}, ${opts.communityName}, 'social_group', false, ${ownerId})`;
  let ownerTermId: string | null = null;
  if (opts.ownerTerm === true) {
    ownerTermId = scope.uuid();
    await db`insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
      (${ownerTermId}, ${communityId}, ${ownerId}, 'owner', ${opts.ownerName}, 'created')`;
  }
  return { ownerId, ownerEmail, communityId, slug, ownerTermId };
}

export interface DeliveryOpts {
  /** Recipient; defaults to a fresh run-scoped address. null for skipped rows. */
  readonly address?: string | null;
  readonly assurance?: string | null;
  readonly status?: string;
  readonly attemptCount?: number;
  readonly errorCode?: string | null;
  readonly nextRetryAt?: string | null;
  /** created_at = now() − ageHours. */
  readonly ageHours?: number;
  readonly eventType?: string;
  readonly payload?: Record<string, unknown>;
}

export interface DeliveryFixture {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly address: string | null;
}

/** One notification event plus one email delivery for it (one event per delivery). */
export async function addEmailDelivery(db: Db, scope: RunScope, community: CommunityFixture, opts: DeliveryOpts = {}): Promise<DeliveryFixture> {
  const deliveryId = scope.uuid();
  const eventId = scope.uuid();
  const address = opts.address === undefined ? scope.address() : opts.address;
  const assurance = opts.assurance === undefined ? (address === null ? null : "unverified_supplied") : opts.assurance;
  const payload = (opts.payload ?? {}) as Parameters<Db["json"]>[0];
  await db`insert into public.notification_events
    (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
    values (${eventId}::uuid, ${community.communityId}::uuid, ${opts.eventType ?? "member.create"}, ${scope.eventKey()},
            'officer', ${community.ownerId}::uuid, 'member', ${deliveryId}::uuid, ${db.json(payload)})`;
  await db`insert into public.notification_deliveries
    (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance,
     attempt_count, error_code, next_retry_at, created_at, send_class)
    values (${deliveryId}::uuid, ${eventId}::uuid, ${community.communityId}::uuid, 'email',
            ${opts.status ?? "pending"}::public.notification_delivery_status, ${address}, ${assurance},
            ${opts.attemptCount ?? 0}, ${opts.errorCode ?? null}, ${opts.nextRetryAt ?? null}::timestamptz,
            now() - make_interval(hours => ${opts.ageHours ?? 0}::int), 'transactional')`;
  return { deliveryId, eventId, address };
}

export interface DeliveryRow {
  status: string;
  error_code: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  provider_message_id: string | null;
  send_lease_token: string | null;
  send_lease_expires_at: string | null;
  recipient_address: string | null;
}

export async function readDelivery(db: Db, id: string): Promise<DeliveryRow> {
  const [row] = await db<DeliveryRow[]>`
    select status::text as status, error_code, attempt_count, next_retry_at, provider_message_id,
           send_lease_token, send_lease_expires_at, recipient_address
    from public.notification_deliveries where id = ${id}::uuid`;
  if (!row) throw new Error("delivery not found");
  return row;
}
