-- ─────────────────────────────────────────────────────────────────────────────
-- 62 — Collection payment activity (20261117130000)
--
--   · a verified payment is 'successful' at once, with the payer's name and amount
--   · T+1 decides eligibility only: scheduled / awaiting_provider / released,
--     while the payment stays 'successful' throughout
--   · fees are the frozen lines: processing, Kolekto, total, bearer, net, charged
--     (host absorbs and contributor pays)
--   · unconfirmed checkouts are 'pending', refused ones 'failed', with no fee
--   · filters apply before paging; withdrawals need balance.view
--   · unknown filter, outsider and anon are refused; reading moves no money
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
-- 20261118100100 added a verified-charge schedule (no provider confirmation)
-- effective 2026-11-18. This file tests the provider-confirmed rule with
-- captures dated relative to now(), so it pins that rule for its own
-- captures inside this rolled-back transaction, whatever today is.
insert into public.settlement_schedules
  (version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes)
-- The pin must also start after the newest migration schedule (the verified-
-- charge rule starts 2026-11-17 23:00 UTC); a bare now() - 3 days lost to it
-- whenever the test ran before 2026-11-20 23:00 UTC (session 40).
values ('test-pin-provider-confirmed', greatest(now() - interval '3 days', (select max(s.effective_from) from public.settlement_schedules s) + interval '1 second'), 'Africa/Lagos', 1, time '05:00', true, 'test only');
-- 20261118100100 revoked app.request_withdrawal (typed destination) from
-- clients; this file still uses it to create withdrawals, so the grant is
-- restored inside this rolled-back transaction only.
grant execute on function app.request_withdrawal(uuid, bigint, text, text, text, text) to authenticated;
select plan(24);

insert into auth.users (id, instance_id, aud, role, email) values
  ('a6210000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@activity.example.test'),
  ('a6210000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@activity.example.test');
insert into public.users (id, full_name, email, identity_level) values
  ('a6210000-0000-4000-8000-000000000001', 'Activity Owner', 'owner@activity.example.test',    'identity_verified'),
  ('a6210000-0000-4000-8000-000000000003', 'Other Owner',    'outsider@activity.example.test', 'identity_verified')
on conflict (id) do update set full_name = excluded.full_name, identity_level = excluded.identity_level;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6220000-0000-4000-8000-00000000000a', 'activity-tests', 'Activity Tests', 'social_group', false, 'a6210000-0000-4000-8000-000000000001'),
  ('a6220000-0000-4000-8000-00000000000b', 'activity-other', 'Activity Other', 'social_group', false, 'a6210000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6220000-0000-4000-8000-00000000000a', 'a6210000-0000-4000-8000-000000000001', 'owner', 'Activity Owner', 'created', null),
  ('a6220000-0000-4000-8000-00000000000b', 'a6210000-0000-4000-8000-000000000003', 'owner', 'Other Owner',    'created', null);

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a6250000-0000-4000-8000-000000000001', 'a6220000-0000-4000-8000-00000000000a', 'absorbs', 'Host Absorbs',
   'dues', 'open', 'public', 'fixed', 1000000, 'active', 'unlisted', 'community_absorbs', 'a6210000-0000-4000-8000-000000000001'),
  ('a6250000-0000-4000-8000-000000000002', 'a6220000-0000-4000-8000-00000000000a', 'payer-pays', 'Payer Pays',
   'dues', 'open', 'public', 'fixed', 1000000, 'active', 'unlisted', 'contributor_pays', 'a6210000-0000-4000-8000-000000000001');

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;
create function pg_temp.col(n integer) returns uuid language sql as $$
  select ('a6250000-0000-4000-8000-00000000000' || n)::uuid $$;

-- ₦10,000. Kolekto fee ₦50 (0.5%), processing fee ₦150 (1.5%), total ₦200.
-- Host absorbs: charged ₦10,000, net ₦9,800. Contributor pays: charged ₦10,200, net ₦10,000.
create function pg_temp.attempt(p_col integer, p_ref integer, p_name text) returns uuid language plpgsql as $$
declare
  v_attempt uuid;
  v_payer_pays boolean := p_col = 2;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    pg_temp.col(p_col), 'checkout-key-activity-' || p_ref, pg_temp.ref(p_ref), 'fake', null,
    p_name, 'payer' || p_ref || '@activity.example.test', '+2348000000062', '{}'::jsonb, '{}'::text[],
    null, null,
    1000000, 5000, 15000, 0, 20000,
    case when v_payer_pays then 1020000 else 1000000 end,
    case when v_payer_pays then 1000000 else 980000 end, 10000,
    case when v_payer_pays then 'contributor_pays' else 'community_absorbs' end::public.fee_mode, '2026-11-founder');
  return v_attempt;
end;
$$;

create function pg_temp.pay(p_col integer, p_ref integer, p_name text, p_paid_at timestamptz) returns uuid language plpgsql as $$
declare
  v_attempt uuid := pg_temp.attempt(p_col, p_ref, p_name);
begin
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    case when p_col = 2 then 1020000 else 1000000 end, 'NGN', null, p_paid_at, 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
  return v_attempt;
end;
$$;

create temporary table tmp_a (label text primary key, id uuid);
insert into tmp_a values
  ('today',    pg_temp.pay(1, 6201, 'Adebayo Johnson', now())),
  ('due',      pg_temp.pay(1, 6202, 'Maryam Ibrahim',  now() - interval '2 days')),
  ('released', pg_temp.pay(1, 6203, 'David Okafor',    now() - interval '2 days')),
  ('waiting',  pg_temp.attempt(1, 6204, 'Fatima Bello')),
  ('refused',  pg_temp.attempt(1, 6205, 'Kunle Ade')),
  ('payer',    pg_temp.pay(2, 6206, 'Ngozi Eze',       now()));
grant select on tmp_a to authenticated, anon;
create function pg_temp.a(p text) returns uuid language sql as $$ select id from tmp_a where label = p $$;

select app.mark_payment_attempt_initialized(pg_temp.a('refused'), 'access-6205') is not null;
select is(app.mark_payment_attempt_failed(pg_temp.a('refused'), 'declined')::text, 'failed', 'Kunle''s checkout is refused by the provider');

-- The provider settles David's payment; the automatic release moves it to available.
select is((select outcome from app.record_provider_settlement(pg_temp.ref(6203), 'STL-62', 990000, now() - interval '1 day')),
  'confirmed', 'provider settlement for David''s payment recorded (₦10,000 − ₦100 provider fee)');
select is((select released from app.release_due_settlements(500)), 1, 'the release job moves exactly that payment');

create temporary table tmp_pos as
  select pending_kobo, available_kobo, withdrawing_kobo, withdrawn_kobo
  from public.v_collection_position where collection_id = pg_temp.col(1);

create function pg_temp.row(p text) returns text language sql as $$
  select concat_ws(':', r.name, r.payment_status, r.amount_kobo, r.eligibility)
  from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0) r where r.id = pg_temp.a(p) $$;


-- ── The organiser's view ───────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6210000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(pg_temp.row('today'), 'Adebayo Johnson:successful:1000000:scheduled',
  'a payment verified today is successful at once, named, ₦10,000, and only its withdrawal waits for T+1');
select is(pg_temp.row('due'), 'Maryam Ibrahim:successful:1000000:awaiting_provider',
  'past T+1 without provider settlement: still successful; eligibility says the provider has not settled');
select is(pg_temp.row('released'), 'David Okafor:successful:1000000:released',
  'released to the available balance; still successful');
select is(pg_temp.row('waiting'), 'Fatima Bello:pending:1000000',
  'a checkout the provider has not confirmed is pending, with no eligibility');
select is(pg_temp.row('refused'), 'Kunle Ade:failed:1000000', 'a refused checkout is failed');

select is(
  (select concat_ws(':', charged_kobo, processing_fee_kobo, kolekto_fee_kobo, total_fees_kobo, net_kobo, fee_bearer)
   from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0) where id = pg_temp.a('today')),
  '1000000:15000:5000:20000:980000:community_absorbs',
  'host absorbs: paid ₦10,000, processing ₦150 + Kolekto ₦50 = ₦200 fees, ₦9,800 credited');
select is(
  (select concat_ws(':', amount_kobo, charged_kobo, total_fees_kobo, net_kobo, fee_bearer)
   from app.collection_payment_activity(pg_temp.col(2), 'all', 50, 0) where id = pg_temp.a('payer')),
  '1000000:1020000:20000:1000000:contributor_pays',
  'contributor pays: ₦10,000 contribution, ₦10,200 charged, ₦200 fees, ₦10,000 credited');
select is(
  (select count(*)::integer from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0)
   where payment_status <> 'successful' and (total_fees_kobo is not null or net_kobo is not null or charged_kobo is not null)),
  0, 'no fee or net is shown for a payment that did not succeed');

select is(
  (select verified_at from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0) where id = pg_temp.a('released')),
  (select captured_at from public.contributions where attempt_id = pg_temp.a('released')),
  'verified_at is the capture time');
select ok(
  (select eligible_at > verified_at from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0) where id = pg_temp.a('today')),
  'eligible_at (T+1) is after verification');


-- ── Filters and paging ─────────────────────────────────────────────────────

select is((select count(*)::integer from app.collection_payment_activity(pg_temp.col(1), 'successful', 50, 0)), 3, 'three successful');
select is((select count(*)::integer from app.collection_payment_activity(pg_temp.col(1), 'pending', 50, 0)), 1, 'one pending');
select is((select count(*)::integer from app.collection_payment_activity(pg_temp.col(1), 'failed', 50, 0)), 1, 'one failed');
select is((select total_count::integer from app.collection_payment_activity(pg_temp.col(1), 'successful', 1, 0)), 3,
  'the filter applies before paging: one row, total three');
select throws_ok($$ select * from app.collection_payment_activity('a6250000-0000-4000-8000-000000000001', 'settlement', 10, 0) $$,
  '22023', null, 'an unknown filter is refused');


-- ── Withdrawals are their own rows ─────────────────────────────────────────

select is((select status::text from app.request_withdrawal(
            pg_temp.col(1), 500000, 'Activity Owner', '0123456789', 'Test Bank', 'activity-wd-key-1')),
  'approved', 'the owner withdraws ₦5,000 of the released ₦9,800');
select is(
  (select concat_ws(':', kind, amount_kobo, withdrawal_status, destination, payment_status is null)
   from app.collection_payment_activity(pg_temp.col(1), 'withdrawals', 50, 0)),
  'withdrawal:500000:approved:Test Bank ••••6789:t',
  'the withdrawal shows its amount, status and masked account; it has no payment status');
select is((select count(*)::integer from app.collection_payment_activity(pg_temp.col(1), 'all', 50, 0)), 6,
  'All lists five payments and the withdrawal');


-- ── Outsiders ──────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"a6210000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from app.collection_payment_activity('a6250000-0000-4000-8000-000000000001', 'all', 10, 0) $$,
  '42501', null, 'another community''s owner is refused');

reset role;
set local role anon;
select throws_ok($$ select * from app.collection_payment_activity('a6250000-0000-4000-8000-000000000001', 'all', 10, 0) $$,
  '42501', null, 'anon cannot execute it');


-- ── Reading moves nothing ──────────────────────────────────────────────────

reset role;
select is(
  (select pending_kobo || ':' || (available_kobo + withdrawing_kobo) from public.v_collection_position where collection_id = pg_temp.col(1)),
  (select pending_kobo || ':' || (available_kobo + withdrawing_kobo) from tmp_pos),
  'pending unchanged; available + being withdrawn unchanged (the hold only moved money between them)');

select * from finish();
rollback;
