/**
 * worker-safety.ts — what the worker may log about a failure, and when a database
 * failure must end the process (M13.2 Phase 7, findings F-2, F-5, F-6, F-7).
 *
 * ── WHY ERRORS ARE NEVER LOGGED RAW ─────────────────────────────────────────
 * postgres.js copies every server field onto the error object, and Node prints
 * every enumerable property of an error. A constraint failure's `detail` is
 * "Failing row contains (…)", which can hold a recipient address; `message` can
 * hold a rejected value ("invalid input value for enum …"); `query` and
 * `parameters` hold the statement and its bound values; a URL parse error's
 * `input` holds the whole connection string. So the summary below is built from
 * an allow-list of fields, never by deleting known-bad ones.
 *
 * A server error keeps its SQLSTATE, severity and object names only. Any other
 * error keeps its name, its code and a scrubbed, length-limited message, because
 * those messages are written by this codebase or by Node and are how an operator
 * tells a configuration refusal from a network failure.
 *
 * ── WHY SOME DATABASE FAILURES END THE PROCESS ──────────────────────────────
 * A worker pointed at the wrong database, or holding a revoked credential, used
 * to poll forever with exit code never set, so a supervisor's crash-loop policy
 * could never fire. Startup now proves the connection before claiming to be
 * connected; a failure that retrying cannot fix exits at once, and a failure that
 * might be transient exits after a bounded number of consecutive attempts.
 */

export interface SafeError {
  readonly name: string;
  readonly code?: string;
  readonly severity?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  /** Scrubbed. Present only for errors that did not come from the database server. */
  readonly message?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const CLIENT_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const SEVERITY = /^[A-Z]{1,10}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_MESSAGE_LENGTH = 200;

function text(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** Removes anything shaped like a credential, address, phone number or token from free text. */
export function scrubText(value: string): string {
  const scrubbed = value
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+/g, "[address]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[token]");
  return scrubbed.length > MAX_MESSAGE_LENGTH ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…` : scrubbed;
}

/** True for an error the database server sent, whose message may quote row data. */
function isServerError(error: Record<string, unknown>): boolean {
  return error["name"] === "PostgresError" || "severity_local" in error || text(error["code"], SQLSTATE) !== undefined;
}

/** The only representation of an error that may reach a log line. */
export function safeErrorSummary(error: unknown): SafeError {
  if (typeof error !== "object" || error === null) {
    return { name: "NonError", message: typeof error === "string" ? scrubText(error) : typeof error };
  }
  const e = error as Record<string, unknown>;
  const name = text(e["name"], ERROR_NAME) ?? "Error";
  if (isServerError(e)) {
    const code = text(e["code"], SQLSTATE);
    const severity = text(e["severity"], SEVERITY);
    const constraint = text(e["constraint_name"], IDENTIFIER);
    const table = text(e["table_name"], IDENTIFIER);
    const column = text(e["column_name"], IDENTIFIER);
    return {
      name,
      ...(code === undefined ? {} : { code }),
      ...(severity === undefined ? {} : { severity }),
      ...(constraint === undefined ? {} : { constraint }),
      ...(table === undefined ? {} : { table }),
      ...(column === undefined ? {} : { column }),
    };
  }
  const code = text(e["code"], CLIENT_CODE);
  const message = typeof e["message"] === "string" && e["message"] !== "" ? scrubText(e["message"]) : undefined;
  return {
    name,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

/** A one-line JSON form of safeErrorSummary, for a log line. */
export function safeErrorJson(error: unknown): string {
  return JSON.stringify(safeErrorSummary(error));
}

/**
 * SQLSTATEs and client codes that retrying cannot fix: wrong password or role,
 * wrong database, missing privilege, missing schema object, unresolvable host,
 * unusable URL. Each one means the process is pointed at the wrong target or holds
 * the wrong credential, and must stop rather than poll.
 */
const FATAL_CODES: ReadonlySet<string> = new Set([
  "28000", // invalid_authorization_specification
  "28P01", // invalid_password
  "3D000", // invalid_catalog_name
  "3F000", // invalid_schema_name
  "42501", // insufficient_privilege
  "42P01", // undefined_table
  "42883", // undefined_function
  "42703", // undefined_column: a migration has not reached this environment
  "42704", // undefined_object: likewise
  "ENOTFOUND",
  "ERR_INVALID_URL",
]);

export function isFatalDatabaseError(error: unknown): boolean {
  const { code } = safeErrorSummary(error);
  return code !== undefined && FATAL_CODES.has(code);
}

/**
 * The bounds on every database session the worker opens (finding F-14). Without them a
 * single held lock stalled the whole loop indefinitely, with nothing logged.
 *
 * Measured on the test stack over about 8,000 worker statements (Phase 8 evidence,
 * worker-statement-timings.txt): every statement that was not deliberately blocked
 * finished in under 1 s, and almost all in under 20 ms.
 *
 * - lock_timeout 5 s: five times the slowest unblocked statement seen. A wait this long
 *   means another session is holding something, not that the database is busy. The
 *   statement fails with 55P03 and the transaction rolls back.
 * - statement_timeout 15 s: for work that is slow without waiting on a lock. It is longer
 *   than lock_timeout so that a lock wait always reports as 55P03, not as 57014.
 * - idle_in_transaction_session_timeout 30 s: no worker transaction waits on anything but
 *   the database (provider calls run outside transactions), so an idle one is a client
 *   that has died or hung. Equal to the queue's visibility timeout.
 */
export const DB_SESSION_TIMEOUTS = Object.freeze({
  lock_timeout: 5_000,
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
});

/** The same bounds as the server reports them through current_setting(). */
const DB_SESSION_TIMEOUT_TEXT: Readonly<Record<keyof typeof DB_SESSION_TIMEOUTS, string>> = Object.freeze({
  lock_timeout: "5s",
  statement_timeout: "15s",
  idle_in_transaction_session_timeout: "30s",
});

/**
 * The names of any session timeout the server is not actually applying. A transaction-mode
 * pooler can drop startup parameters silently, and the worker would then run unbounded.
 */
export function timeoutMismatches(effective: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(DB_SESSION_TIMEOUT_TEXT).filter(([name, value]) => effective[name] !== value).map(([name]) => name);
}

/**
 * A failure of this attempt rather than of the message: another session held a lock, the
 * statement ran out of time, the transaction lost a conflict, or the connection went away.
 * Retrying later can succeed, so these must not use up a message's attempts quickly.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "25P03", // idle_in_transaction_session_timeout
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "CONNECTION_ENDED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

export function isTransientDatabaseError(error: unknown): boolean {
  const { code } = safeErrorSummary(error);
  return code !== undefined && (TRANSIENT_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code));
}

export const STARTUP_ATTEMPTS = 5;
export const STARTUP_RETRY_MS = 2_000;
/** One startup probe. Longer than connect_timeout, so a refused connection reports as itself. */
export const STARTUP_PROBE_TIMEOUT_MS = 15_000;

export type StartupResult = { readonly ok: true } | { readonly ok: false; readonly attempts: number; readonly fatal: boolean };

/** Rejects if `work` has not settled in time. The server-side timeouts cannot bound a connection that has stopped answering. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`No answer within ${ms} ms.`), { code: "STARTUP_PROBE_TIMEOUT" }));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Proves the database answers before the worker says it is connected. Stops at
 * once on a fatal failure, and after STARTUP_ATTEMPTS on any other.
 */
export async function waitForDatabase(deps: {
  readonly probe: () => Promise<unknown>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly attempts?: number;
  readonly retryMs?: number;
  readonly probeTimeoutMs?: number;
}): Promise<StartupResult> {
  const attempts = deps.attempts ?? STARTUP_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withDeadline(deps.probe(), deps.probeTimeoutMs ?? STARTUP_PROBE_TIMEOUT_MS);
      return { ok: true };
    } catch (error) {
      const fatal = isFatalDatabaseError(error);
      deps.log(JSON.stringify({ msg: "worker_database_unavailable", attempt, of: attempts, fatal, error: safeErrorSummary(error) }));
      if (fatal) return { ok: false, attempts: attempt, fatal: true };
      if (attempt < attempts) await deps.sleep(deps.retryMs ?? STARTUP_RETRY_MS);
    }
  }
  return { ok: false, attempts, fatal: false };
}

/** At 10 s between failed polls this is about five minutes of uninterrupted failure. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 30;

/** Decides whether a queue poll failure ends the process. Any successful poll resets the count. */
export class PollFailureTracker {
  #consecutive = 0;
  readonly #limit: number;

  constructor(limit: number = MAX_CONSECUTIVE_POLL_FAILURES) {
    this.#limit = limit;
  }

  get consecutive(): number {
    return this.#consecutive;
  }

  succeeded(): void {
    this.#consecutive = 0;
  }

  failed(error: unknown): "continue" | "exit" {
    this.#consecutive += 1;
    return isFatalDatabaseError(error) || this.#consecutive >= this.#limit ? "exit" : "continue";
  }
}

/** Event-stage counters since the process started. Counts only, safe to log. */
export interface EventStageCounters {
  processed: number;
  skipped: number;
  /** Processing itself failed. An acknowledgement or archive failure is counted separately (F-15). */
  failed: number;
  deadLettered: number;
  pollFailures: number;
  /** Processing committed but pgmq.delete failed. */
  ackFailures: number;
  /** A later read completed an acknowledgement that had failed. */
  ackRecovered: number;
  /** The dead-letter pgmq.archive failed. */
  archiveFailures: number;
  /** Messages this process moved out of circulation after bounded attempts. */
  parked: number;
  parkFailures: number;
  /** Failures that say this role or schema cannot process anything. The process stops on the first (R-1). */
  workerFaults: number;
}

export function newEventStageCounters(): EventStageCounters {
  return { processed: 0, skipped: 0, failed: 0, deadLettered: 0, pollFailures: 0, ackFailures: 0, ackRecovered: 0, archiveFailures: 0, parked: 0, parkFailures: 0, workerFaults: 0 };
}

/** The once-a-minute event-stage health line (F-5). The send-stage health line covers only the send stage. */
export function eventHealthLogLine(
  counters: EventStageCounters,
  queue: { readonly depth: number; readonly maxReadCt: number; readonly oldestAgeS: number; readonly parked: number } | null,
): Record<string, unknown> {
  return {
    msg: "notification_event_health",
    queue_depth: queue?.depth ?? null,
    queue_max_read_ct: queue?.maxReadCt ?? null,
    queue_oldest_age_s: queue?.oldestAgeS ?? null,
    queue_parked: queue?.parked ?? null,
    processed_total: counters.processed,
    skipped_total: counters.skipped,
    failed_total: counters.failed,
    dead_lettered_total: counters.deadLettered,
    poll_failures_total: counters.pollFailures,
    ack_failures_total: counters.ackFailures,
    ack_recovered_total: counters.ackRecovered,
    archive_failures_total: counters.archiveFailures,
    parked_total: counters.parked,
    park_failures_total: counters.parkFailures,
    worker_faults_total: counters.workerFaults,
  };
}
