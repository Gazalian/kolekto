/**
 * queue-disposition.ts — what the event stage does with one message it read from pgmq
 * (M13.2 Phase 8, findings F-14 and F-15).
 *
 * pgmq raises read_ct on every read, whatever the outcome of the last one, so read_ct alone
 * cannot say why a message came back. Three different failures are kept apart here:
 *
 *   Processing failed.     Nothing committed. Retried, and after MAX_READ_CT attempts the
 *                          message is poison and is dead-lettered with pgmq.archive. A failure
 *                          of the attempt rather than of the message (a lock timeout, a lost
 *                          connection) also backs off, because a lock held for a few minutes
 *                          must not use up every attempt and dead-letter healthy messages.
 *   Acknowledgement failed. Processing COMMITTED, then pgmq.delete failed. This message is not
 *                          poison. It is marked in its own headers so that later reads only
 *                          retry the delete, even after a restart. If the mark also failed,
 *                          the next read processes it again, which is idempotent.
 *   Archive failed.        Poison, and the dead-letter move itself failed.
 *
 * The last two are bounded: when attempts run out at PARK_READ_CT the message is PARKED. It
 * stays in the queue table, nothing is deleted, its visibility is moved years ahead so it is
 * not read again, and the reason is written into its headers. That is the durable outcome:
 * readable with SQL by anyone, independent of this process and its logs. An operator releases
 * it with `select pgmq.set_vt('notification_events', <msg_id>, 0)` once the cause is fixed. A
 * released message gets one more attempt and parks again if that fails.
 *
 * If parking itself keeps failing, the worker stops rather than retry for ever: at
 * ABANDON_READ_CT the disposition is "stuck" and the caller exits non-zero.
 *
 * A worker fault is a fourth case, kept apart from all three (finding R-1). Processing failed with
 * an error that says this role or schema cannot process anything: a missing privilege, table,
 * column or function. The message did nothing wrong, and retrying it at the visibility timeout
 * would dead-letter every healthy message in about 2.5 minutes. So the attempt is not counted: the
 * read is recorded in the message's own headers, and the caller exits non-zero. After a restart
 * the preflight in worker-guards.ts refuses to read at all while the privilege is missing, and
 * once the cause is fixed the message is simply read and processed. Nothing is replayed: it is the
 * same message, still in the queue, and only one worker ever holds it.
 *
 * Log lines carry ids, counts and stable codes only. The message body is never logged.
 */

import { MAX_READ_CT, shouldDeadLetter } from "./dead-letter.ts";
import type { ProcessOutcome } from "./notification-processor.js";
import { isWatchedAction } from "./notification-rules.ts";
import { isFatalDatabaseError, isTransientDatabaseError, safeErrorJson, safeErrorSummary, type EventStageCounters } from "./worker-safety.ts";

/** Three reads at the final operation, about 30 s apart: the first attempt and two retries. */
export const PARK_READ_CT = MAX_READ_CT + 3;
/** Three more reads in which parking also failed. */
export const ABANDON_READ_CT = PARK_READ_CT + 3;

/** Set when processing committed but the acknowledgement failed. */
export const PROCESSED_HEADER = "kolekto_processed_at";
/** Set when the message is parked: the reason, and when. */
export const PARKED_REASON_HEADER = "kolekto_parked_reason";
export const PARKED_AT_HEADER = "kolekto_parked_at";
/** How many of read_ct's reads were a worker fault's and so do not count against the message, and the latest cause. */
export const FAULT_READS_HEADER = "kolekto_fault_reads";
export const FAULT_CODE_HEADER = "kolekto_fault_code";
export const FAULT_AT_HEADER = "kolekto_fault_at";
/** The code on a message that was read in a batch and never attempted, because the worker stopped first. */
export const BATCH_ABANDONED_CODE = "batch_abandoned";

export type ParkReason = "ack_failed" | "archive_failed";

const BASE_RETRY_S = 30;
const MAX_RETRY_S = 480;

/**
 * The wait after a transient failure on read `readCt`: 30, 60, 120, 240, then 480 s. All five
 * attempts then span about 15 minutes, where the plain 30 s visibility timeout would use them
 * up in about 3. A lock held longer than that still dead-letters, into the archive.
 */
export function transientRetryDelaySeconds(readCt: number): number {
  const exponent = Math.max(0, Math.min(readCt - 1, 8));
  return Math.min(BASE_RETRY_S * 2 ** exponent, MAX_RETRY_S);
}

export interface QueueMessage {
  readonly msg_id: string;
  readonly read_ct: number;
  readonly message: Record<string, unknown>;
  readonly headers: Record<string, unknown> | null;
}

/** The database operations a disposition can perform. index.ts supplies the real ones. */
export interface QueueOps {
  process(message: Record<string, unknown>): Promise<ProcessOutcome>;
  acknowledge(msgId: string): Promise<void>;
  deadLetter(msgId: string): Promise<boolean>;
  delay(msgId: string, seconds: number): Promise<void>;
  markProcessed(msgId: string): Promise<void>;
  park(msgId: string, reason: ParkReason): Promise<void>;
  /** Adds one to FAULT_READS_HEADER, and records the cause. */
  recordFaultRead(msgId: string, code: string): Promise<void>;
}

export interface QueueLog {
  info(line: string): void;
  error(line: string): void;
}

export type Disposition =
  | "processed"
  | "skipped"
  | "failed"
  | "ack_failed"
  | "ack_recovered"
  | "dead_lettered"
  | "archive_failed"
  | "parked"
  /** Parking kept failing past ABANDON_READ_CT. The caller must end the process. */
  | "stuck"
  /** This role or schema cannot process anything. The caller must end the process. */
  | "worker_fault";

/** read_ct without the reads a worker fault caused. An unreadable header counts nothing, so poison handling still applies. */
export function countedReads(msg: QueueMessage): number {
  const excluded = msg.headers?.[FAULT_READS_HEADER];
  return typeof excluded === "number" && Number.isInteger(excluded) && excluded > 0 ? Math.max(msg.read_ct - excluded, 0) : msg.read_ct;
}

/** Best effort. If this fails too the privilege to write headers is gone, and the preflight stops any further read. */
async function recordFaultRead(msg: QueueMessage, code: string, ops: QueueOps, log: QueueLog): Promise<void> {
  try {
    await ops.recordFaultRead(msg.msg_id, code);
  } catch (error) {
    log.error(JSON.stringify({ msg: "notification_event_fault_record_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, error: safeErrorSummary(error) }));
  }
}

async function workerFault(msg: QueueMessage, stage: "process" | "mark", error: unknown, ops: QueueOps, counters: EventStageCounters, log: QueueLog): Promise<Disposition> {
  counters.workerFaults += 1;
  const summary = safeErrorSummary(error);
  log.error(JSON.stringify({ msg: "notification_event_worker_fault", msg_id: msg.msg_id, read_ct: msg.read_ct, stage, error: summary }));
  await recordFaultRead(msg, summary.code ?? "unknown", ops, log);
  return "worker_fault";
}

/** Messages a stopping worker read but will not attempt. Their reads must not count against them. */
export async function abandonBatch(messages: readonly QueueMessage[], ops: QueueOps, log: QueueLog): Promise<void> {
  for (const msg of messages) await recordFaultRead(msg, BATCH_ABANDONED_CODE, ops, log);
}

function outcomeLine(msg: QueueMessage, outcome: ProcessOutcome): string {
  // The action is untrusted input: only a value on the watched list is printed.
  const action = typeof msg.message["action"] === "string" && isWatchedAction(msg.message["action"]) ? msg.message["action"] : null;
  return outcome.outcome === "skipped"
    ? JSON.stringify({ msg: "notification_event_skipped", msg_id: msg.msg_id, read_ct: msg.read_ct, action, reason: outcome.reason })
    : JSON.stringify({ msg: "notification_event_processed", msg_id: msg.msg_id, read_ct: msg.read_ct, action, deliveries: outcome.deliveries, email: outcome.email });
}

async function parkIfExhausted(msg: QueueMessage, reason: ParkReason, ops: QueueOps, counters: EventStageCounters, log: QueueLog, otherwise: Disposition): Promise<Disposition> {
  if (msg.read_ct < PARK_READ_CT) return otherwise;
  try {
    await ops.park(msg.msg_id, reason);
    counters.parked += 1;
    log.error(JSON.stringify({ msg: "notification_event_parked", msg_id: msg.msg_id, read_ct: msg.read_ct, reason }));
    return "parked";
  } catch (error) {
    counters.parkFailures += 1;
    log.error(JSON.stringify({ msg: "notification_event_park_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, reason, error: safeErrorSummary(error) }));
    return msg.read_ct >= ABANDON_READ_CT ? "stuck" : otherwise;
  }
}

async function acknowledgeOnly(msg: QueueMessage, ops: QueueOps, counters: EventStageCounters, log: QueueLog): Promise<Disposition> {
  try {
    await ops.acknowledge(msg.msg_id);
  } catch (error) {
    counters.ackFailures += 1;
    log.error(JSON.stringify({ msg: "notification_event_ack_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, processing: "committed_earlier", error: safeErrorSummary(error) }));
    return parkIfExhausted(msg, "ack_failed", ops, counters, log, "ack_failed");
  }
  counters.ackRecovered += 1;
  log.info(JSON.stringify({ msg: "notification_event_ack_recovered", msg_id: msg.msg_id, read_ct: msg.read_ct }));
  return "ack_recovered";
}

async function deadLetter(msg: QueueMessage, ops: QueueOps, counters: EventStageCounters, log: QueueLog): Promise<Disposition> {
  log.error(`Dead-lettering message ${msg.msg_id}: read_ct=${msg.read_ct} exceeds threshold ${MAX_READ_CT}.`);
  try {
    const moved = await ops.deadLetter(msg.msg_id);
    // False means the row is already gone: there was nothing to move, so nothing is counted.
    if (moved) counters.deadLettered += 1;
    return "dead_lettered";
  } catch (error) {
    counters.archiveFailures += 1;
    log.error(JSON.stringify({ msg: "notification_event_archive_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, attempts_until_park: Math.max(0, PARK_READ_CT - msg.read_ct), error: safeErrorSummary(error) }));
    return parkIfExhausted(msg, "archive_failed", ops, counters, log, "archive_failed");
  }
}

export async function handleQueueMessage(msg: QueueMessage, ops: QueueOps, counters: EventStageCounters, log: QueueLog): Promise<Disposition> {
  if (typeof msg.headers?.[PROCESSED_HEADER] === "string") return acknowledgeOnly(msg, ops, counters, log);
  const counted = countedReads(msg);
  if (shouldDeadLetter(counted)) return deadLetter(counted === msg.read_ct ? msg : { ...msg, read_ct: counted }, ops, counters, log);

  let outcome: ProcessOutcome;
  try {
    outcome = await ops.process(msg.message);
  } catch (error) {
    if (isFatalDatabaseError(error)) return workerFault(msg, "process", error, ops, counters, log);
    counters.failed += 1;
    log.error(`Failed to process message ${msg.msg_id} (read_ct=${msg.read_ct}): ${safeErrorJson(error)}`);
    if (isTransientDatabaseError(error)) {
      const seconds = transientRetryDelaySeconds(msg.read_ct);
      try {
        await ops.delay(msg.msg_id, seconds);
        log.info(JSON.stringify({ msg: "notification_event_retry_delayed", msg_id: msg.msg_id, read_ct: msg.read_ct, delay_s: seconds }));
      } catch (delayError) {
        // The ordinary visibility timeout still brings the message back.
        log.error(JSON.stringify({ msg: "notification_event_delay_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, error: safeErrorSummary(delayError) }));
      }
    }
    return "failed";
  }

  // Processing has committed. From here on, a failure is an acknowledgement failure.
  try {
    await ops.acknowledge(msg.msg_id);
  } catch (error) {
    counters.ackFailures += 1;
    log.error(JSON.stringify({ msg: "notification_event_ack_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, processing: "committed", error: safeErrorSummary(error) }));
    try {
      await ops.markProcessed(msg.msg_id);
    } catch (markError) {
      // Without the mark the next read processes it again, which creates nothing new.
      log.error(JSON.stringify({ msg: "notification_event_mark_failed", msg_id: msg.msg_id, read_ct: msg.read_ct, error: safeErrorSummary(markError) }));
      // Nothing can be recorded against this message, so its reads would count until it looked like poison.
      if (isFatalDatabaseError(markError)) return workerFault(msg, "mark", markError, ops, counters, log);
    }
    return "ack_failed";
  }

  // Logged only after the acknowledgement, so a line means the message is gone.
  if (outcome.outcome === "skipped") counters.skipped += 1;
  else counters.processed += 1;
  log.info(outcomeLine(msg, outcome));
  return outcome.outcome === "skipped" ? "skipped" : "processed";
}
