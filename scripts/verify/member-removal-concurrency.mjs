#!/usr/bin/env node
/**
 * Membership removal vs checkout under genuine two-session races
 * (Phase 3, migration 20261126100000; Policy B).
 *
 * WHY THIS IS NOT A pgTAP TEST. pgTAP runs in one session, so a lock can never
 * be made to block there. These scenarios hold one transaction open on its
 * own connection, start the competing call on a second connection, prove from
 * a third (pg_blocking_pids) that it is waiting on the first, then release.
 *
 *   A  checkout first: create_payment_attempt holds the member lock; archive
 *      waits; checkout commits; archive proceeds. Attempt exists, member
 *      archived, passes revoked.
 *   B  archive first: checkout waits; archive commits; checkout resumes and
 *      is refused (MEMBER_NOT_ELIGIBLE). Nothing written.
 *   C  remove_member_from_group vs a 'groups' checkout, both orders.
 *   D  set_member_groups vs a 'groups' checkout, both orders.
 *   E  Policy B: an attempt made before the archive is captured after it —
 *      while another archive of the same member is in flight, capture does not
 *      wait on the member lock; two concurrent captures produce one
 *      contribution; a replayed provider success changes nothing; journals
 *      balance; the contribution is attributed to the archived member.
 *   F  restore: the pre-archive pass stays revoked; a checkout racing a
 *      restore with the old pass waits, then is refused (MEMBER_PROOF_EXPIRED);
 *      a fresh validation yields a working pass.
 *
 * Provider: no network. A provider success is written the way the
 * orchestrator writes the fake provider's verify result
 * (app.record_provider_transaction with provider 'fake').
 *
 * SAFETY. Refuses unless current_database() starts with `kolekto_scratch` and
 * the host is this machine. Every fixture is this run's own (random ids).
 * Nothing is deleted. Clean-up is dropping the throwaway scratch database.
 *
 * Usage (itest stack shown; dev works the same with its container/port):
 *   docker exec supabase_db_kolekto-itest psql -U supabase_admin -d postgres -c "create database kolekto_scratch_removal"
 *   docker exec supabase_db_kolekto-itest sh -c "pg_dump -U supabase_admin -d postgres | psql -U supabase_admin -d kolekto_scratch_removal -q"
 *   docker exec supabase_db_kolekto-itest psql -U postgres -d kolekto_scratch_removal \
 *     -c "select pgmq.create('notification_events'); select pgmq.create('notification_events_held');"
 *   SCRATCH_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55422/kolekto_scratch_removal \
 *     node scripts/verify/member-removal-concurrency.mjs
 */

import postgres from "postgres";
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

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

const connect = (name) =>
  postgres(URL_, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: `m79-race-${name}`, lock_timeout: "20s", statement_timeout: "60000" },
  });

const admin = connect("admin");
const [{ db }] = await admin`select current_database() as db`;
if (!db.startsWith("kolekto_scratch")) {
  console.error(`REFUSING: ${db} is not a kolekto_scratch* database.`);
  await admin.end();
  process.exit(2);
}

let passes = 0;
let failures = 0;
function check(condition, description, detail) {
  if (condition) {
    passes += 1;
    console.log(`  ok   ${description}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${description}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const run = randomUUID().slice(0, 8);
const OWNER = randomUUID();
const COMMUNITY = randomUUID();
const GROUP = randomUUID();
const DUES = randomUUID(); // all_members, fixed ₦5,000
const COMMITTEE = randomUUID(); // audience = GROUP
const claims = JSON.stringify({ sub: OWNER, role: "authenticated" });
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: membership_ids_plaintext_format
const code = () => Array.from(randomBytes(5), (b) => ALPHA[b % ALPHA.length]).join("");
const phone = () => `+23480${String(10000000 + (randomBytes(4).readUInt32BE() % 89999999))}`;
const ref = () => `KLK-${Array.from(randomBytes(26), (b) => String(b % 10)).join("")}`;

const names = ["a", "b", "c1", "c2", "d1", "d2", "e", "f1", "f2"];
const M = Object.fromEntries(names.map((n) => [n, { id: randomUUID(), mid: `SCR/${code()}` }]));
const inGroup = ["c1", "c2", "d1", "d2"];

await admin.begin(async (tx) => {
  await tx`insert into auth.users (id, instance_id, aud, role, email)
           values (${OWNER}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${`owner-${run}@scratch.example.test`})`;
  await tx`insert into public.users (id, full_name, email) values (${OWNER}, ${`Race Owner ${run}`}, ${`owner-${run}@scratch.example.test`})
           on conflict (id) do update set full_name = excluded.full_name`;
  await tx`insert into public.communities (id, slug, name, type, is_personal, created_by)
           values (${COMMUNITY}, ${`scr-${run}`}, ${`Scratch ${run}`}, 'social_group', false, ${OWNER})`;
  await tx`insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
           values (${COMMUNITY}, ${OWNER}, 'owner', 'Race Owner', 'created')`;
  await tx`insert into public.community_membership_id_settings (community_id, prefix, separator, suffix_length, enabled)
           values (${COMMUNITY}, 'SCR', '/', 5, true)`;
  for (const n of names) {
    await tx`insert into public.members (id, community_id, full_name, phone_e164, status, joined_via)
             values (${M[n].id}, ${COMMUNITY}, ${`Member ${n} ${run}`}, ${phone()}, 'active', 'manual')`;
    await tx`insert into public.membership_ids (community_id, member_id, membership_id, canonical_id, prefix, separator, last2)
             values (${COMMUNITY}, ${M[n].id}, ${M[n].mid}, app.canonical_membership_id(${M[n].mid}), 'SCR', '/', right(${M[n].mid}, 2))`;
  }
  await tx`insert into public.member_groups (id, community_id, name, created_by) values (${GROUP}, ${COMMUNITY}, 'Committee', ${OWNER})`;
  for (const n of inGroup) {
    await tx`insert into public.member_group_memberships (group_id, member_id, added_by) values (${GROUP}, ${M[n].id}, ${OWNER})`;
  }
  for (const [id, slug] of [[DUES, "dues"], [COMMITTEE, "committee"]]) {
    await tx`insert into public.collections
               (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
                status, visibility, fee_mode, collect_attendee_details, close_when_target_reached, created_by)
             values (${id}, ${COMMUNITY}, ${`scr-${run}-${slug}`}, ${`Scratch ${slug}`}, 'dues', 'managed', 'fixed', 500000,
                     'active', 'unlisted', 'community_absorbs', false, false, ${OWNER})`;
  }
  await tx`update public.collections set audience_mode = 'groups' where id = ${COMMITTEE}`;
  await tx`insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by)
           values (${COMMITTEE}, ${GROUP}, ${COMMUNITY}, ${OWNER})`;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function issuePass(member, collection) {
  const token = randomBytes(32).toString("hex");
  await admin`insert into public.membership_access_grants (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
              select extensions.digest(${token}, 'sha256'), mi.id, mi.member_id, ${collection}, mi.community_id, now(), now() + interval '30 minutes'
              from public.membership_ids mi where mi.member_id = ${member} and mi.revoked_at is null`;
  return token;
}

const checkout = (c, collection, member, token, key, reference) => c`
  select * from app.create_payment_attempt(
    ${collection}::uuid, ${`scr-${run}-${key}`}, ${reference}, 'fake', ${member}::uuid,
    'Race Payer', ${`payer-${run}@scratch.example.test`}, '+2348000000079', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000,
    'community_absorbs', '2026-11-founder', ${token})`;

async function beginAsOwner(c) {
  await c.unsafe("begin");
  await c`select set_config('role', 'authenticated', true)`;
  await c`select set_config('request.jwt.claims', ${claims}, true)`;
}

const asOwner = (fn) =>
  admin.begin(async (tx) => {
    await tx`select set_config('role', 'authenticated', true)`;
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return fn(tx);
  });

/** A promise whose outcome can be inspected without awaiting it. */
function track(promise) {
  const t = { done: false, value: undefined, error: undefined };
  t.settled = promise.then(
    (v) => Object.assign(t, { done: true, value: v }),
    (e) => Object.assign(t, { done: true, error: e }),
  );
  return t;
}

const obs = connect("observer");
const pid = async (c) => (await c`select pg_backend_pid() as p`)[0].p;

async function waitBlocked(waiterPid, blockerPid, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [r] = await obs`select pg_blocking_pids(${waiterPid}::int) as b`;
    if ((r.b ?? []).map(Number).includes(Number(blockerPid))) return true;
    await sleep(50);
  }
  return false;
}

/** True when the observer cannot take FOR NO KEY UPDATE on the member row right now (someone holds a conflicting lock). */
async function rowLockedAgainstRemoval(member) {
  try {
    await obs.begin(async (tx) => tx`select 1 from public.members where id = ${member} for no key update nowait`);
    return false;
  } catch (e) {
    return e.code === "55P03";
  }
}

async function attemptsForKey(key) {
  const [r] = await admin`select count(*)::int as n from public.contribution_intents
                          where collection_id in (${DUES}, ${COMMITTEE}) and checkout_idempotency_key = ${`scr-${run}-${key}`}`;
  return r.n;
}

const memberStatus = async (member) => (await admin`select status::text as s from public.members where id = ${member}`)[0].s;
const liveGrants = async (member) =>
  (await admin`select count(*)::int as n from public.membership_access_grants where member_id = ${member} and revoked_at is null`)[0].n;
const inGroupNow = async (member) =>
  (await admin`select count(*)::int as n from public.member_group_memberships where group_id = ${GROUP} and member_id = ${member}`)[0].n;

const removals = {
  archive: (c, member) => c`select app.archive_member(${member}, 'concurrency test')`,
  removeFromGroup: (c, member) => c`select app.remove_member_from_group(${GROUP}, ${member})`,
  setGroupsEmpty: (c, member) => c`select app.set_member_groups(${member}, '{}'::uuid[])`,
};

// ── Generic races ───────────────────────────────────────────────────────────

/** Checkout holds the member lock; removal waits; checkout commits; removal proceeds. */
async function checkoutFirst(label, n, collection, removal) {
  console.log(`\n${label}: checkout first, then ${removal}`);
  const member = M[n].id;
  const token = await issuePass(member, collection);
  const A = connect(`A-${n}`);
  const B = connect(`B-${n}`);
  try {
    const [aPid, bPid] = [await pid(A), await pid(B)];
    await A.unsafe("begin");
    const [att] = await checkout(A, collection, member, token, `${n}-first`, ref());
    check(att?.attempt_id && att.reused === false, `${label}: session A created the attempt inside an open transaction`);
    const [{ x }] = await A`select (pg_current_xact_id()::text::bigint % 4294967296)::text as x`;
    const [{ xmax }] = await obs`select xmax::text as xmax from public.members where id = ${member}`;
    check(xmax === x, `${label}: the member row carries session A's lock (xmax = A's xid)`, `xmax ${xmax}, A ${x}`);
    check(await rowLockedAgainstRemoval(member), `${label}: a removal-mode lock (FOR NO KEY UPDATE NOWAIT) is refused while A is open`);

    await beginAsOwner(B);
    const pB = track(removals[removal](B, member));
    check(await waitBlocked(bPid, aPid), `${label}: session B (${removal}) is waiting on session A`);
    await sleep(300);
    check(!pB.done, `${label}: B is still waiting 300 ms later`);

    await A.unsafe("commit");
    await pB.settled;
    check(pB.error === undefined, `${label}: after A commits, B's ${removal} completes`, pB.error?.message);
    await B.unsafe(pB.error ? "rollback" : "commit");

    const [row] = await admin`select status::text as s, member_id from public.payment_attempts where id = ${att.attempt_id}`;
    check(row?.s === "created" && row.member_id === member, `${label}: the attempt exists, created, attributed to the member`);
    if (removal === "archive") {
      check((await memberStatus(member)) === "archived", `${label}: the member is archived`);
      check((await liveGrants(member)) === 0, `${label}: the member's passes are revoked`);
    } else {
      check((await inGroupNow(member)) === 0, `${label}: the member is out of the group`);
    }
    return att.attempt_id;
  } finally {
    await A.end();
    await B.end();
  }
}

/** Removal holds the member lock; checkout waits; removal commits; checkout is refused. */
async function removalFirst(label, n, collection, removal, expectedCode) {
  console.log(`\n${label}: ${removal} first, then checkout`);
  const member = M[n].id;
  const token = await issuePass(member, collection);
  const A = connect(`A-${n}`);
  const B = connect(`B-${n}`);
  try {
    const [aPid, bPid] = [await pid(A), await pid(B)];
    await beginAsOwner(B);
    await removals[removal](B, member);
    check(await rowLockedAgainstRemoval(member), `${label}: session B holds the member-row lock (${removal}, uncommitted)`);

    await A.unsafe("begin");
    const pA = track(checkout(A, collection, member, token, `${n}-second`, ref()));
    check(await waitBlocked(aPid, bPid), `${label}: session A (checkout) is waiting on session B`);
    await sleep(300);
    check(!pA.done, `${label}: A is still waiting 300 ms later`);

    await B.unsafe("commit");
    await pA.settled;
    check(
      pA.error?.message?.startsWith(`${expectedCode}:`),
      `${label}: after B commits, checkout resumes and is refused with ${expectedCode}`,
      pA.error?.message ?? "checkout succeeded",
    );
    await A.unsafe("rollback");
    check((await attemptsForKey(`${n}-second`)) === 0, `${label}: the refused checkout wrote no intent or attempt`);
  } finally {
    await A.end();
    await B.end();
  }
}

// ── Scenarios A–D ───────────────────────────────────────────────────────────

await checkoutFirst("A", "a", DUES, "archive");
await removalFirst("B", "b", DUES, "archive", "MEMBER_NOT_ELIGIBLE");
await checkoutFirst("C1", "c1", COMMITTEE, "removeFromGroup");
await removalFirst("C2", "c2", COMMITTEE, "removeFromGroup", "MEMBER_NOT_ELIGIBLE");
await checkoutFirst("D1", "d1", COMMITTEE, "setGroupsEmpty");
await removalFirst("D2", "d2", COMMITTEE, "setGroupsEmpty", "MEMBER_NOT_ELIGIBLE");

// ── Scenario E — Policy B ───────────────────────────────────────────────────

console.log("\nE: Policy B — an attempt made before the archive completes after it");
{
  const member = M.e.id;
  const token = await issuePass(member, DUES);
  const reference = ref();
  const [att] = await checkout(admin, DUES, member, token, "e-before", reference);
  await admin`select app.mark_payment_attempt_initialized(${att.attempt_id}, 'fake_access_code')`;
  await asOwner((tx) => tx`select app.archive_member(${member}, 'left before paying')`);
  const [a1] = await admin`select status::text as s, member_id from public.payment_attempts where id = ${att.attempt_id}`;
  check(a1.s === "initialized" && a1.member_id === member && (await memberStatus(member)) === "archived",
    "E: after the archive the attempt is still initialized and still the member's (not cancelled)");

  const A = connect("A-e");
  const B = connect("B-e");
  const C = connect("C-e");
  try {
    const [aPid] = [await pid(A)];
    const cPid = await pid(C);

    // Another removal of the same member is in flight for the whole capture.
    await beginAsOwner(B);
    await removals.archive(B, member);
    check(await rowLockedAgainstRemoval(member), "E: session B holds the member-row lock (archive again, uncommitted)");

    const statement = (status) => A`
      select status::text as s from app.record_provider_transaction(
        ${reference}, 'fake', ${`FAKE_TXN_${run}`}, ${reference}, ${status}, 'success',
        500000, 'NGN', 7500, now(), 'card', null, '{"__fake": true}'::jsonb)`;

    await A.unsafe("begin");
    await A`set local lock_timeout = '3s'`;
    const t0 = Date.now();
    const [rec] = await statement("succeeded");
    await A.unsafe("commit");
    check(rec.s === "captured", "E: the provider success is recorded (captured) while B holds the member lock", rec.s);

    // Two captures at once: the second waits on the attempt row, then returns the first's result.
    await A.unsafe("begin");
    await A`set local lock_timeout = '3s'`;
    const [cap1] = await A`select * from app.complete_payment_capture(${att.attempt_id})`;
    check(Date.now() - t0 < 3000 && cap1.status === "completed",
      "E: capture completes without waiting on the member lock (lock_timeout 3s not hit)", `${Date.now() - t0} ms, ${cap1.status}`);

    await C.unsafe("begin");
    const pC = track(C`select * from app.complete_payment_capture(${att.attempt_id})`);
    check(await waitBlocked(cPid, aPid), "E: a concurrent second capture waits on the first");
    await A.unsafe("commit");
    await pC.settled;
    await C.unsafe("commit");
    const cap2 = pC.value?.[0];
    check(cap2?.status === "completed" && cap2.contribution_id === cap1.contribution_id,
      "E: the second capture returns the same contribution (exactly once)", pC.error?.message);

    await B.unsafe("rollback");

    // A replayed provider success (webhook retry) changes nothing.
    const [rec2] = await statement("succeeded");
    const [cap3] = await admin`select * from app.complete_payment_capture(${att.attempt_id})`;
    check(rec2.s === "completed" && cap3.contribution_id === cap1.contribution_id, "E: a replayed provider success is a no-op");

    const [c] = await admin`select count(*)::int as n, min(member_id::text) as m, sum(contribution_kobo)::bigint as k
                            from public.contributions where attempt_id = ${att.attempt_id}`;
    check(c.n === 1 && c.m === member && Number(c.k) === 500000, "E: exactly one contribution, ₦5,000, attributed to the archived member");
    const [st] = await admin`select status::text as s from public.payment_attempts where id = ${att.attempt_id}`;
    check(st.s === "completed", "E: the attempt is completed");
    const [ob] = await admin`select o.status::text as s from public.obligations o
                             join public.contributions c on c.obligation_id = o.id where c.attempt_id = ${att.attempt_id}`;
    check(ob?.s === "paid", "E: the obligation created on capture is paid");
    const [j] = await admin`select count(*)::int as n from public.ledger_journals where idempotency_key = ${`capture:${att.attempt_id}`}`;
    check(j.n === 1, "E: one capture journal");
    const [bal] = await admin`
      select count(*)::int as journals,
             count(*) filter (where d <> cr)::int as unbalanced
      from (select e.journal_id,
                   sum(e.amount_kobo) filter (where e.direction = 'debit')  as d,
                   sum(e.amount_kobo) filter (where e.direction = 'credit') as cr
            from public.ledger_entries e
            join public.ledger_journals lj on lj.id = e.journal_id
            where lj.idempotency_key like ${`%:${att.attempt_id}`}
            group by e.journal_id) s`;
    check(bal.journals >= 2 && bal.unbalanced === 0, `E: this payment's ${bal.journals} journals each balance`);
    const [all] = await admin`
      select count(*) filter (where d is distinct from cr)::int as unbalanced from (
        select journal_id, sum(amount_kobo) filter (where direction = 'debit') as d,
                           sum(amount_kobo) filter (where direction = 'credit') as cr
        from public.ledger_entries group by journal_id) s`;
    check(all.unbalanced === 0, "E: every journal in the database balances");
    const [orph] = await admin`
      select count(*)::int as n from public.provider_transactions t
      join public.payment_attempts a on a.id = t.attempt_id
      where a.community_id = ${COMMUNITY} and t.status_mapped = 'succeeded'
        and not exists (select 1 from public.contributions c where c.attempt_id = a.id)`;
    check(orph.n === 0, "E: no successful provider payment in this run lacks a contribution (none orphaned)");
  } finally {
    await A.end();
    await B.end();
    await C.end();
  }
}

// ── Scenario F — restore ────────────────────────────────────────────────────

console.log("\nF: restore");
{
  // F1: sequential restore.
  const member = M.f1.id;
  const oldToken = await issuePass(member, DUES);
  await asOwner((tx) => tx`select app.archive_member(${member}, 'left')`);
  const [{ s }] = await asOwner((tx) => tx`select app.restore_member(${member}, 'back') as s`);
  check(s === "active", "F1: the restored member is active again");
  const [{ r }] = await admin`select app.resolve_membership_access_grant(${DUES}, ${oldToken}) as r`;
  check(r === null, "F1: the pre-archive pass stays revoked");
  let err;
  try {
    await checkout(admin, DUES, member, oldToken, "f1-old", ref());
  } catch (e) {
    err = e;
  }
  check(err?.message?.startsWith("MEMBER_PROOF_EXPIRED:"), "F1: checkout with the old proof is refused", err?.message ?? "succeeded");
  const ipHash = randomBytes(32);
  const [v] = await admin`select * from app.validate_membership_id(${DUES}, ${M.f1.mid}, ${ipHash})`;
  check(v.valid === true && typeof v.access_token === "string", "F1: a fresh membership-ID validation issues a new pass");
  const [att] = await checkout(admin, DUES, member, v.access_token, "f1-new", ref());
  const [row] = await admin`select member_id from public.payment_attempts where id = ${att.attempt_id}`;
  check(row.member_id === member, "F1: the new pass starts a checkout attributed to the member");

  // F2: checkout with the old pass racing the restore.
  const m2 = M.f2.id;
  const old2 = await issuePass(m2, DUES);
  await asOwner((tx) => tx`select app.archive_member(${m2}, 'left')`);
  const A = connect("A-f2");
  const B = connect("B-f2");
  try {
    const [aPid, bPid] = [await pid(A), await pid(B)];
    await beginAsOwner(B);
    await B`select app.restore_member(${m2}, 'back')`;
    await A.unsafe("begin");
    const pA = track(checkout(A, DUES, m2, old2, "f2-old", ref()));
    check(await waitBlocked(aPid, bPid), "F2: a checkout with the old pass waits on the uncommitted restore");
    await B.unsafe("commit");
    await pA.settled;
    check(pA.error?.message?.startsWith("MEMBER_PROOF_EXPIRED:"),
      "F2: after the restore commits, the old pass is still refused", pA.error?.message ?? "succeeded");
    await A.unsafe("rollback");
    check((await attemptsForKey("f2-old")) === 0, "F2: nothing written");
  } finally {
    await A.end();
    await B.end();
  }
}

await obs.end();
await admin.end();
console.log(`\nrun ${run}: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
