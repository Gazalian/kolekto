/**
 * itest-queue.ts — notification-queue isolation for integration files (M13.2 Phase 6A).
 *
 * The audit trigger enqueues into pgmq `notification_events`, and pgmq is as
 * global as the delivery claim: any reader sees every message. An end-to-end
 * test that COMMITS a domain action therefore leaves a real queue message that
 * a later file (or a worker) could pick up. This module keeps that contained:
 *
 *   assertQueueEmpty(sql, stage)  read-only; the queue holds no message at all —
 *                                 neither queued nor read (read_ct > 0). Used by
 *                                 the harness preflight, checkpoint and finish.
 *   findOwnQueueMessages(sql, owner, communityIds)
 *                                 read-only; the messages whose community_id is
 *                                 one of the owner's communities. Each returned
 *                                 message is an issued handle bound to `owner`.
 *   waitForOwnQueueMessage(sql, owner, communityId)
 *                                 bounded poll (no fixed sleep) for exactly one
 *                                 message of that community.
 *   archiveOwnQueueMessage(sql, owner, message)
 *                                 the ONLY queue write in the test tree. Archives
 *                                 (pgmq.archive — moves the row to
 *                                 pgmq.a_notification_events, keeping it as
 *                                 evidence; nothing is deleted) one message, and
 *                                 only when ALL of these hold:
 *                                   1. `message` is a handle this module issued for
 *                                      this same `owner` (not a hand-built object,
 *                                      not one issued for another owner);
 *                                   2. `owner.owns(communityId)` is still true at
 *                                      archive time (a harness test owner stops
 *                                      owning a community when the next test
 *                                      starts);
 *                                   3. inside one transaction, the queue row with
 *                                      that msg_id still exists and still carries
 *                                      that community_id (SELECT … FOR UPDATE), so
 *                                      the database row itself is re-checked;
 *                                   4. pgmq.archive reports true for exactly one row.
 *   recoverOwnQueueMessages(sql, owner, communityIds)
 *                                 afterEach recovery: archives, through the same
 *                                 guarded path, any message left queued for the
 *                                 owner's communities (a test that failed between
 *                                 its domain commit and its acknowledgement).
 *
 * There is no queue-wide delete, purge, pop or read, and no way to archive a
 * message by bare msg_id. The acceptance guard (itest-acceptance.ts) forbids every
 * pgmq write elsewhere in the test tree and allows exactly one pgmq.archive here,
 * after the ownership assertion in the same function.
 *
 * Lexical guards are guards against accident, not a boundary (Phase 1b §9.7).
 */

import { IntegrationGateError, refuse } from "./itest-environment.ts";
import type { ItestSql, ItestTx } from "./itest-db.ts";
import { pollBounded, PollTimeout, realClock, type PollClock } from "./itest-mutex.ts";

/** The one queue the notification trigger writes (20261009110000). */
export const NOTIFICATION_QUEUE = "notification_events";

/** Read-only: every message in the queue, and those already read by a consumer. */
export const QUEUE_STATE_SQL =
  "select count(*)::int as queued, (count(*) filter (where read_ct > 0))::int as read_messages " +
  "from pgmq.q_notification_events";

/** Read-only: the messages of `n` named communities, oldest first (one text placeholder per community, as itest-quarantine.ts does). */
export function ownQueueMessagesSql(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_QUEUE_OWNER_SCOPE) {
    throw refuse("QUEUE_OWNER_INVALID", `A queue read names 1-${MAX_QUEUE_OWNER_SCOPE} communities.`);
  }
  const placeholders = Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ");
  return (
    "select msg_id::text as msg_id, read_ct, message from pgmq.q_notification_events " +
    `where message ->> 'community_id' in (${placeholders}) order by msg_id`
  );
}

/** Locks the one queue row that still has this msg_id AND this community_id (re-check in the database). */
export const LOCK_OWN_QUEUE_MESSAGE_SQL =
  "select msg_id::text as msg_id from pgmq.q_notification_events " +
  "where msg_id = $1::bigint and message ->> 'community_id' = $2 for update";

/** Read-only evidence: the archived copy of one message. */
export const ARCHIVED_QUEUE_MESSAGE_SQL =
  "select msg_id::text as msg_id, message from pgmq.a_notification_events where msg_id = $1::bigint";

/** At most this many communities per recovery read (the harness tracks one per committed fixture). */
export const MAX_QUEUE_OWNER_SCOPE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MSG_ID = /^[1-9][0-9]{0,18}$/;

/** Who may acknowledge a message: a predicate over community ids (the harness supplies a per-test owner). */
export interface QueueOwner {
  owns(communityId: string): boolean;
}

/** A queue message this module read for a specific owner. Only these can be archived. */
export interface OwnedQueueMessage {
  readonly msgId: string;
  readonly communityId: string;
  readonly readCount: number;
  readonly message: Readonly<Record<string, unknown>>;
}

export type QueueStage = "preflight" | "checkpoint" | "finish";

export interface QueueState {
  readonly queued: number;
  readonly readMessages: number;
}

/** Handles issued by findOwnQueueMessages, mapped to the owner they were issued for. */
const issued = new WeakMap<object, QueueOwner>();

function driverTag(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` (code ${code})` : "";
}

function assertOwner(owner: unknown): asserts owner is QueueOwner {
  if (typeof owner !== "object" || owner === null || typeof (owner as { owns?: unknown }).owns !== "function") {
    throw refuse("QUEUE_OWNER_INVALID", "A queue owner must be an object with an owns(communityId) predicate.");
  }
}

function assertOwnedCommunities(owner: QueueOwner, communityIds: readonly string[]): void {
  if (!Array.isArray(communityIds) || communityIds.length > MAX_QUEUE_OWNER_SCOPE) {
    throw refuse("QUEUE_OWNER_INVALID", `A queue read names 0-${MAX_QUEUE_OWNER_SCOPE} communities.`);
  }
  for (const [i, id] of communityIds.entries()) {
    if (typeof id !== "string" || !UUID.test(id) || owner.owns(id) !== true) {
      throw refuse("QUEUE_MESSAGE_NOT_OWNED", "A queue read may only name communities the current owner created.");
    }
    if (communityIds.indexOf(id) !== i) throw refuse("QUEUE_OWNER_INVALID", "A queue read names the same community twice.");
  }
}

/** Read-only queue counts. */
export async function readQueueState(sql: ItestSql | ItestTx): Promise<QueueState> {
  let rows: readonly { queued?: unknown; read_messages?: unknown }[];
  try {
    rows = (await sql.unsafe(QUEUE_STATE_SQL)) as unknown as readonly { queued?: unknown; read_messages?: unknown }[];
  } catch (error) {
    throw refuse("PREFLIGHT_INCONCLUSIVE", `The notification queue count failed${driverTag(error)}. Details withheld.`);
  }
  if (rows.length !== 1) throw refuse("PREFLIGHT_INCONCLUSIVE", `The notification queue count returned ${rows.length} rows, expected 1.`);
  const { queued, read_messages: readMessages } = rows[0]!;
  if (typeof queued !== "number" || typeof readMessages !== "number") {
    throw refuse("PREFLIGHT_INCONCLUSIVE", "The notification queue count was not numeric.");
  }
  return { queued, readMessages };
}

const STAGE_CODE = {
  preflight: "PREFLIGHT_QUEUE_NOT_EMPTY",
  checkpoint: "ISOLATION_FOREIGN_QUEUE",
  finish: "QUEUE_RESIDUE",
} as const;

/**
 * Refuses unless pgmq notification_events holds no message at all (queued 0 and
 * read 0). Preflight: before a file starts. Checkpoint: before every test (every
 * earlier test acknowledged or recovered its own messages). Finish: after the file.
 */
export async function assertQueueEmpty(sql: ItestSql | ItestTx, stage: QueueStage): Promise<QueueState> {
  const code = STAGE_CODE[stage];
  if (code === undefined) throw refuse("QUEUE_OWNER_INVALID", "Unknown queue-check stage.");
  const state = await readQueueState(sql);
  const out: { code: typeof code | "PREFLIGHT_QUEUE_CONSUMED"; message: string }[] = [];
  if (state.queued !== 0) {
    out.push({ code, message: `${state.queued} message(s) are in the notification_events queue at ${stage}; a test could process or acknowledge a message it does not own.` });
  }
  if (state.readMessages !== 0) {
    out.push({ code: "PREFLIGHT_QUEUE_CONSUMED", message: `${state.readMessages} notification_events message(s) were read by a consumer at ${stage}: something may be consuming the test stack's queue.` });
  }
  if (out.length > 0) throw new IntegrationGateError(out);
  return state;
}

function issue(owner: QueueOwner, row: { msg_id?: unknown; read_ct?: unknown; message?: unknown }, allowed: ReadonlySet<string>): OwnedQueueMessage {
  const msgId = row.msg_id;
  const message = row.message;
  const readCount = row.read_ct;
  if (typeof msgId !== "string" || !MSG_ID.test(msgId) || typeof readCount !== "number" || typeof message !== "object" || message === null || Array.isArray(message)) {
    throw refuse("PREFLIGHT_INCONCLUSIVE", "A notification queue row was malformed.");
  }
  const communityId = (message as Record<string, unknown>)["community_id"];
  if (typeof communityId !== "string" || !allowed.has(communityId) || owner.owns(communityId) !== true) {
    throw refuse("QUEUE_MESSAGE_NOT_OWNED", "The queue returned a message for a community the current owner did not create.");
  }
  const handle: OwnedQueueMessage = Object.freeze({ msgId, communityId, readCount, message: Object.freeze({ ...(message as Record<string, unknown>) }) });
  issued.set(handle, owner);
  return handle;
}

/** Read-only: this owner's queued messages for the named communities, oldest first. */
export async function findOwnQueueMessages(sql: ItestSql | ItestTx, owner: QueueOwner, communityIds: readonly string[]): Promise<OwnedQueueMessage[]> {
  assertOwner(owner);
  assertOwnedCommunities(owner, communityIds);
  if (communityIds.length === 0) return [];
  let rows: readonly { msg_id?: unknown; read_ct?: unknown; message?: unknown }[];
  try {
    rows = (await sql.unsafe(ownQueueMessagesSql(communityIds.length), [...communityIds])) as unknown as readonly { msg_id?: unknown; read_ct?: unknown; message?: unknown }[];
  } catch (error) {
    throw refuse("PREFLIGHT_INCONCLUSIVE", `Reading the current test's queue messages failed${driverTag(error)}. Details withheld.`);
  }
  const allowed = new Set(communityIds);
  return rows.map((row) => issue(owner, row, allowed));
}

/** Bounded poll until exactly one queue message exists for `communityId`. No fixed sleep. */
export async function waitForOwnQueueMessage(
  sql: ItestSql | ItestTx,
  owner: QueueOwner,
  communityId: string,
  opts: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly clock?: PollClock } = {},
): Promise<OwnedQueueMessage> {
  assertOwner(owner);
  assertOwnedCommunities(owner, [communityId]);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const r = await pollBounded<OwnedQueueMessage>(
      { label: "own queue message", timeoutMs, intervalMs: opts.intervalMs ?? 100, clock: opts.clock ?? realClock },
      async () => {
        const found = await findOwnQueueMessages(sql, owner, [communityId]);
        if (found.length > 1) {
          throw refuse("QUEUE_MESSAGE_AMBIGUOUS", `${found.length} queue messages exist for the current test's community; expected exactly one.`);
        }
        return found.length === 1 ? { done: true, value: found[0]! } : { done: false };
      },
    );
    return r.value;
  } catch (error) {
    if (error instanceof PollTimeout) {
      throw refuse("QUEUE_MESSAGE_TIMEOUT", `No queue message for the current test's community appeared within ${timeoutMs} ms.`);
    }
    throw error;
  }
}

/** Throws unless `message` was issued by this module for this same owner, and the owner still owns its community. */
export function assertOwnedQueueMessage(owner: QueueOwner, message: OwnedQueueMessage): void {
  assertOwner(owner);
  if (typeof message !== "object" || message === null || issued.get(message) !== owner) {
    throw refuse("QUEUE_MESSAGE_NOT_OWNED", "Only a queue message read for the current owner (findOwnQueueMessages / waitForOwnQueueMessage) can be acknowledged.");
  }
  if (!MSG_ID.test(message.msgId) || owner.owns(message.communityId) !== true) {
    throw refuse("QUEUE_MESSAGE_NOT_OWNED", "The current owner no longer owns this queue message's community (it belongs to another test).");
  }
}

/**
 * Archives exactly one message the current owner owns (pgmq.archive: the row
 * moves to pgmq.a_notification_events and is kept as evidence). Refuses before
 * any query when ownership fails, and refuses (rolling back) when the database
 * row no longer matches.
 */
export async function archiveOwnQueueMessage(sql: ItestSql, owner: QueueOwner, message: OwnedQueueMessage): Promise<void> {
  assertOwnedQueueMessage(owner, message);
  await sql.begin(async (raw) => {
    const tx = raw as unknown as ItestTx;
    const locked = (await tx.unsafe(LOCK_OWN_QUEUE_MESSAGE_SQL, [message.msgId, message.communityId])) as unknown as readonly { msg_id?: unknown }[];
    if (locked.length !== 1 || locked[0]!.msg_id !== message.msgId) {
      throw refuse("QUEUE_MESSAGE_NOT_OWNED", "The queue row for this message is gone or no longer carries the current test's community; nothing was archived.");
    }
    assertOwnedQueueMessage(owner, message);
    const rows = (await tx.unsafe("select pgmq.archive('notification_events', $1::bigint) as archived", [message.msgId])) as unknown as readonly { archived?: unknown }[];
    if (rows.length !== 1 || rows[0]!.archived !== true) {
      throw refuse("QUEUE_ARCHIVE_FAILED", "pgmq.archive did not archive exactly the current test's message.");
    }
  });
}

/** Read-only evidence: the archived copy of an owned message, or null. */
export async function readArchivedQueueMessage(sql: ItestSql | ItestTx, owner: QueueOwner, message: OwnedQueueMessage): Promise<Readonly<Record<string, unknown>> | null> {
  assertOwner(owner);
  if (typeof message !== "object" || message === null || issued.get(message) !== owner) {
    throw refuse("QUEUE_MESSAGE_NOT_OWNED", "Only a queue message read for the current owner can be looked up in the archive.");
  }
  const rows = (await sql.unsafe(ARCHIVED_QUEUE_MESSAGE_SQL, [message.msgId])) as unknown as readonly { msg_id?: unknown; message?: unknown }[];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || rows[0]!.msg_id !== message.msgId || typeof rows[0]!.message !== "object" || rows[0]!.message === null) {
    throw refuse("PREFLIGHT_INCONCLUSIVE", "The archived queue row was malformed.");
  }
  return rows[0]!.message as Record<string, unknown>;
}

/**
 * afterEach recovery: archive (never delete) every message still queued for the
 * owner's communities. Returns how many were archived. Every message goes through
 * archiveOwnQueueMessage, so the same ownership checks apply.
 */
export async function recoverOwnQueueMessages(sql: ItestSql, owner: QueueOwner, communityIds: readonly string[]): Promise<number> {
  const leftovers = await findOwnQueueMessages(sql, owner, communityIds);
  for (const message of leftovers) await archiveOwnQueueMessage(sql, owner, message);
  return leftovers.length;
}
