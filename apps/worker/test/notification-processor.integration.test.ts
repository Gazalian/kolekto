/**
 * notification-processor.integration.test.ts — the real database, end to end.
 *
 * Drives REAL audited domain functions under REAL roles, takes the queue messages the
 * REAL trigger produced, runs them through the REAL processor, and asserts on what the
 * database then holds. Everything happens inside one transaction that is rolled back, so
 * it leaves no trace in the database it runs against.
 *
 * OPT-IN, and local only. It runs when BOTH are true:
 *   KOLEKTO_WORKER_INTEGRATION=1, and SUPABASE_DB_URL points at this machine.
 * Otherwise every test here is reported as skipped. It is NOT part of the CI "typecheck
 * and unit tests" job, which has no database; the pgTAP suite covers the database side
 * in CI, and the unit tests in this folder cover the processor's decisions. Run locally:
 *
 *   KOLEKTO_WORKER_INTEGRATION=1 SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test --workspace apps/worker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import postgres from "postgres";

import { processNotificationMessage } from "../src/notification-processor.ts";

const URL_ENV = process.env["SUPABASE_DB_URL"] ?? "";
const IS_LOOPBACK = (() => {
  try {
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(URL_ENV).hostname);
  } catch {
    return false;
  }
})();
const ENABLED = process.env["KOLEKTO_WORKER_INTEGRATION"] === "1" && IS_LOOPBACK;
const SKIP = ENABLED ? false : "set KOLEKTO_WORKER_INTEGRATION=1 and a loopback SUPABASE_DB_URL to run";

class Rollback extends Error {}

const OWNER = "b1000000-0000-4000-8000-000000000001";
const ADMIN = "b1000000-0000-4000-8000-000000000002";
const COMMUNITY = "b2000000-0000-4000-8000-00000000000a";
const OWNER_TERM = "b3000000-0000-4000-8000-000000000001";
const ADMIN_TERM = "b3000000-0000-4000-8000-000000000002";

type Tx = postgres.TransactionSql<Record<string, never>>;

function first<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

describe("the processor against the real database", { skip: SKIP }, () => {
  it("handles the approved events end to end, writes no email row, and is replay-safe", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 1 });
    const evidence: Record<string, unknown> = {};
    try {
      await sql
        .begin(async (rawTx) => {
          const tx = rawTx as unknown as Tx;

          // ── fixtures ──────────────────────────────────────────────────────────
          await tx`insert into auth.users (id, instance_id, aud, role, email) values
            (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@itest.example.test'),
            (${ADMIN}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@itest.example.test')`;
          await tx`insert into public.users (id, full_name, email) values
            (${OWNER}, 'It Owner', 'owner@itest.example.test'), (${ADMIN}, 'It Admin', 'admin@itest.example.test')
            on conflict (id) do update set full_name = excluded.full_name`;
          await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
            values (${COMMUNITY}, 'itest-worker', 'ITest Worker', 'social_group', false, ${OWNER})`;
          await tx`insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
            (${OWNER_TERM}, ${COMMUNITY}, ${OWNER}, 'owner', 'It Owner', 'created'),
            (${ADMIN_TERM}, ${COMMUNITY}, ${ADMIN}, 'admin', 'It Admin', 'invited')`;

          const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
            await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: "authenticated" })}, true)`;
            await tx`set local role authenticated`;
            try {
              return await fn();
            } finally {
              await tx`reset role`;
            }
          };
          const asAnon = async <T>(fn: () => Promise<T>): Promise<T> => {
            await tx`set local role anon`;
            try {
              return await fn();
            } finally {
              await tx`reset role`;
            }
          };

          // ── real domain actions ────────────────────────────────────────────────
          const created = first(
            await asOwner(
              () => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, 'Manually Added', '+2348095551001', 'added@example.com') as id`,
            ),
          ).id;

          // A member who is archived before the event is processed (decision record F-3): nothing to tell anyone.
          const toArchive = first(
            await asOwner(
              () => tx<{ id: string }[]>`select app.create_member(${COMMUNITY}::uuid, 'To Archive', '+2348095551004', 'archive.me@example.com') as id`,
            ),
          ).id;
          await asOwner(() => tx`select app.archive_member(${toArchive}::uuid, 'integration test')`);

          const token = first(
            await asOwner(
              () => tx<{ token: string }[]>`select token from app.create_invite_link(${COMMUNITY}::uuid, '{}'::uuid[], false, false, true)`,
            ),
          ).token;

          const toReject = first(
            await asAnon(
              () => tx<{ member_id: string }[]>`select member_id from app.redeem_invite_link(${token}, 'Reject Me', '+2348095551002', 'reject.me@example.com')`,
            ),
          ).member_id;
          const toApprove = first(
            await asAnon(
              () => tx<{ member_id: string }[]>`select member_id from app.redeem_invite_link(${token}, 'Approve Me', '+2348095551003', 'approve.me@example.com')`,
            ),
          ).member_id;

          // A joiner still awaiting approval when the event is processed: officers MUST still hear someone applied.
          const toPending = first(
            await asAnon(
              () => tx<{ member_id: string }[]>`select member_id from app.redeem_invite_link(${token}, 'Still Pending', '+2348095551005', 'pending@example.com')`,
            ),
          ).member_id;

          await asOwner(() => tx`select app.reject_pending_member(${toReject}::uuid, 'officer free text: looks fake')`);
          await asOwner(() => tx`select app.approve_pending_member(${toApprove}::uuid)`);
          await asOwner(() => tx`select app.end_officer_term(${ADMIN_TERM}::uuid, 'integration test')`);

          // A repair run silently by an operator: suppressed, so it must produce no message.
          await tx`select app.begin_notification_suppression('integration repair')`;
          const silent = first(
            await tx<{ id: string }[]>`
              select app.write_audit_log(${COMMUNITY}::uuid, 'officer', ${OWNER}::uuid, 'member.create', 'member', gen_random_uuid()) as id`,
          ).id;

          // ── the messages the real trigger produced ─────────────────────────────
          const messages = await tx<{ message: Record<string, unknown> }[]>`
            select message from pgmq.q_notification_events
            where message ->> 'community_id' = ${COMMUNITY} order by msg_id`;
          const actions = messages.map((m) => String(m.message["action"]));
          evidence["queued_actions"] = actions;

          assert.deepEqual(
            [...actions].sort(),
            ["member.approve_join", "member.create", "member.create", "member.join_via_invite", "member.join_via_invite", "member.join_via_invite", "member.reject_join", "officer_term.end"].sort(),
            "exactly the approved events were queued for this community",
          );
          assert.ok(!messages.some((m) => String(m.message["audit_log_id"]) === silent), "the suppressed repair produced no message");

          // The queued rejection carries the narrow object and nothing else of the member.
          const rejectMsg = messages.find((m) => m.message["action"] === "member.reject_join")!.message;
          const rejectText = JSON.stringify(rejectMsg);
          assert.deepEqual(Object.keys(rejectMsg["before_state"] as object).sort(), ["email", "full_name", "joined_via"]);
          assert.ok(!rejectText.includes("2348095551002") && !rejectText.includes("looks fake"), "no phone and no officer reason in the queue");

          // ── run the real processor over them ───────────────────────────────────
          const outcomes = new Map<string, string>();
          for (const m of messages) {
            const out = await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
            outcomes.set(`${String(m.message["action"])}:${String(m.message["object_id"])}`, out.outcome === "skipped" ? `skipped/${out.reason}` : "processed");
          }
          evidence["outcomes"] = Object.fromEntries(outcomes);

          // The requester who was rejected also has a queued join_via_invite message. By the time it
          // is processed their row is gone, so it is correctly skipped (race rule F-3): no officer is
          // told that someone "joined" who was in fact turned away.
          const SKIPPED_BY_DESIGN = new Set([`member.join_via_invite:${toReject}`, `member.create:${toArchive}`]);
          assert.equal(outcomes.get(`member.join_via_invite:${toReject}`), "skipped/member_unavailable");
          assert.equal(outcomes.get(`member.create:${toArchive}`), "skipped/member_unavailable", "an archived member is skipped (F-3)");
          assert.equal(outcomes.get(`member.join_via_invite:${toPending}`), "processed", "a still-pending joiner is available: officers are told");
          for (const [k, v] of outcomes) {
            if (!SKIPPED_BY_DESIGN.has(k)) assert.equal(v, "processed", k);
          }

          const events = await tx<{ event_type: string; payload: Record<string, unknown> }[]>`
            select event_type, payload from public.notification_events where community_id = ${COMMUNITY} order by event_type`;
          const deliveries = await tx<{ channel: string; recipient_user_id: string | null; event_type: string }[]>`
            select d.channel, d.recipient_user_id, e.event_type
            from public.notification_deliveries d join public.notification_events e on e.id = d.notification_event_id
            where d.community_id = ${COMMUNITY}`;
          evidence["events"] = events.length;
          evidence["deliveries"] = deliveries.length;

          assert.equal(events.length, 6, "one event per processed message (the rejected joiner's join notice and the archived member's create were skipped)");
          assert.ok(deliveries.every((d) => d.channel === "in_app"), "every delivery is in_app");
          assert.equal(deliveries.filter((d) => d.channel === "email").length, 0, "NO email delivery row exists");

          // The admin's term was ended before processing, so only the owner still admits members.
          const joined = deliveries.filter((d) => d.event_type === "member.join_via_invite");
          assert.equal(joined.length, 2, "the approved joiner and the still-pending joiner are each told to the one remaining officer who admits members");
          assert.ok(joined.every((d) => d.recipient_user_id === OWNER), "only an officer is told; never a joiner");
          assert.deepEqual(
            deliveries.filter((d) => d.event_type === "officer_term.end").map((d) => d.recipient_user_id),
            [ADMIN],
            "the ended officer is told in-app",
          );
          assert.equal(deliveries.filter((d) => d.event_type === "member.reject_join").length, 0, "a rejected requester gets no in-app notification");

          // No event payload carries an address, a phone, or the officer's text.
          const all = JSON.stringify(events.map((e) => e.payload));
          assert.ok(!all.includes("@"), "no '@' anywhere in any event payload");
          assert.ok(!all.includes("2348095551"), "no phone number in any event payload");
          assert.ok(!all.includes("looks fake") && !all.includes("integration test"), "no officer free text in any event payload");
          const rejected = events.find((e) => e.event_type === "member.reject_join")!;
          assert.equal(rejected.payload["member_name"], "Reject Me", "the rejection event carries the requester's name");

          // ── replay: the same messages again change nothing ─────────────────────
          for (const m of messages) await processNotificationMessage(tx as unknown as postgres.TransactionSql, m.message);
          const eventsAfter = first(await tx<{ n: number }[]>`select count(*)::int as n from public.notification_events where community_id = ${COMMUNITY}`).n;
          const deliveriesAfter = first(await tx<{ n: number }[]>`select count(*)::int as n from public.notification_deliveries where community_id = ${COMMUNITY}`).n;
          assert.equal(eventsAfter, events.length, "replay created no duplicate event");
          assert.equal(deliveriesAfter, deliveries.length, "replay created no duplicate delivery");

          // created is referenced so the member.create path is demonstrably exercised
          assert.ok(created);
          throw new Rollback();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
      console.log("integration evidence:", JSON.stringify(evidence));
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
});
