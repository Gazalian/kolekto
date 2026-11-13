/**
 * worker-safety.test.ts — M13.2 Phase 7, F-2 and F-7. Pure; no database.
 *
 * The regression that matters: a real postgres.js PostgresError carrying a recipient
 * address, a phone number and a connection string in every field the driver copies
 * from the server must produce a log summary containing none of them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

import postgres from "postgres";

import {
  DB_SESSION_TIMEOUTS,
  eventHealthLogLine,
  isFatalDatabaseError,
  isTransientDatabaseError,
  MAX_CONSECUTIVE_POLL_FAILURES,
  newEventStageCounters,
  PollFailureTracker,
  safeErrorJson,
  safeErrorSummary,
  scrubText,
  timeoutMismatches,
  waitForDatabase,
} from "../src/worker-safety.ts";

const ADDRESS = "real.person@example.com";
const PHONE = "+2348012345678";
const URL_WITH_PASSWORD = "postgresql://kolekto_worker:hunter2hunter2@db.internal:5432/postgres";

function sensitiveServerError(): Error {
  const fields = {
    severity: "ERROR",
    severity_local: "ERROR",
    code: "23514",
    message: `new row violates check constraint for ${ADDRESS}`,
    detail: `Failing row contains (${ADDRESS}, ${PHONE}, pending).`,
    hint: `Check ${ADDRESS}`,
    where: `SQL statement with ${PHONE}`,
    internal_query: `select '${ADDRESS}'`,
    schema_name: "public",
    table_name: "notification_deliveries",
    column_name: "recipient_address",
    constraint_name: "notification_deliveries_email_address_check",
    file: "execMain.c",
    line: "2060",
    routine: "ExecConstraints",
  };
  const error = new (postgres as unknown as { PostgresError: new (x: Record<string, string>) => Error }).PostgresError(fields);
  return Object.assign(error, { query: `insert into x values ('${ADDRESS}')`, parameters: [ADDRESS, PHONE], args: [ADDRESS], types: [25] });
}

describe("safeErrorSummary — sensitive values never reach a log line (F-2)", () => {
  it("a raw PostgresError would leak: this is what the summary exists to prevent", () => {
    const printed = inspect(sensitiveServerError());
    assert.ok(printed.includes(ADDRESS), "the driver's error really does carry the address when printed raw");
    assert.ok(printed.includes(PHONE), "and the phone number");
  });

  it("keeps only the SQLSTATE, severity and object names of a real PostgresError", () => {
    assert.deepEqual(safeErrorSummary(sensitiveServerError()), {
      name: "PostgresError",
      code: "23514",
      severity: "ERROR",
      constraint: "notification_deliveries_email_address_check",
      table: "notification_deliveries",
      column: "recipient_address",
    });
  });

  it("the JSON form holds no address, phone number or query text", () => {
    const line = safeErrorJson(sensitiveServerError());
    for (const secret of [ADDRESS, PHONE, "Failing row", "insert into", "hint", "where"]) {
      assert.ok(!line.includes(secret), secret);
    }
  });

  it("drops a server message that quotes the rejected value", () => {
    const error = Object.assign(new Error(`invalid input value for enum audit_actor_type: "${ADDRESS}"`), { name: "PostgresError", code: "22P02" });
    assert.deepEqual(safeErrorSummary(error), { name: "PostgresError", code: "22P02" });
  });

  it("treats anything carrying a SQLSTATE as a server error even if renamed", () => {
    const error = Object.assign(new Error(`failed for ${ADDRESS}`), { code: "23505" });
    assert.ok(!safeErrorJson(error).includes(ADDRESS));
    assert.equal(safeErrorSummary(error).message, undefined);
  });

  it("keeps a scrubbed message for a client error, and never its extra properties", () => {
    const error = Object.assign(new Error(`connect to ${URL_WITH_PASSWORD} for ${ADDRESS} failed`), { code: "CONNECT_TIMEOUT", input: URL_WITH_PASSWORD, address: "10.0.0.1" });
    const line = safeErrorJson(error);
    assert.ok(!line.includes("hunter2"), "no password");
    assert.ok(!line.includes(ADDRESS), "no address");
    assert.ok(!line.includes("10.0.0.1"), "extra properties are not copied");
    assert.equal(safeErrorSummary(error).code, "CONNECT_TIMEOUT");
    assert.match(safeErrorSummary(error).message ?? "", /\[url\]/);
  });

  it("a URL parse error's input property is not carried", () => {
    let parseError: unknown;
    try {
      new URL("hunter2hunter2 is not a url");
    } catch (error) {
      parseError = error;
    }
    assert.ok(parseError instanceof Error);
    assert.ok(!safeErrorJson(parseError).includes("hunter2"));
    assert.equal(safeErrorSummary(parseError).code, "ERR_INVALID_URL");
  });

  it("handles non-errors, hostile names and long messages without echoing them", () => {
    assert.deepEqual(safeErrorSummary(undefined), { name: "NonError", message: "undefined" });
    assert.deepEqual(safeErrorSummary(`boom ${ADDRESS}`), { name: "NonError", message: "boom [address]" });
    assert.equal(safeErrorSummary(Object.assign(new Error("x"), { name: `name ${ADDRESS}` })).name, "Error");
    assert.ok((safeErrorSummary(new Error("a b ".repeat(500))).message ?? "").length <= 201);
    assert.equal(safeErrorSummary(Object.assign(new Error("x"), { code: `bad ${ADDRESS}` })).code, undefined);
  });

  it("scrubText removes addresses, phone numbers, URLs and long tokens", () => {
    assert.equal(scrubText(`to ${ADDRESS}`), "to [address]");
    assert.equal(scrubText(`call ${PHONE} now`), "call [number] now");
    assert.equal(scrubText(`at ${URL_WITH_PASSWORD}`), "at [url]");
    assert.equal(scrubText(`key ${"a".repeat(40)}`), "key [token]");
    assert.equal(scrubText("Email sender refused"), "Email sender refused");
  });
});

describe("invalid database configuration fails safely (F-7)", () => {
  const code = (c: string) => Object.assign(new Error("x"), { code: c });

  it("classifies what retrying cannot fix as fatal, and network failures as transient", () => {
    for (const fatal of ["28P01", "28000", "3D000", "42501", "42P01", "42883", "42703", "42704", "ENOTFOUND", "ERR_INVALID_URL"]) {
      assert.equal(isFatalDatabaseError(code(fatal)), true, fatal);
    }
    for (const transient of ["ECONNREFUSED", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "57P01", "40001"]) {
      assert.equal(isFatalDatabaseError(code(transient)), false, transient);
    }
    assert.equal(isFatalDatabaseError(new Error("no code")), false);
  });

  const noSleep = async () => {};

  it("startup succeeds as soon as the probe answers, after retrying a transient failure", async () => {
    let calls = 0;
    const logged: string[] = [];
    const result = await waitForDatabase({
      probe: async () => {
        calls += 1;
        if (calls < 3) throw code("ECONNREFUSED");
      },
      sleep: noSleep,
      log: (l) => logged.push(l),
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
    assert.equal(logged.length, 2);
  });

  it("startup stops at once on a fatal failure", async () => {
    let calls = 0;
    const result = await waitForDatabase({ probe: async () => { calls += 1; throw code("28P01"); }, sleep: noSleep, log: () => {} });
    assert.deepEqual(result, { ok: false, attempts: 1, fatal: true });
    assert.equal(calls, 1);
  });

  it("startup gives up after the bounded number of attempts and never logs the raw error", async () => {
    const logged: string[] = [];
    const result = await waitForDatabase({
      probe: async () => { throw Object.assign(new Error(`refused ${URL_WITH_PASSWORD}`), { code: "ECONNREFUSED" }); },
      sleep: noSleep,
      log: (l) => logged.push(l),
      attempts: 3,
    });
    assert.deepEqual(result, { ok: false, attempts: 3, fatal: false });
    assert.equal(logged.length, 3);
    assert.ok(!logged.join("\n").includes("hunter2"));
  });

  it("the poll tracker exits on a fatal failure and after the limit, and a success resets it", () => {
    assert.equal(new PollFailureTracker().failed(code("28P01")), "exit");
    const tracker = new PollFailureTracker(3);
    assert.equal(tracker.failed(code("ECONNREFUSED")), "continue");
    assert.equal(tracker.failed(code("ECONNREFUSED")), "continue");
    tracker.succeeded();
    assert.equal(tracker.consecutive, 0);
    assert.equal(tracker.failed(code("ECONNREFUSED")), "continue");
    assert.equal(tracker.failed(code("ECONNREFUSED")), "continue");
    assert.equal(tracker.failed(code("ECONNREFUSED")), "exit");
    assert.ok(MAX_CONSECUTIVE_POLL_FAILURES >= 10, "a brief database restart does not end the process");
  });
});

describe("event-stage health line (F-5)", () => {
  it("reports counts only, and nulls when the queue could not be read", () => {
    const counters = newEventStageCounters();
    counters.failed = 2;
    assert.deepEqual(eventHealthLogLine(counters, null), {
      msg: "notification_event_health",
      queue_depth: null,
      queue_max_read_ct: null,
      queue_oldest_age_s: null,
      queue_parked: null,
      processed_total: 0,
      skipped_total: 0,
      failed_total: 2,
      dead_lettered_total: 0,
      poll_failures_total: 0,
      ack_failures_total: 0,
      ack_recovered_total: 0,
      archive_failures_total: 0,
      parked_total: 0,
      park_failures_total: 0,
      worker_faults_total: 0,
    });
    const line = eventHealthLogLine(counters, { depth: 3, maxReadCt: 2, oldestAgeS: 9, parked: 1 });
    assert.equal(line["queue_depth"], 3);
    assert.equal(line["queue_parked"], 1);
  });
});

describe("database session bounds (F-14)", () => {
  it("a lock wait ends before the statement limit, so it always reports as 55P03", () => {
    assert.ok(DB_SESSION_TIMEOUTS.lock_timeout < DB_SESSION_TIMEOUTS.statement_timeout);
    assert.ok(DB_SESSION_TIMEOUTS.statement_timeout < DB_SESSION_TIMEOUTS.idle_in_transaction_session_timeout);
  });

  it("names every timeout the server is not applying, and only those", () => {
    const applied = { lock_timeout: "5s", statement_timeout: "15s", idle_in_transaction_session_timeout: "30s" };
    assert.deepEqual(timeoutMismatches(applied), []);
    assert.deepEqual(timeoutMismatches({ ...applied, lock_timeout: "0" }), ["lock_timeout"]);
    assert.deepEqual(timeoutMismatches({}), ["lock_timeout", "statement_timeout", "idle_in_transaction_session_timeout"]);
  });

  it("classifies a lock timeout, a statement timeout and a lost connection as transient, and a bad value or missing privilege as not", () => {
    for (const code of ["55P03", "57014", "25P03", "40001", "40P01", "57P01", "08006"]) {
      assert.equal(isTransientDatabaseError({ name: "PostgresError", code }), true, code);
    }
    // The driver raises these itself, as plain errors with a code.
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNRESET", "EPIPE"]) {
      assert.equal(isTransientDatabaseError(Object.assign(new Error(code), { code })), true, code);
    }
    for (const code of ["22P02", "23514", "42501", "28P01"]) {
      assert.equal(isTransientDatabaseError({ name: "PostgresError", code }), false, code);
    }
    assert.equal(isTransientDatabaseError(new Error("no code")), false);
  });

  it("a probe that never answers is bounded, reported with a stable code, and retried", async () => {
    const lines: string[] = [];
    const result = await waitForDatabase({ probe: () => new Promise(() => {}), sleep: async () => {}, log: (l) => lines.push(l), attempts: 2, probeTimeoutMs: 5 });
    assert.deepEqual(result, { ok: false, attempts: 2, fatal: false });
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /STARTUP_PROBE_TIMEOUT/);
  });
});
