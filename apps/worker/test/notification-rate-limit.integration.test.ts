/**
 * notification-rate-limit.integration.test.ts — rate limits against the real database.
 *
 * Proves what pgTAP cannot: two workers on REAL connections racing one
 * address produce exactly one grant. The boundary semantics themselves
 * (L1/L2/L3, backlog, purge, append-only) are proved in
 * supabase/tests/38; what is proved here is that the worker module calls
 * the database functions inside a transaction, and that advisory locks
 * serialise concurrent workers end to end.
 *
 * OPT-IN, local only — same gate as the claim integration suite:
 *
 *   KOLEKTO_WORKER_INTEGRATION=1 SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test --workspace apps/worker
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import postgres from "postgres";

import { claimDeliveryById } from "../src/notification-send-claim.ts";
import { reserveEmailAttempt, purgeStaleSendAttempts } from "../src/notification-rate-limit.ts";

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

const OWNER = "e9000000-0000-4000-8000-000000000001";
const COMMUNITY = "e9100000-0000-4000-8000-00000000000a";

const DELIVERIES = [
  "e9300000-0000-4000-8000-000000000001",
  "e9300000-0000-4000-8000-000000000002",
  "e9300000-0000-4000-8000-000000000003",
  "e9300000-0000-4000-8000-000000000004",
] as const;

const EVENTS = [
  { id: "e9200000-0000-4000-8000-000000000001", key: "rl-itest-1" },
  { id: "e9200000-0000-4000-8000-000000000002", key: "rl-itest-2" },
  { id: "e9200000-0000-4000-8000-000000000003", key: "rl-itest-3" },
  { id: "e9200000-0000-4000-8000-000000000004", key: "rl-itest-4" },
] as const;

type Sql = postgres.Sql<Record<string, never>>;
type TxSql = postgres.TransactionSql<Record<string, never>>;

async function cleanup(sql: Sql): Promise<void> {
  await sql`alter table public.notification_send_attempts disable trigger notification_send_attempts_no_delete`;
  try {
    await sql`delete from public.notification_send_attempts where community_id = ${COMMUNITY}::uuid`;
  } finally {
    await sql`alter table public.notification_send_attempts enable trigger notification_send_attempts_no_delete`;
  }
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

async function endQuietly(end: () => Promise<void>): Promise<void> {
  try { await end(); } catch { /* best-effort */ }
}

async function fixtures(sql: Sql): Promise<void> {
  await cleanup(sql);
  await sql`insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
    (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@rl.example.test', now())`;
  await sql`insert into public.users (id, full_name, email) values (${OWNER}, 'RL Owner', 'owner@rl.example.test')
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email`;
  await sql`insert into public.communities (id, slug, name, type, is_personal, created_by)
    values (${COMMUNITY}, 'rl-itest', 'RL ITest', 'social_group', false, ${OWNER})`;
  for (let i = 0; i < DELIVERIES.length; i++) {
    const d = DELIVERIES[i]!;
    const e = EVENTS[i]!;
    await sql`insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
      values (${e.id}::uuid, ${COMMUNITY}::uuid, 'member.create', ${e.key}, 'officer', ${OWNER}::uuid, 'member', ${d}::uuid, '{}')`;
    await sql`insert into public.notification_deliveries
      (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count)
      values (${d}::uuid, ${e.id}::uuid, ${COMMUNITY}::uuid, 'email', 'pending', 'rl@rl.example.test', 'unverified_supplied', 0)`;
  }
}

describe("rate limits against the real database", { skip: SKIP }, () => {
  it("claim+reserve in a transaction grants, then skips at L1", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 2 });
    try {
      await fixtures(sql);

      for (let i = 0; i < 3; i++) {
        const r = await sql.begin(async (tx: TxSql) => {
          const c = await claimDeliveryById(tx as unknown as Sql, DELIVERIES[i]!);
          assert.equal(c.claimed, true, `delivery ${i} claimed`);
          return reserveEmailAttempt(tx as unknown as Sql, DELIVERIES[i]!);
        });
        assert.equal(r.reservation, "granted", `delivery ${i} granted`);
      }

      const r4 = await sql.begin(async (tx: TxSql) => {
        const c = await claimDeliveryById(tx as unknown as Sql, DELIVERIES[3]!);
        assert.equal(c.claimed, true);
        return reserveEmailAttempt(tx as unknown as Sql, DELIVERIES[3]!);
      });
      assert.equal(r4.reservation, "address_limited");

      const [row] = await sql<{ status: string; error_code: string }[]>`
        select status::text as status, error_code
        from public.notification_deliveries where id = ${DELIVERIES[3]}::uuid`;
      assert.equal(row!.status, "skipped");
      assert.equal(row!.error_code, "recipient_rate_limited");
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });

  it("two concurrent workers serialize on the advisory lock", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 6 });
    try {
      await fixtures(sql);

      await sql`insert into public.notification_send_attempts
        (delivery_id, community_id, address_key, attempted_at) values
        (${DELIVERIES[0]}::uuid, ${COMMUNITY}::uuid, 'rl@rl.example.test', now() - interval '1 minute'),
        (${DELIVERIES[0]}::uuid, ${COMMUNITY}::uuid, 'rl@rl.example.test', now() - interval '2 minutes')`;

      const a = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 1 });
      const b = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 1 });
      try {
        const [ra, rb] = await Promise.all([
          a.begin(async (tx: TxSql) => {
            await claimDeliveryById(tx as unknown as Sql, DELIVERIES[0]!);
            return reserveEmailAttempt(tx as unknown as Sql, DELIVERIES[0]!);
          }),
          b.begin(async (tx: TxSql) => {
            await claimDeliveryById(tx as unknown as Sql, DELIVERIES[1]!);
            return reserveEmailAttempt(tx as unknown as Sql, DELIVERIES[1]!);
          }),
        ]);
        const granted = [ra, rb].filter((r) => r.reservation === "granted").length;
        const limited = [ra, rb].filter((r) => r.reservation === "address_limited").length;
        assert.equal(granted, 1, "exactly one worker gets the last slot");
        assert.equal(limited, 1, "exactly one worker is rate-limited");
      } finally {
        await endQuietly(() => a.end());
        await endQuietly(() => b.end());
      }
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });

  it("a rolled-back reservation leaves no ledger row", async () => {
    const sql = postgres(URL_ENV, { prepare: false, transform: { undefined: null }, max: 2 });
    try {
      await fixtures(sql);
      await sql.begin(async (tx: TxSql) => {
        await claimDeliveryById(tx as unknown as Sql, DELIVERIES[0]!);
        const r = await reserveEmailAttempt(tx as unknown as Sql, DELIVERIES[0]!);
        assert.equal(r.reservation, "granted");
        throw new Rollback();
      }).catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });

      const [ledger] = await sql<{ c: number }[]>`
        select count(*)::int as c from public.notification_send_attempts
        where delivery_id = ${DELIVERIES[0]}::uuid`;
      assert.equal(ledger!.c, 0, "no ledger row after rollback");

      const [row] = await sql<{ status: string; attempt_count: number }[]>`
        select status::text as status, attempt_count
        from public.notification_deliveries where id = ${DELIVERIES[0]}::uuid`;
      assert.equal(row!.status, "pending", "delivery still pending after rollback");
      assert.equal(row!.attempt_count, 0, "attempt not consumed after rollback");
    } finally {
      await cleanup(sql).catch(() => {});
      await endQuietly(() => sql.end());
    }
  });
});

class Rollback extends Error {}
