-- ─────────────────────────────────────────────────────────────────────────────
-- 55 — Payment notifications, the receipt read and the fee alarm (20261116100000)
--
--   · created → initialized audits payment.initialized and queues it
--   · initialized → failed audits payment.failed; created → failed (a checkout
--     that never existed) audits nothing
--   · capture's payment.captured is now queued for the worker
--   · the four payment actions are essential in the SQL policy map
--   · app.payment_receipt: completed only, by reference, email masked, no phone
--   · app.payment_notification_context: the payer's address for the worker
--   · app.payment_fee_alarms: reported fee > fee charged (loss) and > estimate,
--     over real contributions; estimated fees never alarm
--   · none of the three read functions is executable by a client role
--
-- Runs as the database owner (session role `none`), like 52_payments.sql.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(27);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5510000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@notify.example.test');

insert into public.users (id, full_name, email) values
  ('a5510000-0000-4000-8000-000000000001', 'Notify Owner', 'owner@notify.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5520000-0000-4000-8000-00000000000a', 'notify-tests', 'Notify Tests', 'social_group', false, 'a5510000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a5520000-0000-4000-8000-00000000000a', 'a5510000-0000-4000-8000-000000000001', 'owner', 'Notify Owner', 'created');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, max_amount_kobo, target_amount_kobo, deadline_at, status, visibility, fee_mode,
   collect_attendee_details, close_when_target_reached, created_by)
values
  ('a5550000-0000-4000-8000-000000000001', 'a5520000-0000-4000-8000-00000000000a', 'notify-gala', 'Notify Gala',
   'event', 'open', 'tiers', null, null, null, null, null, 'active', 'public', 'community_absorbs',
   false, false, 'a5510000-0000-4000-8000-000000000001');

insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, quantity_limit, per_order_limit, hidden) values
  ('a5560000-0000-4000-8000-000000000001', 'a5550000-0000-4000-8000-000000000001', 'a5520000-0000-4000-8000-00000000000a', 'Table seat', 500000, null, 1, false);

create function pg_temp.ref(n integer) returns text language sql as $$
  select 'KLK-' || lpad((5500 + n)::text, 26, '0')
$$;

-- One seat at ₦5,000, host absorbs: fees ₦100 (7500 processing + 2500 Kolekto); estimate 1% = ₦50.
create function pg_temp.attempt(p_ref integer, p_initialize boolean default true) returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  select attempt_id into v_id from app.create_payment_attempt(
    'a5550000-0000-4000-8000-000000000001', 'notify-key-' || lpad(p_ref::text, 8, '0'), pg_temp.ref(p_ref), 'fake', null,
    'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[],
    jsonb_build_array(jsonb_build_object('tier_id', 'a5560000-0000-4000-8000-000000000001', 'quantity', 1)), null,
    500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  if p_initialize then
    perform app.mark_payment_attempt_initialized(v_id, 'ACCESS_' || p_ref);
  end if;
  return v_id;
end;
$$;

create function pg_temp.provider_says(p_ref integer, p_status text, p_fee bigint) returns public.payment_attempt_status language sql as $$
  select status from app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), p_status, p_status,
    500000, 'NGN', p_fee, case when p_status = 'succeeded' then now() end, 'card', null, '{"__fake": true}'::jsonb)
$$;

create function pg_temp.audits(p_attempt uuid, p_action text) returns integer language sql as $$
  select count(*)::integer from public.audit_logs where object_id = p_attempt and action = p_action
$$;

create function pg_temp.queued(p_attempt uuid, p_action text) returns integer language sql as $$
  select count(*)::integer from pgmq.q_notification_events
  where message ->> 'object_id' = p_attempt::text and message ->> 'action' = p_action
$$;


-- ── Lifecycle audits and the queue ──────────────────────────────────────────

create temporary table tmp_a as select pg_temp.attempt(1) as id;

select is(pg_temp.audits((select id from tmp_a), 'payment.initialized'), 1, 'created → initialized audits payment.initialized');
select is(pg_temp.queued((select id from tmp_a), 'payment.initialized'), 1, 'and queues it for the worker');
select is(
  (select after_state ->> 'reference' from public.audit_logs where object_id = (select id from tmp_a) and action = 'payment.initialized'),
  pg_temp.ref(1),
  'the audit names the reference'
);

select is(pg_temp.provider_says(1, 'succeeded', 5000), 'captured'::public.payment_attempt_status, 'success captures');
select is((select status::text from app.complete_payment_capture((select id from tmp_a))), 'completed', 'and completes');
select is(pg_temp.queued((select id from tmp_a), 'payment.captured'), 1, 'payment.captured is now queued (the receipt)');
select is(pg_temp.audits((select id from tmp_a), 'payment.failed'), 0, 'a successful payment never audits payment.failed');

create temporary table tmp_declined as select pg_temp.attempt(2) as id;
select is(pg_temp.provider_says(2, 'failed', null), 'failed'::public.payment_attempt_status, 'a declined card fails the attempt');
select is(pg_temp.audits((select id from tmp_declined), 'payment.failed'), 1, 'initialized → failed audits payment.failed');
select is(
  (select after_state ->> 'failure_code' from public.audit_logs where object_id = (select id from tmp_declined) and action = 'payment.failed'),
  'provider_failed',
  'with the failure code'
);
select is(pg_temp.queued((select id from tmp_declined), 'payment.failed'), 1, 'and queues it');

create temporary table tmp_refused as select pg_temp.attempt(3, false) as id;
select is(app.mark_payment_attempt_failed((select id from tmp_refused), 'invalid_params'), 'failed'::public.payment_attempt_status, 'a refused initialize fails the attempt');
select is(
  pg_temp.audits((select id from tmp_refused), 'payment.failed') + pg_temp.audits((select id from tmp_refused), 'payment.initialized'),
  0,
  'a checkout that never existed audits nothing (no email to send)'
);

select is(
  (select array_agg(category order by e) from unnest(array['payment.initialized', 'payment.captured', 'payment.needs_review', 'payment.failed']) e,
     lateral app.communication_category_for_event(e)),
  array['essential', 'essential', 'essential', 'essential'],
  'the four payment actions are essential in the SQL policy map'
);


-- ── The receipt ─────────────────────────────────────────────────────────────

select is(app.payment_receipt(pg_temp.ref(1)) ->> 'reference', pg_temp.ref(1), 'a completed payment has a receipt');
select is(app.payment_receipt(pg_temp.ref(1)) ->> 'contributor_email_masked', 'p***@example.test', 'with the email masked');
select ok(not (app.payment_receipt(pg_temp.ref(1)) ? 'contributor_phone'), 'and no phone');
select is(app.payment_receipt(pg_temp.ref(1)) -> 'lines' -> 0 ->> 'name', 'Table seat', 'and the tier line by name');
select is(app.payment_receipt(pg_temp.ref(2)), null, 'a failed payment has no receipt');
select is(app.payment_receipt('not-a-reference'), null, 'a malformed reference has no receipt');

select is(
  (select contributor_email from app.payment_notification_context((select id from tmp_a))),
  'payer@example.test',
  'the worker context carries the address the payer typed'
);
select is(
  (select provider from app.payment_notification_context((select id from tmp_a))),
  'fake',
  'the worker context carries the provider name'
);
select is(
  (select provider_access_code from app.payment_notification_context((select id from tmp_a))),
  'ACCESS_1',
  'the worker context carries the provider access code for the checkout URL'
);


-- ── M8.7 alarm 1: the fee ───────────────────────────────────────────────────
-- Attempt 1: reported ₦50 = estimate ₦50, below the ₦100 charged → no alarm.
-- Attempt 4: reported ₦75 (1.5%) → over the estimate by ₦25 only.
-- Attempt 5: reported ₦120 → over the fee charged by ₦20 and the estimate by ₦70.
-- Attempt 6: no fee reported (estimated basis) → never alarms.

select pg_temp.attempt(4); select pg_temp.provider_says(4, 'succeeded', 7500);
select app.complete_payment_capture(id) from public.payment_attempts where reference = pg_temp.ref(4);
select pg_temp.attempt(5); select pg_temp.provider_says(5, 'succeeded', 12000);
select app.complete_payment_capture(id) from public.payment_attempts where reference = pg_temp.ref(5);
select pg_temp.attempt(6); select pg_temp.provider_says(6, 'succeeded', null);
select app.complete_payment_capture(id) from public.payment_attempts where reference = pg_temp.ref(6);

select results_eq(
  $$ select reference, alarm, overrun_kobo from app.payment_fee_alarms(now() - interval '1 hour')
     where collection_id = 'a5550000-0000-4000-8000-000000000001' order by reference, alarm $$,
  $$ values (pg_temp.ref(4), 'provider_fee_exceeds_estimate', 2500::bigint),
            (pg_temp.ref(5), 'provider_fee_exceeds_estimate', 7000::bigint),
            (pg_temp.ref(5), 'provider_fee_exceeds_fee_charged', 2000::bigint) $$,
  'alarms fire on reported fees over the estimate and over the fee charged, by how much; estimated fees never alarm'
);

select is(
  (select count(*)::integer from app.payment_fee_alarms(now() + interval '1 hour')),
  0,
  'the window excludes older contributions'
);


-- ── No client role can call the read functions ──────────────────────────────

select ok(
  not has_function_privilege('anon', 'app.payment_receipt(text)', 'execute')
  and not has_function_privilege('authenticated', 'app.payment_receipt(text)', 'execute')
  and not has_function_privilege('anon', 'app.payment_notification_context(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app.payment_notification_context(uuid)', 'execute'),
  'receipt and notification context are not client-callable'
);
select ok(
  not has_function_privilege('anon', 'app.payment_fee_alarms(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'app.payment_fee_alarms(timestamptz)', 'execute'),
  'the fee alarm is not client-callable'
);

select * from finish();
rollback;
