/**
 * queue-disposition.test.ts — M13.2 Phase 8, F-14 and F-15. Pure; no database.
 *
 * Every branch of what the event stage does with a message. The same behaviours are run against
 * the real worker in test/integration/notification-worker-reliability.integration.test.ts; the
 * branch only reachable here is a park that itself keeps failing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MAX_READ_CT } from "../src/dead-letter.ts";
import { abandonBatch, ABANDON_READ_CT, BATCH_ABANDONED_CODE, countedReads, FAULT_READS_HEADER, handleQueueMessage, PARK_READ_CT, PROCESSED_HEADER, transientRetryDelaySeconds, type ParkReason, type QueueMessage, type QueueOps } from "../src/queue-disposition.ts";
import { newEventStageCounters } from "../src/worker-safety.ts";

const serverError = (code: string, message = "boom") => Object.assign(new Error(message), { name: "PostgresError", code, severity: "ERROR", severity_local: "ERROR" });

interface Rig {
  readonly ops: QueueOps;
  readonly calls: string[];
  readonly parked: ParkReason[];
  readonly delays: number[];
}

function rig(overrides: Partial<QueueOps> = {}): Rig {
  const calls: string[] = [];
  const parked: ParkReason[] = [];
  const delays: number[] = [];
  const ops: QueueOps = {
    process: async () => { calls.push("process"); return { outcome: "processed", deliveries: 1, email: { kind: "pending" } }; },
    acknowledge: async () => { calls.push("acknowledge"); },
    deadLetter: async () => { calls.push("deadLetter"); return true; },
    delay: async (_, seconds) => { calls.push("delay"); delays.push(seconds); },
    markProcessed: async () => { calls.push("markProcessed"); },
    park: async (_, reason) => { calls.push("park"); parked.push(reason); },
    recordFaultRead: async () => { calls.push("recordFaultRead"); },
  };
  for (const [name, fn] of Object.entries(overrides)) {
    (ops as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      calls.push(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { ops, calls, parked, delays };
}

function message(readCt: number, headers: Record<string, unknown> | null = null): QueueMessage {
  return { msg_id: "7", read_ct: readCt, message: { action: "member.create" }, headers };
}

function logs() {
  const lines: string[] = [];
  return { lines, log: { info: (l: string) => lines.push(l), error: (l: string) => lines.push(l) } };
}

const fail = (error: unknown) => () => { throw error; };

describe("the three failures stay apart", () => {
  it("success: processed, then acknowledged, then logged", async () => {
    const r = rig();
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(1), r.ops, counters, log), "processed");
    assert.deepEqual(r.calls, ["process", "acknowledge"]);
    assert.equal(counters.processed, 1);
    assert.match(lines[0]!, /notification_event_processed/);
  });

  it("a processing failure that is the message's own fault waits the ordinary timeout and counts as failed", async () => {
    const r = rig({ process: fail(serverError("22P02")) });
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(2), r.ops, counters, log), "failed");
    assert.deepEqual(r.calls, ["process"], "no acknowledgement, no delay");
    assert.equal(counters.failed, 1);
    assert.match(lines[0]!, /^Failed to process message 7 \(read_ct=2\): \{"name":"PostgresError","code":"22P02","severity":"ERROR"\}$/);
  });

  it("a lock timeout during processing backs off, so a held lock does not use up the attempts", async () => {
    const r = rig({ process: fail(serverError("55P03")) });
    const { lines, log } = logs();
    assert.equal(await handleQueueMessage(message(2), r.ops, newEventStageCounters(), log), "failed");
    assert.deepEqual(r.delays, [60]);
    assert.ok(lines.some((l) => l.includes("notification_event_retry_delayed")));
  });

  it("a failed delay is logged and changes nothing else: the visibility timeout still brings the message back", async () => {
    const r = rig({ process: fail(serverError("55P03")), delay: fail(serverError("57014")) });
    const { lines, log } = logs();
    assert.equal(await handleQueueMessage(message(1), r.ops, newEventStageCounters(), log), "failed");
    assert.ok(lines.some((l) => l.includes("notification_event_delay_failed")));
  });

  it("an acknowledgement failure after processing is not a processing failure, and marks the message", async () => {
    const r = rig({ acknowledge: fail(serverError("55P03")) });
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(1), r.ops, counters, log), "ack_failed");
    assert.deepEqual(r.calls, ["process", "acknowledge", "markProcessed"]);
    assert.equal(counters.failed, 0, "not counted as a processing failure");
    assert.equal(counters.processed, 0, "a processed line means the message is gone");
    assert.equal(counters.ackFailures, 1);
    assert.ok(!lines.some((l) => l.includes("Failed to process")));
    assert.ok(lines.some((l) => l.includes("notification_event_ack_failed")));
  });

  it("if the mark fails too it is only logged: the next read processes again, which is idempotent", async () => {
    const r = rig({ acknowledge: fail(serverError("55P03")), markProcessed: fail(serverError("55P03")) });
    const { lines, log } = logs();
    assert.equal(await handleQueueMessage(message(1), r.ops, newEventStageCounters(), log), "ack_failed");
    assert.ok(lines.some((l) => l.includes("notification_event_mark_failed")));
  });

  it("a marked message is never processed again: only the acknowledgement is retried", async () => {
    const r = rig();
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(3, { [PROCESSED_HEADER]: "2026-11-06T10:00:00Z" }), r.ops, counters, log), "ack_recovered");
    assert.deepEqual(r.calls, ["acknowledge"]);
    assert.equal(counters.ackRecovered, 1);
    assert.match(lines[0]!, /notification_event_ack_recovered/);
  });

  it("a marked message past the poison threshold is still acknowledged, never dead-lettered", async () => {
    const r = rig();
    const { log } = logs();
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 1, { [PROCESSED_HEADER]: "2026-11-06T10:00:00Z" }), r.ops, newEventStageCounters(), log), "ack_recovered");
    assert.deepEqual(r.calls, ["acknowledge"]);
  });

  it("an unmarked message past the threshold is dead-lettered, without being processed", async () => {
    const r = rig();
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 1), r.ops, counters, log), "dead_lettered");
    assert.deepEqual(r.calls, ["deadLetter"]);
    assert.equal(counters.deadLettered, 1);
    assert.match(lines[0]!, /^Dead-lettering message 7: read_ct=6 exceeds threshold 5\.$/);
  });

  it("an archive that found no row counts nothing", async () => {
    const r = rig({ deadLetter: async () => false });
    const { log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 1), r.ops, counters, log), "dead_lettered");
    assert.equal(counters.deadLettered, 0);
  });
});

describe("archive and acknowledgement failures are bounded", () => {
  it("parks at PARK_READ_CT and not before, with a reason that says which failure it was", async () => {
    const archive = rig({ deadLetter: fail(serverError("42501")) });
    const { log } = logs();
    const counters = newEventStageCounters();
    for (let readCt = MAX_READ_CT + 1; readCt < PARK_READ_CT; readCt += 1) {
      assert.equal(await handleQueueMessage(message(readCt), archive.ops, counters, log), "archive_failed", String(readCt));
    }
    assert.deepEqual(archive.parked, []);
    assert.equal(await handleQueueMessage(message(PARK_READ_CT), archive.ops, counters, log), "parked");
    assert.deepEqual(archive.parked, ["archive_failed"]);
    assert.equal(counters.parked, 1);
    assert.equal(counters.deadLettered, 0, "a failed move is never counted as dead-lettered");
    assert.equal(counters.archiveFailures, PARK_READ_CT - MAX_READ_CT);

    const ack = rig({ acknowledge: fail(serverError("42501")) });
    const marked = { [PROCESSED_HEADER]: "2026-11-06T10:00:00Z" };
    assert.equal(await handleQueueMessage(message(PARK_READ_CT - 1, marked), ack.ops, newEventStageCounters(), log), "ack_failed");
    assert.equal(await handleQueueMessage(message(PARK_READ_CT, marked), ack.ops, newEventStageCounters(), log), "parked");
    assert.deepEqual(ack.parked, ["ack_failed"]);
  });

  it("a released message gets one more attempt: success finishes it, and failure parks it again at once", async () => {
    const { log } = logs();
    const released = rig();
    assert.equal(await handleQueueMessage(message(PARK_READ_CT + 1), released.ops, newEventStageCounters(), log), "dead_lettered");
    const stillBroken = rig({ deadLetter: fail(serverError("42501")) });
    assert.equal(await handleQueueMessage(message(PARK_READ_CT + 1), stillBroken.ops, newEventStageCounters(), log), "parked");
  });

  it("never deletes a message to hide an archive failure", async () => {
    const r = rig({ deadLetter: fail(serverError("42501")) });
    const { log } = logs();
    await handleQueueMessage(message(PARK_READ_CT), r.ops, newEventStageCounters(), log);
    assert.ok(!r.calls.includes("acknowledge"));
  });

  it("if parking keeps failing the disposition becomes stuck, which ends the process", async () => {
    const r = rig({ deadLetter: fail(serverError("42501")), park: fail(serverError("42501")) });
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(ABANDON_READ_CT - 1), r.ops, counters, log), "archive_failed");
    assert.equal(await handleQueueMessage(message(ABANDON_READ_CT), r.ops, counters, log), "stuck");
    assert.equal(counters.parkFailures, 2);
    assert.ok(lines.some((l) => l.includes("notification_event_park_failed")));
  });
});

describe("a worker fault is not the message's fault (R-1)", () => {
  /**
   * The sequence the review found: the role lacks a privilege, so every processing attempt fails with 42501.
   * Before this change the attempts ran out and a healthy message was archived as poison at read 6.
   */
  for (const code of ["42501", "42P01", "42883", "42703", "3F000", "28P01"]) {
    it(`${code} during processing: reported, recorded in the message, ends the process, nothing dead-lettered`, async () => {
      const r = rig({ process: fail(serverError(code)) });
      const { lines, log } = logs();
      const counters = newEventStageCounters();
      assert.equal(await handleQueueMessage(message(1), r.ops, counters, log), "worker_fault");
      assert.deepEqual(r.calls, ["process", "recordFaultRead"], "no acknowledgement, no archive, no park, no delay");
      assert.equal(counters.workerFaults, 1);
      assert.equal(counters.failed, 0, "not counted as a processing failure");
      assert.equal(counters.deadLettered, 0);
      assert.deepEqual(JSON.parse(lines[0]!), { msg: "notification_event_worker_fault", msg_id: "7", read_ct: 1, stage: "process", error: { name: "PostgresError", code, severity: "ERROR" } });
    });
  }

  it("what the message itself did wrong still counts, and still ends in the archive", async () => {
    const r = rig({ process: fail(serverError("22P02")) });
    const { log } = logs();
    for (let readCt = 1; readCt <= MAX_READ_CT; readCt += 1) assert.equal(await handleQueueMessage(message(readCt), r.ops, newEventStageCounters(), log), "failed");
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 1), r.ops, newEventStageCounters(), log), "dead_lettered");
    assert.ok(!r.calls.includes("recordFaultRead"));
  });

  it("a recorded fault read does not count: past the threshold by raw read_ct, the message is still processed", async () => {
    const r = rig();
    const { log } = logs();
    const healthy = message(MAX_READ_CT + 3, { [FAULT_READS_HEADER]: 4, kolekto_fault_code: "42501" });
    assert.equal(countedReads(healthy), MAX_READ_CT - 1);
    assert.equal(await handleQueueMessage(healthy, r.ops, newEventStageCounters(), log), "processed");
    assert.deepEqual(r.calls, ["process", "acknowledge"], "recovery is the ordinary path: no replay, no second copy");
  });

  it("recovery end to end: fault, restart, fault, privilege restored, processed exactly once, never archived", async () => {
    const { log } = logs();
    const headers: Record<string, unknown> = {};
    let processed = 0;
    let privilegeRestored = false;
    const r = rig({
      process: async () => {
        if (!privilegeRestored) throw serverError("42501");
        processed += 1;
        return { outcome: "processed", deliveries: 1, email: { kind: "pending" } };
      },
      recordFaultRead: async () => { headers[FAULT_READS_HEADER] = ((headers[FAULT_READS_HEADER] as number | undefined) ?? 0) + 1; },
    });
    // Far more restarts than the five attempts that used to dead-letter it.
    for (let readCt = 1; readCt <= 12; readCt += 1) {
      assert.equal(await handleQueueMessage(message(readCt, { ...headers }), r.ops, newEventStageCounters(), log), "worker_fault", String(readCt));
    }
    privilegeRestored = true;
    assert.equal(await handleQueueMessage(message(13, { ...headers }), r.ops, newEventStageCounters(), log), "processed");
    assert.equal(processed, 1);
    assert.ok(!r.calls.includes("deadLetter"));
    assert.ok(!r.calls.includes("park"));
  });

  it("a real poison message is still caught when some of its reads were a fault's", async () => {
    const r = rig({ process: fail(serverError("22P02")) });
    const { log } = logs();
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 2, { [FAULT_READS_HEADER]: 2 }), r.ops, newEventStageCounters(), log), "failed", "its fifth counted attempt");
    const dead = rig();
    const { lines, log: deadLog } = logs();
    assert.equal(await handleQueueMessage(message(MAX_READ_CT + 3, { [FAULT_READS_HEADER]: 2 }), dead.ops, newEventStageCounters(), deadLog), "dead_lettered");
    assert.match(lines[0]!, /read_ct=6 exceeds threshold 5/, "the line reports the counted reads");
  });

  it("an unreadable fault header counts nothing, so it cannot be used to keep poison in circulation by accident", () => {
    for (const value of ["4", -2, 1.5, null, {}]) assert.equal(countedReads(message(9, { [FAULT_READS_HEADER]: value })), 9, JSON.stringify(value));
    assert.equal(countedReads(message(2, { [FAULT_READS_HEADER]: 5 })), 0, "never below zero");
  });

  it("if the record fails as well it is logged, and the process still stops: the preflight then refuses to read", async () => {
    const r = rig({ process: fail(serverError("42501")), recordFaultRead: fail(serverError("42501")) });
    const { lines, log } = logs();
    assert.equal(await handleQueueMessage(message(2), r.ops, newEventStageCounters(), log), "worker_fault");
    assert.ok(lines.some((l) => l.includes("notification_event_fault_record_failed")));
  });

  it("a transient failure is still a retry: a held lock is not a worker fault", async () => {
    const r = rig({ process: fail(serverError("55P03")) });
    const { log } = logs();
    assert.equal(await handleQueueMessage(message(1), r.ops, newEventStageCounters(), log), "failed");
    assert.ok(!r.calls.includes("recordFaultRead"));
  });

  it("the rest of an abandoned batch is recorded too, and one failure does not stop the others", async () => {
    const recorded: [string, string][] = [];
    const r = rig({
      recordFaultRead: async (id, code) => {
        if (id === "2") throw serverError("42501");
        recorded.push([id, code]);
      },
    });
    const { lines, log } = logs();
    await abandonBatch([{ ...message(1), msg_id: "1" }, { ...message(1), msg_id: "2" }, { ...message(1), msg_id: "3" }], r.ops, log);
    assert.deepEqual(recorded, [["1", BATCH_ABANDONED_CODE], ["3", BATCH_ABANDONED_CODE]]);
    assert.equal(lines.length, 1);
  });
});

describe("an acknowledgement problem never dead-letters a healthy message (R-1)", () => {
  it("a delete that keeps failing with a missing privilege: marked, never processed twice, parked and not archived", async () => {
    const r = rig({ acknowledge: fail(serverError("42501")) });
    const { log } = logs();
    assert.equal(await handleQueueMessage(message(1), r.ops, newEventStageCounters(), log), "ack_failed");
    assert.ok(r.calls.includes("markProcessed"), "the mark is what protects it");
    const marked = { [PROCESSED_HEADER]: "2026-11-06T10:00:00Z" };
    for (let readCt = 2; readCt < PARK_READ_CT; readCt += 1) assert.equal(await handleQueueMessage(message(readCt, marked), r.ops, newEventStageCounters(), log), "ack_failed");
    assert.equal(await handleQueueMessage(message(PARK_READ_CT, marked), r.ops, newEventStageCounters(), log), "parked");
    assert.ok(!r.calls.includes("deadLetter"));
    assert.equal(r.calls.filter((c) => c === "process").length, 1);
  });

  it("delete and mark both refused for lack of privilege: a worker fault, because nothing can be recorded", async () => {
    const r = rig({ acknowledge: fail(serverError("42501")), markProcessed: fail(serverError("42501")) });
    const { lines, log } = logs();
    const counters = newEventStageCounters();
    assert.equal(await handleQueueMessage(message(1), r.ops, counters, log), "worker_fault");
    assert.equal(counters.workerFaults, 1);
    assert.ok(lines.some((l) => l.includes('"stage":"mark"')));
    assert.ok(!r.calls.includes("deadLetter"));
  });

  it("a mark that only lost a lock stays an ordinary retry: F14-ACK's path is unchanged", async () => {
    const r = rig({ acknowledge: fail(serverError("42501")), markProcessed: fail(serverError("55P03")) });
    const { log } = logs();
    assert.equal(await handleQueueMessage(message(1), r.ops, newEventStageCounters(), log), "ack_failed");
  });
});

describe("what reaches the log", () => {
  it("a server error's text and the message body never do", async () => {
    const secret = "real.person@example.com";
    const r = rig({ deadLetter: fail(serverError("42501", `denied for ${secret}`)), process: fail(serverError("22P02", `bad value ${secret}`)) });
    const { lines, log } = logs();
    await handleQueueMessage({ ...message(1), message: { action: "member.create", to: secret } }, r.ops, newEventStageCounters(), log);
    await handleQueueMessage({ ...message(PARK_READ_CT), message: { action: "member.create", to: secret } }, r.ops, newEventStageCounters(), log);
    assert.ok(lines.length > 0);
    assert.ok(!lines.join("\n").includes(secret));
  });

  it("an action outside the watched list is not printed", async () => {
    const r = rig();
    const { lines, log } = logs();
    await handleQueueMessage({ ...message(1), message: { action: "free text" } }, r.ops, newEventStageCounters(), log);
    assert.ok(!lines.join("\n").includes("free text"));
  });
});

describe("the backoff", () => {
  it("doubles from 30 s to a 480 s cap", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map(transientRetryDelaySeconds), [30, 60, 120, 240, 480, 480, 480]);
  });

  it("gives the five attempts about 15 minutes, where the plain timeout gives about 3", () => {
    const total = [1, 2, 3, 4, 5].reduce((sum, readCt) => sum + transientRetryDelaySeconds(readCt), 0);
    assert.equal(total, 930);
  });
});
