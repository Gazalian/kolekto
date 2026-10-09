/**
 * index.ts — the worker entrypoint.
 *
 * ADR 0005: this process consumes pgmq queues over a direct Postgres
 * connection. M13.1 wires it to the notification_events queue.
 *
 * The loop: poll pgmq, process each message (resolve recipients, create
 * deliveries), delete the message, sleep if the queue was empty.
 */

import { loadDatabaseUrl } from "@kolekto/config";
import postgres from "postgres";
import { processNotificationMessage } from "./notification-processor.js";

const POLL_INTERVAL_MS = 2_000;
const VISIBILITY_TIMEOUT_S = 30;
const BATCH_SIZE = 10;

let running = true;

async function main() {
  const sql = postgres(loadDatabaseUrl(), {
    prepare: false,
    transform: { undefined: null },
  });

  console.log("Kolekto worker: connected. Polling notification_events queue.");

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    try {
      const messages = await sql<{ msg_id: string; message: Record<string, unknown> }[]>`
        select msg_id, message
        from pgmq.read('notification_events', ${VISIBILITY_TIMEOUT_S}, ${BATCH_SIZE})
      `;

      if (messages.length === 0) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      for (const msg of messages) {
        try {
          await processNotificationMessage(sql, msg.message);
          // msg_id arrives as text (pgmq.read's bigint, surfaced by the driver as
          // a string). pgmq.delete is overloaded on (text, bigint) and
          // (text, bigint[]), so an untyped argument is ambiguous (42725). The
          // explicit ::bigint cast resolves to the single-message overload.
          await sql`select pgmq.delete('notification_events', ${msg.msg_id}::bigint)`;
        } catch (err) {
          console.error(`Failed to process message ${msg.msg_id}:`, err);
        }
      }
    } catch (err) {
      console.error("Queue poll error:", err);
      await sleep(POLL_INTERVAL_MS * 5);
    }
  }

  console.log("Kolekto worker: shutting down.");
  await sql.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Worker fatal:", err);
  process.exit(1);
});
