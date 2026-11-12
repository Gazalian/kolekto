/**
 * sweep.test.ts — the sweep's decisions, without a database.
 *
 * The integration file (apps/worker/test/integration/payments-orchestrator)
 * proves the sweep against the real functions, but inside one rolled-back
 * transaction no attempt can be past its hold (the hold end is frozen and
 * now() does not move). So the branches that depend on time are proved here,
 * against a scripted database that records every call the sweep makes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFakePaymentProvider, type FakeScenario } from "@kolekto/adapters";
import type { PaymentDb } from "@kolekto/db";

import { sweepPaymentAttempts } from "../src/sweep.ts";

interface Due {
  attempt_id: string;
  reference: string;
  status: "created" | "initialized" | "captured";
  past_check_window: boolean;
}

/** A PaymentDb whose only "SQL" is recognising which payment function was called. */
function scriptedDb(due: Due[], options: { failExpireFor?: string } = {}) {
  const calls: string[] = [];
  const db: PaymentDb = async (fn) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("from public.payment_attempts a")) return Promise.resolve(due);
      if (text.includes("app.expire_payment_attempt")) {
        calls.push(`expire:${String(values[0])}`);
        if (values[0] === options.failExpireFor) return Promise.reject(new Error("PAYMENT_ATTEMPT_STILL_HELD: raced"));
        return Promise.resolve([{ s: "expired" }]);
      }
      if (text.includes("app.complete_payment_capture")) {
        calls.push(`capture:${String(values[0])}`);
        return Promise.resolve([{ contribution_id: "contribution-1", status: "completed", review_reason: null }]);
      }
      if (text.includes("app.record_provider_transaction")) {
        const status = String(values[4]);
        calls.push(`record:${String(values[0])}:${status}`);
        const next = status === "succeeded" ? "captured" : status === "failed" || status === "abandoned" ? "failed" : "initialized";
        return Promise.resolve([{ attempt_id: `id-${String(values[0])}`, status: next, review_reason: null }]);
      }
      return Promise.reject(new Error(`unexpected SQL: ${text}`));
    };
    return fn(tx as never);
  };
  return { db, calls };
}

const due = (reference: string, status: Due["status"], pastWindow = false): Due => ({
  attempt_id: `id-${reference}`,
  reference,
  status,
  past_check_window: pastWindow,
});

function provider(scenarios: Record<string, FakeScenario>) {
  return createFakePaymentProvider({ webhookSecret: "unit-test-secret", scenarios });
}

describe("sweepPaymentAttempts", () => {
  it("expires an attempt the provider has never heard of", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized")]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "not_found" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "expired" }]);
    assert.deepEqual(calls, ["expire:id-R1"]);
  });

  it("leaves a pending payment alone inside the check window, and writes nothing", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized", false)]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "pending" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "still_pending" }]);
    assert.deepEqual(calls, []);
  });

  it("expires a payment still pending after the check window", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized", true)]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "pending" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "expired" }]);
    assert.deepEqual(calls, ["expire:id-R1"]);
  });

  it("does nothing when the provider does not answer (D-27: timeout is not failure)", async () => {
    const { db, calls } = scriptedDb([due("R1", "created", true)]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "verify_timeout" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "provider_unavailable" }]);
    assert.deepEqual(calls, []);
  });

  it("records a success the contributor never came back for, then captures it", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized")]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "success" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "completed" }]);
    assert.deepEqual(calls, ["record:R1:succeeded", "capture:id-R1"]);
  });

  it("records a declined payment as failed", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized")]);
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "payment_failed" }) });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "failed" }]);
    assert.deepEqual(calls, ["record:R1:failed"]);
  });

  it("finishes a captured attempt without asking the provider again", async () => {
    const { db, calls } = scriptedDb([due("R1", "captured")]);
    const fake = provider({});
    const report = await sweepPaymentAttempts({ db, provider: fake });
    assert.deepEqual(report.outcomes, [{ reference: "R1", outcome: "completed" }]);
    assert.deepEqual(calls, ["capture:id-R1"]);
    assert.deepEqual(fake.verifyCalls, []);
  });

  it("one attempt's error does not stop the run", async () => {
    const { db, calls } = scriptedDb([due("R1", "initialized"), due("R2", "initialized")], { failExpireFor: "id-R1" });
    const report = await sweepPaymentAttempts({ db, provider: provider({ R1: "not_found", R2: "not_found" }) });
    assert.deepEqual(report.outcomes, [
      { reference: "R1", outcome: "error", code: "PAYMENT_ATTEMPT_STILL_HELD" },
      { reference: "R2", outcome: "expired" },
    ]);
    assert.deepEqual(calls, ["expire:id-R1", "expire:id-R2"]);
  });
});
