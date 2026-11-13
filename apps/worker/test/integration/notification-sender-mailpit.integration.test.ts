/**
 * notification-sender-mailpit.integration.test.ts — M13.2 P8 sender integration tests
 * (formerly notification-pipeline.integration.test.ts; renamed per review §4.3 because no
 * test here runs the processor-to-sender pipeline).
 *
 * Verifies the SENDER against real local infrastructure:
 *   Delivery claim → Rate-limit reservation → Send context → Template rendering
 *   → Email adapter → Mailpit SMTP → Delivery state settlement.
 *
 * Every test inserts its notification_event and notification_delivery rows
 * directly (addEmailDelivery). No test here runs the audit-queue read or the
 * processor (`processNotificationMessage`); the processor has its own unit and
 * integration tests. No P8 test covers the processor-to-sender handoff.
 *
 * SMTP FILE (itest-lane.ts SMTP_INTEGRATION_FILES): every test here opens an SMTP
 * connection — D1, D2 and E4 to the test stack's Mailpit, E9 to a closed loopback
 * port. The lane starts this file only with `--with-smtp`, which needs its own
 * approval (Phase 5). `--without-smtp` lists and checks it but never starts it.
 *
 * M13.2 Phase 1c moved E1/E2/E3/E8 to notification-processor.test.ts, removed E5,
 * E10 and S1, and moved S2/S3 to notification-sender.test.ts. Phase 4 moved D3, E6
 * and E7 (no SMTP) to notification-sender.integration.test.ts and converted the rest:
 *   - run-unique ids, slugs, event keys and recipients (createRunScope); the shared
 *     P8 ids and addresses are never used again (review §4.4, Q-D);
 *   - no cleanup deletes, no trigger toggles, no Mailpit delete-all; afterEach
 *     quarantines this run's open rows (itest-isolation.ts);
 *   - Mailpit is matched exactly — run-scoped recipient, rendered subject and the
 *     Message-ID derived from the delivery id (itest-mailpit.ts) — by a bounded poll,
 *     never by inbox totals or a fixed sleep;
 *   - every reservation waits for real L5 headroom first (no ledger wipe).
 * Phase 4 did NOT run this file: its conversion is unverified until Phase 5.
 *
 * Uses the REAL database, REAL Mailpit SMTP adapter, and the REAL Mailpit of
 * the dedicated kolekto-itest stack. The email pause switch (`email_sending_enabled`)
 * remains OFF throughout and is never written: the test calls `sendOneClaimed`
 * directly, which bypasses the pause-switch check (only `runSenderTick` gates on it).
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker -- --with-smtp`.
 * The database, SMTP and Mailpit API endpoints all come from gate.verified() (the
 * KOLEKTO_ITEST_* set); there is no default and no developer fallback. Without a
 * verified test-stack environment the gate refuses and every test fails
 * (test/integration/README.md).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { MailpitEmailProvider, type EmailProvider, type EmailSendRequest } from "@kolekto/adapters";

import { sendOneClaimed, type SenderOptions } from "../../src/notification-sender.ts";
import { isEmailSendingEnabled } from "../../src/notification-sender-state.ts";
import { buildEmailMessage } from "../../src/notification-send-message.ts";

import { connectVerified, liveGateDeps } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import {
  addEmailDelivery,
  createCommunityFixture,
  createFileHarness,
  readDelivery,
  waitForL5Headroom,
  type CommunityFixture,
} from "../support/itest-isolation.ts";
import {
  assertNoMessageTo,
  checkMessageContent,
  expectedMessageId,
  findExactMessages,
  selectExactlyOne,
  type ExpectedMessage,
  type MailpitListEntry,
} from "../support/itest-mailpit.ts";
import { pollBounded, PollTimeout, realClock } from "../support/itest-mutex.ts";

// ── Environment gate ──────────────────────────────────────────────────────────

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "sender-mailpit");
const { scope } = harness;

/** The test stack's Mailpit API origin and SMTP listener, from the verified environment only. */
const mailpitApi = () => gate.verified().mailpitApi.origin;
const smtpEndpoint = () => gate.verified().smtp;

const EMAIL_FROM = "noreply@kolekto.test";

// ── Mailpit HTTP helpers (read-only GETs; nothing is ever deleted) ────────────

/** Narrow the inbox to one run-scoped recipient; correctness comes from the exact client-side match. */
async function mailpitSearchTo(address: string): Promise<unknown> {
  const res = await fetch(`${mailpitApi()}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  assert.equal(res.status, 200, "Mailpit search answered");
  return res.json();
}

async function mailpitMessage(id: string): Promise<{ From?: { Address?: string } } & Record<string, unknown>> {
  const res = await fetch(`${mailpitApi()}/api/v1/message/${encodeURIComponent(id)}`);
  assert.equal(res.status, 200, "Mailpit message read answered");
  return res.json() as Promise<{ From?: { Address?: string } } & Record<string, unknown>>;
}

/** Bounded poll until exactly one message matches recipient, subject and Message-ID. */
async function waitForExactlyOne(expected: ExpectedMessage): Promise<MailpitListEntry> {
  let last: unknown = { messages: [] };
  try {
    const r = await pollBounded<MailpitListEntry>(
      { label: "Mailpit exact match", timeoutMs: 10_000, intervalMs: 200, clock: realClock },
      async () => {
        last = await mailpitSearchTo(expected.to);
        const exact = findExactMessages(last, expected);
        if (exact.length > 1) return { done: true, value: selectExactlyOne(last, expected) }; // throws MAILPIT_AMBIGUOUS
        return exact.length === 1 ? { done: true, value: exact[0]! } : { done: false };
      },
    );
    return r.value;
  } catch (error) {
    if (error instanceof PollTimeout) return selectExactlyOne(last, expected); // throws MAILPIT_NO_MATCH with counts
    throw error;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function seedBase(sql: Parameters<typeof createCommunityFixture>[0]): Promise<CommunityFixture> {
  return createCommunityFixture(sql, harness, { ownerName: "P8 Owner", communityName: "P8 Integration Test", ownerTerm: true });
}

function memberCreatePayload(c: CommunityFixture, memberCode = "P8/001"): Record<string, unknown> {
  return {
    actor_name: "P8 Owner",
    community_id: c.communityId,
    member_name: "Synthetic Member",
    member_code: memberCode,
    community_name: "P8 Integration Test",
    community_slug: c.slug,
  };
}

// ── Provider ─────────────────────────────────────────────────────────────────

function mailpitProvider(): MailpitEmailProvider {
  return new MailpitEmailProvider({
    host: smtpEndpoint().host,
    port: smtpEndpoint().port,
    from: EMAIL_FROM,
  });
}

/** Wraps a provider and counts send() calls, so a test can prove the provider was (not) called. */
function countingProvider(inner: EmailProvider): EmailProvider & { readonly calls: () => number } {
  let calls = 0;
  return {
    name: inner.name,
    idempotency: inner.idempotency,
    send: (request: EmailSendRequest) => {
      calls++;
      return inner.send(request);
    },
    calls: () => calls,
  };
}

const halfRng = () => 0.5;
function senderOpts(provider: EmailProvider): SenderOptions {
  return { provider, now: () => Date.now(), rng: halfRng };
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════

describe("M13.2 P8 — sender-to-Mailpit integration", () => {
  // The pause switch is read (never written) before and after this file by the gate;
  // that replaces the former E10 and S1 tests.
  before(async () => {
    await gate.verify();
    await harness.start();
  });
  beforeEach(() => harness.checkpoint());
  afterEach(() => harness.quarantineOwn());
  after(async () => {
    try {
      await harness.finish();
    } finally {
      await gate.postflight();
    }
  });

  describe("claim → reserve → render → SMTP → settle (rows inserted directly)", () => {

    it("D1: sends a member.create email and settles the row as sent, once", async () => {
      const sql = connectVerified(gate.verified(), { max: 2 });
      try {
        const c = await seedBase(sql);
        const provider = countingProvider(mailpitProvider());
        const to = scope.address();
        const payload = memberCreatePayload(c);

        // 1. Insert the event and delivery rows directly (the processor is not exercised).
        const { deliveryId } = await addEmailDelivery(sql, scope, c, { address: to, eventType: "member.create", payload });

        // 2. Verify pause switch is OFF (read only)
        assert.equal(await isEmailSendingEnabled(sql), false, "pause switch must remain OFF");

        // 3. Send via the real Mailpit adapter (sendOneClaimed does not consult the pause switch)
        await waitForL5Headroom(sql);
        const step = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(step.outcome, "sent", "delivery sent successfully");
        assert.ok(step.outcome === "sent");
        assert.equal(step.deliveryId, deliveryId);
        assert.equal(step.providerMessageId, expectedMessageId(deliveryId), "provider message id is the Message-ID derived from the delivery id");

        // 4. Verify delivery state transitions
        const row = await readDelivery(sql, deliveryId);
        assert.equal(row.status, "sent");
        assert.equal(row.error_code, null);
        assert.equal(row.attempt_count, 1);
        assert.equal(row.provider_message_id, step.providerMessageId, "provider_message_id stored");
        assert.equal(row.send_lease_token, null, "lease released after send");

        // 5. Exactly one message for this recipient, subject and Message-ID
        const rendered = buildEmailMessage(to, { eventType: "member.create", payload });
        const expected: ExpectedMessage = { to, subject: rendered.subject, messageId: expectedMessageId(deliveryId), runTag: scope.runTag };
        const msg = await waitForExactlyOne(expected);

        // 6. Verify message content
        assert.ok(msg.Subject.includes("added to"), `subject contains 'added to' (got: ${msg.Subject})`);
        assert.ok(msg.Subject.includes("P8 Integration Test"), "subject contains community name");

        // 7. Verify sender, HTML and plain-text via full message read
        const full = await mailpitMessage(msg.ID);
        assert.equal(full.From?.Address, EMAIL_FROM, "from address is correct");
        checkMessageContent(full, { id: msg.ID, text: ["P8 Integration Test", "P8/001"], html: ["P8 Integration Test", "P8/001"] });

        // 8. Verify no duplicate: the replay claims nothing, so it never reserves or sends.
        const replay = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(replay.outcome, "empty", "sent row is terminal — no duplicate claim");
        assert.equal(provider.calls(), 1, "the provider was called exactly once");
        selectExactlyOne(await mailpitSearchTo(to), expected);

        // 9. Confirm pause switch still OFF
        assert.equal(await isEmailSendingEnabled(sql), false, "pause switch still OFF after test");
      } finally {
        await sql.end({ timeout: 2 });
      }
    });

    it("D2: renders and sends an officer_invitation.accept email", async () => {
      const sql = connectVerified(gate.verified(), { max: 2 });
      try {
        const c = await seedBase(sql);
        const provider = mailpitProvider();
        const to = c.ownerEmail;
        const payload = {
          actor_name: "P8 Owner",
          community_id: c.communityId,
          officer_role: "treasurer",
          community_name: "P8 Integration Test",
          community_slug: c.slug,
        };

        const { deliveryId } = await addEmailDelivery(sql, scope, c, { address: to, eventType: "officer_invitation.accept", payload });

        await waitForL5Headroom(sql);
        const step = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(step.outcome, "sent");
        assert.equal(step.outcome === "sent" && step.deliveryId, deliveryId);

        const rendered = buildEmailMessage(to, { eventType: "officer_invitation.accept", payload });
        const msg = await waitForExactlyOne({ to, subject: rendered.subject, messageId: expectedMessageId(deliveryId), runTag: scope.runTag });
        assert.ok(msg.Subject.includes("treasurer"), "subject contains the officer role");
        assert.ok(msg.Subject.includes("P8 Integration Test"), "subject contains community name");

        const full = await mailpitMessage(msg.ID);
        checkMessageContent(full, { id: msg.ID, text: ["treasurer"], html: ["treasurer"] });

        const row = await readDelivery(sql, deliveryId);
        assert.equal(row.status, "sent");
      } finally {
        await sql.end({ timeout: 2 });
      }
    });

    it("E4: a sent row is terminal — a second sender call claims nothing and does not call the provider", async () => {
      const sql = connectVerified(gate.verified(), { max: 2 });
      try {
        const c = await seedBase(sql);
        const provider = countingProvider(mailpitProvider());
        const to = scope.address();
        const payload = memberCreatePayload(c);

        const { deliveryId } = await addEmailDelivery(sql, scope, c, { address: to, eventType: "member.create", payload });

        await waitForL5Headroom(sql);
        const first = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(first.outcome, "sent");
        assert.equal(first.outcome === "sent" && first.deliveryId, deliveryId);
        assert.equal(provider.calls(), 1, "the first call sent exactly once");

        // No ledger clearing: the replay returns `empty` before it reserves.
        const second = await sendOneClaimed(sql, senderOpts(provider));
        assert.equal(second.outcome, "empty", "a sent row is terminal");
        assert.equal(provider.calls(), 1, "the replay did not call the provider");

        const row = await readDelivery(sql, deliveryId);
        assert.equal(row.status, "sent");
        assert.equal(row.attempt_count, 1, "exactly one attempt");

        const rendered = buildEmailMessage(to, { eventType: "member.create", payload });
        await waitForExactlyOne({ to, subject: rendered.subject, messageId: expectedMessageId(deliveryId), runTag: scope.runTag });
      } finally {
        await sql.end({ timeout: 2 });
      }
    });

    it("E9: an SMTP-unreachable adapter schedules a transient retry (provider_unreachable) and nothing is settled as sent", async () => {
      // Nothing listens on this loopback port: the connection fails before DATA, so the adapter
      // throws EmailProviderError("transient", "provider_unreachable", …, ambiguous = false)
      // (mailpit-email-provider.ts), and classifyFailure retries attempt 1 of 3.
      // No try/catch: any unexpected throw or outcome fails this test.
      const badProvider = new MailpitEmailProvider({
        host: "127.0.0.1",
        port: 59999,
        from: EMAIL_FROM,
      });

      const sql = connectVerified(gate.verified(), { max: 2 });
      try {
        const c = await seedBase(sql);
        const to = scope.address();
        const { deliveryId } = await addEmailDelivery(sql, scope, c, { address: to, eventType: "member.create", payload: memberCreatePayload(c) });

        await waitForL5Headroom(sql);
        const startedAt = Date.now();
        const step = await sendOneClaimed(sql, senderOpts(badProvider));
        assert.equal(step.outcome, "retry", `adapter failure must be a scheduled retry (got ${step.outcome})`);
        assert.ok(step.outcome === "retry");
        assert.equal(step.deliveryId, deliveryId, "the retried row is this test's row");
        assert.equal(step.errorCode, "provider_unreachable");
        assert.ok(Date.parse(step.nextRetryAt) > startedAt, "next retry is scheduled in the future");

        const row = await readDelivery(sql, deliveryId);
        assert.equal(row.status, "pending", "a retry returns the row to pending");
        assert.equal(row.error_code, "provider_unreachable");
        assert.equal(row.attempt_count, 1, "the attempt stays consumed");
        assert.equal(row.send_lease_token, null, "lease released");
        assert.equal(row.provider_message_id, null, "nothing was accepted");
        assert.ok(row.next_retry_at, "next_retry_at is set");
        const delayMs = Date.parse(row.next_retry_at) - startedAt;
        // Attempt 1 backs off 5 minutes ±20% (the sender integration test's window), plus slack.
        assert.ok(delayMs >= 4 * 60_000 && delayMs <= 6 * 60_000 + 30_000, `delay ${delayMs}ms`);

        // Nothing reached the test Mailpit for this run-scoped recipient.
        assertNoMessageTo(await mailpitSearchTo(to), to, scope.runTag);
      } finally {
        await sql.end({ timeout: 2 });
      }
    });
  });
});
