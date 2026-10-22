/**
 * notification-backoff.test.ts — the retry schedule and failure classification.
 *
 * Offline and deterministic: the clock and the jitter source are injected, so
 * these assert the decision record's §10.6.2 rules exactly without a database
 * or a provider.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError } from "@kolekto/adapters";

import {
  BACKOFF_JITTER,
  RETRY_BACKOFF_MS,
  backoffDelayMs,
  classifyFailure,
  nextRetryAt,
} from "../src/notification-backoff.ts";

const MAX = 3;
const NOW = 1_700_000_000_000;

describe("backoff schedule", () => {
  it("is 5 minutes after attempt 1 and 30 minutes after attempt 2 (no jitter at rng=0.5)", () => {
    assert.equal(backoffDelayMs(1, () => 0.5), 5 * 60_000);
    assert.equal(backoffDelayMs(2, () => 0.5), 30 * 60_000);
    assert.equal(RETRY_BACKOFF_MS[1], 5 * 60_000);
    assert.equal(RETRY_BACKOFF_MS[2], 30 * 60_000);
  });

  it("keeps jitter within ±20%", () => {
    for (const attempt of [1, 2] as const) {
      const base = RETRY_BACKOFF_MS[attempt]!;
      const low = backoffDelayMs(attempt, () => 0); // factor 0.8
      const high = backoffDelayMs(attempt, () => 0.999999); // factor ~1.2
      assert.equal(low, Math.round(base * (1 - BACKOFF_JITTER)));
      assert.ok(high <= Math.round(base * (1 + BACKOFF_JITTER)));
      assert.ok(low >= Math.round(base * (1 - BACKOFF_JITTER)) - 1);
      // Every sample sits inside the window.
      for (const r of [0, 0.1, 0.37, 0.5, 0.8, 0.999999]) {
        const d = backoffDelayMs(attempt, () => r);
        assert.ok(d >= base * 0.8 - 1 && d <= base * 1.2 + 1, `attempt ${attempt} rng ${r} → ${d}`);
      }
    }
  });

  it("refuses a schedule for a 3rd (terminal) attempt", () => {
    assert.throws(() => backoffDelayMs(3, () => 0.5), /no backoff schedule/);
  });

  it("nextRetryAt adds the jittered delay to now", () => {
    assert.equal(nextRetryAt(1, NOW, () => 0.5), new Date(NOW + 5 * 60_000).toISOString());
  });
});

type TransientCode = "provider_unreachable" | "provider_timeout" | "provider_rejected_transient";
type PermanentCode = "provider_rejected_permanent" | "provider_protocol_error" | "invalid_message";

function transient(code: TransientCode, ambiguous = false): EmailProviderError {
  return new EmailProviderError("transient", code, "scripted", ambiguous);
}
function permanent(code: PermanentCode): EmailProviderError {
  return new EmailProviderError("permanent", code, "scripted", false);
}

describe("failure classification", () => {
  it("permanent → dead with that code, never retried", () => {
    for (const code of ["provider_rejected_permanent", "provider_protocol_error", "invalid_message"] as const) {
      const action = classifyFailure(permanent(code), 1, MAX, "provider", NOW, () => 0.5);
      assert.deepEqual(action, { kind: "dead", errorCode: code });
    }
  });

  it("adapter_misconfigured → halt", () => {
    const err = new EmailProviderError("permanent", "adapter_misconfigured", "scripted");
    assert.deepEqual(classifyFailure(err, 1, MAX, "provider", NOW, () => 0.5), { kind: "halt", errorCode: "adapter_misconfigured" });
  });

  it("ordinary transient retries while attempts remain", () => {
    const action = classifyFailure(transient("provider_unreachable"), 1, MAX, "provider", NOW, () => 0.5);
    assert.equal(action.kind, "retry");
    if (action.kind === "retry") {
      assert.equal(action.errorCode, "provider_unreachable");
      assert.equal(action.nextRetryAt, new Date(NOW + 5 * 60_000).toISOString());
    }
  });

  it("transient on the last attempt → dead/retries_exhausted, no 4th", () => {
    const action = classifyFailure(transient("provider_rejected_transient"), MAX, MAX, "provider", NOW, () => 0.5);
    assert.deepEqual(action, { kind: "dead", errorCode: "retries_exhausted" });
  });

  it("ambiguous + provider idempotency → retry (same key reused)", () => {
    const action = classifyFailure(transient("provider_timeout", true), 1, MAX, "provider", NOW, () => 0.5);
    assert.equal(action.kind, "retry");
  });

  it("ambiguous + provider idempotency at the cap → dead/retries_exhausted", () => {
    const action = classifyFailure(transient("provider_timeout", true), MAX, MAX, "provider", NOW, () => 0.5);
    assert.deepEqual(action, { kind: "dead", errorCode: "retries_exhausted" });
  });

  it("ambiguous + NO idempotency → dead/outcome_unknown, never retried, even on attempt 1", () => {
    const action = classifyFailure(transient("provider_timeout", true), 1, MAX, "none", NOW, () => 0.5);
    assert.deepEqual(action, { kind: "dead", errorCode: "outcome_unknown" });
  });

  it("non-ambiguous transient + NO idempotency still retries (only ambiguity blocks retry)", () => {
    const action = classifyFailure(transient("provider_unreachable", false), 1, MAX, "none", NOW, () => 0.5);
    assert.equal(action.kind, "retry");
  });
});
