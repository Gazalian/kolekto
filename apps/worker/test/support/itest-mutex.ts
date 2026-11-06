/**
 * itest-mutex.ts — bounded polling and the integration-suite mutex logic (M13.2 Phase 1c).
 *
 * Pure: no database, no driver import, no real timers unless the caller passes
 * them. Implements checklist R9 / review §5.1: the suite mutex is the
 * session-level advisory lock (918273, 1), acquired with `pg_try_advisory_lock`
 * in a bounded poll — never the blocking `pg_advisory_lock` — on a dedicated,
 * long-lived connection (Phase 4–5 wires that connection; it is not created here).
 * Key (918273, 1) does not collide with the only advisory keys in the
 * migrations, whose first int is 1–5 (reserve_email_attempt, review F4).
 *
 * pollBounded() guarantees:
 *   - an explicit timeout (1 ms – 120 s) and polling interval (10 ms – 10 s,
 *     never longer than the timeout); invalid options are refused up front;
 *   - termination: at most floor(timeout / interval) + 2 attempts, even if the
 *     injected clock never advances; a clock that runs backwards or returns a
 *     non-finite value is a refusal, not an infinite loop;
 *   - no sleep longer than the interval or the time remaining;
 *   - an attempt that throws stops the poll at once (POLL_FAILED, SQLSTATE or
 *     errno only): unexpected errors are never retried or swallowed;
 *   - a timeout is a refusal with the label and the waited time.
 */

import { IntegrationGateError, refuse, type GateViolationCode } from "./itest-environment.ts";

export const ITEST_MUTEX_KEY = Object.freeze({ classId: 918273, objId: 1 });

/** Run on the dedicated lock connection only. All four are constant statements. */
export const MUTEX_TRY_LOCK_SQL = "select pg_try_advisory_lock(918273, 1) as locked";
export const MUTEX_UNLOCK_SQL = "select pg_advisory_unlock(918273, 1) as unlocked";
/** Who holds it (for the timeout message). A two-int advisory lock is classid = key1, objid = key2, objsubid = 2. */
export const MUTEX_HOLDER_SQL =
  "select a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid " +
  "where l.locktype = 'advisory' and l.classid = 918273 and l.objid = 1 and l.objsubid = 2 and l.granted";
/** Loss detection at test boundaries: does THIS session still hold it? */
export const MUTEX_HELD_SQL =
  "select count(*)::int as held from pg_locks " +
  "where locktype = 'advisory' and classid = 918273 and objid = 1 and objsubid = 2 and granted and pid = pg_backend_pid()";

export const POLL_LIMITS = Object.freeze({ minTimeoutMs: 1, maxTimeoutMs: 120_000, minIntervalMs: 10, maxIntervalMs: 10_000 });

export interface PollClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: PollClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface PollOptions {
  /** Shown in refusals; fixed text, never a value. */
  readonly label: string;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly clock: PollClock;
}

export type PollAttempt<T> = { readonly done: true; readonly value: T } | { readonly done: false };

export interface PollResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly waitedMs: number;
}

/** Thrown by pollBounded on timeout; carries how long it waited so callers can enrich the message. */
export class PollTimeout extends Error {
  readonly attempts: number;
  readonly waitedMs: number;

  constructor(attempts: number, waitedMs: number) {
    super("poll timed out");
    this.name = "PollTimeout";
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

function safeErrorTag(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z]{2,20})$/.test(code) ? ` (code ${code})` : "";
}

function checkOptions(o: PollOptions): void {
  const ok =
    typeof o.label === "string" && /^[A-Za-z0-9 _.:()-]{1,80}$/.test(o.label) &&
    Number.isInteger(o.timeoutMs) && o.timeoutMs >= POLL_LIMITS.minTimeoutMs && o.timeoutMs <= POLL_LIMITS.maxTimeoutMs &&
    Number.isInteger(o.intervalMs) && o.intervalMs >= POLL_LIMITS.minIntervalMs && o.intervalMs <= POLL_LIMITS.maxIntervalMs &&
    o.intervalMs <= o.timeoutMs &&
    typeof o.clock?.now === "function" && typeof o.clock?.sleep === "function";
  if (!ok) {
    throw refuse(
      "POLL_OPTIONS_INVALID",
      `Polling needs a plain label, a timeout of ${POLL_LIMITS.minTimeoutMs}-${POLL_LIMITS.maxTimeoutMs} ms, an interval of ${POLL_LIMITS.minIntervalMs}-${POLL_LIMITS.maxIntervalMs} ms no longer than the timeout, and a clock.`,
    );
  }
}

function readClock(clock: PollClock, label: string, previous: number | null): number {
  const t = clock.now();
  if (!Number.isFinite(t) || (previous !== null && t < previous)) {
    throw refuse("POLL_INCONCLUSIVE", `${label}: the clock returned a non-finite or decreasing time.`);
  }
  return t;
}

/**
 * Calls `attempt` until it reports done, the timeout passes, or it throws.
 * Throws PollTimeout on timeout (callers turn it into their own refusal) and
 * an IntegrationGateError for invalid options, a broken clock or a failed attempt.
 */
export async function pollBounded<T>(options: PollOptions, attempt: () => Promise<PollAttempt<T>>, failCode: GateViolationCode = "POLL_FAILED"): Promise<PollResult<T>> {
  checkOptions(options);
  const { label, timeoutMs, intervalMs, clock } = options;
  const maxAttempts = Math.floor(timeoutMs / intervalMs) + 2;
  const start = readClock(clock, label, null);
  let last = start;
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    let result: PollAttempt<T>;
    try {
      result = await attempt();
    } catch (error) {
      if (error instanceof PollTimeout || error instanceof IntegrationGateError) throw error;
      throw refuse(failCode, `${label}: an attempt failed${safeErrorTag(error)}. Details withheld; unexpected errors are not retried.`);
    }
    if (typeof result !== "object" || result === null || typeof result.done !== "boolean") {
      throw refuse("POLL_INCONCLUSIVE", `${label}: an attempt returned an unexpected shape.`);
    }
    last = readClock(clock, label, last);
    if (result.done) return { value: result.value, attempts, waitedMs: last - start };
    const remaining = timeoutMs - (last - start);
    if (remaining <= 0 || attempts === maxAttempts) throw new PollTimeout(attempts, last - start);
    await clock.sleep(Math.min(intervalMs, remaining));
  }
  /* c8 ignore next */
  throw new PollTimeout(maxAttempts, last - start);
}

// ── The suite mutex ───────────────────────────────────────────────────────────

export interface MutexOptions {
  /** Runs MUTEX_TRY_LOCK_SQL on the dedicated lock connection; must resolve to exactly true or false. */
  readonly tryLock: () => Promise<unknown>;
  /** Optional: runs MUTEX_HOLDER_SQL; used only to name the holder in a timeout. */
  readonly describeHolder?: () => Promise<unknown>;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly clock: PollClock;
}

const SAFE_APPLICATION_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

async function holderName(describe: MutexOptions["describeHolder"]): Promise<string> {
  if (describe === undefined) return "unknown";
  try {
    const name = await describe();
    return typeof name === "string" && SAFE_APPLICATION_NAME.test(name) ? name : "unknown";
  } catch {
    return "unknown"; // a failed holder lookup must not mask the timeout itself
  }
}

/** Acquire (918273, 1) within the timeout, or refuse. Never blocks without a bound. */
export async function acquireSuiteMutex(o: MutexOptions): Promise<PollResult<true>> {
  try {
    return await pollBounded<true>(
      { label: "Suite mutex", timeoutMs: o.timeoutMs, intervalMs: o.intervalMs, clock: o.clock },
      async () => {
        const locked = await o.tryLock();
        if (locked === true) return { done: true, value: true };
        if (locked === false) return { done: false };
        throw refuse("MUTEX_INCONCLUSIVE", "pg_try_advisory_lock did not return a boolean; the mutex state is unknown.");
      },
      "MUTEX_FAILED",
    );
  } catch (error) {
    if (!(error instanceof PollTimeout)) throw error;
    throw refuse(
      "MUTEX_TIMEOUT",
      `The integration-suite mutex (918273, 1) was not acquired within ${o.timeoutMs} ms (${error.attempts} attempt(s)); held by application_name ${await holderName(o.describeHolder)}. Another run is active or a stale session holds it.`,
    );
  }
}

/** Loss detection: the MUTEX_HELD_SQL count for this session must be exactly 1. */
export function checkMutexHeld(held: unknown): void {
  if (held === 1) return;
  if (held === 0) throw refuse("MUTEX_LOST", "This session no longer holds the integration-suite mutex (connection recycled or lock released); the file must stop.");
  throw refuse("MUTEX_INCONCLUSIVE", "The mutex ownership check did not return 0 or 1.");
}
