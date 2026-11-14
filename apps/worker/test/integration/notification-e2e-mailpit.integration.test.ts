/**
 * notification-e2e-mailpit.integration.test.ts — M13.2 Phase 6A: the first end-to-end
 * notification test.
 *
 * One committed domain action travels the whole pipeline on the dedicated kolekto-itest
 * stack, and every hop is asserted:
 *
 *   app.create_member (real RPC, as the community owner)
 *     → public.audit_logs row (app.write_audit_log, same transaction)
 *     → trigger audit_log_notification_enqueue → pgmq notification_events message
 *     → processNotificationMessage (the real processor)
 *     → notification_events row + email notification_deliveries row (pending)
 *     → sendOneClaimed (the real sender: claim, L1-L5 reservation, render, settle)
 *     → MailpitEmailProvider → the test stack's Mailpit (exact match).
 *
 * What it does NOT exercise (accepted gaps, Phase 6 decisions Q6-2 / Q6-4): the inline
 * event loop in src/index.ts (pgmq.read → dead-letter → process → pgmq.delete) and the
 * runSenderTick gate in its ON state. The pause switch stays false and is only read;
 * sendOneClaimed does not consult it. No worker source is changed.
 *
 * Queue isolation (itest-queue.ts, decision Q6-1): the harness refuses to start a file
 * or a test unless pgmq notification_events is empty (queued and read). The test reads
 * only the message of the community it created, processes it, and ARCHIVES (never
 * deletes) exactly that message through archiveOwnQueueMessage, which re-checks
 * ownership in the database. afterEach archives any message a failed test left queued
 * for its own communities (harness.recoverOwnQueue) and quarantines its open email rows.
 *
 * Permanent residue (decision Q6-3): the committed audit_logs and notification_events
 * rows are append-only and stay on the test stack, run-tagged by their community. The
 * archived queue message stays in pgmq.a_notification_events as evidence.
 *
 * SMTP FILE (itest-lane.ts SMTP_INTEGRATION_FILES): the one test here sends one message
 * to the test Mailpit and costs one transactional grant. The lane starts this file only
 * with `--with-smtp`, which needs its own approval (Phase 6B).
 *
 * Integration lane only — `npm run test:integration --workspace apps/worker -- --with-smtp`.
 * The database, SMTP and Mailpit API endpoints all come from gate.verified(); there is no
 * default and no developer fallback (test/integration/README.md).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type postgres from "postgres";

import { MailpitEmailProvider, type EmailProvider, type EmailSendRequest } from "@kolekto/adapters";

import { processNotificationMessage } from "../../src/notification-processor.ts";
import { eventKey } from "../../src/notification-rules.ts";
import { emailDedupeKey } from "../../src/notification-eligibility.ts";
import { sendOneClaimed, type SenderOptions } from "../../src/notification-sender.ts";
import { isEmailSendingEnabled } from "../../src/notification-sender-state.ts";
import { buildEmailMessage } from "../../src/notification-send-message.ts";

import { connectVerified, liveGateDeps, type ItestSql } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createCommunityFixture, createFileHarness, readDelivery, waitForL5Headroom } from "../support/itest-isolation.ts";
import {
  checkMessageContent,
  expectedMessageId,
  findExactMessages,
  selectExactlyOne,
  type ExpectedMessage,
  type MailpitListEntry,
} from "../support/itest-mailpit.ts";
import { pollBounded, PollTimeout, realClock } from "../support/itest-mutex.ts";
import {
  archiveOwnQueueMessage,
  findOwnQueueMessages,
  readArchivedQueueMessage,
  readQueueState,
  waitForOwnQueueMessage,
} from "../support/itest-queue.ts";

// ── Environment gate and harness ──────────────────────────────────────────────

// Fail-closed gate (test/support/itest-gate.ts): verify() refuses — and every test in
// this file fails, none skips — unless the run came through `npm run test:integration`
// and the live identity of the dedicated kolekto-itest stack checked out. Every
// connection below is opened with connectVerified(gate.verified(), …).
const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "e2e-mailpit");
const { scope } = harness;

/** The test stack's Mailpit API origin and SMTP listener, from the verified environment only. */
const mailpitApi = () => gate.verified().mailpitApi.origin;
const smtpEndpoint = () => gate.verified().smtp;

const EMAIL_FROM = "noreply@kolekto.test";
const COMMUNITY_NAME = "E2E Integration Test";
const OWNER_NAME = "E2E Owner";

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

// ── Provider ─────────────────────────────────────────────────────────────────

function mailpitProvider(): MailpitEmailProvider {
  return new MailpitEmailProvider({ host: smtpEndpoint().host, port: smtpEndpoint().port, from: EMAIL_FROM });
}

/** Wraps a provider and counts send() calls, so the test can prove the provider was called exactly once. */
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

// ── Reads (read-only, scoped by the run-unique community) ─────────────────────

interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_user_id: string | null;
  object_type: string;
  object_id: string | null;
}

interface EventRow {
  id: string;
  event_type: string;
  event_key: string;
  actor_user_id: string | null;
  object_id: string;
  payload: Record<string, unknown>;
}

interface DeliveryRowFull {
  id: string;
  notification_event_id: string;
  channel: string;
  status: string;
  error_code: string | null;
  recipient_address: string | null;
  recipient_address_assurance: string | null;
  recipient_user_id: string | null;
  dedupe_key: string | null;
  send_class: string;
  attempt_count: number;
  provider_message_id: string | null;
}

function auditRows(sql: ItestSql, communityId: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select id::text as id, action, actor_type::text as actor_type, actor_user_id::text as actor_user_id,
           object_type, object_id::text as object_id
    from public.audit_logs where community_id = ${communityId}::uuid order by created_at, id`;
}

function eventRows(sql: ItestSql, communityId: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    select id::text as id, event_type, event_key, actor_user_id::text as actor_user_id, object_id::text as object_id, payload
    from public.notification_events where community_id = ${communityId}::uuid order by created_at, id`;
}

function deliveryRows(sql: ItestSql, communityId: string): Promise<DeliveryRowFull[]> {
  return sql<DeliveryRowFull[]>`
    select id::text as id, notification_event_id::text as notification_event_id, channel::text as channel,
           status::text as status, error_code, recipient_address, recipient_address_assurance,
           recipient_user_id::text as recipient_user_id, dedupe_key, send_class, attempt_count, provider_message_id
    from public.notification_deliveries where community_id = ${communityId}::uuid order by created_at, id`;
}

/** A run-unique Nigerian mobile number (E.164) for the member; the community is run-unique anyway. */
function runScopedPhone(): string {
  return `+2348095${String(Number.parseInt(scope.runTag.slice(0, 5), 16) % 1_000_000).padStart(6, "0")}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════

describe("M13.2 Phase 6A — end-to-end notification pipeline to Mailpit", () => {
  before(async () => {
    await gate.verify();
    await harness.start();
  });
  beforeEach(() => harness.checkpoint());
  afterEach(async () => {
    // Archive (never delete) anything this test left queued, then quarantine its open rows.
    await harness.recoverOwnQueue();
    await harness.quarantineOwn();
  });
  after(async () => {
    try {
      await harness.finish();
    } finally {
      await gate.postflight();
    }
  });

  it("member.create: audit → trigger → queue → processor → delivery → sender → Mailpit, once, and replay-safe", async () => {
    const sql = connectVerified(gate.verified(), { max: 2 });
    try {
      // ── 0. Pause switch is OFF (read only; never written) ─────────────────────
      assert.equal(await isEmailSendingEnabled(sql), false, "pause switch must remain OFF");

      // ── 1. Committed run-unique fixture: owner, community, owner term ─────────
      const c = await createCommunityFixture(sql, harness, { ownerName: OWNER_NAME, communityName: COMMUNITY_NAME, ownerTerm: true });
      assert.ok(harness.testOwner.owns(c.communityId), "the community belongs to this test");
      const to = scope.address();
      const memberName = `E2E Member ${scope.runTag}`;
      const memberPhone = runScopedPhone();

      // ── 2. The real domain operation, committed, as the authenticated owner ───
      const memberId = await sql.begin(async (raw) => {
        const tx = raw as unknown as postgres.TransactionSql<Record<string, never>>;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: c.ownerId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [row] = await tx<{ id: string }[]>`
          select app.create_member(${c.communityId}::uuid, ${memberName}::text, ${memberPhone}::text, ${to}::extensions.citext)::text as id`;
        const id = row?.id;
        if (typeof id !== "string" || id.length === 0) throw new Error("create_member returned no member id");
        return id;
      });

      // ── 3. Audit hop: exactly one audit row for this community ────────────────
      const audits = await auditRows(sql, c.communityId);
      assert.equal(audits.length, 1, "exactly one audit row for this community");
      const audit = audits[0]!;
      assert.equal(audit.action, "member.create");
      assert.equal(audit.actor_type, "officer");
      assert.equal(audit.actor_user_id, c.ownerId);
      assert.equal(audit.object_type, "member");
      assert.equal(audit.object_id, memberId);

      // ── 4. Trigger + queue hop: bounded poll for this community's one message ─
      const queued = await waitForOwnQueueMessage(sql, harness.testOwner, c.communityId);
      const msg = queued.message;
      assert.equal(msg["action"], "member.create", "queued action");
      assert.equal(msg["community_id"], c.communityId, "queued community");
      assert.equal(msg["actor_type"], "officer", "queued actor type");
      assert.equal(msg["actor_user_id"], c.ownerId, "queued actor is the owner");
      assert.equal(msg["object_type"], "member", "queued object type");
      assert.equal(msg["object_id"], memberId, "queued object is the returned member id");
      assert.equal(msg["audit_log_id"], audit.id, "the message carries the audit row's id");
      assert.equal(queued.readCount, 0, "nothing has read the message");
      assert.deepEqual(await readQueueState(sql), { queued: 1, readMessages: 0 }, "the queue holds only this test's message");
      assert.ok(!JSON.stringify(msg).includes(memberPhone), "no phone number in the queued message");

      // ── 5. Processor hop: the real processor on the real message ─────────────
      const processed = await processNotificationMessage(sql as unknown as postgres.Sql, { ...msg });
      assert.equal(processed.outcome, "processed", `processor outcome (got ${JSON.stringify(processed)})`);
      assert.ok(processed.outcome === "processed");
      assert.deepEqual(processed.email, { kind: "pending" }, "an email row was created pending");

      // ── 6. Acknowledge: archive exactly this test's message, nothing else ────
      await archiveOwnQueueMessage(sql, harness.testOwner, queued);
      assert.deepEqual(await readQueueState(sql), { queued: 0, readMessages: 0 }, "the queue is empty after the acknowledgement");
      assert.deepEqual(await findOwnQueueMessages(sql, harness.testOwner, [c.communityId]), [], "no message left for this community");
      const archived = await readArchivedQueueMessage(sql, harness.testOwner, queued);
      assert.ok(archived !== null, "the processed message is kept in the archive as evidence");
      assert.equal(archived["audit_log_id"], audit.id, "the archived copy is this test's message");

      // ── 7. Event and delivery rows written by the processor ──────────────────
      const events = await eventRows(sql, c.communityId);
      assert.equal(events.length, 1, "exactly one notification event");
      const event = events[0]!;
      assert.equal(event.event_type, "member.create");
      assert.equal(event.event_key, eventKey("member.create", memberId, audit.id));
      assert.equal(event.actor_user_id, c.ownerId);
      assert.equal(event.object_id, memberId);
      const payloadText = JSON.stringify(event.payload);
      assert.ok(!payloadText.includes("@"), "no address in the event payload");
      assert.ok(!payloadText.includes(memberPhone), "no phone number in the event payload");
      assert.equal(event.payload["community_name"], COMMUNITY_NAME, "the payload names the community");
      assert.equal(typeof event.payload["member_code"], "string", "the payload carries the member code");

      const deliveries = await deliveryRows(sql, c.communityId);
      assert.equal(deliveries.length, 1, "exactly one delivery (the member has no account: no in-app row)");
      const delivery = deliveries[0]!;
      assert.equal(delivery.notification_event_id, event.id);
      assert.equal(delivery.channel, "email");
      assert.equal(delivery.status, "pending");
      assert.equal(delivery.error_code, null);
      assert.equal(delivery.recipient_address, to, "the supplied run-scoped address");
      assert.equal(delivery.recipient_address_assurance, "unverified_supplied");
      assert.equal(delivery.recipient_user_id, null, "no account is linked");
      assert.equal(delivery.dedupe_key, emailDedupeKey("member.create", memberId));
      assert.equal(delivery.send_class, "transactional");
      assert.equal(delivery.attempt_count, 0);
      assert.equal(delivery.provider_message_id, null);

      // ── 8. Sender hop: send only this delivery to the test Mailpit ───────────
      assert.equal(await isEmailSendingEnabled(sql), false, "pause switch still OFF before the send");
      const provider = countingProvider(mailpitProvider());
      await waitForL5Headroom(sql);
      const step = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(step.outcome, "sent", `sender outcome (got ${JSON.stringify(step)})`);
      assert.ok(step.outcome === "sent");
      assert.equal(step.deliveryId, delivery.id, "the sender claimed this test's delivery");
      assert.equal(step.providerMessageId, expectedMessageId(delivery.id), "provider Message-ID is derived from the delivery id");
      assert.equal(provider.calls(), 1);

      const settled = await readDelivery(sql, delivery.id);
      assert.equal(settled.status, "sent");
      assert.equal(settled.error_code, null);
      assert.equal(settled.attempt_count, 1);
      assert.equal(settled.provider_message_id, step.providerMessageId, "provider_message_id stored");
      assert.equal(settled.send_lease_token, null, "lease released");
      assert.equal(settled.send_lease_expires_at, null, "lease expiry cleared");

      // ── 9. Mailpit: exactly one message, rendered subject and content ────────
      const rendered = buildEmailMessage(to, { eventType: event.event_type, payload: event.payload });
      const expected: ExpectedMessage = { to, subject: rendered.subject, messageId: expectedMessageId(delivery.id), runTag: scope.runTag };
      const mail = await waitForExactlyOne(expected);
      assert.equal(mail.Subject, rendered.subject, "the rendered subject");
      assert.ok(mail.Subject.includes(COMMUNITY_NAME), "subject names the community");
      const full = await mailpitMessage(mail.ID);
      assert.equal(full.From?.Address, EMAIL_FROM, "from address");
      const memberCode = String(event.payload["member_code"]);
      checkMessageContent(full, { id: mail.ID, text: [COMMUNITY_NAME, memberCode], html: [COMMUNITY_NAME, memberCode] });

      // ── 10. Replay the processor message: no new event, no new delivery ──────
      await processNotificationMessage(sql as unknown as postgres.Sql, { ...msg });
      assert.equal((await eventRows(sql, c.communityId)).length, 1, "replay created no duplicate event");
      const afterReplay = await deliveryRows(sql, c.communityId);
      assert.equal(afterReplay.length, 1, "replay created no duplicate delivery");
      assert.equal(afterReplay[0]!.status, "sent", "replay left the sent row terminal");
      assert.equal(afterReplay[0]!.attempt_count, 1);
      assert.deepEqual(await readQueueState(sql), { queued: 0, readMessages: 0 }, "replay enqueued nothing");
      assert.equal((await auditRows(sql, c.communityId)).length, 1, "replay wrote no audit row");

      // ── 11. Sender again: claims nothing, sends nothing ──────────────────────
      const replay = await sendOneClaimed(sql, senderOpts(provider));
      assert.equal(replay.outcome, "empty", "nothing left to claim");
      assert.equal(provider.calls(), 1, "the provider was called exactly once");
      selectExactlyOne(await mailpitSearchTo(to), expected);

      // ── 12. Pause switch unchanged ────────────────────────────────────────────
      assert.equal(await isEmailSendingEnabled(sql), false, "pause switch still OFF after the test");
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
