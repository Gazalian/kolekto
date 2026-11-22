-- ─────────────────────────────────────────────────────────────────────────────
-- 69 — Member one-time code and mandatory community owner approval
--      (20261119120000; owner decisions 2026-11-19, D and E)
--
--   · every request starts requested, reserves the amount, opens a code
--   · unconfirmed email cannot request; only the requester reads / verifies
--   · delivery: hash only, write-once, 10 minutes, 5 attempts
--   · wrong codes count and lock; a lock moves no money
--   · resend: 60 s cooldown, supersedes, 5 per request, 10 per member-hour
--   · a code is bound to its challenge; single use; expiry
--   · owner only: a treasurer's withdrawal.approve does not approve; nor a
--     stranger or another community's owner; no approval after reject / cancel
--   · approve only after the code; reject needs a reason; cancel; codes close
--   · nobody approves their own request: an owner's request needs a
--     designated second approver (admin/owner, designated by an owner);
--     a treasurer, an undesignated admin or another community's owner cannot
--     (20261120100000, owner brief 2026-11-20)
--   · a destination account that changed blocks approval
--   · the transfer claim needs both conditions
--   · grants, RLS, audit carries no code hash
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(102);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a6910000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@otp.example.test', now()),
  ('a6910000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@otp.example.test', now()),
  ('a6910000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unconfirmed@otp.example.test', null),
  ('a6910000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@otp.example.test', now()),
  ('a6910000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other-owner@otp.example.test', now());
insert into public.users (id, full_name, email) values
  ('a6910000-0000-4000-8000-000000000001', 'Ngozi Eze',     'owner@otp.example.test'),
  ('a6910000-0000-4000-8000-000000000002', 'Bayo Adeyemi',  'treasurer@otp.example.test'),
  ('a6910000-0000-4000-8000-000000000003', 'Chidi Nwosu',   'unconfirmed@otp.example.test'),
  ('a6910000-0000-4000-8000-000000000004', 'Some Stranger', 'stranger@otp.example.test'),
  ('a6910000-0000-4000-8000-000000000005', 'Other Owner',   'other-owner@otp.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6920000-0000-4000-8000-00000000000a', 'otp-tests', 'OTP Tests', 'social_group', false, 'a6910000-0000-4000-8000-000000000001'),
  ('a6920000-0000-4000-8000-00000000000b', 'otp-other', 'Another Community', 'social_group', false, 'a6910000-0000-4000-8000-000000000005');
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values ('a6950000-0000-4000-8000-000000000001', 'a6920000-0000-4000-8000-00000000000a', 'otp-a', 'Class Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6910000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000001', 'owner',     'Ngozi Eze',    'created', null),
  ('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000002', 'treasurer', 'Bayo Adeyemi', 'invited', null),
  ('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000003', 'treasurer', 'Chidi Nwosu',  'invited', null),
  ('a6920000-0000-4000-8000-00000000000b', 'a6910000-0000-4000-8000-000000000005', 'owner',     'Other Owner',  'created', null);

create function pg_temp.pos() returns text language sql as $$
  select pending_kobo::bigint || ':' || available_kobo || ':' || withdrawing_kobo || ':' || withdrawn_kobo
  from public.v_collection_position where collection_id = 'a6950000-0000-4000-8000-000000000001'
$$;

-- A known keyed hash per challenge: the database only ever compares hashes.
create function pg_temp.h(p_challenge uuid, p_code text) returns text language sql as $$
  select encode(sha256(convert_to(p_code || ':' || p_challenge, 'UTF8')), 'hex')
$$;

-- Test clock: move a request's codes two minutes into the past (past the
-- 60-second resend cooldown). The guard trigger is bypassed for the fixture only.
create function pg_temp.age(p_withdrawal uuid) returns void language plpgsql as $$
begin
  alter table public.withdrawal_otp_challenges disable trigger withdrawal_otp_challenges_guard;
  update public.withdrawal_otp_challenges set created_at = created_at - interval '2 minutes' where withdrawal_id = p_withdrawal;
  alter table public.withdrawal_otp_challenges enable trigger withdrawal_otp_challenges_guard;
end;
$$;

create function pg_temp.expire(p_challenge uuid) returns void language plpgsql as $$
begin
  alter table public.withdrawal_otp_challenges disable trigger withdrawal_otp_challenges_guard;
  update public.withdrawal_otp_challenges set expires_at = now() - interval '1 second' where id = p_challenge;
  alter table public.withdrawal_otp_challenges enable trigger withdrawal_otp_challenges_guard;
end;
$$;

-- The worker's delivery step, played by hand (operator session).
create function pg_temp.deliver() returns integer language plpgsql as $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from app.claim_withdrawal_otp_deliveries(50) loop
    perform app.record_withdrawal_otp_issued(r.challenge_id, pg_temp.h(r.challenge_id, 'good'));
    perform app.record_withdrawal_otp_delivery(r.challenge_id, true, null);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- A resend by a member, after moving the clock past the cooldown.
create function pg_temp.resend(p_withdrawal uuid, p_user uuid) returns uuid language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.age(p_withdrawal);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select challenge_id into v from app.request_withdrawal_otp(p_withdrawal);
  perform set_config('role', 'none', true);
  return v;
end;
$$;

create function pg_temp.v(p_withdrawal uuid, p_challenge uuid, p_hash text) returns text language sql as $$
  select outcome || ':' || coalesce(attempts_remaining::text, '-') from app.verify_withdrawal_otp(p_withdrawal, p_challenge, p_hash)
$$;

create temporary table tmp_b (label text primary key, id uuid);
create temporary table tmp_w (label text primary key, id uuid);
create temporary table tmp_k (label text primary key, id uuid);
grant all on tmp_b, tmp_w, tmp_k to authenticated;

insert into tmp_b select 'T', bank_account_id from app.register_bank_account(
  'a6910000-0000-4000-8000-000000000002', '058', 'GTBank', '0123400002', 'ADEYEMI BAYO', 'Bayo Adeyemi', true);
insert into tmp_b select 'O', bank_account_id from app.register_bank_account(
  'a6910000-0000-4000-8000-000000000001', '044', 'Access Bank', '0123400001', 'EZE NGOZI', 'Ngozi Eze', true);
select app.set_bank_account_recipient((select id from tmp_b where label = 'T'), 'RCP_otptreas01');

-- ₦50,000 available (test-only funding).
select app.post_ledger_journal(
  'a6920000-0000-4000-8000-00000000000a', 'a6950000-0000-4000-8000-000000000001', now(), 'adjustment',
  'a6950000-0000-4000-8000-000000000001', 'test fixture funding', 'test-fund-otp',
  jsonb_build_array(
    jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'), 'direction', 'debit', 'amount_kobo', 5000000),
    jsonb_build_object('account_id', app.ensure_ledger_account('a6920000-0000-4000-8000-00000000000a', 'a6950000-0000-4000-8000-000000000001', 'collection_available'),
                       'direction', 'credit', 'amount_kobo', 5000000)),
  'system', null);


-- ── Request ─────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_like(format($$ select * from app.request_withdrawal_to_account('a6950000-0000-4000-8000-000000000001', 100000, %L, 'otp-key-u1') $$,
                          (select id from tmp_b where label = 'T')),
  '%EMAIL_NOT_VERIFIED%', 'a member whose email is not confirmed cannot request a withdrawal (the code goes there)');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into tmp_w select 'w1', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 1000000, (select id from tmp_b where label = 'T'), 'otp-key-w1');
select is((select stage || ':' || available_before_kobo || ':' || status from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'w1')),
  'awaiting_member_verification:5000000:requested', 'a treasurer''s ₦10,000 request starts requested, awaiting the member''s code, with the balance before it recorded');
select is(pg_temp.pos(), '0:4000000:1000000:0', 'the amount is reserved at request time');
insert into tmp_k select 'w1c1', challenge_id from app.withdrawal_otp_state((select id from tmp_w where label = 'w1'));
select is((select challenge_status || ':' || member_verified || ':' || stage || ':' || email_hint
           from app.withdrawal_otp_state((select id from tmp_w where label = 'w1'))),
  'pending_delivery:false:awaiting_member_verification:t•••@otp.example.test', 'the requester sees a code on its way to their masked, confirmed email');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'),
                    pg_temp.h((select id from tmp_k where label = 'w1c1'), 'good')),
  'not_sent:-', 'no code is accepted before one was issued');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format($$ select * from app.withdrawal_otp_state(%L) $$, (select id from tmp_w where label = 'w1')),
  'P0002', null, 'the owner cannot read the requester''s code state');
select throws_ok(format($$ select * from app.verify_withdrawal_otp(%L, %L, %L) $$, (select id from tmp_w where label = 'w1'),
                        (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'good')),
  'P0002', null, 'nor enter a code for it: only the requesting member verifies');
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '%WITHDRAWAL_AWAITING_MEMBER_VERIFICATION%', 'the owner cannot approve before the member has confirmed');
select throws_ok($$ select * from app.claim_withdrawal_otp_deliveries(10) $$, '42501', null, 'a client cannot claim code deliveries');


-- ── Delivery (worker) ───────────────────────────────────────────────────────

reset role;
select is((select email || ':' || account_last4 || ':' || amount_kobo from app.claim_withdrawal_otp_deliveries(10)),
  'treasurer@otp.example.test:0002:1000000', 'the worker gets the requester''s confirmed email and only the last four digits');
select throws_ok(format($$ select app.record_withdrawal_otp_issued(%L, '123456') $$, (select id from tmp_k where label = 'w1c1')),
  '22023', null, 'only a 64-character keyed hash is stored, never the 6-digit code');
select is(app.record_withdrawal_otp_issued((select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'good')),
  true, 'the hash is recorded before the email is sent');
select is(app.record_withdrawal_otp_issued((select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'other')),
  false, 'a challenge is issued once: a second code is not stored or sent');
select is(app.record_withdrawal_otp_delivery((select id from tmp_k where label = 'w1c1'), true, null), 'sent', 'delivery is recorded');
select is((select status || ':' || (expires_at = issued_at + interval '10 minutes') || ':' || attempts || '/' || max_attempts
           from public.withdrawal_otp_challenges where id = (select id from tmp_k where label = 'w1c1')),
  'sent:true:0/5', 'valid for 10 minutes from issue, 5 attempts');
select throws_ok(format($$ update public.withdrawal_otp_challenges set code_hash = %L where id = %L $$,
                        pg_temp.h((select id from tmp_k where label = 'w1c1'), 'other'), (select id from tmp_k where label = 'w1c1')),
  'P0001', null, 'an issued code hash never changes');
select throws_ok(format($$ delete from public.withdrawal_otp_challenges where id = %L $$, (select id from tmp_k where label = 'w1c1')),
  'P0001', null, 'code records are never deleted');


-- ── Wrong codes and the lock ────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'bad1')),
  'incorrect:4', 'a wrong code is counted: 4 attempts left');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'bad2')),
  'incorrect:3', 'second wrong code: 3 left');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'bad3')),
  'incorrect:2', 'third wrong code: 2 left');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'bad4')),
  'incorrect:1', 'fourth wrong code: 1 left');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'bad5')),
  'locked:0', 'the fifth wrong code locks the challenge');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c1'), pg_temp.h((select id from tmp_k where label = 'w1c1'), 'good')),
  'locked:0', 'after the lock even the right code is refused');
select is(pg_temp.pos(), '0:4000000:1000000:0', 'wrong codes and a lock move no money: still reserved, nothing paid, nothing released');
select is((select stage from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'w1')),
  'awaiting_member_verification', 'and the request still awaits the member');


-- ── Resend, supersede, binding, single use ──────────────────────────────────

select throws_like(format($$ select * from app.request_withdrawal_otp(%L) $$, (select id from tmp_w where label = 'w1')),
  '%OTP_RESEND_TOO_SOON%', 'a new code is refused within 60 seconds of the last');

reset role;
insert into tmp_k select 'w1c2', pg_temp.resend((select id from tmp_w where label = 'w1'), 'a6910000-0000-4000-8000-000000000002');
select is(pg_temp.deliver(), 1, 'the resent code is delivered');
select is((select string_agg(status, ',' order by created_at) from public.withdrawal_otp_challenges where withdrawal_id = (select id from tmp_w where label = 'w1')),
  'locked,sent', 'the locked code stays locked; the new one is sent');
insert into tmp_k select 'w1c3', pg_temp.resend((select id from tmp_w where label = 'w1'), 'a6910000-0000-4000-8000-000000000002');
select is(pg_temp.deliver(), 1, 'the third code is delivered');
select is((select string_agg(status, ',' order by created_at) from public.withdrawal_otp_challenges where withdrawal_id = (select id from tmp_w where label = 'w1')),
  'locked,superseded,sent', 'a resend supersedes the open code');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into tmp_w select 'w2', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 100000, (select id from tmp_b where label = 'T'), 'otp-key-w2');
insert into tmp_k select 'w2c1', challenge_id from app.withdrawal_otp_state((select id from tmp_w where label = 'w2'));

select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c2'), pg_temp.h((select id from tmp_k where label = 'w1c2'), 'good')),
  'superseded:-', 'the superseded code no longer works');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c3'), pg_temp.h((select id from tmp_k where label = 'w1c2'), 'good')),
  'incorrect:4', 'a code issued under another challenge does not match this one');
select throws_like(format($$ select * from app.verify_withdrawal_otp(%L, %L, %L) $$, (select id from tmp_w where label = 'w1'),
                          (select id from tmp_k where label = 'w2c1'), pg_temp.h((select id from tmp_k where label = 'w2c1'), 'good')),
  '%OTP_CHALLENGE_MISMATCH%', 'another withdrawal''s code is never usable for this one');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c3'), pg_temp.h((select id from tmp_k where label = 'w1c3'), 'good')),
  'verified:-', 'the right code, in time, verifies');
select is(pg_temp.v((select id from tmp_w where label = 'w1'), (select id from tmp_k where label = 'w1c3'), pg_temp.h((select id from tmp_k where label = 'w1c3'), 'good')),
  'already_verified:-', 'single use: verifying again changes nothing');
select is((select stage || ':' || (member_verified_at is not null) || ':' || can_decide
           from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'w1')),
  'awaiting_owner_approval:true:false', 'confirmed, now awaiting the owner; the treasurer cannot decide');
select throws_like(format($$ select * from app.request_withdrawal_otp(%L) $$, (select id from tmp_w where label = 'w1')),
  '%WITHDRAWAL_ALREADY_VERIFIED%', 'no new code once confirmed');
select is(pg_temp.pos(), '0:3900000:1100000:0', 'verifying moves no money either');


-- ── Owner only (decision E) ─────────────────────────────────────────────────

select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '42501', null, 'a treasurer holding withdrawal.approve cannot approve');
select throws_ok(format($$ select app.decide_withdrawal(%L, 'reject', 'no') $$, (select id from tmp_w where label = 'w1')),
  '42501', null, 'nor reject');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '42501', null, 'a stranger cannot approve');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '42501', null, 'the owner of another community cannot approve');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select can_decide || ':' || can_reject from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'w1')),
  'true:true', 'the owner sees Approve and Reject once the member has confirmed');
select is(app.decide_withdrawal((select id from tmp_w where label = 'w1'), 'approve')::text, 'approved', 'the owner approves');
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w1')),
  '%WITHDRAWAL_NOT_PENDING%', 'an approval is given once');

reset role;
select is((select (approved_by = 'a6910000-0000-4000-8000-000000000001')::text || ':' || owner_self_approved || ':'
                  || (member_otp_challenge_id = (select id from tmp_k where label = 'w1c3')) || ':' || app.withdrawal_stage(w)
           from public.withdrawals w where id = (select id from tmp_w where label = 'w1')),
  'true:false:true:ready_for_transfer', 'approver, the verifying challenge and the stage are recorded; not a self-approval');
select throws_ok(format($$ update public.withdrawals set member_otp_verified_at = null where id = %L $$, (select id from tmp_w where label = 'w1')),
  'P0001', null, 'the member verification is write-once');
select throws_ok(format($$ update public.withdrawals set approved_by = 'a6910000-0000-4000-8000-000000000002' where id = %L $$, (select id from tmp_w where label = 'w1')),
  'P0001', null, 'the approval is write-once');
select throws_like(format($$ update public.withdrawals set status = 'approved', approved_by = 'a6910000-0000-4000-8000-000000000001', approved_at = now(), approved_as = 'owner' where id = %L $$,
                          (select id from tmp_w where label = 'w2')),
  '%WITHDRAWAL_AWAITING_MEMBER_VERIFICATION%', 'even a direct write cannot approve an unconfirmed request');


-- ── Rate limits ─────────────────────────────────────────────────────────────

select is((select count(*)::integer from (select pg_temp.resend((select id from tmp_w where label = 'w2'), 'a6910000-0000-4000-8000-000000000002')
                                          from generate_series(1, 4)) s),
  4, 'four resends are allowed for one request (five codes in all)');
select throws_like(format($$ select pg_temp.resend(%L, 'a6910000-0000-4000-8000-000000000002') $$, (select id from tmp_w where label = 'w2')),
  '%OTP_TOO_MANY_CODES%', 'a sixth code for one request is refused');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into tmp_w select 'w3', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 100000, (select id from tmp_b where label = 'T'), 'otp-key-w3');
insert into tmp_w select 'w4', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 100000, (select id from tmp_b where label = 'T'), 'otp-key-w4');
reset role;
select throws_like(format($$ select pg_temp.resend(%L, 'a6910000-0000-4000-8000-000000000002') $$, (select id from tmp_w where label = 'w3')),
  '%OTP_RATE_LIMITED%', 'a member gets at most 10 codes an hour across requests');


-- ── Expiry ──────────────────────────────────────────────────────────────────

select is(pg_temp.deliver(), 3, 'the worker delivers each open code once (w2, w3, w4)');
insert into tmp_k select 'w2c5', id from public.withdrawal_otp_challenges
  where withdrawal_id = (select id from tmp_w where label = 'w2') and status = 'sent';
select pg_temp.expire((select id from tmp_k where label = 'w2c5'));
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select challenge_status from app.withdrawal_otp_state((select id from tmp_w where label = 'w2'))),
  'expired', 'past its 10 minutes a code reads as expired before anyone tries it');
select is(pg_temp.v((select id from tmp_w where label = 'w2'), (select id from tmp_k where label = 'w2c5'), pg_temp.h((select id from tmp_k where label = 'w2c5'), 'good')),
  'expired:-', 'and the right code is refused once expired');
reset role;
select is((select status from public.withdrawal_otp_challenges where id = (select id from tmp_k where label = 'w2c5')),
  'expired', 'the expiry is recorded');


-- ── Reject, cancel ──────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'reject') $$, (select id from tmp_w where label = 'w4')),
  '22023', null, 'a rejection needs a reason');
select is(app.decide_withdrawal((select id from tmp_w where label = 'w4'), 'reject', 'Not agreed at the meeting')::text,
  'rejected', 'the owner can reject, even before the member confirms');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(app.decide_withdrawal((select id from tmp_w where label = 'w3'), 'cancel')::text, 'cancelled', 'the requester can cancel');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w4')),
  '%WITHDRAWAL_NOT_PENDING%', 'a rejected request cannot be approved afterwards');
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w3')),
  '%WITHDRAWAL_NOT_PENDING%', 'nor a cancelled one');
reset role;
select is((select string_agg(c.status, ',' order by w.label) from public.withdrawal_otp_challenges c join tmp_w w on w.id = c.withdrawal_id
           where w.label in ('w3', 'w4')),
  'cancelled,cancelled', 'their open codes are closed');
select is(pg_temp.pos(), '0:3900000:1100000:0', 'rejected and cancelled requests are released exactly once');


-- ── An owner's own request: a designated second approver (2026-11-20) ───────

reset role;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a6910000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@otp.example.test', now()),
  ('a6910000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin2@otp.example.test', now());
insert into public.users (id, full_name, email) values
  ('a6910000-0000-4000-8000-000000000006', 'Designated Admin', 'admin@otp.example.test'),
  ('a6910000-0000-4000-8000-000000000007', 'Other Admin',      'admin2@otp.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000006', 'admin', 'Designated Admin', 'invited', null),
  ('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000007', 'admin', 'Other Admin',      'invited', null);

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select 'w6', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 100000, (select id from tmp_b where label = 'O'), 'otp-key-w6');
insert into tmp_k select 'w6c1', challenge_id from app.withdrawal_otp_state((select id from tmp_w where label = 'w6'));
reset role;
select is(pg_temp.deliver(), 1, 'the owner''s own request gets a code like anyone''s');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(pg_temp.v((select id from tmp_w where label = 'w6'), (select id from tmp_k where label = 'w6c1'), pg_temp.h((select id from tmp_k where label = 'w6c1'), 'good')),
  'verified:-', 'the owner confirms their own request with their code');
select is((select can_decide || ':' || can_reject from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'w6')),
  'false:false', 'the owner sees no Approve or Reject on their own request');
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '%nobody approves or rejects their own withdrawal%', 'the requesting owner cannot approve their own withdrawal');
select throws_ok(format($$ select app.decide_withdrawal(%L, 'reject', 'x') $$, (select id from tmp_w where label = 'w6')),
  '42501', null, 'nor reject it (the requester may cancel instead)');
select throws_like($$ select app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000001', true) $$,
  '%WITHDRAWAL_APPROVER_SELF%', 'an owner cannot designate themself');
select throws_like($$ select app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000002', true) $$,
  '%WITHDRAWAL_APPROVER_NOT_ELIGIBLE%', 'a treasurer cannot be designated second approver');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '42501', null, 'a treasurer holding withdrawal.approve cannot substitute for the second approver');
select throws_ok($$ select app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000006', true) $$,
  '42501', null, 'only an owner designates approvers');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000007","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '42501', null, 'an admin who was not designated cannot approve');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '42501', null, 'another community''s owner cannot approve');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '42501', null, 'an admin cannot approve before being designated');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000006', true), true,
  'the owner designates an admin as second approver');
select is(app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000006', true), false,
  'designating again changes nothing');

set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000006","role":"authenticated"}';
select is((select can_decide || ':' || can_reject from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'w6')),
  'true:true', 'the designated approver sees Approve and Reject on the owner''s request');
select is(app.decide_withdrawal((select id from tmp_w where label = 'w6'), 'approve')::text, 'approved',
  'the designated second approver approves the owner''s request');
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w6')),
  '%WITHDRAWAL_NOT_PENDING%', 'the approval cannot be replayed');

reset role;
select is((select approved_as || ':' || owner_self_approved || ':' || (approved_by = 'a6910000-0000-4000-8000-000000000006')
           from public.withdrawals where id = (select id from tmp_w where label = 'w6')),
  'second_approver:false:true', 'the approver and the basis are recorded; not a self-approval');
select throws_ok(format($$ update public.withdrawals set approved_as = 'owner' where id = %L $$, (select id from tmp_w where label = 'w6')),
  'P0001', null, 'the approval basis is write-once');
select is((select count(*)::integer from public.audit_logs where community_id = 'a6920000-0000-4000-8000-00000000000a'
             and action = 'withdrawal_approver.designated'),
  1, 'the designation is audited once');
select is((select after_state->>'approval_basis' from public.audit_logs
           where object_id = (select id from tmp_w where label = 'w6') and action = 'withdrawal.approve'),
  'second_approver', 'the approval is audited with its basis');
select throws_like(format($$ update public.withdrawals set status = 'approved', approved_by = 'a6910000-0000-4000-8000-000000000002',
                              approved_at = now(), approved_as = 'owner' where id = %L $$, (select id from tmp_w where label = 'w2')),
  '%WITHDRAWAL_SELF_APPROVAL%', 'even a direct write cannot record a self-approval');


-- ── A changed destination account blocks approval ───────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select 'w5', withdrawal_id from app.request_withdrawal_to_account(
  'a6950000-0000-4000-8000-000000000001', 200000, (select id from tmp_b where label = 'O'), 'otp-key-w5');
insert into tmp_k select 'w5c1', challenge_id from app.withdrawal_otp_state((select id from tmp_w where label = 'w5'));
reset role;
select pg_temp.deliver();
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(pg_temp.v((select id from tmp_w where label = 'w5'), (select id from tmp_k where label = 'w5c1'), pg_temp.h((select id from tmp_k where label = 'w5c1'), 'good')),
  'verified:-', 'the owner, requesting for themself, confirms with their own code');
reset role;
update public.users set full_name = 'Ngozi Eze-Okoro' where id = 'a6910000-0000-4000-8000-000000000001';
select is((select status from public.user_bank_accounts where id = (select id from tmp_b where label = 'O')),
  'needs_review', 'a profile name change sends the destination account back to review');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select account_status from app.collection_withdrawals('a6950000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'w5')),
  'needs_review', 'the owner''s review shows the destination is no longer verified');
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_like(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w5')),
  '%WITHDRAWAL_BANK_ACCOUNT_CHANGED%', 'approval is blocked when the destination changed after the request');
select is(app.decide_withdrawal((select id from tmp_w where label = 'w5'), 'reject', 'Destination account changed')::text,
  'rejected', 'the designated approver rejects it instead');

-- Test clock: inside one transaction now() never moves, so the designation is
-- placed an hour back and the approval half an hour back (fixture only).
reset role;
alter table public.community_withdrawal_approvers disable trigger community_withdrawal_approvers_guard;
update public.community_withdrawal_approvers set started_at = started_at - interval '1 hour'
  where user_id = 'a6910000-0000-4000-8000-000000000006' and ended_at is null;
alter table public.community_withdrawal_approvers enable trigger community_withdrawal_approvers_guard;
update public.officer_terms set started_at = started_at - interval '1 hour'
  where user_id = 'a6910000-0000-4000-8000-000000000006' and ended_at is null;
alter table public.withdrawals disable trigger withdrawals_guard;
update public.withdrawals set approved_at = approved_at - interval '30 minutes' where id = (select id from tmp_w where label = 'w6');
alter table public.withdrawals enable trigger withdrawals_guard;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(app.set_withdrawal_approver('a6920000-0000-4000-8000-00000000000a', 'a6910000-0000-4000-8000-000000000006', false), true,
  'the owner ends the designation');
reset role;
select is((select app.withdrawal_approval_basis(w, 'a6910000-0000-4000-8000-000000000006', now()) from public.withdrawals w
           where id = (select id from tmp_w where label = 'w6')),
  null, 'once ended, the designation gives no authority');
select is((select app.withdrawal_approval_basis(w, 'a6910000-0000-4000-8000-000000000006', w.approved_at) from public.withdrawals w
           where id = (select id from tmp_w where label = 'w6')),
  'second_approver', 'an approval given while designated stays valid for that time');


-- ── The transfer claim needs both conditions ────────────────────────────────

reset role;
select is((select string_agg(withdrawal_id::text, ',') from app.claim_withdrawal_transfers(10)),
  (select id::text from tmp_w where label = 'w1'), 'the worker claims only the request with both the member''s code and the owner''s approval');


-- ── Grants, RLS, audit ──────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6910000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$ select count(*) from public.withdrawal_otp_challenges $$, '42501', null, 'clients cannot read code records');
reset role;
select is(has_function_privilege('authenticated', 'app.record_withdrawal_otp_issued(uuid, text)', 'execute')
          or has_function_privilege('authenticated', 'app.claim_withdrawal_otp_deliveries(integer)', 'execute')
          or has_function_privilege('authenticated', 'app.record_withdrawal_otp_delivery(uuid, boolean, text)', 'execute'),
  false, 'only the worker issues and delivers codes');
select is(has_function_privilege('anon', 'app.verify_withdrawal_otp(uuid, uuid, text)', 'execute')
          or has_function_privilege('anon', 'app.request_withdrawal_otp(uuid)', 'execute')
          or has_function_privilege('anon', 'app.withdrawal_otp_state(uuid)', 'execute'),
  false, 'anonymous visitors cannot read, request or verify codes');
select is(has_function_privilege('authenticated', 'app.verify_withdrawal_otp(uuid, uuid, text)', 'execute'), true,
  'a signed-in member can verify (their own, enforced inside)');
select is((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.withdrawal_otp_challenges'::regclass), true,
  'row level security is enabled and forced on code records');
select is((select count(*)::integer from public.audit_logs a
           where a.object_id in (select id from tmp_w)
             and (coalesce(a.after_state::text, '') ~ '[0-9a-f]{64}' or coalesce(a.before_state::text, '') ~ '[0-9a-f]{64}')),
  0, 'no code hash reaches the audit log');
select is((select string_agg(distinct action, ',' order by action) from public.audit_logs
           where object_id = (select id from tmp_w where label = 'w1')),
  'withdrawal.approve,withdrawal.member_verified,withdrawal.otp_locked,withdrawal.otp_resend,withdrawal.processing,withdrawal.request',
  'request, lock, resends, verification, approval and processing are each audited');
select is((select count(*)::integer from public.v_ledger_imbalances), 0, 'every journal balances');

select * from finish();
rollback;
