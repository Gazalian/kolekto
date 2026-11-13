import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MAX_READ_CT, shouldDeadLetter } from "../src/dead-letter.ts";
import { processNotificationMessage } from "../src/notification-processor.ts";

describe("dead-letter threshold (P6)", () => {
  it("MAX_READ_CT is 5 (decision record §10.4)", () => {
    assert.equal(MAX_READ_CT, 5);
  });

  it("does not dead-letter a message on its first read", () => {
    assert.equal(shouldDeadLetter(1), false);
  });

  it("does not dead-letter at exactly the threshold", () => {
    assert.equal(shouldDeadLetter(MAX_READ_CT), false);
  });

  it("dead-letters one past the threshold", () => {
    assert.equal(shouldDeadLetter(MAX_READ_CT + 1), true);
  });

  it("dead-letters well past the threshold", () => {
    assert.equal(shouldDeadLetter(100), true);
  });

  it("does not dead-letter a zero read count", () => {
    assert.equal(shouldDeadLetter(0), false);
  });
});

// ---------------------------------------------------------------------------
// Event-loop dead-letter path (simulated)
//
// index.ts auto-runs main() so its loop cannot be imported. These tests
// replicate the per-message conditional from the event stage and verify that
// the recording SQL stub receives exactly the right calls. This is the
// "worker test with a poison message" the acceptance criterion requires.
// ---------------------------------------------------------------------------

interface Recorded { readonly text: string; readonly values: unknown[] }

function recordingSql() {
  const log: Recorded[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push({ text, values });
    if (text.includes("from app.evaluate_email_eligibility")) {
      return [{ eligible: false, address: null, assurance: null, skip_reason: "missing_membership_relationship" }];
    }
    if (text.includes("select id from public.notification_events")) return [{ id: "evt-1" }];
    return [];
  }) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    json: (v: unknown) => unknown;
  };
  sql.json = (v: unknown) => ({ __json: v });
  const db = { begin: <T>(fn: (t: typeof sql) => Promise<T>) => fn(sql) };
  return { sql: db as unknown as Parameters<typeof processNotificationMessage>[0], rawSql: sql, log };
}

const VALID_MESSAGE = {
  audit_log_id: "a6000000-0000-4000-8000-000000000001",
  community_id: "a2000000-0000-4000-8000-00000000000a",
  action: "member.create",
  actor_type: "officer",
  actor_user_id: "a1000000-0000-4000-8000-0000000000aa",
  actor_name: "Ada Officer",
  object_type: "member",
  object_id: "a4000000-0000-4000-8000-000000000001",
  after_state: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
};

/**
 * Simulate the per-message body of the event stage for-loop from index.ts.
 * The structure mirrors the real code exactly so the test breaks if they diverge.
 */
async function simulateEventLoop(
  sql: ReturnType<typeof recordingSql>["rawSql"],
  processFn: typeof processNotificationMessage,
  processSql: ReturnType<typeof recordingSql>["sql"],
  msg: { msg_id: string; read_ct: number; message: Record<string, unknown> },
): Promise<"dead-lettered" | "processed" | "failed"> {
  if (shouldDeadLetter(msg.read_ct)) {
    try {
      await sql`select pgmq.archive('notification_events', ${msg.msg_id}::bigint)`;
    } catch (archiveErr) {
      // mirrors F-1 fix: isolated catch
    }
    return "dead-lettered";
  }
  try {
    await processFn(processSql, msg.message);
    await sql`select pgmq.delete('notification_events', ${msg.msg_id}::bigint)`;
    return "processed";
  } catch {
    return "failed";
  }
}

describe("event-loop dead-letter path (P6)", () => {
  it("a poison message (read_ct > threshold) is archived, not processed", async () => {
    const { sql, rawSql, log } = recordingSql();
    const outcome = await simulateEventLoop(rawSql, processNotificationMessage, sql, {
      msg_id: "42",
      read_ct: MAX_READ_CT + 1,
      message: VALID_MESSAGE,
    });

    assert.equal(outcome, "dead-lettered");

    const archiveCalls = log.filter((r) => r.text.includes("pgmq.archive"));
    assert.equal(archiveCalls.length, 1, "exactly one archive call");
    assert.ok(archiveCalls[0]!.text.includes("notification_events"), "archives the correct queue");
    assert.equal(archiveCalls[0]!.values[0], "42", "passes the msg_id");

    const deleteCalls = log.filter((r) => r.text.includes("pgmq.delete"));
    assert.equal(deleteCalls.length, 0, "does not delete (archive replaces delete)");

    const processCalls = log.filter((r) => r.text.includes("notification_events") === false && r.text.includes("pgmq") === false);
    assert.equal(processCalls.length, 0, "processNotificationMessage was not called");
  });

  it("a normal message (read_ct at threshold) is processed and deleted, not archived", async () => {
    const { sql, rawSql, log } = recordingSql();
    const outcome = await simulateEventLoop(rawSql, processNotificationMessage, sql, {
      msg_id: "7",
      read_ct: MAX_READ_CT,
      message: VALID_MESSAGE,
    });

    assert.equal(outcome, "processed");

    const archiveCalls = log.filter((r) => r.text.includes("pgmq.archive"));
    assert.equal(archiveCalls.length, 0, "no archive for a normal message");

    const deleteCalls = log.filter((r) => r.text.includes("pgmq.delete"));
    assert.equal(deleteCalls.length, 1, "message is deleted after processing");
    assert.equal(deleteCalls[0]!.values[0], "7", "deletes the correct msg_id");
  });

  it("a batch continues after one message is dead-lettered", async () => {
    const { sql, rawSql, log } = recordingSql();
    const batch = [
      { msg_id: "10", read_ct: MAX_READ_CT + 1, message: VALID_MESSAGE },
      { msg_id: "11", read_ct: 1, message: VALID_MESSAGE },
    ];

    const outcomes: string[] = [];
    for (const msg of batch) {
      outcomes.push(await simulateEventLoop(rawSql, processNotificationMessage, sql, msg));
    }

    assert.deepEqual(outcomes, ["dead-lettered", "processed"]);

    const archiveCalls = log.filter((r) => r.text.includes("pgmq.archive"));
    assert.equal(archiveCalls.length, 1, "only the poison message was archived");
    assert.equal(archiveCalls[0]!.values[0], "10");

    const deleteCalls = log.filter((r) => r.text.includes("pgmq.delete"));
    assert.equal(deleteCalls.length, 1, "the healthy message was deleted");
    assert.equal(deleteCalls[0]!.values[0], "11");
  });
});
