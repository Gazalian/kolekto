/**
 * notification-sender.test.ts — the pause switch (`email_sending_enabled`)
 * blocks every provider call.
 *
 * Offline. Covers the one branch at the top of `runSenderTick`: when
 * `isEmailSendingEnabled` returns false the loop never runs, so the provider
 * is never called, no claim transaction is opened and `steps` is empty. The
 * full crash/retry story is covered by notification-sender.integration.test.ts;
 * this is only the smallest proof that the switch denies delivery.
 *
 * `allowSend=false` must have the same effect even when the switch is on, so
 * a halted sender keeps running maintenance without issuing sends.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EmailProviderError, MailpitEmailProvider, type EmailProvider } from "@kolekto/adapters";

import { runSenderTick, sendOneClaimed, type TickOptions } from "../src/notification-sender.ts";

/**
 * The narrowest possible stand-in for the postgres.js connection: it answers
 * `app.email_sending_enabled()` and `app.record_sender_heartbeat()` only, and
 * fails any other query loudly so an accidental DB call would show up as a
 * test failure, not as silence.
 */
function fakeSql(enabled: boolean): {
  sql: Parameters<typeof runSenderTick>[0];
  log: string[];
} {
  const log: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push(text);
    if (text.includes("app.email_sending_enabled()")) {
      return [{ enabled }];
    }
    if (text.includes("app.record_sender_heartbeat")) {
      return [];
    }
    throw new Error(`fakeSql: unexpected query "${text}"`);
  }) as unknown as Parameters<typeof runSenderTick>[0];
  // runSenderTick never calls .begin when the pause switch is off; make the
  // method obviously throw if that invariant is ever broken.
  (tagged as unknown as { begin: unknown }).begin = () => {
    throw new Error("fakeSql: begin() must not be reached while sending is disabled");
  };
  return { sql: tagged, log };
}

/** Provider that records every send() call. Should never be invoked in these tests. */
function recordingProvider(): EmailProvider & { attempts: number } {
  const provider: EmailProvider & { attempts: number } = {
    name: "fake",
    idempotency: "provider",
    attempts: 0,
    async send() {
      provider.attempts += 1;
      return { providerMessageId: "unreachable" };
    },
  };
  return provider;
}

function tickOpts(provider: EmailProvider, over: Partial<TickOptions> = {}): TickOptions {
  return {
    provider,
    now: () => Date.parse("2026-10-29T00:00:00Z"),
    rng: () => 0.5,
    maxBatch: 10,
    runMaintenance: false,
    allowSend: true,
    log: () => {},
    ...over,
  };
}

describe("runSenderTick — pause switch", () => {
  it("claims nothing and never calls the provider when email_sending_enabled is false", async () => {
    const { sql, log } = fakeSql(false);
    const provider = recordingProvider();

    const result = await runSenderTick(sql, tickOpts(provider));

    assert.equal(result.paused, true, "paused flag reflects the DB switch");
    assert.equal(result.steps.length, 0, "no claim steps while paused");
    assert.equal(provider.attempts, 0, "provider.send() must not be called while paused");
    assert.equal(result.halted, false);
    // The two expected calls: read the switch, write a heartbeat. Nothing else.
    assert.ok(
      log.some((q) => q.includes("app.email_sending_enabled()")),
      "reads the pause switch",
    );
    assert.ok(
      log.some((q) => q.includes("app.record_sender_heartbeat")),
      "still records a heartbeat so an idle paused worker is visible",
    );
  });

  // M13.2 R11′: integration tests never turn the switch on, so this fake-connection
  // test is the coverage for "switch ON → the tick attempts a claim".
  it("attempts a claim in a transaction when email_sending_enabled is true", async () => {
    const { sql, log } = fakeSql(true);
    const txLog: string[] = [];
    let begun = 0;
    (sql as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => unknown) => {
      begun += 1;
      const tx = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        txLog.push(text);
        if (text.includes("app.claim_next_notification_delivery")) return []; // queue empty
        throw new Error(`fakeSql tx: unexpected query "${text}"`);
      };
      return cb(tx);
    };
    const provider = recordingProvider();

    const result = await runSenderTick(sql, tickOpts(provider));

    assert.equal(result.paused, false, "paused flag reflects the DB switch");
    assert.equal(begun, 1, "one claim transaction is opened");
    assert.ok(txLog.some((q) => q.includes("app.claim_next_notification_delivery")), "the real claim function is called");
    assert.equal(result.steps.length, 0, "an empty queue yields no steps");
    assert.equal(provider.attempts, 0, "nothing to send, so no provider call");
    assert.ok(log.some((q) => q.includes("app.record_sender_heartbeat")), "heartbeat recorded");
  });

  it("still blocks delivery when allowSend=false, even if the switch is on", async () => {
    const { sql, log } = fakeSql(true);
    const provider = recordingProvider();

    const result = await runSenderTick(sql, tickOpts(provider, { allowSend: false }));

    // paused reflects the DB switch, not allowSend; the invariant we care
    // about is that nothing is sent, not what the flag reads as.
    assert.equal(result.steps.length, 0, "no claim steps when allowSend is false");
    assert.equal(provider.attempts, 0, "provider.send() must not be called when allowSend is false");
    assert.ok(log.every((q) => !q.includes("claim_next_notification_delivery")), "no claim query attempted");
  });
});

/**
 * Moved from test/integration/notification-sender-mailpit.integration.test.ts (M13.2 Phase 1c;
 * review §4.2 S2/S3: "Unit. No database."). They need no database, so they run in every
 * `npm test` instead of only in the integration lane. S3's rejection is now awaited: the
 * old un-awaited `assert.rejects` could never fail the test.
 *
 * No connection is made. The constructor check is synchronous, and send() validates the
 * request before it opens a socket (packages/adapters/test/mailpit-email-provider.test.ts
 * proves that ordering with a connection-counting server). Port 1 on loopback is used so
 * that even a regression could not reach a listening SMTP catcher.
 */
describe("sender safety invariants (no database, no SMTP)", () => {
  it("S2: the Mailpit adapter refuses a non-loopback host", () => {
    assert.throws(
      () => new MailpitEmailProvider({ host: "smtp.example.com", port: 587, from: "noreply@kolekto.test" }),
      (e: unknown) => e instanceof EmailProviderError && e.code === "adapter_misconfigured" && /loopback/.test(e.message),
      "Mailpit adapter refuses non-loopback hosts",
    );
  });

  it("S3: the adapter rejects an empty recipient before connecting", async () => {
    const provider = new MailpitEmailProvider({ host: "127.0.0.1", port: 1, from: "noreply@kolekto.test" });
    await assert.rejects(
      provider.send({ idempotencyKey: "test", message: { to: "", subject: "x", text: "x" } }),
      (e: unknown) =>
        e instanceof EmailProviderError &&
        e.kind === "permanent" &&
        e.code === "invalid_message" &&
        /not a single valid email address/.test(e.message),
      "adapter rejects empty recipient",
    );
  });
});

// ── M13.2 Phase 4: deferral mapping (compensates for the deferral integration tests
// moving into rolled-back transactions, where sendOneClaimed itself cannot run) ──

/**
 * A fake connection whose begin() answers exactly the claim and the reservation,
 * and whose base connection answers nothing: a deferred or skipped reservation
 * must return before loadSendContext, the provider and the settle are reached.
 */
function claimReserveSql(reservation: string, retryAt: string | null): { sql: Parameters<typeof sendOneClaimed>[0]; txLog: string[]; baseLog: string[] } {
  const txLog: string[] = [];
  const baseLog: string[] = [];
  const base = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    baseLog.push(text);
    throw new Error(`fakeSql: unexpected base query "${text}"`);
  }) as unknown as Parameters<typeof sendOneClaimed>[0];
  (base as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => unknown) => {
    const tx = async (strings: TemplateStringsArray) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim();
      txLog.push(text);
      if (text.includes("app.claim_next_notification_delivery")) {
        return [{ delivery_id: "11111111-1111-4111-8111-111111111111", claimed: true, lease_token: "t".repeat(64), lease_expires_at: "2026-10-29T00:05:00Z", attempt_count: 1, reason: "claimed" }];
      }
      if (text.includes("app.reserve_email_attempt")) return [{ reservation, retry_at: retryAt }];
      throw new Error(`fakeSql tx: unexpected query "${text}"`);
    };
    return cb(tx);
  };
  return { sql: base, txLog, baseLog };
}

describe("sendOneClaimed — non-granted reservations make no provider call", () => {
  for (const reservation of ["community_deferred", "provider_daily_limited", "provider_rate_limited"] as const) {
    it(`maps ${reservation} to outcome "deferred" with its retry time, and never calls the provider`, async () => {
      const retryAt = "2026-10-29T01:00:00.000Z";
      const { sql, txLog, baseLog } = claimReserveSql(reservation, retryAt);
      const provider = recordingProvider();

      const step = await sendOneClaimed(sql, { provider, now: () => Date.parse("2026-10-29T00:00:00Z"), rng: () => 0.5 });

      assert.deepEqual(step, { outcome: "deferred", deliveryId: "11111111-1111-4111-8111-111111111111", reservation, retryAt });
      assert.equal(provider.attempts, 0, "no provider call on a deferral");
      assert.equal(txLog.length, 2, "claim and reserve, in one transaction");
      assert.deepEqual(baseLog, [], "no send context, settle or other query after a deferral");
    });
  }

  for (const reservation of ["address_suppressed", "address_limited", "backlog_full"] as const) {
    it(`maps ${reservation} to outcome "skipped", and never calls the provider`, async () => {
      const { sql, baseLog } = claimReserveSql(reservation, null);
      const provider = recordingProvider();

      const step = await sendOneClaimed(sql, { provider, now: () => Date.parse("2026-10-29T00:00:00Z"), rng: () => 0.5 });

      assert.deepEqual(step, { outcome: "skipped", deliveryId: "11111111-1111-4111-8111-111111111111", reservation });
      assert.equal(provider.attempts, 0);
      assert.deepEqual(baseLog, []);
    });
  }
});
