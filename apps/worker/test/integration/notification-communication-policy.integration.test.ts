/**
 * notification-communication-policy.integration.test.ts — M13.3 against the real database.
 *
 * The central communication policy (apps/worker/src/communication-policy.ts) with the three M13.3
 * database proposals applied (communication policy, revised member announcements, R3 send-time
 * recheck). Accountless members, no consent values. Every test runs inside one transaction that is
 * rolled back (inRollback), uses run-unique ids (createRunScope) and holds the suite mutex, like
 * every integration file (test/integration/README.md).
 *
 * Integration lane only (`npm run test:integration -- --without-smtp`): it opens no SMTP connection,
 * never writes the pause switch and never calls a provider. The R2 test moved here from the processor
 * file at M13.3 R3 so that file's set_config guard (test/itest-acceptance.test.ts) stays at three.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type postgres from "postgres";

import { processNotificationMessage } from "../../src/notification-processor.ts";

import { connectVerified, liveGateDeps } from "../support/itest-db.ts";
import { createIntegrationGate } from "../support/itest-gate.ts";
import { createFileHarness, inRollback } from "../support/itest-isolation.ts";

const gate = createIntegrationGate(liveGateDeps());
const harness = createFileHarness(() => gate.verified(), "communication-policy");
const { scope } = harness;

type Tx = postgres.TransactionSql<Record<string, never>>;

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

describe("the M13.3 communication policy against the real database", () => {
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

  // M13.3 R2-verify: the worker's central policy against the database proposals
  // (M13.3-COMMUNICATION-POLICY + revised MEMBER-ANNOUNCEMENTS). Accountless
  // members, no consent values anywhere. Rolled back like every test here.
  it("M13.3 R2 — community email needs the notice attestation, honours opt-outs, never needs consent; transactional and payment rules unchanged", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    const evidence: Record<string, unknown> = {};
    try {
      await inRollback(sql, async (tx: Tx) => {
        const OWNER = scope.uuid();
        const COMMUNITY = scope.uuid();
        const TERM = scope.uuid();
        const COL_BEFORE = scope.uuid();
        const COL_AFTER = scope.uuid();
        const COL_UNPAID = scope.uuid();
        const OWNER_EMAIL = scope.address();
        const A_EMAIL = scope.address();
        const B_EMAIL = scope.address();

        await tx`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
          (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${OWNER_EMAIL}, now())`;
        await tx`insert into public.users (id, full_name, email) values (${OWNER}, 'R2 Owner', ${OWNER_EMAIL})
          on conflict (id) do update set full_name = excluded.full_name`;
        await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
          values (${COMMUNITY}, ${scope.slug()}, 'ITest R2', 'social_group', false, ${OWNER})`;
        await tx`insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason)
          values (${TERM}, ${COMMUNITY}, ${OWNER}, 'owner', 'R2 Owner', 'created')`;

        const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
          await tx`set local role authenticated`;
          try {
            return await fn();
          } finally {
            await tx`reset role`;
          }
        };

        // Three accountless members: A (email), B (email, will opt out), C (no email).
        const memberA = first(await asOwner(() => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, 'R2 Member A', '+2348095553001', ${A_EMAIL}) as id`)).id;
        const memberB = first(await asOwner(() => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, 'R2 Member B', '+2348095553002', ${B_EMAIL}) as id`)).id;
        const memberC = first(await asOwner(() => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, 'R2 Member C', '+2348095553003', null) as id`)).id;
        const consent = first(await tx<{ n: number }[]>`select count(*)::int as n from public.members where community_id = ${COMMUNITY} and consent_messages_at is not null`).n;
        assert.equal(consent, 0, "no member has any consent value");

        // B asked the organiser to stop community email (real function, officer path).
        await asOwner(() => tx`select app.record_member_communication_opt_out_on_request(${memberB}::uuid, 'community_operational', 'email', 'phone')`);

        for (const id of [COL_BEFORE, COL_AFTER, COL_UNPAID]) {
          await tx`insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, visibility, created_by, audience_mode)
            values (${id}, ${COMMUNITY}, ${scope.slug()}, 'ITest R2', 'dues', 'managed', 'fixed', 500000, 'draft', 'unlisted', ${OWNER}, 'all_members')`;
        }

        const messagesFor = async (action: string, objectId: string) =>
          tx<{ message: Record<string, unknown> }[]>`
            select message from pgmq.q_notification_events
            where message ->> 'community_id' = ${COMMUNITY} and message ->> 'action' = ${action} and message ->> 'object_id' = ${objectId}
            order by msg_id`;
        const emailRowsFor = async (objectId: string) =>
          tx<{ member: string; status: string; code: string | null; send_class: string; has_address: boolean; assurance: string | null }[]>`
            select d.recipient_member_id::text as member, d.status::text as status, d.error_code as code, d.send_class,
                   d.recipient_address is not null as has_address, d.recipient_address_assurance as assurance
            from public.notification_deliveries d
            join public.notification_events e on e.id = d.notification_event_id
            where d.community_id = ${COMMUNITY} and d.channel = 'email' and e.object_id = ${objectId}
            order by d.recipient_member_id`;
        const byMember = (rows: { member: string; status: string; code: string | null }[]) =>
          Object.fromEntries(rows.map((r) => [r.member === memberA ? "A" : r.member === memberB ? "B" : r.member === memberC ? "C" : r.member, `${r.status}:${r.code ?? "-"}`]));

        // ── 1. Not attested: nobody is pending; B's own opt-out is reported first.
        const attestedBefore = first(await tx<{ v: boolean }[]>`select app.community_communication_notice_attested(${COMMUNITY}::uuid) as v`).v;
        assert.equal(attestedBefore, false);
        await asOwner(() => tx`select app.publish_collection(${COL_BEFORE}::uuid, 'draft'::public.collection_status, null, 'all')`);
        for (const m of await messagesFor("collection.publish", COL_BEFORE)) {
          await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
        }
        const before = await emailRowsFor(COL_BEFORE);
        evidence["before_attestation"] = byMember(before);
        assert.deepEqual(byMember(before), { A: "skipped:community_notice_missing", B: "skipped:opted_out", C: "skipped:community_notice_missing" });
        assert.ok(before.every((r) => !r.has_address), "no address stored on any skipped row");

        // ── 2. The owner attests (real function). The worker detects it.
        await asOwner(() => tx`select app.attest_community_communication_notice(${COMMUNITY}::uuid, 'community-notice-v1')`);
        assert.equal(first(await tx<{ v: boolean }[]>`select app.community_communication_notice_attested(${COMMUNITY}::uuid) as v`).v, true);
        await asOwner(() => tx`select app.publish_collection(${COL_AFTER}::uuid, 'draft'::public.collection_status, null, 'all')`);
        for (const m of await messagesFor("collection.publish", COL_AFTER)) {
          await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
        }
        const after = await emailRowsFor(COL_AFTER);
        evidence["after_attestation"] = byMember(after);
        assert.deepEqual(byMember(after), { A: "pending:-", B: "skipped:opted_out", C: "skipped:no_recipient" });
        const a = after.find((r) => r.member === memberA)!;
        assert.equal(a.has_address, true);
        assert.equal(a.assurance, "unverified_supplied", "accountless member reached at the member-record address");
        assert.ok(after.every((r) => r.send_class === "bulk"), "community email is bulk");

        // ── 3. Payment-targeted publish: no email and no in-app delivery.
        await asOwner(() => tx`select app.publish_collection(${COL_UNPAID}::uuid, 'draft'::public.collection_status, null, 'unpaid')`);
        for (const m of await messagesFor("collection.publish_remind_unpaid", COL_UNPAID)) {
          await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
        }
        const unpaidRows = first(await tx<{ n: number }[]>`
          select count(*)::int as n from public.notification_deliveries d join public.notification_events e on e.id = d.notification_event_id
          where d.community_id = ${COMMUNITY} and e.object_id = ${COL_UNPAID}`).n;
        assert.equal(unpaidRows, 0, "no payment-targeted delivery of any kind");

        // ── 4. Transactional confirmations are unaffected by attestation and by B's community opt-out.
        for (const member of [memberA, memberB]) {
          for (const m of await messagesFor("member.create", member)) {
            await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
          }
        }
        const confirmations = await tx<{ member: string; status: string; send_class: string }[]>`
          select d.recipient_member_id::text as member, d.status::text as status, d.send_class
          from public.notification_deliveries d join public.notification_events e on e.id = d.notification_event_id
          where d.community_id = ${COMMUNITY} and d.channel = 'email' and e.event_type = 'member.create'
          order by d.recipient_member_id`;
        evidence["confirmations"] = confirmations.map((c) => `${c.member === memberA ? "A" : "B"}:${c.status}:${c.send_class}`);
        assert.equal(confirmations.length, 2);
        assert.ok(confirmations.every((c) => c.status === "pending" && c.send_class === "transactional"), "membership confirmations stay transactional and pending");

        // ── 5. Nothing anywhere in this community was sent; consent never appears.
        const sentOrConsent = first(await tx<{ n: number }[]>`
          select count(*)::int as n from public.notification_deliveries
          where community_id = ${COMMUNITY} and (status::text in ('sent', 'delivered') or error_code in ('consent_missing', 'legacy_consent_gate'))`).n;
        assert.equal(sentOrConsent, 0, "no email sent, no consent-based skip");
      });
      console.log("M13.3 R2 integration evidence:", JSON.stringify(evidence));
    } finally {
      await sql.end({ timeout: 2 });
    }
  });

  // M13.3 R3: the send-time recheck on the real claim → reserve path, over rows the real processor wrote.
  it("M13.3 R3 — withdrawals after queueing are honoured at send time; categories are recorded; essential is unaffected", async () => {
    const sql = connectVerified(gate.verified(), { max: 1 });
    const evidence: Record<string, unknown> = {};
    try {
      await inRollback(sql, async (tx: Tx) => {
        const OWNER = scope.uuid();
        const COMMUNITY = scope.uuid();
        const TERM = scope.uuid();
        const COL = scope.uuid();
        const OWNER_EMAIL = scope.address();

        await tx`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
          (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${OWNER_EMAIL}, now())`;
        await tx`insert into public.users (id, full_name, email) values (${OWNER}, 'R3 Owner', ${OWNER_EMAIL})
          on conflict (id) do update set full_name = excluded.full_name`;
        await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
          values (${COMMUNITY}, ${scope.slug()}, 'ITest R3', 'social_group', false, ${OWNER})`;
        await tx`insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason)
          values (${TERM}, ${COMMUNITY}, ${OWNER}, 'owner', 'R3 Owner', 'created')`;

        const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
          await tx`set local role authenticated`;
          try {
            return await fn();
          } finally {
            await tx`reset role`;
          }
        };

        // Five accountless members: Stays (eligible), Leaves (opts out after queueing), Moves (address
        // corrected after queueing), Essential (opts out of all community messages; gets a confirmation),
        // Later (claimed only after the attestation is revoked).
        const names = ["Stays", "Leaves", "Moves", "Essential", "Later"] as const;
        type Name = (typeof names)[number];
        const ids = {} as Record<Name, string>;
        let phone = 2348095554001;
        for (const n of names) {
          ids[n] = first(await asOwner(() => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, ${"R3 " + n}, ${"+" + String(phone++)}, ${scope.address()}) as id`)).id;
        }
        await asOwner(() => tx`select app.attest_community_communication_notice(${COMMUNITY}::uuid, 'community-notice-v1')`);
        await tx`insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, visibility, created_by, audience_mode)
          values (${COL}, ${COMMUNITY}, ${scope.slug()}, 'ITest R3', 'dues', 'managed', 'fixed', 500000, 'draft', 'unlisted', ${OWNER}, 'all_members')`;

        // ── Queue: publish → real trigger → real processor; and one membership confirmation.
        await asOwner(() => tx`select app.publish_collection(${COL}::uuid, 'draft'::public.collection_status, null, 'all')`);
        const queued = await tx<{ message: Record<string, unknown> }[]>`
          select message from pgmq.q_notification_events
          where message ->> 'community_id' = ${COMMUNITY} and message ->> 'object_id' = ${COL} and message ->> 'action' = 'collection.publish'`;
        for (const m of queued) await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
        const confirmation = first(await tx<{ message: Record<string, unknown> }[]>`
          select message from pgmq.q_notification_events
          where message ->> 'community_id' = ${COMMUNITY} and message ->> 'action' = 'member.create' and message ->> 'object_id' = ${ids.Essential}`);
        await processNotificationMessage(tx as unknown as postgres.TransactionSql, confirmation.message);

        const rows = await tx<{ id: string; member: string; status: string; category: string | null; event_type: string }[]>`
          select d.id::text as id, d.recipient_member_id::text as member, d.status::text as status,
                 d.communication_category as category, e.event_type
          from public.notification_deliveries d join public.notification_events e on e.id = d.notification_event_id
          where d.community_id = ${COMMUNITY} and d.channel = 'email'`;
        const label = (member: string) => Object.entries(ids).find(([, v]) => v === member)?.[0] ?? "?";
        evidence["queued"] = rows.map((r) => `${label(r.member)}:${r.event_type}:${r.status}:${r.category}`).sort();
        assert.ok(rows.filter((r) => r.event_type === "collection.publish").every((r) => r.category === "community_operational"), "the worker recorded community_operational on every announcement row");
        assert.ok(rows.filter((r) => r.event_type === "member.create").every((r) => r.category === "essential"), "and essential on the confirmation");
        const pendingRow = (n: Name, eventType: string): string => {
          const r = rows.find((x) => x.member === ids[n] && x.event_type === eventType && x.status === "pending");
          assert.ok(r, `${n} has a pending ${eventType} row`);
          return r.id;
        };
        const d = {
          Stays: pendingRow("Stays", "collection.publish"),
          Leaves: pendingRow("Leaves", "collection.publish"),
          Moves: pendingRow("Moves", "collection.publish"),
          EssentialAnnouncement: pendingRow("Essential", "collection.publish"),
          EssentialConfirmation: pendingRow("Essential", "member.create"),
          Later: pendingRow("Later", "collection.publish"),
        };

        // ── The world changes AFTER queueing.
        await asOwner(() => tx`select app.record_member_communication_opt_out_on_request(${ids.Leaves}::uuid, 'community_operational', 'email', 'phone')`);
        await asOwner(() => tx`select app.record_member_communication_opt_out_on_request(${ids.Essential}::uuid, 'community_operational', 'all', 'in_person')`);
        await tx`update public.members set email = ${scope.address()} where id = ${ids.Moves}`;

        // ── The sender's database path, as sendOneClaimed runs it: claim (row lock) → reserve (recheck first).
        const claimReserve = async (id: string): Promise<{ reservation: string; code: string | null; hasAddress: boolean }> => {
          const c = first(await tx<{ claimed: boolean; reason: string | null }[]>`select claimed, reason from app.claim_notification_delivery(${id}::uuid, 300)`);
          if (!c.claimed) return { reservation: `not_claimed:${c.reason}`, code: null, hasAddress: false };
          const r = first(await tx<{ reservation: string }[]>`select reservation from app.reserve_email_attempt(${id}::uuid)`).reservation;
          const row = first(await tx<{ code: string | null; has_address: boolean }[]>`select error_code as code, recipient_address is not null as has_address from public.notification_deliveries where id = ${id}`);
          return { reservation: r, code: row.code, hasAddress: row.has_address };
        };
        const out: Record<string, { reservation: string; code: string | null; hasAddress: boolean }> = {};
        for (const k of ["Stays", "Leaves", "Moves", "EssentialAnnouncement", "EssentialConfirmation"] as const) out[k] = await claimReserve(d[k]);

        await asOwner(() => tx`select app.revoke_community_communication_notice(${COMMUNITY}::uuid, 'attested_in_error')`);
        out["Later"] = await claimReserve(d.Later);
        evidence["send_time"] = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.reservation}:${v.code ?? "-"}`]));

        assert.equal(out["Stays"]!.reservation, "provider_daily_limited", "eligible: passes the recheck, then waits on the zero bulk cap — never sent");
        assert.deepEqual([out["Leaves"]!.reservation, out["Leaves"]!.code, out["Leaves"]!.hasAddress], ["ineligible", "opted_out", false], "an opt-out after queueing blocks the send and erases the address");
        assert.deepEqual([out["Moves"]!.reservation, out["Moves"]!.code], ["ineligible", "recipient_changed"], "a corrected address after queueing is not used");
        assert.deepEqual([out["EssentialAnnouncement"]!.reservation, out["EssentialAnnouncement"]!.code], ["ineligible", "opted_out"], "an all-channel community opt-out blocks the announcement");
        assert.equal(out["EssentialConfirmation"]!.reservation, "granted", "… but never the membership confirmation (essential)");
        assert.deepEqual([out["Later"]!.reservation, out["Later"]!.code], ["ineligible", "community_notice_missing"], "a revocation after queueing blocks the send");

        const sent = first(await tx<{ n: number }[]>`select count(*)::int as n from public.notification_deliveries where community_id = ${COMMUNITY} and status::text in ('sent', 'delivered')`).n;
        assert.equal(sent, 0, "nothing was sent");
      });
      console.log("M13.3 R3 integration evidence:", JSON.stringify(evidence));
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
