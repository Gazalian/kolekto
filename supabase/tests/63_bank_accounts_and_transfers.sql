-- ─────────────────────────────────────────────────────────────────────────────
-- 63 — Saved bank accounts, Paystack transfers, verified-charge T+1
--      (20261118100000, 20261118100100; owner decisions 2026-11-18)
--
--   · settlement: the 2026-11-18 schedule releases at T+1 05:00 Lagos once the
--     charge is verified, with no provider confirmation; idempotent release
--   · bank accounts: operator-only registration, name match → verified,
--     mismatch → needs_review, D-08 cooling-off after the first account,
--     masked reads, owner-only use, immutable facts
--   · withdrawals to saved accounts: ownership, verified, cooling-off,
--     available-only, collection isolation, no withdrawal fee (Q4)
--   · transfers: claim, manual path refused, success / failed / reversed,
--     idempotent replays, amount mismatch and contradictions change nothing,
--     transfer fee booked to transfer_fee_expense, reconciliation holds
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(80);

-- ── Settlement rule (Q2) ────────────────────────────────────────────────────

select is((select requires_provider_confirmation::text || ':' || (effective_from = '2026-11-18 00:00:00+01'::timestamptz)
           from public.settlement_schedules where version = '2026-11-18-t1-0500-lagos-verified-charge'),
  'false:true', 'the 2026-11-18 schedule needs no provider confirmation and starts 2026-11-18 00:00 WAT');
select is(app.settlement_schedule_version_at('2026-11-19 12:00+01'), '2026-11-18-t1-0500-lagos-verified-charge',
  'a capture on or after 2026-11-18 is scheduled under the verified-charge rule');
select is(app.settlement_schedule_version_at('2026-11-17 12:00+01'), '2026-11-t1-0500-lagos',
  'a capture before 2026-11-18 keeps the provider-confirmed rule it was scheduled under');
select is(app.settlement_due_at('2026-11-23 10:00+01', '2026-11-18-t1-0500-lagos-verified-charge'), '2026-11-24 05:00+01'::timestamptz,
  'Mon 10:00 → Tue 05:00 WAT');
select is(app.settlement_due_at('2026-11-23 23:55+01', '2026-11-18-t1-0500-lagos-verified-charge'), '2026-11-24 05:00+01'::timestamptz,
  'Mon 23:55 → Tue 05:00 WAT');
select is(app.settlement_due_at('2026-11-22 22:59:59+00', '2026-11-18-t1-0500-lagos-verified-charge'), '2026-11-23 05:00+01'::timestamptz,
  'Sun 22:59:59 UTC is Sun 23:59:59 WAT → Mon 05:00 WAT (the Lagos day decides, not the UTC day)');

-- The same rule with relative dates, so captures made two days ago are due
-- now whatever today is (test-only version, rolled back).
insert into public.settlement_schedules
  (version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes)
values ('test-verified-charge', now() - interval '3 days', 'Africa/Lagos', 1, time '05:00', false, 'test only');


-- ── Fixtures ────────────────────────────────────────────────────────────────

-- email_confirmed_at: the withdrawal code goes to a confirmed email (20261119120000).
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a6310000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@bt.example.test', now()),
  ('a6310000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@bt.example.test', now()),
  ('a6310000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@bt.example.test', now()),
  ('a6310000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@bt.example.test', now());
insert into public.users (id, full_name, email) values
  ('a6310000-0000-4000-8000-000000000001', 'Adaeze Okafor', 'owner@bt.example.test'),
  ('a6310000-0000-4000-8000-000000000002', 'Tunde Bello',   'treasurer@bt.example.test'),
  ('a6310000-0000-4000-8000-000000000003', 'Some Stranger', 'stranger@bt.example.test'),
  ('a6310000-0000-4000-8000-000000000004', 'Second Approver', 'admin@bt.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6320000-0000-4000-8000-00000000000a', 'bt-tests', 'Bank Transfer Tests', 'social_group', false, 'a6310000-0000-4000-8000-000000000001');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a6350000-0000-4000-8000-000000000001', 'a6320000-0000-4000-8000-00000000000a', 'bt-a', 'Departmental Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6310000-0000-4000-8000-000000000001'),
  ('a6350000-0000-4000-8000-000000000002', 'a6320000-0000-4000-8000-00000000000a', 'bt-b', 'Event Contributions',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6310000-0000-4000-8000-000000000001'),
  ('a6350000-0000-4000-8000-000000000003', 'a6320000-0000-4000-8000-00000000000a', 'bt-c', 'Fellowship Fund',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6310000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6320000-0000-4000-8000-00000000000a', 'a6310000-0000-4000-8000-000000000001', 'owner',     'Adaeze Okafor', 'created', null),
  ('a6320000-0000-4000-8000-00000000000a', 'a6310000-0000-4000-8000-000000000002', 'treasurer', 'Tunde Bello',   'invited', null),
  ('a6320000-0000-4000-8000-00000000000a', 'a6310000-0000-4000-8000-000000000004', 'admin',     'Second Approver', 'invited', null);
-- The owner designated the admin as second approver for the owner's own
-- requests (20261120100000; the designation function is proved in 69).
insert into public.community_withdrawal_approvers (community_id, user_id, designated_by) values
  ('a6320000-0000-4000-8000-00000000000a', 'a6310000-0000-4000-8000-000000000004', 'a6310000-0000-4000-8000-000000000001');

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;

-- ₦5,000 into collection A, host absorbs: net ₦4,900.
create function pg_temp.pay(p_ref integer, p_paid_at timestamptz) returns void language plpgsql as $$
declare
  v_attempt uuid;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a6350000-0000-4000-8000-000000000001', 'checkout-key-bt-' || p_ref, pg_temp.ref(p_ref), 'fake', null,
    'Payer ' || p_ref, 'payer' || p_ref || '@bt.example.test', '+2348000000063', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    500000, 'NGN', null, p_paid_at, 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
end;
$$;

create function pg_temp.pos(p_collection uuid) returns text language sql as $$
  select pending_kobo::bigint || ':' || available_kobo || ':' || withdrawing_kobo || ':' || withdrawn_kobo
  from public.v_collection_position where collection_id = p_collection
$$;

-- Test-only funding so the isolation scenario has round numbers.
create function pg_temp.fund(p_collection uuid, p_kobo bigint) returns void language sql as $$
  select app.post_ledger_journal(
    'a6320000-0000-4000-8000-00000000000a', p_collection, now(), 'adjustment', p_collection,
    'test fixture funding', 'test-fund:' || p_collection,
    jsonb_build_array(
      jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'),
                         'direction', 'debit', 'amount_kobo', p_kobo),
      jsonb_build_object('account_id', app.ensure_ledger_account('a6320000-0000-4000-8000-00000000000a', p_collection, 'collection_available'),
                         'direction', 'credit', 'amount_kobo', p_kobo)),
    'system', null);
$$;


-- ── Verified charge + T+1, no provider confirmation ─────────────────────────

select pg_temp.pay(6301, now() - interval '2 days');
select pg_temp.pay(6302, now());

select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '980000:0:0:0',
  'two verified payments sit in pending; nothing is available before release');
select is((select released || ':' || released_kobo || ':' || awaiting_provider from app.release_due_settlements(500)), '1:490000:0',
  'the due payment is released with no provider settlement recorded; nothing awaits the provider');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '490000:490000:0:0',
  'today''s payment stays pending until its own 05:00');
select is((select released || ':' || awaiting_provider from app.release_due_settlements(500)), '0:0',
  'running the release again credits nothing twice');
select is((select count(*)::integer from public.ledger_journals j
           join public.contributions c on c.id = j.source_id
           join public.payment_attempts a on a.id = c.attempt_id
           where j.source_type = 'balance_release' and a.reference = pg_temp.ref(6301)), 1,
  'one balance_release journal for the released payment');
select is((select (released_at is not null)::text || ':' || (provider_confirmed_at is null)::text
           from public.contribution_settlements s join public.contributions c on c.id = s.contribution_id
           join public.payment_attempts a on a.id = c.attempt_id where a.reference = pg_temp.ref(6301)),
  'true:true', 'scheduled and actual release times are recorded; provider confirmation stays empty');


-- ── Saved bank accounts ─────────────────────────────────────────────────────

create temporary table tmp_b (label text primary key, id uuid);
create temporary table tmp_w (label text primary key, id uuid);
grant all on tmp_b, tmp_w to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from app.register_bank_account('a6310000-0000-4000-8000-000000000001', '058', 'GTBank',
                     '0123456789', 'OKAFOR ADAEZE', 'Adaeze Okafor', true) $$,
  '42501', null, 'a client cannot register a bank account directly (resolution happens on the server)');
select throws_ok($$ select count(*) from public.user_bank_accounts $$, '42501', null,
  'clients cannot read saved bank accounts directly');
reset role;

insert into tmp_b select 'owner_gt', bank_account_id from app.register_bank_account(
  'a6310000-0000-4000-8000-000000000001', '058', 'GTBank', '0123456789', 'OKAFOR ADAEZE', 'Adaeze Okafor', true);
select is((select status || ':' || is_default || ':' || (usable_from <= now()) from public.user_bank_accounts
           where id = (select id from tmp_b where label = 'owner_gt')),
  'verified:true:true', 'a name-matched first account is verified, default, and usable at once');
select is((select bank_account_id || ':' || outcome from app.register_bank_account(
            'a6310000-0000-4000-8000-000000000001', '058', 'GTBank', '0123456789', 'OKAFOR ADAEZE', 'Adaeze Okafor', true)),
  (select id from tmp_b where label = 'owner_gt') || ':reused', 'registering the same account again returns it');

insert into tmp_b select 'owner_mismatch', bank_account_id from app.register_bank_account(
  'a6310000-0000-4000-8000-000000000001', '044', 'Access Bank', '1111111111', 'JOHN DOE', 'Adaeze Okafor', false);
select is((select status || ':' || is_default || ':' || (usable_from > now() + interval '47 hours') from public.user_bank_accounts
           where id = (select id from tmp_b where label = 'owner_mismatch')),
  'needs_review:false:true', 'a name mismatch is held for review, not default, and carries the 48-hour cooling-off');

insert into tmp_b select 'owner_second', bank_account_id from app.register_bank_account(
  'a6310000-0000-4000-8000-000000000001', '033', 'UBA', '2222222222', 'ADAEZE N OKAFOR', 'Adaeze Okafor', true);
select is((select status || ':' || is_default || ':' || (usable_from > now() + interval '47 hours') from public.user_bank_accounts
           where id = (select id from tmp_b where label = 'owner_second')),
  'verified:false:true', 'a second verified account is not default and waits 48 hours (D-08)');

select throws_ok($$ select * from app.register_bank_account('a6310000-0000-4000-8000-000000000001', '035', 'Wema',
                     '3333333333', 'OKAFOR ADAEZE', 'Someone Else', true) $$,
  'P0001', null, 'a comparison made against a different profile name is refused');
select throws_ok($$ select * from app.register_bank_account('a6310000-0000-4000-8000-000000000001', '035', 'Wema',
                     '33333', 'OKAFOR ADAEZE', 'Adaeze Okafor', true) $$,
  '22023', null, 'an account number must be 10 digits');

insert into tmp_b select 'treasurer_gt', bank_account_id from app.register_bank_account(
  'a6310000-0000-4000-8000-000000000002', '058', 'GTBank', '0987654321', 'BELLO TUNDE', 'Tunde Bello', true);

select throws_ok(format($$ update public.user_bank_accounts set account_number = '9999999999' where id = %L $$,
                        (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'a saved account''s number never changes');
select throws_ok(format($$ delete from public.user_bank_accounts where id = %L $$, (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'a saved account is never deleted');
select throws_ok(format($$ select app.set_bank_account_recipient(%L, 'not-a-code') $$, (select id from tmp_b where label = 'owner_gt')),
  '22023', null, 'a recipient code must look like a Paystack recipient');
select lives_ok(format($$ select app.set_bank_account_recipient(%L, 'RCP_owner0001') $$, (select id from tmp_b where label = 'owner_gt')),
  'the operator records the Paystack recipient');
select throws_ok(format($$ select app.set_bank_account_recipient(%L, 'RCP_other0002') $$, (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'a recorded recipient is never replaced');

select is(app.review_bank_account((select id from tmp_b where label = 'owner_mismatch'), 'reject', 'Ops Reviewer',
                                  'Name does not match the profile'),
  'rejected', 'an operator rejects the mismatched account');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select string_agg(account_last4 || ':' || status, ',' order by account_last4) from app.my_bank_accounts()),
  '1111:rejected,2222:verified,6789:verified', 'the owner sees their own accounts, last four digits only');
select is((select count(*)::integer from information_schema.routines r
           join information_schema.parameters p on p.specific_name = r.specific_name
           where r.routine_schema = 'app' and r.routine_name = 'my_bank_accounts' and p.parameter_name = 'account_number'), 0,
  'and the read has no full account number column');
select is((select string_agg(account_last4 || ':' || coalesce(account_name, '(hidden)'), ',' order by account_last4) from app.my_bank_accounts()
           where status <> 'verified'),
  '1111:(hidden)', 'the bank-reported name of an unverified account is never shown back');
select throws_ok(format($$ select app.set_default_bank_account(%L) $$, (select id from tmp_b where label = 'treasurer_gt')),
  'P0002', null, 'nobody can touch another person''s account');
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::integer from app.my_bank_accounts()), 0, 'a stranger sees none of them');


-- ── Withdrawals to a saved account ──────────────────────────────────────────

reset role;
select pg_temp.fund('a6350000-0000-4000-8000-000000000002', 5000000);   -- B ₦50,000
select pg_temp.fund('a6350000-0000-4000-8000-000000000003', 2500000);   -- C ₦25,000

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(has_function_privilege('authenticated', 'app.request_withdrawal(uuid, bigint, text, text, text, text)', 'execute'),
  false, 'typed (unverified) destinations can no longer be used by clients');

select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 100000, %L, 'bt-key-other') $$,
                        (select id from tmp_b where label = 'treasurer_gt')),
  'P0001', null, 'an owner cannot withdraw to the treasurer''s account');
select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 100000, %L, 'bt-key-cool') $$,
                        (select id from tmp_b where label = 'owner_second')),
  'P0001', null, 'an account still cooling off cannot receive a withdrawal');
select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 100000, %L, 'bt-key-rej') $$,
                        (select id from tmp_b where label = 'owner_mismatch')),
  'P0001', null, 'a rejected account cannot receive a withdrawal');
select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 490001, %L, 'bt-key-over') $$,
                        (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'collection A cannot pay out more than its ₦4,900 available, though pending and other collections hold more');

-- Isolation: A ₦100,000 available (₦4,900 released + ₦95,100 funding).
reset role;
select pg_temp.fund('a6350000-0000-4000-8000-000000000001', 9510000);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 15000000, %L, 'bt-key-150k') $$,
                        (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, '₦150,000 from A is refused although A + B + C hold ₦175,000');

insert into tmp_w select 'w80', withdrawal_id from app.request_withdrawal_to_account(
  'a6350000-0000-4000-8000-000000000001', 8000000, (select id from tmp_b where label = 'owner_gt'), 'bt-key-80k');
select is((select status::text || ':' || fee_kobo || ':' || payout_method || ':' || account_last4
           from app.collection_withdrawals('a6350000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'w80')),
  'requested:0:manual:6789', 'the owner''s ₦80,000 request is free, to the saved account, and starts requested (member code, then owner approval: 2026-11-19)');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '490000:2000000:8000000:0',
  'A: ₦80,000 held, ₦20,000 left available');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000002') || '|' || pg_temp.pos('a6350000-0000-4000-8000-000000000003'),
  '0:5000000:0:0|0:2500000:0:0', 'B and C are untouched');
select is((select withdrawal_id || ':' || reused from app.request_withdrawal_to_account(
            'a6350000-0000-4000-8000-000000000001', 8000000, (select id from tmp_b where label = 'owner_gt'), 'bt-key-80k')),
  (select id from tmp_w where label = 'w80') || ':true', 'a replayed request returns the first one and holds nothing twice');
select throws_ok(format($$ select * from app.request_withdrawal_to_account('a6350000-0000-4000-8000-000000000001', 2000001, %L, 'bt-key-over2') $$,
                        (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'the held ₦80,000 cannot be requested again');
insert into tmp_w select 'w20', withdrawal_id from app.request_withdrawal_to_account(
  'a6350000-0000-4000-8000-000000000001', 2000000, (select id from tmp_b where label = 'owner_gt'), 'bt-key-20k');
select is((select status::text || ':' || fee_kobo || ':' || is_first
           from app.collection_withdrawals('a6350000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'w20')),
  'requested:0:false', 'a second withdrawal is allowed and free (Q4)');
select throws_ok(format($$ select app.disable_bank_account(%L) $$, (select id from tmp_b where label = 'owner_gt')),
  'P0001', null, 'an account with a withdrawal in progress cannot be removed');

set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into tmp_w select 'wt', withdrawal_id from app.request_withdrawal_to_account(
  'a6350000-0000-4000-8000-000000000002', 1000000, (select id from tmp_b where label = 'treasurer_gt'), 'bt-key-treasurer');
select is((select status::text from app.collection_withdrawals('a6350000-0000-4000-8000-000000000002') where id = (select id from tmp_w where label = 'wt')),
  'requested', 'a treasurer''s request waits for the owner (D-06)');

-- Owner decisions 2026-11-19: the requesting member confirms with the emailed
-- code, then it is approved. Here the owner is the requester of w80 / w20, so
-- the designated second approver approves (nobody approves their own request,
-- 2026-11-20). The worker's delivery step is played by hand: a
-- known keyed hash is issued for each challenge.
reset role;
create temporary table tmp_c as select challenge_id, withdrawal_id from app.claim_withdrawal_otp_deliveries(10);
select app.record_withdrawal_otp_issued(challenge_id, encode(sha256(convert_to('code:' || challenge_id, 'UTF8')), 'hex')) from tmp_c;
grant select on tmp_c to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve') $$, (select id from tmp_w where label = 'w80')),
  'P0001', null, 'the approver cannot approve before the requesting member has confirmed with the code');
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select string_agg(v.outcome, ',' order by w.label)
           from tmp_w w join tmp_c c on c.withdrawal_id = w.id
           cross join lateral app.verify_withdrawal_otp(w.id, c.challenge_id, encode(sha256(convert_to('code:' || c.challenge_id, 'UTF8')), 'hex')) v
           where w.label in ('w80', 'w20')),
  'verified,verified', 'the requester confirms both requests with their codes');
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select string_agg(app.decide_withdrawal(id, 'approve')::text, ',' order by label) from tmp_w where label in ('w80', 'w20')),
  'approved,approved', 'the designated second approver then approves both');
reset role;
select is((select string_agg(approved_as || ':' || owner_self_approved::text || ':' || (approved_by = requested_by)::text, ',') from public.withdrawals
           where id in (select id from tmp_w where label in ('w80', 'w20'))),
  'second_approver:false:false,second_approver:false:false', 'an owner''s own request is approved by the designated second approver, never self-approved');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6310000-0000-4000-8000-000000000001","role":"authenticated"}';


-- ── Transfers ───────────────────────────────────────────────────────────────

select throws_ok($$ select * from app.claim_withdrawal_transfers(10) $$, '42501', null, 'a client cannot claim transfers');
select throws_ok($$ select app.settle_withdrawal_transfer('ktr_000000000000000000000000', 'success', null, null, null, null, now()) $$,
  '42501', null, 'a client cannot settle a transfer');
reset role;

select is((select string_agg(amount_kobo::text || ':' || coalesce(recipient_code, '-') || ':' || (transfer_reference ~ '^ktr_[0-9a-f]{24}$'), ','
                              order by amount_kobo)
           from app.claim_withdrawal_transfers(10)),
  '2000000:RCP_owner0001:true,8000000:RCP_owner0001:true',
  'the worker claims the two approved withdrawals (not the one awaiting approval), with the saved recipient');
select is((select count(*)::integer from app.claim_withdrawal_transfers(10)), 0, 'a second claim takes nothing');
select is((select string_agg(status::text, ',') from public.withdrawals where id in (select id from tmp_w where label in ('w80', 'w20'))),
  'processing,processing', 'both are processing');

create temporary table tmp_t as
  select w.label, t.reference from public.withdrawal_transfers t join tmp_w w on w.id = t.withdrawal_id;

select throws_ok(format($$ select app.complete_withdrawal(%L, 'NIP-MANUAL', now()) $$, (select id from tmp_w where label = 'w80')),
  'P0001', null, 'the manual payout path refuses a withdrawal paid by transfer');
select throws_ok(format($$ select app.fail_withdrawal(%L, 'manual failure') $$, (select id from tmp_w where label = 'w80')),
  'P0001', null, 'and so does manual failure');

select is(app.record_withdrawal_transfer_state((select reference from tmp_t where label = 'w80'), 'pending', null, 'TRF_eighty0001', '901', null),
  'pending', 'Paystack accepted the transfer: pending, with its transfer code');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'success', 8000001, 'TRF_eighty0001', 2500, null, now()),
  'amount_mismatch', 'a different amount from Paystack changes nothing');
select is((select status::text from public.withdrawals where id = (select id from tmp_w where label = 'w80')), 'processing',
  'the withdrawal is still processing after the mismatch');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'success', 8000000, 'TRF_other00001', 2500, null, now()),
  'conflict', 'a different transfer code for the same reference changes nothing');

select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'success', 8000000, 'TRF_eighty0001', 2500, null, now()),
  'paid', 'transfer.success (verified) pays the withdrawal');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '490000:0:2000000:8000000',
  'A: ₦80,000 withdrawn exactly once; ₦20,000 still held for the other transfer');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'success', 8000000, 'TRF_eighty0001', 2500, null, now()),
  'already_paid', 'a duplicate success webhook does nothing');
select is((select count(*)::integer from public.ledger_journals where source_id = (select id from tmp_w where label = 'w80')
           and idempotency_key in ('payout:' || (select id from tmp_w where label = 'w80'), 'transfer_fee:' || (select id from tmp_w where label = 'w80'))),
  2, 'one payout journal and one transfer fee journal');
select is((select sum(case when e.direction = 'debit' then e.amount_kobo else -e.amount_kobo end)::bigint
           from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
           join public.ledger_journals j on j.id = e.journal_id
           where a.code = 'transfer_fee_expense'
             and j.idempotency_key = 'transfer_fee:' || (select id from tmp_w where label = 'w80')),
  2500::bigint, 'the ₦25 Paystack transfer fee is Kolekto''s transfer_fee_expense, not the collection''s');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'failed', 8000000, 'TRF_eighty0001', null, 'late failure', now()),
  'conflict', 'a failure after success changes nothing (a bank return arrives as transfer.reversed)');

select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w20'), 'failed', 2000000, null, null, 'Account could not be credited', now()),
  'failed', 'transfer.failed releases the reservation');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '490000:2000000:0:8000000',
  'A: the ₦20,000 is available again and counts nothing as withdrawn');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w20'), 'failed', 2000000, null, null, 'again', now()),
  'already_failed', 'a duplicate failure webhook does nothing');
select is((select status::text || ':' || failure_reason from public.withdrawals where id = (select id from tmp_w where label = 'w20')),
  'failed:Account could not be credited', 'the failure reason is kept');

select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'reversed', 8000000, 'TRF_eighty0001', null, 'Beneficiary bank returned the funds', now()),
  'reversed', 'transfer.reversed after success restores the money');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000001'), '490000:10000000:0:0',
  'A: ₦100,000 available again, nothing withdrawn');
select is(app.settle_withdrawal_transfer((select reference from tmp_t where label = 'w80'), 'reversed', 8000000, 'TRF_eighty0001', null, 'again', now()),
  'already_reversed', 'a duplicate reversal restores nothing twice');
select is((select status::text || ':' || (paid_at is not null) || ':' || (payout_journal_id is not null) || ':' || (reversal_journal_id is not null)
           from public.withdrawals where id = (select id from tmp_w where label = 'w80')),
  'reversed:true:true:true', 'the reversed withdrawal keeps its paid history and names its reversal');
select is((select reverses_journal_id = (select payout_journal_id from public.withdrawals where id = (select id from tmp_w where label = 'w80'))
           from public.ledger_journals where idempotency_key = 'payout_reversal:' || (select id from tmp_w where label = 'w80')),
  true, 'the reversal journal points at the payout it reverses');
select throws_ok(format($$ update public.withdrawals set status = 'paid' where id = %L $$, (select id from tmp_w where label = 'w80')),
  'P0001', null, 'a reversed withdrawal is final');
select is(pg_temp.pos('a6350000-0000-4000-8000-000000000002') || '|' || pg_temp.pos('a6350000-0000-4000-8000-000000000003'),
  '0:4000000:1000000:0|0:2500000:0:0', 'B holds only its own treasurer request; C never moved');


-- ── Reconciliation ──────────────────────────────────────────────────────────

-- A's only differences are the test-only funding (an adjustment with no
-- payment behind it), to the kobo; pay, fail and reverse added none.
select is((select string_agg(check_name || '=' || difference_kobo, ',' order by check_name)
           from app.collection_reconciliation_checks('a6350000-0000-4000-8000-000000000001') where not ok),
  'net_raised=9510000,released_position=9510000',
  'collection A reconciles after pay, fail and reverse, apart from exactly the test funding');
select is((select string_agg(check_name, ',') from app.platform_reconciliation() where not ok), null,
  'every platform identity holds, including transfers paid from the Paystack balance and their fees');
select is((select count(*)::integer from public.v_ledger_imbalances), 0, 'every journal balances');

select * from finish();
rollback;
