import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  claimDeliveryById,
  claimNextDelivery,
  isLeaseExpired,
  isTerminalDeliveryStatus,
  MAX_DELIVERY_ATTEMPTS,
  recoverExpiredLease,
  SEND_LEASE_SECONDS,
  settleDelivery,
} from "../src/notification-send-claim.ts";

/**
 * A recording stand-in for a postgres.js connection, in the style of
 * notification-processor.test.ts. It matches each statement by a fragment of
 * its SQL text and answers with canned rows. The claim/settle/recover
 * guarantees themselves live in the database functions (migration
 * 20261013100000, proved by supabase/tests/37); what is proved here is that
 * this module calls them narrowly — ids and tokens only, never addresses —
 * and maps their answers faithfully.
 */
function fakeDb(answer: (text: string) => unknown[]) {
  const log: string[] = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    log.push(`${text} :: ${JSON.stringify(values)}`);
    return answer(text);
  }) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    json: (v: unknown) => unknown;
  };
  tx.json = (v: unknown) => ({ __json: v });
  return { sql: tx as unknown as Parameters<typeof claimDeliveryById>[0], log };
}

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DELIVERY = "c9300000-0000-4000-8000-000000000001";
const LEASE = "0123456789abcdef".repeat(4);

describe("send-claim constants and pure helpers", () => {
  it("fixes the five-minute lease and the three-attempt cap", () => {
    assert.equal(SEND_LEASE_SECONDS, 300);
    assert.equal(MAX_DELIVERY_ATTEMPTS, 3);
  });

  it("treats sent, dead and skipped as terminal and nothing else as terminal", () => {
    assert.equal(isTerminalDeliveryStatus("sent"), true);
    assert.equal(isTerminalDeliveryStatus("dead"), true);
    assert.equal(isTerminalDeliveryStatus("skipped"), true);
    assert.equal(isTerminalDeliveryStatus("pending"), false);
    assert.equal(isTerminalDeliveryStatus("sending"), false);
    assert.equal(isTerminalDeliveryStatus("failed"), false);
    assert.equal(isTerminalDeliveryStatus("delivered"), false);
  });

  it("reads lease expiry off the timestamp, not the clock", () => {
    assert.equal(isLeaseExpired("2026-10-13T11:59:59Z", NOW), true);
    assert.equal(isLeaseExpired("2026-10-13T12:00:00Z", NOW), true);
    assert.equal(isLeaseExpired("2026-10-13T12:00:01Z", NOW), false);
    assert.equal(isLeaseExpired(new Date("2026-10-13T11:00:00Z"), NOW), true);
  });
});

describe("claim wrappers", () => {
  it("maps a successful by-id claim, passing only the id and lease", async () => {
    const { sql, log } = fakeDb((text) =>
      text.includes("from app.claim_notification_delivery")
        ? [{ claimed: true, lease_token: LEASE, lease_expires_at: "2026-10-13T12:05:00Z", attempt_count: 1, reason: "claimed" }]
        : [],
    );
    const claim = await claimDeliveryById(sql, DELIVERY);
    assert.equal(claim.claimed, true);
    assert.equal(claim.leaseToken, LEASE);
    assert.equal(claim.attemptCount, 1);
    assert.equal(claim.reason, "claimed");
    assert.match(log.join("\n"), /claim_notification_delivery/);
    assert.doesNotMatch(log.join("\n"), /@/);
  });

  it("maps a refused claim without inventing a token", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.claim_notification_delivery")
        ? [{ claimed: false, lease_token: null, lease_expires_at: null, attempt_count: 3, reason: "exhausted" }]
        : [],
    );
    const claim = await claimDeliveryById(sql, DELIVERY);
    assert.equal(claim.claimed, false);
    assert.equal(claim.leaseToken, null);
    assert.equal(claim.reason, "exhausted");
  });

  it("claims next oldest-first and reports the delivery id", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.claim_next_notification_delivery")
        ? [{ delivery_id: DELIVERY, claimed: true, lease_token: LEASE, lease_expires_at: "2026-10-13T12:05:00Z", attempt_count: 1, reason: "claimed" }]
        : [],
    );
    const claim = await claimNextDelivery(sql);
    assert.equal(claim.deliveryId, DELIVERY);
    assert.equal(claim.claimed, true);
  });

  it("settles with the token and maps the outcome", async () => {
    const { sql, log } = fakeDb((text) =>
      text.includes("from app.resolve_notification_claim") ? [{ settled: true, reason: "sent" }] : [],
    );
    const out = await settleDelivery(sql, DELIVERY, LEASE, "sent", { providerMessageId: "FAKE_EMAIL_1" });
    assert.deepEqual(out, { settled: true, reason: "sent" });
    assert.doesNotMatch(log.join("\n"), /@/);
  });

  it("reports a stale token as unsettled, never as an error", async () => {
    const { sql } = fakeDb((text) =>
      text.includes("from app.resolve_notification_claim")
        ? [{ settled: false, reason: "invalid_or_expired_lease" }]
        : [],
    );
    const out = await settleDelivery(sql, DELIVERY, "wrong", "sent");
    assert.deepEqual(out, { settled: false, reason: "invalid_or_expired_lease" });
  });

  it("recovers an expired lease and refuses a live one", async () => {
    const recovered = fakeDb((text) =>
      text.includes("from app.recover_expired_notification_lease") ? [{ recovered: true, reason: "pending" }] : [],
    );
    assert.deepEqual(await recoverExpiredLease(recovered.sql, DELIVERY), { recovered: true, reason: "pending" });

    const live = fakeDb((text) =>
      text.includes("from app.recover_expired_notification_lease")
        ? [{ recovered: false, reason: "lease_still_valid" }]
        : [],
    );
    assert.deepEqual(await recoverExpiredLease(live.sql, DELIVERY), {
      recovered: false,
      reason: "lease_still_valid",
    });
  });
});
