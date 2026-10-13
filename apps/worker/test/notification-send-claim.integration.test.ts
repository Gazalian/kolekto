/**
 * notification-send-claim.integration.test.ts — claims against the real database.
 *
 * Proves what pgTAP cannot: two workers on REAL connections racing one
 * delivery produce exactly one owner. Everything else (lock-and-recheck
 * semantics, token gating, recovery, the attempt cap) is proved in
 * supabase/tests/37 and re-asserted here end to end through the worker
 * module under test.
 *
 * OPT-IN, and local only — the same gate as
 * notification-processor.integration.test.ts: KOLEKTO_WORKER_INTEGRATION=1
 * and a loopback SUPABASE_DB_URL. Fixtures use fixed ids and are removed
 * afterwards, so a crashed run is cleaned up by the next one. Committed
 * (not rolled back): concurrent connections cannot see uncommitted rows.
 *
 *   KOLEKTO_WORKER_INTEGRATION=1 SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test --workspace apps/worker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import postgres from "postgres";

import {
  claimDeliveryById,
  claimNextDelivery,
  recoverExpiredLease,
  settleDelivery,
} from "../src/notification-send-claim.ts";

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

const OWNER = "d9000000-0000-4000-8000-000000000001";
const COMMUNITY = "d9100000-0000-4000-8000-00000000000a";
const RACE = "d9300000-0000-4000-8000-000000000001";
const SINGLE = "d9300000-0000-4000-8000-000000000002";
const SPENT = "d9300000-0000-4000-8000-000000000003";
const TERMINAL = "d9300000-0000-4000-8000-000000000004";

// One event per delivery: the per-event recipient index treats two email
// rows with no recipient ids on the same event as the same delivery.
const EVENTS: Record<string, { id: string; key: string }> = {
  [RACE]: { id: "d9200000-0000-4000-8000-000000000001", key: "claim-itest-race" },
  [SINGLE]: { id: "d9200000-0000-4000-8000-000000000002", key: "claim-itest-single" },
  [SPENT]: { id: "d9200000-0000-4000-8000-000000000003", key: "claim-itest-spent" },
  [TERMINAL]: { id: "d9200000-0000-4000-8000-000000000004", key: "claim-itest-terminal" },
};

type Sql = postgres.Sql<Record<string, never>>;

// notification_events is append-only (M13.1): its delete guard is lifted
// for exactly this statement, following scripts/verify/reference-concurrency.mjs,
// which disables its own guards for fixture teardown. Only rows this suite
// created are touched, on the local database only.
async function cleanup(sql: Sql): Promise<void> {
  await sql`delete from public.notification_deliveries where community_id = ${COMMUNITY}::uuid`;
  await sql`alter table public.notification_events disable trigger notification_events_no_delete`;
  try {
    await sql`delete from public.notification_events where community_id = ${COMMUNITY}::uuid`;
  } finally {
    await sql`alter table public.notification_events enable trigger notification_events_no_delete`;
  }
  await sql`delete from public.communities where id = ${COMMUNITY}::uuid`;
  await sql`delete from public.users where id = ${OWNER}::uuid`;
  await sql`delete from auth.users where id = ${OWNER}::uuid`;
}

/** Cleanup must never strand an open pool (a stranded pool hangs the runner). */
async function endQuietly(end: () => Promise<void>): Promise<void> {
  try {
    await end();
  } catch {
    // Teardown is best-effort; the assertions already ran.
  }
}

async function fixtures(sql: Sql): Promise<void> {
  await cleanup(sql);
  await sql`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@claim.example.test', now())`;
  // The sign-up trigger may already have created this row from auth.users.
  await sql`insert into public.users (id, full_name, email) values (${OWNER}, 'Claim Owner', 'owner@claim.example.test')
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
  await sql`insert into public.communities (id, slug, name, type, is_personal, created_by)
    values (${COMMUNITY}, 'claim-itest', 'Claim ITest', 'social_group', false, ${OWNER})`;
  const deliveries: Array<{ id: string; status: string; attempts: number; code: string | null }> = [
    { id: RACE, status: "pending", attempts: 0, code: null },
    { id: SINGLE, status: "pending", attempts: 0, code: null },
    { id: SPENT, status: "pending", attempts: 3, code: null },
    { id: TERMINAL, status: "skipped", attempts: 0, code: "no_recipient" },
  ];
  for (const d of deliveries) {
    const event = EVENTS[d.id]!;
    await sql`insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
      values (${event.id}::uuid, ${COMMUNITY}::uuid, 'member.create', ${event.key}, 'officer', ${OWNER}::uuid, 'member', ${d.id}::uuid, '{}')`;
    // A skipped email row carries no address (P2 constraint); decide in JS
    // so the driver never sends an untyped parameter inside a CASE.
    const address = d.status === "skipped" ? null : "sam@claim.example.test";
    const assurance = d.status === "skipped" ? null : "unverified_supplied";
    await sql`insert into public.notification_deliveries
      (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count, error_code)
      values (${d.id}::uuid, ${event.id}::uuid, ${COMMUNITY}::uuid, 'email',
        ${d.status}::public.notification_delivery_status,
        ${address}, ${assurance}, ${d.attempts}, ${d.code})`;
  }
}

describe("send claims against the real database", { skip: SKIP }, () => {
  it("races two workers: exactly one owns the delivery", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 6 });
    try {
      await fixtures(sql);
      const a = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 1 });
      const b = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 1 });
      try {
        // Both promises are issued before either is awaited, so the two
        // sessions genuinely overlap inside the database.
        const [ra, rb] = await Promise.all([claimDeliveryById(a, RACE), claimDeliveryById(b, RACE)]);
        assert.equal([ra.claimed, rb.claimed].filter(Boolean).length, 1);
        const winner = ra.claimed ? ra : rb;
        assert.match(winner.leaseToken ?? "", /^[0-9a-f]{64}$/);
        assert.equal(winner.attemptCount, 1);

        // The loser sees the row as already claimed and reserves nothing.
        const loser = ra.claimed ? rb : ra;
        assert.equal(loser.reason, "already_claimed");
        const [row] = await sql<{ attempt_count: number }[]>`
          select attempt_count from public.notification_deliveries where id = ${RACE}::uuid`;
        assert.equal(row!.attempt_count, 1);

        // The winner's token settles; the loser's (null) token cannot.
        const settled = await settleDelivery(sql, RACE, winner.leaseToken!, "sent", {
          providerMessageId: "FAKE_EMAIL_RACE",
        });
        assert.deepEqual(settled, { settled: true, reason: "sent" });
        const replay = await settleDelivery(sql, RACE, winner.leaseToken!, "sent", {
          providerMessageId: "FAKE_EMAIL_RACE",
        });
        assert.deepEqual(replay, { settled: false, reason: "invalid_or_expired_lease" });
      } finally {
        await endQuietly(() => a.end());
        await endQuietly(() => b.end());
      }
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });

  it("gates settle and recover on the live token, caps attempts, refuses terminal rows", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 2 });
    try {
      await fixtures(sql);

      const claim = await claimDeliveryById(sql, SINGLE);
      assert.equal(claim.claimed, true);

      // Recovery refuses a live lease; a wrong token settles nothing.
      assert.deepEqual(await recoverExpiredLease(sql, SINGLE), {
        recovered: false,
        reason: "lease_still_valid",
      });
      assert.deepEqual(await settleDelivery(sql, SINGLE, "wrong", "sent"), {
        settled: false,
        reason: "invalid_or_expired_lease",
      });

      // Let the lease lapse, then race recovery against the old worker: the
      // old token must lose and the row must end pending, ownable again.
      await sql`update public.notification_deliveries set send_lease_expires_at = now() - interval '1 second'
        where id = ${SINGLE}::uuid`;
      assert.deepEqual(await settleDelivery(sql, SINGLE, claim.leaseToken!, "sent"), {
        settled: false,
        reason: "invalid_or_expired_lease",
      });
      assert.deepEqual(await recoverExpiredLease(sql, SINGLE), { recovered: true, reason: "pending" });
      assert.deepEqual(await settleDelivery(sql, SINGLE, claim.leaseToken!, "sent"), {
        settled: false,
        reason: "invalid_or_expired_lease",
      });
      const again = await claimDeliveryById(sql, SINGLE);
      assert.equal(again.claimed, true);
      assert.equal(again.attemptCount, 2);
      assert.notEqual(again.leaseToken, claim.leaseToken);

      // Exhausted and terminal rows are never claimable.
      assert.equal((await claimDeliveryById(sql, SPENT)).reason, "exhausted");
      assert.equal((await claimDeliveryById(sql, TERMINAL)).reason, "terminal");

      // claim_next skips the exhausted, terminal and sending rows: only
      // RACE is due, then the queue is empty.
      const next = await claimNextDelivery(sql);
      assert.equal(next.claimed, true);
      assert.equal(next.deliveryId, RACE);
      const drained = await claimNextDelivery(sql);
      assert.equal(drained.claimed, false);
      assert.equal(drained.reason, "empty");
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });

  it("rolls a claim and its attempt reservation back together", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 2 });
    try {
      await fixtures(sql);
      await sql.begin(async (tx) => {
        await claimDeliveryById(
          tx as unknown as Parameters<typeof claimDeliveryById>[0],
          SINGLE,
        );
        throw new Rollback();
      }).catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
      const [row] = await sql<{ status: string; attempt_count: number }[]>`
        select status::text as status, attempt_count from public.notification_deliveries where id = ${SINGLE}::uuid`;
      assert.equal(row!.status, "pending");
      assert.equal(row!.attempt_count, 0);
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });
});

class Rollback extends Error {}
