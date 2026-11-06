/**
 * itest-queue-seed.ts — the one guarded queue write for shapes the trigger cannot produce
 * (M13.2 Phase 7): a poison message, a replay of an already-processed message, and messages the
 * processor must skip. Everything else reaches the queue through a real domain action and the trigger.
 *
 * Refuses unless the message names a community the current test created, so the real worker, which
 * reads the queue globally, only ever sees this test's messages. The acceptance guard allows exactly
 * this one pgmq call, in this file, after the assertion below.
 */

import type { ItestSql } from "./itest-db.ts";
import { refuse } from "./itest-environment.ts";
import type { QueueOwner } from "./itest-queue.ts";

export function assertSeedOwned(owner: QueueOwner, message: Readonly<Record<string, unknown>>): void {
  const communityId = message["community_id"];
  if (typeof communityId !== "string" || owner.owns(communityId) !== true) {
    throw refuse("QUEUE_SEED_NOT_OWNED", "A seeded queue message must name a community the current test created.");
  }
}

/** Queues one message and returns its msg_id. */
export async function seedOwnQueueMessage(sql: ItestSql, owner: QueueOwner, message: Readonly<Record<string, unknown>>): Promise<string> {
  assertSeedOwned(owner, message);
  // Typed text, then cast: a jsonb parameter would make the driver JSON-encode this string a second time.
  const rows = await sql.unsafe<{ msg_id: unknown }[]>("select pgmq.send('notification_events', $1::text::jsonb)::text as msg_id", [JSON.stringify(message)]);
  const msgId = rows[0]?.msg_id;
  if (rows.length !== 1 || typeof msgId !== "string") throw refuse("QUEUE_SEED_NOT_OWNED", "The seed did not return exactly one message id.");
  return msgId;
}
