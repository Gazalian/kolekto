#!/usr/bin/env node
/**
 * Withdrawal concurrency and idempotency under genuine multi-session races
 * (PA-08 P8-3; rewritten session 39, 2026-11-20, for the current
 * architecture: member code, independent approval, designated second
 * approver for an owner's own request, Paystack approval URL with the
 * 7-argument decision, NOT FOUND release policy).
 *
 * WHY THIS IS NOT A pgTAP TEST. pgTAP runs in one session inside one
 * transaction, so a lost update or a double release behaves exactly like the
 * correct code there. These scenarios open real connections, park each one
 * behind a barrier inside its own transaction, and let them collide:
 *
 *    1. two requests competing for the same collection balance; and requests
 *       on different collections at once (no cross-collection spending)
 *    2. the same request (same idempotency key) reserving funds twice at once
 *    3. the same withdrawal approved twice at once; approve racing reject
 *    4. a requester approving their own withdrawal (owner and treasurer),
 *       racing the designated second approver
 *    5. two different designated approvers deciding the same owner request
 *    6. two dispatch workers claiming the same approved withdrawals
 *    7. Paystack's approval request arriving twice at once; and racing the
 *       success webhook
 *    8. the same success webhook settled twice at once; success racing failure
 *    9. duplicate releases: "release as never sent" twice with one lease;
 *       reject racing cancel
 *   10. transfer ambiguity: refused, then repeated NOT FOUND checks by
 *       competing checkers; release only after the policy's count and age;
 *       one release; a late success settles nothing
 *
 * Every assertion is scoped to the rows this run creates (its own community,
 * collections, users and withdrawals, tagged with the run id). Nothing depends
 * on how many rows the database already holds.
 *
 * SAFETY AND CLEAN-UP. Withdrawals, journals, transfers, audit rows and
 * designations are append-only by design (guard triggers refuse DELETE), so
 * the script never deletes anything. Instead it refuses to run unless the
 * connection's current_database() starts with `kolekto_scratch`, the host is
 * this machine, and the scratch database is quiescent (no code deliveries,
 * approved withdrawals or open transfers that are not this run's — those
 * would be claimed by the worker functions the scenarios call). Clean-up is
 * dropping the throwaway scratch database afterwards. Test-clock moves (an
 * aged refusal in scenario 10) disable one guard trigger for one row, inside
 * the scratch database only — as pgTAP fixtures do.
 *
 * Usage (dev stack; the itest stack works the same with its container/port):
 *   docker exec supabase_db_kolekto psql -U postgres -d postgres -c "create database kolekto_scratch_wd"
 *   docker exec supabase_db_kolekto sh -c "pg_dump -U postgres -d postgres | psql -U postgres -d kolekto_scratch_wd -q"
 *   SCRATCH_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/kolekto_scratch_wd \
 *     node scripts/verify/withdrawal-concurrency.mjs
 *   docker exec supabase_db_kolekto psql -U postgres -d postgres -c "drop database kolekto_scratch_wd"
 */

import postgres from "postgres";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";

const URL_ = process.env.SCRATCH_DATABASE_URL;
if (!URL_) {
  console.error("SCRATCH_DATABASE_URL is required (a kolekto_scratch* database on this machine).");
  process.exit(2);
}
const host = new URL(URL_).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`REFUSING: ${host} is not this machine.`);
  process.exit(2);
}

const sql = postgres(URL_, { max: 12, onnotice: () => {} });

let failures = 0;
let passes = 0;
function check(condition, description, detail) {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

const run = randomUUID().slice(0, 8);
const OWNER = randomUUID();
const TREASURER = randomUUID();
const APPROVER1 = randomUUID();
const APPROVER2 = randomUUID();
const COMMUNITY = randomUUID();
const COLL_A = randomUUID(); // well funded
const COLL_B = randomUUID(); // ₦1,500: two ₦1,000 requests compete
const COLL_C = randomUUID(); // unfunded
const NGN = "NGN";
const AMOUNT = 100000; // ₦1,000

const hash = (challengeId, code) => createHash("sha256").update(`${code}:${challengeId}`).digest("hex");
const claims = (uid) => JSON.stringify({ sub: uid, role: "authenticated" });
const ours = new Set(); // this run's withdrawal ids
const valueOrError = (r) => r.value ?? r.error;

async function asUser(uid, fn) {
  return sql.begin(async (tx) => {
    await tx`select set_config('role', 'authenticated', true)`;
    await tx`select set_config('request.jwt.claims', ${claims(uid)}, true)`;
    return fn(tx);
  });
}

/** Two (or more) transactions, each parked behind one gate, released together. */
async function race(bodies) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runs = bodies.map(({ uid, fn }) =>
    sql
      .begin(async (tx) => {
        if (uid) {
          await tx`select set_config('role', 'authenticated', true)`;
          await tx`select set_config('request.jwt.claims', ${claims(uid)}, true)`;
        }
        await gate;
        return { value: await fn(tx) };
      })
      .catch((error) => ({ error: String(error.message ?? error) })),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  release();
  return Promise.all(runs);
}

async function balance(collection, kind) {
  const [r] = await sql`select app.ledger_account_balance(app.ensure_ledger_account(${COMMUNITY}, ${collection}, ${kind}))::bigint as b`;
  return Number(r.b);
}
const position = async (c) => ({
  available: await balance(c, "collection_available"),
  withdrawing: await balance(c, "collection_withdrawing"),
  withdrawn: await balance(c, "collection_withdrawn"),
});

/** The worker's code delivery, played by hand. Only this run's challenges exist (quiescence checked). */
async function deliverCodes() {
  const out = [];
  for (const row of await sql`select challenge_id, withdrawal_id from app.claim_withdrawal_otp_deliveries(100)`) {
    if (!ours.has(row.withdrawal_id)) throw new Error(`claimed a code delivery that is not this run's (${row.withdrawal_id}); scratch database not quiescent`);
    const h = hash(row.challenge_id, "good");
    await sql`select app.record_withdrawal_otp_issued(${row.challenge_id}, ${h})`;
    await sql`select app.record_withdrawal_otp_delivery(${row.challenge_id}, true, null)`;
    out.push({ withdrawalId: row.withdrawal_id, challengeId: row.challenge_id, good: h });
  }
  return out;
}

let keySeq = 0;
const bank = {};
const bankOf = (uid) => (uid === OWNER ? bank.owner : bank.treasurer);

async function request(uid, collection, amount, key = `conc-${run}-${++keySeq}`) {
  const [w] = await asUser(uid, (tx) => tx`
    select withdrawal_id from app.request_withdrawal_to_account(${collection}, ${amount}::bigint, ${bankOf(uid)}, ${key})`);
  ours.add(w.withdrawal_id);
  return w.withdrawal_id;
}

async function verified(uid, collection = COLL_A, amount = AMOUNT) {
  const id = await request(uid, collection, amount);
  const mine = (await deliverCodes()).find((d) => d.withdrawalId === id);
  const [v] = await asUser(uid, (tx) => tx`select outcome from app.verify_withdrawal_otp(${id}, ${mine.challengeId}, ${mine.good})`);
  if (v.outcome !== "verified") throw new Error(`fixture: code not verified (${v.outcome})`);
  return id;
}

/** A treasurer's request approved by the owner (basis: owner). */
async function approvedWithdrawal() {
  const id = await verified(TREASURER);
  await asUser(OWNER, (tx) => tx`select app.decide_withdrawal(${id}, 'approve')`);
  return id;
}

/** Claims exactly the given approved withdrawals for one dispatcher. */
async function dispatch(ids, worker) {
  const rows = await sql`select withdrawal_id, transfer_reference, claim_token, recipient_code, amount_kobo
                         from app.claim_withdrawal_transfers(50, ${worker})`;
  for (const r of rows) if (!ours.has(r.withdrawal_id)) throw new Error(`dispatch claimed a withdrawal that is not this run's (${r.withdrawal_id})`);
  const want = new Set(ids);
  const got = rows.filter((r) => want.has(r.withdrawal_id));
  if (got.length !== ids.length) throw new Error(`fixture: expected to claim ${ids.length}, got ${got.length}`);
  return got;
}

/** Sent to Paystack and accepted: initiating → pending with a transfer code. */
async function sent(claim) {
  const ok = await sql`select app.mark_withdrawal_transfer_initiating(${claim.transfer_reference}, ${claim.claim_token}) as ok`;
  if (!ok[0].ok) throw new Error("fixture: could not mark initiating");
  const code = `TRF_${run}${randomUUID().slice(0, 6)}`;
  await sql`select app.record_withdrawal_transfer_state(${claim.transfer_reference}, 'pending', null, ${code}, ${"9" + Date.now()}, null)`;
  return code;
}

async function journals(id) {
  const [j] = await sql`select
      (select count(*)::int from public.ledger_journals where idempotency_key = ${"withdrawal_hold:" + id}) as holds,
      (select count(*)::int from public.ledger_journals where idempotency_key = ${"withdrawal_release:" + id}) as releases,
      (select count(*)::int from public.ledger_journals where idempotency_key = ${"payout:" + id}) as payouts`;
  return j;
}
const status = async (id) => (await sql`select status::text as s from public.withdrawals where id = ${id}`)[0].s;

async function quiescent() {
  const [q] = await sql`select
      (select count(*)::int from public.withdrawal_otp_challenges where status in ('pending_delivery', 'sending')) as codes,
      (select count(*)::int from public.withdrawals where status = 'approved') as approved,
      (select count(*)::int from public.withdrawal_transfers where status in ('initiating', 'pending', 'otp', 'unknown')) as open_transfers`;
  return q;
}

async function fixtures() {
  await sql.unsafe(`
    insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
      ('${OWNER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner-${run}@conc.example.test', now()),
      ('${TREASURER}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer-${run}@conc.example.test', now()),
      ('${APPROVER1}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'approver1-${run}@conc.example.test', now()),
      ('${APPROVER2}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'approver2-${run}@conc.example.test', now());
    insert into public.users (id, full_name, email) values
      ('${OWNER}', 'Race Owner', 'owner-${run}@conc.example.test'),
      ('${TREASURER}', 'Race Treasurer', 'treasurer-${run}@conc.example.test'),
      ('${APPROVER1}', 'Race Approver One', 'approver1-${run}@conc.example.test'),
      ('${APPROVER2}', 'Race Approver Two', 'approver2-${run}@conc.example.test')
    on conflict (id) do update set full_name = excluded.full_name;
    insert into public.communities (id, slug, name, type, is_personal, created_by)
      values ('${COMMUNITY}', 'conc-${run}', 'Concurrency ${run}', 'social_group', false, '${OWNER}');
    insert into public.collections
      (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
       status, visibility, fee_mode, created_by)
    values ('${COLL_A}', '${COMMUNITY}', 'conc-a', 'Race Fund A', 'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', '${OWNER}'),
           ('${COLL_B}', '${COMMUNITY}', 'conc-b', 'Race Fund B', 'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', '${OWNER}'),
           ('${COLL_C}', '${COMMUNITY}', 'conc-c', 'Race Fund C', 'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', '${OWNER}');
    insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
      ('${COMMUNITY}', '${OWNER}', 'owner', 'Race Owner', 'created', null),
      ('${COMMUNITY}', '${TREASURER}', 'treasurer', 'Race Treasurer', 'invited', null),
      ('${COMMUNITY}', '${APPROVER1}', 'admin', 'Race Approver One', 'invited', null),
      ('${COMMUNITY}', '${APPROVER2}', 'admin', 'Race Approver Two', 'invited', null);
  `);
  for (const [collection, kobo] of [[COLL_A, 50000000], [COLL_B, 150000]]) {
    await sql`select app.post_ledger_journal(
      ${COMMUNITY}, ${collection}, now(), 'adjustment', ${collection}, 'concurrency fixture funding', ${`conc-fund-${run}-${collection}`},
      jsonb_build_array(
        jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'), 'direction', 'debit', 'amount_kobo', ${kobo}::bigint),
        jsonb_build_object('account_id', app.ensure_ledger_account(${COMMUNITY}, ${collection}, 'collection_available'),
                           'direction', 'credit', 'amount_kobo', ${kobo}::bigint)),
      'system', null)`;
  }
  const digits = String(Date.now()).slice(-8);
  const [t] = await sql`select bank_account_id from app.register_bank_account(
    ${TREASURER}, '058', 'GTBank', ${"10" + digits}, 'TREASURER RACE', 'Race Treasurer', true)`;
  const [o] = await sql`select bank_account_id from app.register_bank_account(
    ${OWNER}, '044', 'Access Bank', ${"20" + digits}, 'OWNER RACE', 'Race Owner', true)`;
  bank.treasurer = t.bank_account_id;
  bank.owner = o.bank_account_id;
  const tag = run.replace(/[^0-9a-z]/gi, "");
  await sql`select app.set_bank_account_recipient(${bank.treasurer}, ${"RCP_conct" + tag})`;
  await sql`select app.set_bank_account_recipient(${bank.owner}, ${"RCP_conco" + tag})`;
  // The owner designates both admins as second approvers (owner-only function).
  for (const a of [APPROVER1, APPROVER2]) {
    await asUser(OWNER, (tx) => tx`select app.set_withdrawal_approver(${COMMUNITY}, ${a}, true)`);
  }
}

async function main() {
  const [{ db }] = await sql`select current_database() as db`;
  if (!db.startsWith("kolekto_scratch")) {
    console.error(`REFUSING: connected to ${db}; this script only runs against a kolekto_scratch* clone.`);
    await sql.end();
    process.exit(2);
  }
  const q = await quiescent();
  if (q.codes + q.approved + q.open_transfers > 0) {
    console.error(`REFUSING: ${db} is not quiescent (${JSON.stringify(q)}); the worker functions would claim rows that are not this run's.`);
    await sql.end();
    process.exit(2);
  }
  console.log(`Withdrawal concurrency on ${db} (run ${run})\n`);
  await fixtures();

  // ── 1. Competing for one balance; collections isolated ────────────────────
  console.log("1. two requests competing for the same collection balance");
  {
    const before = await position(COLL_B);
    const results = await race([TREASURER, OWNER].map((uid, i) => ({
      uid,
      fn: async (tx) => (await tx`select withdrawal_id from app.request_withdrawal_to_account(
        ${COLL_B}, ${AMOUNT}::bigint, ${bankOf(uid)}, ${`conc-${run}-b${i}`})`)[0].withdrawal_id,
    })));
    results.filter((r) => r.value).forEach((r) => ours.add(r.value));
    check(results.filter((r) => r.value).length === 1, "exactly one of two ₦1,000 requests on ₦1,500 succeeds", JSON.stringify(results));
    check(results.some((r) => r.error?.includes("INSUFFICIENT_AVAILABLE_BALANCE")), "the other is refused for insufficient balance", JSON.stringify(results));
    const after = await position(COLL_B);
    check(after.available === before.available - AMOUNT && after.withdrawing === AMOUNT, "exactly one hold is taken", JSON.stringify(after));
    check(after.available >= 0 && after.withdrawing >= 0, "the balance never goes negative", JSON.stringify(after));
  }
  {
    const aBefore = await position(COLL_A);
    const results = await race([
      { uid: TREASURER, fn: async (tx) => (await tx`select withdrawal_id from app.request_withdrawal_to_account(${COLL_C}, 1::bigint, ${bank.treasurer}, ${`conc-${run}-c1`})`)[0].withdrawal_id },
      { uid: TREASURER, fn: async (tx) => (await tx`select withdrawal_id from app.request_withdrawal_to_account(${COLL_A}, ${AMOUNT}::bigint, ${bank.treasurer}, ${`conc-${run}-a1`})`)[0].withdrawal_id },
    ]);
    results.filter((r) => r.value).forEach((r) => ours.add(r.value));
    check(results[0].error?.includes("INSUFFICIENT_AVAILABLE_BALANCE") ?? false, "an unfunded collection cannot withdraw although another collection has funds", valueOrError(results[0]));
    check(Boolean(results[1].value), "the funded collection's own request succeeds at the same time", valueOrError(results[1]));
    const aAfter = await position(COLL_A);
    const c = await position(COLL_C);
    check(aAfter.available === aBefore.available - AMOUNT, "collection A is debited only by its own request", `${aBefore.available} → ${aAfter.available}`);
    check(c.available === 0 && c.withdrawing === 0, "collection C is untouched", JSON.stringify(c));
  }

  // ── 2. Same request, same key, two sessions ───────────────────────────────
  console.log("2. the same request reserving funds twice at once");
  {
    const key = `conc-${run}-same`;
    const before = await position(COLL_A);
    const results = await race([0, 1].map(() => ({
      uid: TREASURER,
      fn: async (tx) => (await tx`select withdrawal_id, reused from app.request_withdrawal_to_account(${COLL_A}, ${AMOUNT}::bigint, ${bank.treasurer}, ${key})`)[0],
    })));
    const rows = await sql`select id from public.withdrawals where collection_id = ${COLL_A} and requested_by = ${TREASURER} and idempotency_key = ${key}`;
    rows.forEach((r) => ours.add(r.id));
    check(rows.length === 1, "one withdrawal exists for the key", `${rows.length}`);
    const j = await journals(rows[0].id);
    check(j.holds === 1, "the funds are reserved exactly once", JSON.stringify(j));
    const after = await position(COLL_A);
    check(after.available === before.available - AMOUNT, "available falls by the amount once", `${before.available} → ${after.available}`);
    const ok = results.filter((r) => r.value);
    check(ok.every((r) => r.value.withdrawal_id === rows[0].id), "any session that succeeded names the same withdrawal", JSON.stringify(results));
  }

  // ── 3. Same withdrawal approved twice; approve vs reject ──────────────────
  console.log("3. the same withdrawal approved twice at once");
  {
    const id = await verified(TREASURER);
    const results = await race([0, 1].map(() => ({ uid: OWNER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s })));
    check(results.filter((r) => r.value === "approved").length === 1, "exactly one approval succeeds", JSON.stringify(results));
    check(results.some((r) => r.error?.includes("WITHDRAWAL_NOT_PENDING")), "the other is refused as no longer pending", JSON.stringify(results));
    const [a] = await sql`select count(*)::int as n from public.audit_logs where object_id = ${id} and action = 'withdrawal.approve'`;
    check(a.n === 1, "the approval is audited once", `${a.n}`);
    await asUser(TREASURER, (tx) => tx`select app.decide_withdrawal(${id}, 'cancel')`);
  }
  {
    const id = await verified(TREASURER);
    const results = await race([
      { uid: OWNER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s },
      { uid: OWNER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'reject', 'race test')::text as s`)[0].s },
    ]);
    const ok = results.filter((r) => r.value);
    check(ok.length === 1, "approve racing reject: exactly one decision", JSON.stringify(results));
    const s = await status(id);
    const j = await journals(id);
    check(s === ok[0]?.value, "the stored status is the winning decision", s);
    check(s === "rejected" ? j.releases === 1 : j.releases === 0, "the hold is released only if rejected, at most once", JSON.stringify(j));
    if (s === "approved") await asUser(TREASURER, (tx) => tx`select app.decide_withdrawal(${id}, 'cancel')`);
  }

  // ── 4. Self-approval refused, even racing the real approver ───────────────
  console.log("4. a requester approving their own withdrawal");
  {
    const id = await verified(OWNER);
    const results = await race([
      { uid: OWNER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s },
      { uid: APPROVER1, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s },
    ]);
    check(results[0].error?.includes("nobody approves or rejects their own withdrawal") ?? false, "the owner cannot approve their own request", valueOrError(results[0]));
    check(results[1].value === "approved", "the designated second approver can", valueOrError(results[1]));
    const [w] = await sql`select approved_by, approved_as, owner_self_approved from public.withdrawals where id = ${id}`;
    check(w.approved_by === APPROVER1 && w.approved_as === "second_approver" && w.owner_self_approved === false,
      "recorded as approved by the second approver, not self-approved", JSON.stringify(w));
    await asUser(OWNER, (tx) => tx`select app.decide_withdrawal(${id}, 'cancel')`);
  }
  {
    const id = await verified(TREASURER);
    const results = await race([
      { uid: TREASURER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s },
      { uid: TREASURER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'reject', 'mine')::text as s`)[0].s },
    ]);
    check(results.every((r) => r.error?.includes("FORBIDDEN")), "a treasurer can neither approve nor reject their own request", JSON.stringify(results));
    check((await status(id)) === "requested", "it stays requested", await status(id));
    await asUser(TREASURER, (tx) => tx`select app.decide_withdrawal(${id}, 'cancel')`);
  }

  // ── 5. Two approvers on one owner request ─────────────────────────────────
  console.log("5. two different approvers deciding the same request");
  {
    const id = await verified(OWNER);
    const results = await race([
      { uid: APPROVER1, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'approve')::text as s`)[0].s },
      { uid: APPROVER2, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'reject', 'second opinion')::text as s`)[0].s },
    ]);
    const ok = results.filter((r) => r.value);
    check(ok.length === 1, "exactly one approver's decision stands", JSON.stringify(results));
    check(results.some((r) => r.error?.includes("WITHDRAWAL_NOT_PENDING")), "the other is told it is no longer pending", JSON.stringify(results));
    const s = await status(id);
    const j = await journals(id);
    check(s === ok[0]?.value && (s === "rejected" ? j.releases === 1 : j.releases === 0), "status and release match the winner", `${s} ${JSON.stringify(j)}`);
    if (s === "approved") await asUser(OWNER, (tx) => tx`select app.decide_withdrawal(${id}, 'cancel')`);
  }

  // ── 6. Two dispatchers ────────────────────────────────────────────────────
  console.log("6. two dispatch workers claiming at once");
  const dispatched = [];
  {
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(await approvedWithdrawal());
    const results = await race(["dispatch-a", "dispatch-b"].map((worker) => ({
      fn: async (tx) => tx`select withdrawal_id, transfer_reference, claim_token from app.claim_withdrawal_transfers(50, ${worker})`,
    })));
    check(results.every((r) => !r.error), "neither worker errors", JSON.stringify(results.filter((r) => r.error)));
    const claimed = results.flatMap((r) => r.value ?? []);
    check(claimed.every((c) => ours.has(c.withdrawal_id)), "only this run's withdrawals were claimable");
    check(new Set(claimed.map((c) => c.withdrawal_id)).size === claimed.length, "no withdrawal is claimed by both workers", `${claimed.length} claims`);
    check(ids.every((id) => claimed.some((c) => c.withdrawal_id === id)), "each approved withdrawal is claimed once", `${claimed.length}`);
    const [t] = await sql`select count(*)::int as n from public.withdrawal_transfers where withdrawal_id = any(${ids}::uuid[])`;
    check(t.n === 3, "one transfer per withdrawal", `${t.n}`);
    const again = await sql`select withdrawal_id from app.claim_withdrawal_transfers(50, 'dispatch-c')`;
    check(again.length === 0, "a third claim finds nothing left to send", `${again.length}`);
    dispatched.push(...claimed);
  }

  // ── 7. Approval callback twice; and racing the success webhook ────────────
  console.log("7. Paystack's approval request arriving twice at once");
  {
    const id = await approvedWithdrawal();
    const [c] = await dispatch([id], "dispatch-p");
    const code = await sent(c);
    const results = await race([0, 1].map(() => ({
      fn: async (tx) => (await tx`select decision || ':' || reason_code as r from app.decide_transfer_approval(
        ${c.transfer_reference}, ${AMOUNT}::bigint, ${c.recipient_code}, 'valid', ${NGN}, ${code}, null)`)[0].r,
    })));
    check(results.every((r) => r.value === "approve:authorised"), "both identical requests get the same approval", JSON.stringify(results));
    const [t] = await sql`select provider_approval_count, provider_approved_at is not null as approved from public.withdrawal_transfers where reference = ${c.transfer_reference}`;
    check(t.provider_approval_count === 2 && t.approved, "both are counted; approved once", JSON.stringify(t));
    const [a] = await sql`select count(*)::int as n from public.audit_logs where object_id = ${id} and action = 'withdrawal.transfer_approved_by_kolekto'`;
    check(a.n === 1, "the Kolekto approval is audited once", `${a.n}`);
    const [r] = await sql`select count(*)::int as n from public.withdrawal_transfer_approval_requests where reference = ${c.transfer_reference}`;
    check(r.n === 2, "both requests are logged", `${r.n}`);

    const late = await race([
      { fn: async (tx) => (await tx`select decision || ':' || reason_code as r from app.decide_transfer_approval(
          ${c.transfer_reference}, ${AMOUNT}::bigint, ${c.recipient_code}, 'valid', ${NGN}, ${code}, null)`)[0].r },
      { fn: async (tx) => (await tx`select app.settle_withdrawal_transfer(${c.transfer_reference}, 'success', ${AMOUNT}::bigint, ${code}, 0, null, now()) as r`)[0].r },
    ]);
    const [approval, settle] = late.map(valueOrError);
    check(settle === "paid", "the success webhook settles", settle);
    check(approval === "approve:authorised" || approval === "reject:transfer_already_final" || approval === "reject:already_paid",
      "an approval racing the success either approves first or is refused as final", approval);
    const j = await journals(id);
    check(j.payouts === 1 && j.releases === 0, "exactly one payout, no release", JSON.stringify(j));
  }

  // ── 8. Duplicate payout webhook; success vs failure ───────────────────────
  console.log("8. the same success webhook delivered twice at once");
  {
    const id = await approvedWithdrawal();
    const [c] = await dispatch([id], "dispatch-s");
    const code = await sent(c);
    const results = await race([0, 1].map(() => ({
      fn: async (tx) => (await tx`select app.settle_withdrawal_transfer(${c.transfer_reference}, 'success', ${AMOUNT}::bigint, ${code}, 1000, null, now()) as r`)[0].r,
    })));
    check(results.map(valueOrError).sort().join(",") === "already_paid,paid", "one session pays, the other sees it already paid", results.map(valueOrError).join(","));
    const j = await journals(id);
    check(j.payouts === 1 && j.releases === 0, "exactly one payout journal", JSON.stringify(j));
    const [f] = await sql`select count(*)::int as n from public.ledger_journals where source_id = ${id} and idempotency_key like '%fee%'`;
    check(f.n <= 1, "the transfer fee is booked at most once", `${f.n}`);
  }
  {
    const id = await approvedWithdrawal();
    const [c] = await dispatch([id], "dispatch-f");
    const code = await sent(c);
    const results = await race([
      { fn: async (tx) => (await tx`select app.settle_withdrawal_transfer(${c.transfer_reference}, 'success', ${AMOUNT}::bigint, ${code}, 0, null, now()) as r`)[0].r },
      { fn: async (tx) => (await tx`select app.settle_withdrawal_transfer(${c.transfer_reference}, 'failed', null, ${code}, null, 'race failure', now()) as r`)[0].r },
    ]);
    const outcomes = results.map(valueOrError);
    const j = await journals(id);
    const s = await status(id);
    const consistent = (outcomes[0] === "paid" && outcomes[1] === "conflict" && s === "paid" && j.payouts === 1 && j.releases === 0)
      || (outcomes[1] === "failed" && outcomes[0] === "conflict" && s === "failed" && j.payouts === 0 && j.releases === 1);
    check(consistent, "success racing failure: paid or failed, never both", `${outcomes.join(",")} → ${s} ${JSON.stringify(j)}`);
  }

  // ── 9. Duplicate releases ─────────────────────────────────────────────────
  console.log("9. duplicate release attempts");
  {
    const c = dispatched[0];
    const results = await race([0, 1].map(() => ({
      fn: async (tx) => (await tx`select app.release_withdrawal_transfer_never_sent(${c.transfer_reference}, ${c.claim_token}, null) as r`)[0].r,
    })));
    const outcomes = results.map(valueOrError).sort();
    check(outcomes[0] === "failed" && ["not_eligible", "stale_claim", "already_failed"].includes(outcomes[1]),
      "a never-sent transfer is released by exactly one of two attempts", outcomes.join(","));
    const j = await journals(c.withdrawal_id);
    check(j.releases === 1 && j.payouts === 0, "exactly one release journal", JSON.stringify(j));
    // The other two dispatched-but-never-sent transfers, released through the same audited path.
    for (const other of dispatched.slice(1)) {
      await sql`select app.release_withdrawal_transfer_never_sent(${other.transfer_reference}, ${other.claim_token}, null)`;
    }
  }
  {
    const id = await verified(TREASURER);
    const results = await race([
      { uid: OWNER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'reject', 'race')::text as s`)[0].s },
      { uid: TREASURER, fn: async (tx) => (await tx`select app.decide_withdrawal(${id}, 'cancel')::text as s`)[0].s },
    ]);
    check(results.filter((r) => r.value).length === 1, "reject racing cancel: exactly one", JSON.stringify(results));
    const j = await journals(id);
    check(j.releases === 1, "the hold is released exactly once", JSON.stringify(j));
  }

  // ── 10. Ambiguity and NOT FOUND ───────────────────────────────────────────
  console.log("10. transfer ambiguity and repeated NOT FOUND checks");
  {
    const id = await approvedWithdrawal();
    const [c] = await dispatch([id], "dispatch-z");
    await sql`select app.mark_withdrawal_transfer_initiating(${c.transfer_reference}, ${c.claim_token})`;
    const [refused] = await sql`select status, resend_allowed, release_eligible from app.record_withdrawal_transfer_check(
      ${c.transfer_reference}, ${c.claim_token}, 'dispatch', 'dispatch-z', 'refused', null, 'unknown', 'unknown', ${c.recipient_code},
      null, null, 'initiate_refused', 'Recipient is blacklisted', true)`;
    check(refused.status === "unknown" && !refused.resend_allowed && !refused.release_eligible,
      "an ambiguous refusal is unknown: no resend, no release", JSON.stringify(refused));

    let lastToken = null;
    let staleToken = null;
    for (const n of [1, 2, 3]) {
      await sql`update public.withdrawal_transfers set next_check_at = now() - interval '1 second' where reference = ${c.transfer_reference}`;
      const results = await race(["check-a", "check-b"].map((worker) => ({
        fn: async (tx) => {
          const rows = await tx`select transfer_reference, claim_token from app.claim_withdrawal_transfers_to_check(${worker}, 50)`;
          for (const r of rows.filter((x) => x.transfer_reference !== c.transfer_reference)) {
            await tx`select app.release_withdrawal_transfer_claim(${r.transfer_reference}, ${r.claim_token})`;
          }
          return rows.filter((x) => x.transfer_reference === c.transfer_reference);
        },
      })));
      const got = results.flatMap((r) => r.value ?? []);
      check(got.length === 1, `check ${n}: exactly one checker holds the lease`, `${got.length}`);
      staleToken = lastToken;
      lastToken = got[0]?.claim_token;
      const [rec] = await sql`select not_found_count, resend_allowed, release_eligible, stale from app.record_withdrawal_transfer_check(
        ${c.transfer_reference}, ${lastToken}, 'check', 'checker', 'not_found', null, '404', 'unknown', null, null, null, 'not_found', null, ${n < 3})`;
      check(rec.not_found_count === n && !rec.stale, `check ${n}: NOT FOUND counted once (${n})`, JSON.stringify(rec));
      check(!rec.resend_allowed, `check ${n}: no blind re-send after an ambiguous refusal`);
      check(!rec.release_eligible, `check ${n}: not released before the policy's minimum age`);
    }
    // A checker whose lease was taken over answers late: nothing changes.
    const [stale] = await sql`select not_found_count, stale from app.record_withdrawal_transfer_check(
      ${c.transfer_reference}, ${staleToken}, 'check', 'checker-late', 'not_found', null, '404', 'unknown', null, null, null, 'not_found', null, true)`;
    check(stale.stale && stale.not_found_count === 3, "a stale checker's NOT FOUND is not counted", JSON.stringify(stale));

    // Test clock (scratch only): the refusal is 31 minutes old.
    await sql.begin(async (tx) => {
      await tx`alter table public.withdrawal_transfers disable trigger withdrawal_transfers_guard`;
      await tx`update public.withdrawal_transfers set refused_at = refused_at - interval '31 minutes' where reference = ${c.transfer_reference}`;
      await tx`alter table public.withdrawal_transfers enable trigger withdrawal_transfers_guard`;
    });
    const [elig] = await sql`select app.transfer_release_eligible(id) as e from public.withdrawal_transfers where reference = ${c.transfer_reference}`;
    check(elig.e === true, "after the policy's count and age the hold may be released");

    const results = await race([
      { fn: async (tx) => (await tx`select app.release_withdrawal_transfer_never_sent(${c.transfer_reference}, ${lastToken}, null) as r`)[0].r },
      { fn: async (tx) => (await tx`select app.release_withdrawal_transfer_never_sent(${c.transfer_reference}, ${staleToken}, null) as r`)[0].r },
    ]);
    check(valueOrError(results[0]) === "failed" && valueOrError(results[1]) === "stale_claim",
      "only the lease holder releases; a stale releaser does nothing", results.map(valueOrError).join(","));
    const j = await journals(id);
    check(j.releases === 1 && j.payouts === 0 && (await status(id)) === "failed", "failed with exactly one release and no payout", JSON.stringify(j));
    const [late] = await sql`select app.settle_withdrawal_transfer(${c.transfer_reference}, 'success', ${AMOUNT}::bigint, ${"TRF_late" + run}, 0, null, now()) as r`;
    check(late.r === "conflict", "a late success after the release settles nothing", late.r);
    const [ap] = await sql`select decision from app.decide_transfer_approval(${c.transfer_reference}, ${AMOUNT}::bigint, ${c.recipient_code}, 'valid', ${NGN}, ${"TRF_late" + run}, null)`;
    check(ap.decision === "reject", "and Paystack is told no if it asks to approve now", ap.decision);
    const j2 = await journals(id);
    check(j2.payouts === 0 && j2.releases === 1, "still no payout, still one release", JSON.stringify(j2));
  }

  // ── Run-scoped ledger checks ──────────────────────────────────────────────
  console.log("ledger");
  {
    const both = await sql`select id from public.withdrawals where id = any(${[...ours]}::uuid[])
                           and payout_journal_id is not null and release_journal_id is not null`;
    check(both.length === 0, "no withdrawal of this run is both paid and released", `${both.length}`);
    const dup = await sql`select source_id, idempotency_key from public.ledger_journals
                          where collection_id = any(${[COLL_A, COLL_B, COLL_C]}::uuid[])
                          group by source_id, idempotency_key having count(*) > 1`;
    check(dup.length === 0, "no journal idempotency key is posted twice", JSON.stringify(dup));
    const [imb] = await sql`select count(*)::int as n from public.v_ledger_imbalances where collection_id = any(${[COLL_A, COLL_B, COLL_C]}::uuid[])`;
    check(imb.n === 0, "every journal of this run balances", `${imb.n} imbalanced`);
    for (const [name, coll] of [["A", COLL_A], ["B", COLL_B], ["C", COLL_C]]) {
      const p = await position(coll);
      check(p.available >= 0 && p.withdrawing >= 0, `collection ${name}: no negative balance`, JSON.stringify(p));
      const bad = await sql`select check_name from app.collection_reconciliation_checks(${coll}) where not ok`;
      check(bad.every((r) => ["net_raised", "released_position"].includes(r.check_name)),
        `collection ${name} reconciles apart from the test funding`, bad.map((r) => r.check_name).join(","));
    }
  }

  console.log(`\n${passes} passed, ${failures} failed.`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await sql.end();
  process.exit(1);
});
