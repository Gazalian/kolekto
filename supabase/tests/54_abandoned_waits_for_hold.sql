-- ─────────────────────────────────────────────────────────────────────────────
-- 54 — An abandoned checkout stays pending until its hold ends (20261114110000)
--
-- Paystack reports an initialized transaction that is not paid yet as
-- `abandoned`. A verify that runs before the payer finishes (the callback page
-- reached early, an early webhook) must not fail the checkout:
--
--   · inside the hold, `abandoned` is evidence only: the attempt stays
--     initialized, its stock stays reserved, nobody else can take the unit
--   · a success that follows captures and completes normally, with the stock
--     converted (no stock_exhausted, no oversell window)
--   · once the hold has ended, `abandoned` fails the attempt as
--     provider_abandoned and releases its stock
--   · a declined payment (`failed`) still fails at once, inside the hold
--   · a money-known attempt is never moved by `abandoned`
--
-- Runs as the database owner (session role `none`), like 52_payments.sql.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(16);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5410000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@hold.example.test');

insert into public.users (id, full_name, email) values
  ('a5410000-0000-4000-8000-000000000001', 'Hold Owner', 'owner@hold.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5420000-0000-4000-8000-00000000000a', 'hold-tests', 'Hold Tests', 'social_group', false, 'a5410000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a5420000-0000-4000-8000-00000000000a', 'a5410000-0000-4000-8000-000000000001', 'owner', 'Hold Owner', 'created');

-- Tiers, host absorbs, three tiers of one place each.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, max_amount_kobo, target_amount_kobo, deadline_at, status, visibility, fee_mode,
   collect_attendee_details, close_when_target_reached, created_by)
values
  ('a5450000-0000-4000-8000-000000000001', 'a5420000-0000-4000-8000-00000000000a', 'hold-gala', 'Hold Gala',
   'event', 'open', 'tiers', null, null, null, null, null, 'active', 'public', 'community_absorbs',
   false, false, 'a5410000-0000-4000-8000-000000000001');

insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, quantity_limit, per_order_limit, hidden) values
  ('a5460000-0000-4000-8000-000000000001', 'a5450000-0000-4000-8000-000000000001', 'a5420000-0000-4000-8000-00000000000a', 'Front row', 500000, 1, 1, false),
  ('a5460000-0000-4000-8000-000000000002', 'a5450000-0000-4000-8000-000000000001', 'a5420000-0000-4000-8000-00000000000a', 'Balcony',   500000, 1, 1, false),
  ('a5460000-0000-4000-8000-000000000003', 'a5450000-0000-4000-8000-000000000001', 'a5420000-0000-4000-8000-00000000000a', 'Lounge',    500000, 1, 1, false);

create function pg_temp.ref(n integer) returns text language sql as $$
  select 'KLK-' || lpad((5400 + n)::text, 26, '0')
$$;

-- One place on a tier at ₦5,000, host absorbs: 0.5% + 1.5% = ₦100; estimate 1% = ₦50.
-- Initialized afterwards, as the orchestrator does once the provider answers.
create function pg_temp.attempt(p_key text, p_ref integer, p_tier uuid) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select attempt_id into v_id from app.create_payment_attempt(
    'a5450000-0000-4000-8000-000000000001', p_key, pg_temp.ref(p_ref), 'fake', null,
    'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[],
    jsonb_build_array(jsonb_build_object('tier_id', p_tier, 'quantity', 1)), null,
    500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.mark_payment_attempt_initialized(v_id, 'ACCESS_' || p_ref);
  return v_id;
end;
$$;

create function pg_temp.provider_says(p_ref integer, p_status text) returns public.payment_attempt_status language sql as $$
  select status from app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), p_status, p_status,
    500000, 'NGN', case when p_status = 'succeeded' then 5000 end,
    case when p_status = 'succeeded' then now() end, 'card', null, '{"__fake": true}'::jsonb)
$$;

create function pg_temp.stock(p_attempt uuid, p_status text) returns integer language sql as $$
  select coalesce(sum(quantity), 0)::integer from public.stock_reservations
  where attempt_id = p_attempt and status::text = p_status
$$;


-- ── Inside the hold: abandoned is evidence only ─────────────────────────────

create temporary table tmp_early as
  select pg_temp.attempt('hold-key-early-0001', 1, 'a5460000-0000-4000-8000-000000000001') as id;

select is(
  pg_temp.provider_says(1, 'abandoned'),
  'initialized'::public.payment_attempt_status,
  'abandoned inside the hold leaves the attempt pending'
);

select is(
  (select failure_code from public.payment_attempts where id = (select id from tmp_early)),
  null,
  'and sets no failure code'
);

select is(
  pg_temp.stock((select id from tmp_early), 'reserved'),
  1,
  'its place stays reserved'
);

select is(
  (select count(*)::integer from public.provider_transactions
   where attempt_id = (select id from tmp_early) and status_mapped = 'abandoned'),
  1,
  'the statement is still kept as evidence'
);

select is(
  pg_temp.provider_says(1, 'abandoned'),
  'initialized'::public.payment_attempt_status,
  'a repeat of the same statement changes nothing'
);

select throws_like(
  $$ select pg_temp.attempt('hold-key-other-0002', 2, 'a5460000-0000-4000-8000-000000000001') $$,
  'SOLD_OUT:%',
  'nobody else can take the place while the payer may still be paying'
);

select is(
  pg_temp.provider_says(1, 'succeeded'),
  'captured'::public.payment_attempt_status,
  'the payer finishes: the success captures'
);

select is(
  (select status::text from app.complete_payment_capture((select id from tmp_early))),
  'completed',
  'and completes — the place was never released, so it is not parked as stock_exhausted'
);

select is(
  pg_temp.stock((select id from tmp_early), 'converted'),
  1,
  'its reservation is converted'
);

select is(
  pg_temp.provider_says(1, 'abandoned'),
  'completed'::public.payment_attempt_status,
  'a late abandoned never moves a completed payment'
);


-- ── A declined payment still fails at once ──────────────────────────────────

create temporary table tmp_declined as
  select pg_temp.attempt('hold-key-declined-0003', 3, 'a5460000-0000-4000-8000-000000000002') as id;

select is(
  pg_temp.provider_says(3, 'failed'),
  'failed'::public.payment_attempt_status,
  'failed inside the hold fails the attempt'
);

select is(
  pg_temp.stock((select id from tmp_declined), 'released'),
  1,
  'and releases its place'
);


-- ── After the hold: abandoned fails the attempt ─────────────────────────────

create temporary table tmp_late as
  select pg_temp.attempt('hold-key-late-0004', 4, 'a5460000-0000-4000-8000-000000000003') as id;

-- now() does not move inside a test transaction, and the hold is frozen on the
-- attempt (D-16), so the clock is moved the other way: the attempt is aged
-- with the frozen-column trigger off, as a restore would load it.
set local session_replication_role = replica;
update public.payment_attempts
   set created_at = now() - interval '31 minutes',
       hold_expires_at = now() - interval '1 minute',
       check_until = now() + interval '23 hours'
 where id = (select id from tmp_late);
set local session_replication_role = origin;

select is(
  pg_temp.provider_says(4, 'abandoned'),
  'failed'::public.payment_attempt_status,
  'abandoned after the hold fails the attempt'
);

select is(
  (select failure_code from public.payment_attempts where id = (select id from tmp_late)),
  'provider_abandoned',
  'as provider_abandoned'
);

select is(
  pg_temp.stock((select id from tmp_late), 'released'),
  1,
  'and releases its place'
);

select is(
  pg_temp.provider_says(4, 'succeeded'),
  'captured'::public.payment_attempt_status,
  'a success after that is still captured — money is never refused'
);

select * from finish();
rollback;
