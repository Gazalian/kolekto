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

import { createEmailProviderAsync, type EmailProvider } from "@kolekto/adapters";
import { loadConfig, loadDatabaseUrl, loadEmailConfig } from "@kolekto/config";
import postgres from "postgres";

import { processNotificationMessage } from "./notification-processor.js";
import { getSendLimits } from "./notification-rate-limit.ts";
import { runSenderTick } from "./notification-sender.ts";
import { abandonBatch, FAULT_AT_HEADER, FAULT_CODE_HEADER, FAULT_READS_HEADER, handleQueueMessage, PARKED_AT_HEADER, PARKED_REASON_HEADER, PROCESSED_HEADER, type QueueMessage, type QueueOps } from "./queue-disposition.ts";
import { checkWorkerPrivileges, enforceWorkerEnvironment, sqlPrivilegeProbe } from "./worker-guards.ts";
import {
  DB_SESSION_TIMEOUTS,
  eventHealthLogLine,
  newEventStageCounters,
  PollFailureTracker,
  safeErrorJson,
  safeErrorSummary,
  timeoutMismatches,
  waitForDatabase,
} from "./worker-safety.ts";

const POLL_INTERVAL_MS = 2_000;
const VISIBILITY_TIMEOUT_S = 30;
const BATCH_SIZE = 10;
/** Far enough ahead that a parked message is never read again unless an operator releases it (queue-disposition.ts). */
const PARK_INTERVAL = "10 years";

/** Deliveries attempted per send tick, and how often maintenance runs. */
const SENDER_BATCH = 20;
const SENDER_MAINTENANCE_MS = 60_000;

/** How often the event stage reports queue depth and its counters. */
const EVENT_HEALTH_MS = 60_000;
const DRAIN_TIMEOUT_S = 5;
const CONNECT_TIMEOUT_S = 10;

let running = true;

/**
 * Build the email provider from configuration, or return null (and run only
 * the event stage) when email is unconfigured or the startup guards refuse
 * the configuration. Never throws — a misconfigured sender must not take
 * down the event stage.
 *
 * The SES adapter needs an async startup check (GetAccount) and the
 * configured L4/L5 numbers so it can refuse to start when the provider's
 * own quotas sit at or below ours. The transactional class is the only
 * one any code path writes today (P9-3), so its numbers are what we
 * reconcile against.
 */
async function loadEmailSender(sql: postgres.Sql<Record<string, never>>): Promise<EmailProvider | null> {
  if (!process.env["EMAIL_PROVIDER"]) {
    console.log("Email sender disabled: EMAIL_PROVIDER is not set.");
    return null;
  }
  try {
    const { environment } = loadConfig();
    const config = loadEmailConfig(environment);
    let built: EmailProvider;
    if (config.provider === "ses") {
      const limits = await getSendLimits(sql, "transactional");
      const sesConfig = {
        provider: "ses" as const,
        from: config.from,
        region: config.region,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        requireProductionAccess: environment === "production",
        localL4Daily: limits.l4Daily,
        localL5PerSecond: limits.l5PerSecond,
        ...(config.sessionToken !== undefined ? { sessionToken: config.sessionToken } : {}),
        ...(config.configurationSetName !== undefined ? { configurationSetName: config.configurationSetName } : {}),
        ...(config.httpTimeoutMs !== undefined ? { httpTimeoutMs: config.httpTimeoutMs } : {}),
      };
      built = await createEmailProviderAsync(sesConfig);
    } else {
      built = await createEmailProviderAsync(config);
    }
    console.log(
      `Email sender configured: provider=${built.name}, idempotency=${built.idempotency}. ` +
        "Sending stays off until the email_sending_enabled pause switch is on.",
    );
    return built;
  } catch (err) {
    console.error("Email sender NOT started (configuration refused):", safeErrorJson(err));
    return null;
  }
}

async function main() {
  // First, before any connection, and whatever the email configuration (R-4).
  const allowed = enforceWorkerEnvironment({ env: process.env, loadConfig, loadEmailConfig, log: (line) => console.error(line) });
  if (!allowed) {
    process.exitCode = 1;
    return;
  }

  const sql = postgres(loadDatabaseUrl(), {
    prepare: false,
    transform: { undefined: null },
    connect_timeout: CONNECT_TIMEOUT_S,
    // The driver prints server notices by default, and a notice can quote row data.
    onnotice: () => {},
    // Sent as startup parameters, so every pooled connection has them from its first statement (F-14).
    connection: { ...DB_SESSION_TIMEOUTS },
  });

  // The driver connects lazily, so prove the connection before claiming one (F-7).
  let effective: Record<string, unknown> = {};
  const database = await waitForDatabase({
    probe: async () => {
      const [row] = await sql<Record<string, unknown>[]>`
        select current_setting('lock_timeout') as lock_timeout,
               current_setting('statement_timeout') as statement_timeout,
               current_setting('idle_in_transaction_session_timeout') as idle_in_transaction_session_timeout
      `;
      effective = row ?? {};
    },
    sleep,
    log: (line) => console.error(line),
  });
  if (!database.ok) {
    console.error(`Kolekto worker: database unavailable after ${database.attempts} attempt(s); exiting.`);
    process.exitCode = 1;
    await sql.end({ timeout: DRAIN_TIMEOUT_S }).catch(() => {});
    return;
  }

  // Running without its bounds would bring back F-14 silently, so this is a refusal, not a warning.
  const missingTimeouts = timeoutMismatches(effective);
  if (missingTimeouts.length > 0) {
    console.error(JSON.stringify({ msg: "worker_database_timeouts_refused", not_applied: missingTimeouts }));
    process.exitCode = 1;
    await sql.end({ timeout: DRAIN_TIMEOUT_S }).catch(() => {});
    return;
  }

  // Before the first read: pgmq raises read_ct on every read, so a role that cannot process must never read (R-1).
  const privileges = await checkWorkerPrivileges(sqlPrivilegeProbe(sql));
  if (privileges.missing.length > 0) {
    console.error(JSON.stringify({ msg: "worker_privileges_refused", missing: privileges.missing, queue_read: false }));
    process.exitCode = 1;
    await sql.end({ timeout: DRAIN_TIMEOUT_S }).catch(() => {});
    return;
  }
  if (privileges.degraded.length > 0) {
    console.error(JSON.stringify({ msg: "worker_privileges_degraded", degraded: privileges.degraded }));
  }

  console.log("Kolekto worker: connected. Polling notification_events queue.");
  console.log(JSON.stringify({ msg: "worker_database_timeouts", ...effective }));

  const queueOps: QueueOps = {
    process: (message) => processNotificationMessage(sql, message),
    // msg_id arrives as text (pgmq's bigint, surfaced by the driver as a string). pgmq.delete and
    // pgmq.archive are overloaded on (text, bigint) and (text, bigint[]), so an untyped argument
    // is ambiguous (42725). The explicit ::bigint cast resolves to the single-message overload.
    acknowledge: async (msgId) => { await sql`select pgmq.delete('notification_events', ${msgId}::bigint)`; },
    deadLetter: async (msgId) => {
      const [row] = await sql<{ archived: boolean }[]>`select pgmq.archive('notification_events', ${msgId}::bigint) as archived`;
      return row?.archived === true;
    },
    delay: async (msgId, seconds) => { await sql`select msg_id from pgmq.set_vt('notification_events', ${msgId}::bigint, ${seconds}::integer)`; },
    markProcessed: async (msgId) => {
      await sql`
        update pgmq.q_notification_events
        set headers = coalesce(headers, '{}'::jsonb) || jsonb_build_object(${PROCESSED_HEADER}::text, clock_timestamp())
        where msg_id = ${msgId}::bigint
      `;
    },
    park: async (msgId, reason) => {
      await sql`
        update pgmq.q_notification_events
        set vt = clock_timestamp() + ${PARK_INTERVAL}::interval,
            headers = coalesce(headers, '{}'::jsonb) || jsonb_build_object(${PARKED_REASON_HEADER}::text, ${reason}::text, ${PARKED_AT_HEADER}::text, clock_timestamp())
        where msg_id = ${msgId}::bigint
      `;
    },
    recordFaultRead: async (msgId, code) => {
      await sql`
        update pgmq.q_notification_events
        set headers = coalesce(headers, '{}'::jsonb) || jsonb_build_object(
          ${FAULT_READS_HEADER}::text, coalesce((headers->>${FAULT_READS_HEADER}::text)::int, 0) + 1,
          ${FAULT_CODE_HEADER}::text, ${code}::text,
          ${FAULT_AT_HEADER}::text, clock_timestamp())
        where msg_id = ${msgId}::bigint
      `;
    },
  };
  const queueLog = { info: (line: string) => console.log(line), error: (line: string) => console.error(line) };

  const provider = await loadEmailSender(sql);
  let senderHalted = false;
  let lastMaintenance = 0;
  let lastEventHealth = 0;
  let lastPaused: boolean | null = null;
  const counters = newEventStageCounters();
  const pollFailures = new PollFailureTracker();

  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    let hadMessages = false;

    // ── Event stage ────────────────────────────────────────────────────────
    try {
      const messages = await sql<QueueMessage[]>`
        select msg_id, read_ct, message, headers
        from pgmq.read('notification_events', ${VISIBILITY_TIMEOUT_S}, ${BATCH_SIZE})
      `;
      pollFailures.succeeded();
      hadMessages = messages.length > 0;

      for (const [index, msg] of messages.entries()) {
        const disposition = await handleQueueMessage(msg, queueOps, counters, queueLog);
        if (disposition === "stuck" || disposition === "worker_fault") {
          console.error(
            disposition === "stuck"
              ? `Kolekto worker: message ${msg.msg_id} can be neither moved nor parked at read_ct=${msg.read_ct}; exiting.`
              : `Kolekto worker: this role or schema cannot process messages (see notification_event_worker_fault); exiting without dead-lettering.`,
          );
          // The rest of this batch was read and will not be attempted: that is not the messages' fault either.
          await abandonBatch(messages.slice(index + 1), queueOps, queueLog);
          process.exitCode = 1;
          running = false;
          break;
        }
      }
    } catch (err) {
      counters.pollFailures += 1;
      console.error("Queue poll error:", safeErrorJson(err));
      if (pollFailures.failed(err) === "exit") {
        console.error(`Kolekto worker: giving up after ${pollFailures.consecutive} consecutive queue poll failure(s); exiting.`);
        process.exitCode = 1;
        break;
      }
      await sleep(POLL_INTERVAL_MS * 5);
    }

    if (Date.now() - lastEventHealth >= EVENT_HEALTH_MS) {
      lastEventHealth = Date.now();
      try {
        const [queue] = await sql<{ depth: number; max_read_ct: number; oldest_age_s: number; parked: number }[]>`
          select count(*)::int as depth,
                 coalesce(max(read_ct), 0)::int as max_read_ct,
                 coalesce(extract(epoch from now() - min(enqueued_at)), 0)::int as oldest_age_s,
                 (count(*) filter (where headers ? ${PARKED_REASON_HEADER}::text and vt > now()))::int as parked
          from pgmq.q_notification_events
        `;
        console.log(JSON.stringify(eventHealthLogLine(counters, queue ? { depth: queue.depth, maxReadCt: queue.max_read_ct, oldestAgeS: queue.oldest_age_s, parked: queue.parked } : null)));
      } catch (err) {
        console.log(JSON.stringify({ ...eventHealthLogLine(counters, null), error: safeErrorSummary(err) }));
      }
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

        // The pause switch as this process last read it: one line at start and one on
        // every change, so a log shows when sending opened and closed (F-3).
        if (result.paused !== lastPaused) {
          console.log(JSON.stringify({ msg: "notification_sender_pause_state", email_sending_enabled: !result.paused, first_reading: lastPaused === null }));
          lastPaused = result.paused;
        }

        if (result.halted && !senderHalted) {
          senderHalted = true;
          console.error(
            "Email sender HALTED: adapter misconfigured. Maintenance continues; no further sends this process.",
          );
        }
      } catch (err) {
        console.error("Sender tick error:", safeErrorJson(err));
      }
    }

    if (!hadMessages) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.log("Kolekto worker: shutting down.");
  await sql.end({ timeout: DRAIN_TIMEOUT_S });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Worker fatal:", safeErrorJson(err));
  process.exit(1);
});
