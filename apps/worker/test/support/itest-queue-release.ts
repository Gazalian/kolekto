/**
 * itest-queue-release.ts — what an operator does to a parked message once its cause is fixed
 * (M13.2 Phase 8, finding F-15): make it visible again, so the worker gives it one more attempt.
 *
 * Refuses unless the message was read for the current test and that test still owns its community.
 * The acceptance guard allows exactly this one queue call, in this file, after the assertion below.
 */

import type { ItestSql } from "./itest-db.ts";
import { refuse } from "./itest-environment.ts";
import { assertOwnedQueueMessage, type OwnedQueueMessage, type QueueOwner } from "./itest-queue.ts";

export async function releaseParkedOwnMessage(sql: ItestSql, owner: QueueOwner, message: OwnedQueueMessage): Promise<void> {
  assertOwnedQueueMessage(owner, message);
  const rows = await sql.unsafe<{ msg_id: unknown }[]>("select msg_id::text as msg_id from pgmq.set_vt('notification_events', $1::bigint, 0)", [message.msgId]);
  if (rows.length !== 1 || rows[0]?.msg_id !== message.msgId) throw refuse("QUEUE_MESSAGE_NOT_OWNED", "The release did not affect exactly the current test's message.");
}
