/**
 * index.ts — the worker entrypoint.
 *
 * ADR 0005: this process consumes pgmq queues over a direct Postgres
 * connection. M13.1 wired it to the notification_events queue; M13.2 P5 adds
 * the email send stage.
 *
 * Two stages run in the one loop (decision record §10.1):
 *   1. Event stage (queue): poll pgmq, process each message (resolve
 *      recipients, create delivery rows), delete the message.
 *   2. Send stage (table-driven): claim due `pending` email deliveries, call
 *      the provider, record the outcome, and run periodic maintenance
 *      (lease recovery, 72-hour expiry, ledger purge, a health log line).
 *
 * The send stage runs only when EMAIL_PROVIDER is configured AND the database
 * pause switch (email_sending_enabled) is on. The switch is off by default in
 * every environment, so a worker that is merely started sends nothing.
 */

import { createEmailProvider, type EmailProvider } from "@kolekto/adapters";
import { loadConfig, loadDatabaseUrl, loadEmailConfig } from "@kolekto/config";
import postgres from "postgres";

import { processNotificationMessage } from "./notification-processor.js";
import { runSenderTick } from "./notification-sender.ts";

const POLL_INTERVAL_MS = 2_000;
const VISIBILITY_TIMEOUT_S = 30;
const BATCH_SIZE = 10;

/** Deliveries attempted per send tick, and how often maintenance runs. */
const SENDER_BATCH = 20;
const SENDER_MAINTENANCE_MS = 60_000;

let running = true;

/**
 * Build the email provider from configuration, or return null (and run only
 * the event stage) when email is unconfigured or the startup guards refuse the
 * configuration. Never throws — a misconfigured sender must not take down the
 * event stage.
 */
function loadEmailSender(): EmailProvider | null {
  if (!process.env["EMAIL_PROVIDER"]) {
    console.log("Email sender disabled: EMAIL_PROVIDER is not set.");
    return null;
  }
  try {
    const { environment } = loadConfig();
    const provider = createEmailProvider(loadEmailConfig(environment));
    console.log(
      `Email sender configured: provider=${provider.name}, idempotency=${provider.idempotency}. ` +
        "Sending stays off until the email_sending_enabled pause switch is on.",
    );
    return provider;
  } catch (err) {
    console.error("Email sender NOT started (configuration refused):", err instanceof Error ? err.message : err);
    return null;
  }
}

async function main() {
  const sql = postgres(loadDatabaseUrl(), {
    prepare: false,
    transform: { undefined: null },
  });

  console.log("Kolekto worker: connected. Polling notification_events queue.");

  const provider = loadEmailSender();
  let senderHalted = false;
  let lastMaintenance = 0;

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    let hadMessages = false;

    // ── Event stage ────────────────────────────────────────────────────────
    try {
      const messages = await sql<{ msg_id: string; message: Record<string, unknown> }[]>`
        select msg_id, message
        from pgmq.read('notification_events', ${VISIBILITY_TIMEOUT_S}, ${BATCH_SIZE})
      `;
      hadMessages = messages.length > 0;

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

    // ── Send stage ───────────────────────────────────────────────────────────
    if (provider) {
      try {
        const nowMs = Date.now();
        const runMaintenance = nowMs - lastMaintenance >= SENDER_MAINTENANCE_MS;
        if (runMaintenance) lastMaintenance = nowMs;

        const result = await runSenderTick(sql, {
          provider,
          now: () => Date.now(),
          rng: Math.random,
          maxBatch: SENDER_BATCH,
          runMaintenance,
          allowSend: !senderHalted,
          log: (line) => console.log(JSON.stringify(line)),
          shouldContinue: () => running,
        });

        if (result.halted && !senderHalted) {
          senderHalted = true;
          console.error(
            "Email sender HALTED: adapter misconfigured. Maintenance continues; no further sends this process.",
          );
        }
      } catch (err) {
        console.error("Sender tick error:", err);
      }
    }

    if (!hadMessages) {
      await sleep(POLL_INTERVAL_MS);
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
