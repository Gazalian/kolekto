-- ─────────────────────────────────────────────────────────────────────────────
-- 58 — Withdrawal lifecycle (20261117100200)
--
--   · only AVAILABLE money can be withdrawn; pending money never
--   · request: permission, identity verification (PRD 10.1), validation,
--     idempotency, first-free, second refused until O-2 brackets exist,
--     ₦1M/day for unverified communities (D-07), manual review over ₦1M (D-06)
--   · the hold journal moves available → withdrawing in the same transaction
--   · owner approves / rejects; requester cancels; reject / cancel / fail
--     release the hold by a reversal journal; failed is never "withdrawn"
--   · operator: processing → paid posts the payout journal; idempotent replay
--   · facts immutable, transitions guarded, clients never touch operator steps
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
-- 20261118100100 added a verified-charge schedule (no provider confirmation)
-- effective 2026-11-18. This file tests the provider-confirmed rule with
-- captures dated relative to now(), so it pins that rule for its own
-- captures inside this rolled-back transaction, whatever today is.
insert into public.settlement_schedules
  (version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes)
values ('test-pin-provider-confirmed', now() - interval '3 days', 'Africa/Lagos', 1, time '05:00', true, 'test only');
-- 20261118100100 revoked app.request_withdrawal (typed destination) from
-- clients; this file still exercises its lifecycle, so the grant is restored
-- inside this rolled-back transaction only. 63_bank_accounts_and_transfers.sql
-- asserts clients cannot call it.
grant execute on function app.request_withdrawal(uuid, bigint, text, text, text, text) to authenticated;
select plan(52);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5810000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@wd.example.test'),
  ('a5810000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@wd.example.test'),
  ('a5810000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer2@wd.example.test'),
  ('a5810000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@wd.example.test');
insert into public.users (id, full_name, email, identity_level) values
  ('a5810000-0000-4000-8000-000000000001', 'Wd Owner',       'owner@wd.example.test',      'identity_verified'),
  ('a5810000-0000-4000-8000-000000000002', 'Wd Treasurer',   'treasurer@wd.example.test',  'identity_verified'),
  ('a5810000-0000-4000-8000-000000000003', 'Wd Unverified',  'treasurer2@wd.example.test', 'contact_verified'),
  ('a5810000-0000-4000-8000-000000000004', 'Wd Collector',   'collector@wd.example.test',  'identity_verified')
on conflict (id) do update set full_name = excluded.full_name, identity_level = excluded.identity_level;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5820000-0000-4000-8000-00000000000a', 'wd-tests', 'Withdrawal Tests', 'social_group', false, 'a5810000-0000-4000-8000-000000000001');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a5850000-0000-4000-8000-000000000001', 'a5820000-0000-4000-8000-00000000000a', 'wd-a', 'Wd A',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5810000-0000-4000-8000-000000000001'),
  ('a5850000-0000-4000-8000-000000000002', 'a5820000-0000-4000-8000-00000000000a', 'wd-b', 'Wd B',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5810000-0000-4000-8000-000000000001'),
  ('a5850000-0000-4000-8000-000000000003', 'a5820000-0000-4000-8000-00000000000a', 'wd-c', 'Wd C',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5810000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a5820000-0000-4000-8000-00000000000a', 'a5810000-0000-4000-8000-000000000001', 'owner',     'Wd Owner',      'created', null),
  ('a5820000-0000-4000-8000-00000000000a', 'a5810000-0000-4000-8000-000000000002', 'treasurer', 'Wd Treasurer',  'invited', null),
  ('a5820000-0000-4000-8000-00000000000a', 'a5810000-0000-4000-8000-000000000003', 'treasurer', 'Wd Unverified', 'invited', null),
  ('a5820000-0000-4000-8000-00000000000a', 'a5810000-0000-4000-8000-000000000004', 'collector', 'Wd Collector',  'invited', null);

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;

-- ₦5,000 into collection A, captured two days ago, provider-confirmed, released → ₦4,900 available each.
create function pg_temp.pay_and_release(p_ref integer) returns void language plpgsql as $$
declare
  v_attempt uuid;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a5850000-0000-4000-8000-000000000001', 'checkout-key-wd-' || p_ref, pg_temp.ref(p_ref), 'fake', null,
    'Payer ' || p_ref, 'payer' || p_ref || '@wd.example.test', '+2348000000058', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    500000, 'NGN', null, now() - interval '2 days', 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
  perform app.record_provider_settlement(pg_temp.ref(p_ref), 'STL-' || p_ref, 495000, now() - interval '1 day');
end;
$$;
select pg_temp.pay_and_release(5801) is not null;
select pg_temp.pay_and_release(5802) is not null;
select pg_temp.pay_and_release(5803) is not null;
select pg_temp.pay_and_release(5804) is not null;   -- captured but its release is not run: see "pending is never withdrawable"
select released from app.release_due_settlements(3);  -- releases three of the four (oldest first); one stays pending

-- Collections B and C get ₦1,500,000 available each through a test-only
-- adjustment, so the daily limit and manual-review threshold can be reached.
create function pg_temp.fund(p_collection uuid, p_kobo bigint) returns void language sql as $$
  select app.post_ledger_journal(
    'a5820000-0000-4000-8000-00000000000a', p_collection, now(), 'adjustment', p_collection,
    'test fixture funding', 'test-fund:' || p_collection,
    jsonb_build_array(
      jsonb_build_object('account_id', app.ensure_ledger_account(null, null, 'provider_settled_funds'),
                         'direction', 'debit', 'amount_kobo', p_kobo),
      jsonb_build_object('account_id', app.ensure_ledger_account('a5820000-0000-4000-8000-00000000000a', p_collection, 'collection_available'),
                         'direction', 'credit', 'amount_kobo', p_kobo)),
    'system', null);
$$;
select pg_temp.fund('a5850000-0000-4000-8000-000000000002', 150000000);
select pg_temp.fund('a5850000-0000-4000-8000-000000000003', 150000000);

create function pg_temp.pos(p_collection uuid) returns text language sql as $$
  select available_kobo::bigint || ':' || withdrawing_kobo || ':' || withdrawn_kobo
  from public.v_collection_position where collection_id = p_collection
$$;

create temporary table tmp_w (label text primary key, id uuid);
grant all on tmp_w to authenticated;

select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '1470000:0:0',
  'collection A: ₦14,700 available (three released payments), nothing withdrawing');
select is((select pending_kobo::bigint from public.v_collection_position where collection_id = 'a5850000-0000-4000-8000-000000000001'),
  490000::bigint, 'one ₦4,900 payment is still pending');


-- ── Treasurer requests ──────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000001', 1960000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-all-of-it') $$,
  'P0001', null, 'pending money is never withdrawable: available + pending is refused');

select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000001', 0, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-zero') $$,
  '22023', null, 'a zero amount is refused');
select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000001', 100000, 'Wd Treasurer', '01234', 'Test Bank', 'wd-key-short') $$,
  '22023', null, 'a short account number is refused');
select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000001', 100000, 'Wd Treasurer', '0123456789', 'Test Bank', 'short') $$,
  '22023', null, 'an idempotency key under 8 characters is refused');

insert into tmp_w select 'r1', withdrawal_id from app.request_withdrawal(
  'a5850000-0000-4000-8000-000000000001', 500000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-one');

select is((select status::text || ':' || fee_kobo || ':' || is_first || ':' || requires_manual_review
           from app.collection_withdrawals('a5850000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'r1')),
  'requested:0:true:false', 'a treasurer''s request waits for the owner; the first withdrawal is free');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '970000:500000:0',
  'the hold moved ₦5,000 from available to withdrawing at once');

select is((select withdrawal_id || ':' || reused from app.request_withdrawal(
            'a5850000-0000-4000-8000-000000000001', 500000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-one')),
  (select id from tmp_w where label = 'r1') || ':true', 'a replayed request returns the first one');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '970000:500000:0', 'and holds nothing twice');

select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000001', 100000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-two') $$,
  'P0001', null, 'a second withdrawal is refused while no withdrawal fee schedule exists (O-2)');

select is((select account_last4 || ':' || (account_name is not null) from app.collection_withdrawals('a5850000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'r1')),
  '6789:true', 'the list shows the account''s last four digits only');

select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve', null) $$, (select id from tmp_w where label = 'r1')),
  '42501', null, 'a treasurer cannot approve (D-06: the owner does)');
select throws_ok(format($$ select app.mark_withdrawal_processing(%L) $$, (select id from tmp_w where label = 'r1')),
  '42501', null, 'a client cannot mark a payout as processing');
select throws_ok(format($$ select app.complete_withdrawal(%L, 'NIP-X', now()) $$, (select id from tmp_w where label = 'r1')),
  '42501', null, 'a client cannot mark a withdrawal paid');
select throws_ok($$ select count(*) from public.withdrawals $$, '42501', null,
  'clients cannot read the withdrawals table directly');

set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000002', 100000, 'Wd Unverified', '0123456789', 'Test Bank', 'wd-key-unverified') $$,
  'P0001', null, 'an officer without identity verification cannot withdraw (PRD 10.1)');

set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000002', 100000, 'Wd Collector', '0123456789', 'Test Bank', 'wd-key-collector') $$,
  '42501', null, 'a collector (no withdrawal.request) cannot withdraw');


-- ── Owner rejects; the hold is released ─────────────────────────────────────

set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(format($$ select app.decide_withdrawal(%L, 'reject', null) $$, (select id from tmp_w where label = 'r1')),
  '22023', null, 'a rejection needs a reason');
select lives_ok(format($$ select app.decide_withdrawal(%L, 'reject', 'Wrong account') $$, (select id from tmp_w where label = 'r1')),
  'the owner rejects the request');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '1470000:0:0', 'the hold is released in full');
select is((select count(*)::integer from public.ledger_journals
           where idempotency_key = 'withdrawal_release:' || (select id from tmp_w where label = 'r1')
             and reverses_journal_id is not null), 1,
  'by one reversal journal that names the hold it reverses');
select throws_ok(format($$ select app.decide_withdrawal(%L, 'approve', null) $$, (select id from tmp_w where label = 'r1')),
  'P0001', null, 'a rejected withdrawal cannot be approved afterwards');


-- ── Requester cancels ───────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into tmp_w select 'r2', withdrawal_id from app.request_withdrawal(
  'a5850000-0000-4000-8000-000000000001', 1000000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-cancel');
select is((select is_first from app.collection_withdrawals('a5850000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'r2')),
  true, 'a rejected withdrawal does not use up the free first withdrawal');
select lives_ok(format($$ select app.decide_withdrawal(%L, 'cancel', null) $$, (select id from tmp_w where label = 'r2')),
  'the requester cancels');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '1470000:0:0', 'cancelling releases the hold');


-- ── Owner request: approved as made → processing → failed ──────────────────

set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select 'r3', withdrawal_id from app.request_withdrawal(
  'a5850000-0000-4000-8000-000000000001', 1200000, 'Wd Owner', '0987654321', 'Test Bank', 'wd-key-owner-1');
select is((select status::text from app.collection_withdrawals('a5850000-0000-4000-8000-000000000001') where id = (select id from tmp_w where label = 'r3')),
  'approved', 'an owner''s own request is approved as made');

reset role;
select throws_ok(format($$ select app.complete_withdrawal(%L, 'NIP-1', now()) $$, (select id from tmp_w where label = 'r3')),
  'P0001', null, 'a payout cannot be completed before it is processing');
select lives_ok(format($$ select app.mark_withdrawal_processing(%L) $$, (select id from tmp_w where label = 'r3')),
  'the operator marks the payout as processing');
select throws_ok(format($$ select app.fail_withdrawal(%L, '') $$, (select id from tmp_w where label = 'r3')),
  '22023', null, 'a failure needs a reason');
select lives_ok(format($$ select app.fail_withdrawal(%L, 'Bank rejected the transfer') $$, (select id from tmp_w where label = 'r3')),
  'the operator records the failed payout');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '1470000:0:0',
  'a failed payout returns the money to available and counts nothing as withdrawn');
select is((select status::text || ':' || (release_journal_id is not null) || ':' || (payout_journal_id is null)
           from public.withdrawals where id = (select id from tmp_w where label = 'r3')),
  'failed:true:true', 'failed: hold released, no payout journal');


-- ── Owner request again → processing → paid ─────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into tmp_w select 'r4', withdrawal_id from app.request_withdrawal(
  'a5850000-0000-4000-8000-000000000001', 1200000, 'Wd Owner', '0987654321', 'Test Bank', 'wd-key-owner-2');
select is((select fee_kobo || ':' || is_first from app.collection_withdrawals('a5850000-0000-4000-8000-000000000001')
           where id = (select id from tmp_w where label = 'r4')),
  '0:true', 'a failed withdrawal does not use up the free first withdrawal either');

reset role;
select app.mark_withdrawal_processing((select id from tmp_w where label = 'r4'));
select throws_ok(format($$ select app.complete_withdrawal(%L, 'NIP-2', now() + interval '1 day') $$, (select id from tmp_w where label = 'r4')),
  '22023', null, 'a payout cannot be dated in the future');
select lives_ok(format($$ select app.complete_withdrawal(%L, 'NIP-2', now()) $$, (select id from tmp_w where label = 'r4')),
  'the operator records the payout with the bank reference');
select is(pg_temp.pos('a5850000-0000-4000-8000-000000000001'), '270000:0:1200000',
  'paid: ₦12,000 withdrawn, ₦2,700 still available');
select lives_ok(format($$ select app.complete_withdrawal(%L, 'NIP-2', now()) $$, (select id from tmp_w where label = 'r4')),
  'recording the same payout again is a no-op');
select is((select count(*)::integer from public.ledger_journals where source_type = 'payout'
           and source_id = (select id from tmp_w where label = 'r4')), 1, 'one payout journal');
select throws_ok(format($$ select app.complete_withdrawal(%L, 'NIP-OTHER', now()) $$, (select id from tmp_w where label = 'r4')),
  'P0001', null, 'a different reference for a paid withdrawal is refused');
select throws_ok(format($$ select app.fail_withdrawal(%L, 'oops') $$, (select id from tmp_w where label = 'r4')),
  'P0001', null, 'a paid withdrawal cannot be failed');

select throws_ok(format($$ update public.withdrawals set amount_kobo = 1 where id = %L $$, (select id from tmp_w where label = 'r4')),
  'P0001', null, 'withdrawal facts are immutable');
select throws_ok(format($$ update public.withdrawals set status = 'processing' where id = %L $$, (select id from tmp_w where label = 'r4')),
  'P0001', null, 'a paid withdrawal is final');
select throws_ok(format($$ delete from public.withdrawals where id = %L $$, (select id from tmp_w where label = 'r4')),
  'P0001', null, 'a withdrawal is never deleted');

select is((select count(*)::integer from public.v_ledger_imbalances), 0, 'every journal balances');
select is((select count(*)::integer from app.collection_reconciliation_checks('a5850000-0000-4000-8000-000000000001') where not ok), 0,
  'collection A reconciles: released − paid withdrawals = available, withdrawn = paid withdrawals');


-- ── Daily limit (D-07) and manual review (D-06) ─────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000002', 98800100, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-b-daily') $$,
  'P0001', null, 'the community already moved ₦12,000 today, so ₦988,001 more would pass ₦1,000,000: refused');
select lives_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000002', 98800000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-b-ok') $$,
  '₦988,000 fits exactly under the ₦1,000,000 daily limit');
select throws_ok($$ select * from app.request_withdrawal('a5850000-0000-4000-8000-000000000003', 100, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-c-daily') $$,
  'P0001', null, 'the limit is per community per Lagos day, across collections');

reset role;
update public.communities set verification_status = 'verified' where id = 'a5820000-0000-4000-8000-00000000000a';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a5810000-0000-4000-8000-000000000002","role":"authenticated"}';

insert into tmp_w select 'c1', withdrawal_id from app.request_withdrawal(
  'a5850000-0000-4000-8000-000000000003', 120000000, 'Wd Treasurer', '0123456789', 'Test Bank', 'wd-key-c-big');
select is((select requires_manual_review from app.collection_withdrawals('a5850000-0000-4000-8000-000000000003')
           where id = (select id from tmp_w where label = 'c1')),
  true, 'a verified community has no daily limit; over ₦1,000,000 is flagged for manual review');


-- ── Audit ───────────────────────────────────────────────────────────────────

reset role;
select is((select count(*)::integer from public.audit_logs
           where action = 'withdrawal.request' and community_id = 'a5820000-0000-4000-8000-00000000000a'
             and after_state ? 'account_number'), 0,
  'the audit trail never stores a full account number');
select is((select count(*)::integer from public.audit_logs
           where action = 'withdrawal.request' and community_id = 'a5820000-0000-4000-8000-00000000000a'), 6,
  'every accepted request is audited once (replays are not)');

select * from finish();
rollback;
