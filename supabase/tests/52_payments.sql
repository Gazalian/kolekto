-- ─────────────────────────────────────────────────────────────────────────────
-- 52 — Payment records, attempts and capture (M8.3 / M8.4)
--
-- Coverage for 20261111100000_payment_records.sql and
-- 20261111100100_payment_functions.sql. What has to be true before a single
-- naira moves through the new system:
--
--   · no client role can execute a payment function, and a stray grant still
--     cannot make one client-callable (the inner session guard)
--   · the amount is re-derived from rows by id; a stale or tampered figure is
--     refused, never charged
--   · the fee breakdown uses the collection's bearer and the schedule in force,
--     adds up, and stays under the platform ceiling
--   · a double-click returns the same attempt; a different payment under the
--     same key is refused
--   · stock is reserved under a lock; a released hold frees it; a late capture
--     that finds it gone is parked, not refused
--   · capture is exactly once, posts balanced, collection-attributed journals,
--     and records a mismatch as needs_review rather than accepting it
--   · an obligation becomes paid only with a contribution to show for it
--   · a fundraiser that opted in closes when a capture crosses its target
--
-- Runs as the database owner (session role `none`), which is how the server's
-- owner connection reaches these functions.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(76);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('e1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@pay.example.test'),
  ('e1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'other@pay.example.test');

insert into public.users (id, full_name, email) values
  ('e1000000-0000-4000-8000-000000000001', 'Pay Owner',   'owner@pay.example.test'),
  ('e1000000-0000-4000-8000-000000000002', 'Other Owner', 'other@pay.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('e2000000-0000-4000-8000-00000000000a', 'pay-tests',       'Pay Tests',  'social_group', false, 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-00000000000b', 'pay-tests-other', 'Other Club', 'social_group', false, 'e1000000-0000-4000-8000-000000000002');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('e2000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-000000000001', 'owner', 'Pay Owner',   'created'),
  ('e2000000-0000-4000-8000-00000000000b', 'e1000000-0000-4000-8000-000000000002', 'owner', 'Other Owner', 'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('e3000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 'Ada Payer',   '+2348097770001', 'PT/0001', 'active', 'manual'),
  ('e3000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'Bola Payer',  '+2348097770002', 'PT/0002', 'active', 'manual'),
  ('e3000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-00000000000b', 'Other Payer', '+2348097770003', 'OC/0001', 'active', 'manual');

-- Collections, inserted directly: these tests are about payment, not creation.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, max_amount_kobo, target_amount_kobo, deadline_at, status, visibility, fee_mode,
   collect_attendee_details, close_when_target_reached, created_by)
values
  -- open amount, host absorbs, min ₦100
  ('e4000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 'open-pot', 'Open Pot',
   'contribution', 'open', 'open_amount', null, 10000, null, null, null, 'active', 'public', 'community_absorbs',
   false, false, 'e1000000-0000-4000-8000-000000000001'),
  -- tiers, contributor pays
  ('e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'gala-tickets', 'Gala Tickets',
   'event', 'open', 'tiers', null, null, null, null, null, 'active', 'public', 'contributor_pays',
   false, false, 'e1000000-0000-4000-8000-000000000001'),
  -- managed fixed dues, ₦5,000
  ('e4000000-0000-4000-8000-000000000003', 'e2000000-0000-4000-8000-00000000000a', 'annual-dues', 'Annual Dues',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'e1000000-0000-4000-8000-000000000001'),
  -- fundraiser, target ₦10,000, closes on target
  ('e4000000-0000-4000-8000-000000000004', 'e2000000-0000-4000-8000-00000000000a', 'roof-appeal', 'Roof Appeal',
   'fundraiser', 'open', 'open_amount', null, null, null, 1000000, null, 'active', 'public', 'community_absorbs',
   false, true, 'e1000000-0000-4000-8000-000000000001'),
  -- fixed, closing date two days ago (Lagos)
  ('e4000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-00000000000a', 'late-levy', 'Late Levy',
   'dues', 'open', 'fixed', 500000, null, null, null, now() - interval '2 days', 'active', 'public', 'community_absorbs',
   false, false, 'e1000000-0000-4000-8000-000000000001'),
  -- another community's tiered collection, for foreign ids
  ('e4000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-00000000000b', 'other-gala', 'Other Gala',
   'event', 'open', 'tiers', null, null, null, null, null, 'active', 'public', 'contributor_pays',
   false, false, 'e1000000-0000-4000-8000-000000000002');

insert into public.collection_tiers (id, collection_id, community_id, name, price_kobo, quantity_limit, per_order_limit, hidden) values
  ('e5000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'VIP',     500000, 2,    2,    false),
  ('e5000000-0000-4000-8000-000000000002', 'e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'Regular', 300000, null, null, false),
  ('e5000000-0000-4000-8000-000000000003', 'e4000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'Staff',   100000, null, null, true),
  ('e5000000-0000-4000-8000-000000000004', 'e4000000-0000-4000-8000-000000000006', 'e2000000-0000-4000-8000-00000000000b', 'Foreign',  50000, null, null, false);

insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo) values
  ('e6000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000001', 500000),
  ('e6000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-00000000000a', 'e4000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000002', 500000);

-- A reference in the KLK- format, numbered for readability.
create function pg_temp.ref(n integer) returns text language sql as $$
  select 'KLK-' || lpad(n::text, 26, '0')
$$;

-- Create an attempt with the current schedule. Fee figures are passed in, as
-- the server passes calculateFees() output; the database checks them.
create function pg_temp.attempt(
  p_collection uuid, p_key text, p_ref integer, p_member uuid, p_lines jsonb, p_open bigint,
  p_contribution bigint, p_platform bigint, p_gateway bigint, p_total_fees bigint,
  p_payable bigint, p_net bigint, p_estimate bigint, p_bearer public.fee_mode
) returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, p_key, pg_temp.ref(p_ref), 'fake', p_member,
    'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[],
    p_lines, p_open, p_contribution, p_platform, p_gateway, 0, p_total_fees, p_payable, p_net, p_estimate,
    p_bearer, '2026-11-founder')
$$;

-- What the provider says. Status, amount, currency and fee are the test's choice.
create function pg_temp.provider_says(p_ref integer, p_status text, p_amount bigint, p_currency text, p_fee bigint)
returns public.payment_attempt_status language sql as $$
  select status from app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), p_status, p_status,
    p_amount, p_currency, p_fee, case when p_status = 'succeeded' then now() end, 'card', null,
    '{"__fake": true}'::jsonb)
$$;

-- ₦10,000 open contribution, host absorbs: 0.5% + 1.5% = ₦200; estimate 1% = ₦100.
create temporary table tmp_a1 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0001', 1, null, null, 1000000,
                         1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') as id;


-- ── Who can call these ──────────────────────────────────────────────────────

select is_empty(
  $$ select p.proname from pg_proc p
     where p.pronamespace = 'app'::regnamespace
       and p.proname in ('create_payment_attempt', 'mark_payment_attempt_initialized', 'mark_payment_attempt_failed',
                         'expire_payment_attempt', 'record_provider_transaction', 'complete_payment_capture',
                         'release_payment_attempt_stock', 'ensure_ledger_account', 'stock_remaining', 'post_payment_journal',
                         'current_payment_limits', 'current_fee_schedule_version', 'collection_window_state',
                         'assert_payment_operator_session')
       and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('public', p.oid, 'EXECUTE')) $$,
  'no client role can execute any payment function'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ select * from app.complete_payment_capture(gen_random_uuid()) $$,
  '42501', null,
  'a signed-in officer cannot complete a capture — there is no grant'
);
reset role;

-- Defence in depth: even a mistaken grant does not make it client-callable.
grant execute on function app.complete_payment_capture(uuid) to authenticated;
grant usage on schema app to authenticated;
set local role authenticated;
select throws_like(
  $$ select * from app.complete_payment_capture(gen_random_uuid()) $$,
  'FORBIDDEN:%',
  'with a stray grant, the inner session guard still refuses a client role'
);
reset role;
revoke execute on function app.complete_payment_capture(uuid) from authenticated;


-- ── Creating an attempt ─────────────────────────────────────────────────────

select is(
  (select status::text from public.payment_attempts where id = (select id from tmp_a1)),
  'created',
  'a valid open-amount attempt is created'
);

select is(
  (select reused from app.create_payment_attempt(
     'e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0001', pg_temp.ref(999), 'fake', null,
     'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[], null, 1000000,
     1000000, 5000, 15000, 0, 20000, 1000000, 980000, 10000, 'community_absorbs', '2026-11-founder')),
  true,
  'a double-click with the same checkout key returns the existing attempt'
);

select is(
  (select count(*)::integer from public.payment_attempts
   where collection_id = 'e4000000-0000-4000-8000-000000000001'),
  1,
  'and creates nothing new'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0001', 2, null, null, 2000000,
                            2000000, 10000, 30000, 40000, 2000000, 1960000, 20000, 'community_absorbs') $$,
  'CHECKOUT_KEY_REUSED:%',
  'the same checkout key for a different amount is refused'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0003', 3, null, null, 5000,
                            5000, 25, 75, 100, 5000, 4900, 50, 'community_absorbs') $$,
  'AMOUNT_BELOW_MINIMUM:%',
  'an open amount below the collection minimum is refused'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0004', 4, null, null, 1000000,
                            900000, 4500, 13500, 18000, 900000, 882000, 9000, 'community_absorbs') $$,
  'AMOUNT_MISMATCH:%',
  'a server figure that disagrees with the database by any amount is refused (impossible-state guard)'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0005', 5, null, null, 1000000,
                            1000000, 5000, 15000, 20000, 1020000, 1000000, 10000, 'contributor_pays') $$,
  'FEE_BEARER_MISMATCH:%',
  'a breakdown with a bearer other than the collection''s is refused'
);

select throws_like(
  $$ select attempt_id from app.create_payment_attempt(
       'e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0006', pg_temp.ref(6), 'fake', null,
       'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[], null, 1000000,
       1000000, 15000, 15000, 0, 30000, 1000000, 970000, 15000, 'community_absorbs', '2026-09-founder') $$,
  'FEE_SCHEDULE_NOT_CURRENT:%',
  'a breakdown priced on a superseded schedule is refused'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0007', 7, null, null, 1000000,
                            1000000, 5000, 15000, 20000, 1000000, 990000, 10000, 'community_absorbs') $$,
  'FEE_BREAKDOWN_INVALID:%',
  'a breakdown whose net does not follow from its fees is refused'
);

-- ₦6,000,000: above the ₦5,000,000 per-payment ceiling.
select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0008', 8, null, null, 600000000,
                            600000000, 3000000, 9000000, 12000000, 600000000, 588000000, 200000, 'community_absorbs') $$,
  'PAYMENT_ABOVE_CEILING:%',
  'a payment above the platform ceiling is refused'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000005', 'checkout-key-late-0001', 9, null, null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'COLLECTION_WINDOW_CLOSED:%',
  'a collection past the end of its closing date (Lagos) takes no new payment (D-29)'
);

select throws_like(
  $$ select attempt_id from app.create_payment_attempt(
       'e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0029', pg_temp.ref(29), 'fake', null,
       'Test Payer', 'payer@example.test', '  ', '{}'::jsonb, '{}'::text[], null, 1000000,
       1000000, 5000, 15000, 0, 20000, 1000000, 980000, 10000, 'community_absorbs', '2026-11-founder') $$,
  'CONTACT_REQUIRED:%',
  'a payment without a phone number is refused — name, email and phone are all required'
);

select throws_like(
  $$ select attempt_id from app.create_payment_attempt(
       'e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0030', pg_temp.ref(30), 'fake', null,
       'Test Payer', null, '+2348000000000', '{}'::jsonb, '{}'::text[], null, 1000000,
       1000000, 5000, 15000, 0, 20000, 1000000, 980000, 10000, 'community_absorbs', '2026-11-founder') $$,
  'CONTACT_REQUIRED:%',
  'and so is one without an email address — the receipt and the provider both need it'
);

-- F5: an active collection imported from the legacy system takes no money here.
insert into migration.import_runs (id, source_project, source_snapshot_label)
values ('e7000000-0000-4000-8000-000000000001', 'synthetic:payments-test', 'payments-test');
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by,
   is_imported, source_system, source_table, source_id, imported_at, import_run_id)
values
  ('e4000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-00000000000a', 'legacy-levy', 'Legacy Levy',
   'dues', 'open', 'fixed', 500000, 'active', 'public', 'community_absorbs', 'e1000000-0000-4000-8000-000000000001',
   true, 'kolekto-v1', 'collections', 'e7000000-0000-4000-8000-000000000002', now(), 'e7000000-0000-4000-8000-000000000001');

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000007', 'checkout-key-legacy-001', 28, null, null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'COLLECTION_IMPORTED:%',
  'a collection imported from the previous system takes no payment in the new one (F5)'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0010', 10, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000002","quantity":1}]', 1000000,
                            1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') $$,
  'LINES_NOT_EXPECTED:%',
  'lines sent to an open-amount collection are refused, not ignored'
);


-- ── Tiers, by id, with stock ────────────────────────────────────────────────

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0001', 11, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000003","quantity":1}]', null,
                            100000, 500, 1500, 2000, 102000, 100000, 1000, 'contributor_pays') $$,
  'TIER_NOT_AVAILABLE:%',
  'a hidden tier cannot be bought'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0002', 12, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000004","quantity":1}]', null,
                            50000, 250, 750, 1000, 51000, 50000, 500, 'contributor_pays') $$,
  'TIER_NOT_AVAILABLE:%',
  'another collection''s tier id cannot be bought here'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0003', 13, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000001","quantity":3}]', null,
                            1500000, 7500, 22500, 30000, 1530000, 1500000, 15000, 'contributor_pays') $$,
  'PER_ORDER_LIMIT:%',
  'the per-order limit is enforced'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0004', 14, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000002","quantity":2.5}]', null,
                            750000, 3750, 11250, 15000, 765000, 750000, 7500, 'contributor_pays') $$,
  'QUANTITY_INVALID:%',
  'a fractional quantity is refused, not rounded'
);

-- 2 × VIP at ₦5,000, contributor pays: ₦10,000 + ₦200 fees.
create temporary table tmp_t1 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0005', 15, null,
                         '[{"tier_id":"e5000000-0000-4000-8000-000000000001","quantity":2}]', null,
                         1000000, 5000, 15000, 20000, 1020000, 1000000, 10000, 'contributor_pays') as id;

select is(
  (select amount_kobo::bigint from public.payment_attempts where id = (select id from tmp_t1)),
  1020000::bigint,
  'contributor pays: the total charged is the tier prices plus the fees'
);

select is(
  (select sum(quantity)::integer from public.stock_reservations
   where attempt_id = (select id from tmp_t1) and status = 'reserved'),
  2,
  'both VIP places are reserved for the checkout'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0006', 16, null,
                            '[{"tier_id":"e5000000-0000-4000-8000-000000000001","quantity":1}]', null,
                            500000, 2500, 7500, 10000, 510000, 500000, 5000, 'contributor_pays') $$,
  'SOLD_OUT:%',
  'a third VIP cannot be started while two are held'
);


-- ── Managed dues ────────────────────────────────────────────────────────────

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000003', 'checkout-key-dues-0001', 17, null, null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'MEMBER_REQUIRED:%',
  'a managed collection needs an identified member'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000003', 'checkout-key-dues-0002', 18,
                            'e3000000-0000-4000-8000-000000000003', null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'MEMBER_NOT_ELIGIBLE:%',
  'a member of another community cannot pay this community''s dues'
);

create temporary table tmp_d1 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000003', 'checkout-key-dues-0003', 19,
                         'e3000000-0000-4000-8000-000000000001', null, null,
                         500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') as id;

select is(
  (select obligation_id from public.payment_attempts where id = (select id from tmp_d1)),
  'e6000000-0000-4000-8000-000000000001'::uuid,
  'the database, not the caller, binds the attempt to the member''s obligation'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000003', 'checkout-key-dues-0004', 20,
                            'e3000000-0000-4000-8000-000000000001', null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'PAYMENT_IN_PROGRESS:%',
  'a second tab cannot start paying the same obligation'
);


-- ── The attempt is frozen and moves only forwards ───────────────────────────

select is(
  app.mark_payment_attempt_initialized((select id from tmp_a1), 'FAKE_ACC_1'),
  'initialized'::public.payment_attempt_status,
  'created → initialized when the checkout is issued'
);

select throws_like(
  $$ update public.payment_attempts set status = 'completed' where id = (select id from tmp_a1) $$,
  'PAYMENT_ATTEMPT_TRANSITION_REFUSED:%',
  'initialized → completed is not a transition (capture is the only way to money)'
);

select throws_like(
  $$ update public.payment_attempts set amount_kobo = 1 where id = (select id from tmp_a1) $$,
  'PAYMENT_ATTEMPT_IS_FROZEN:%',
  'the amount on an attempt never changes (D-16)'
);

select throws_like(
  $$ delete from public.payment_attempts where id = (select id from tmp_a1) $$,
  'PAYMENT_RECORD_IS_IMMUTABLE:%',
  'an attempt is never deleted'
);

select throws_like(
  $$ select pg_temp.provider_says(424242, 'succeeded', 1000000, 'NGN', 10000) $$,
  'UNKNOWN_PAYMENT_REFERENCE:%',
  'a provider statement for a reference Kolekto never issued creates nothing'
);


-- ── Capture, exactly once ───────────────────────────────────────────────────

select is(
  pg_temp.provider_says(1, 'succeeded', 1000000, 'NGN', 10000),
  'captured'::public.payment_attempt_status,
  'a matching success captures the attempt'
);

select is(
  pg_temp.provider_says(1, 'succeeded', 1000000, 'NGN', 10000),
  'captured'::public.payment_attempt_status,
  'the same statement again changes nothing'
);

select is(
  (select count(*)::integer from public.provider_transactions where attempt_id = (select id from tmp_a1)),
  1,
  'and is stored once (content-hash dedupe)'
);

create temporary table tmp_c1 as
  select contribution_id as id from app.complete_payment_capture((select id from tmp_a1));

select isnt((select id from tmp_c1), null, 'completing the capture produces a contribution');

select is(
  (select contribution_id from app.complete_payment_capture((select id from tmp_a1))),
  (select id from tmp_c1),
  'completing it again returns the same contribution'
);

select is(
  (select count(*)::integer from public.contributions where attempt_id = (select id from tmp_a1)),
  1,
  'exactly one contribution exists for the attempt'
);

select bag_eq(
  $$ select idempotency_key from public.ledger_journals where source_id = (select id from tmp_c1) $$,
  $$ values ('capture:' || (select id from tmp_a1)), ('fee:' || (select id from tmp_a1)),
            ('provider_fee:' || (select id from tmp_a1)) $$,
  'capture, fee and provider-fee journals are posted once each, keyed by the attempt'
);

select lives_ok(
  $$ set constraints all immediate $$,
  'every journal balances (deferred balance triggers fired now)'
);
-- Deliberately left IMMEDIATE for the rest of this file: every later capture
-- must post a journal and its entries in one statement to pass.

select is(
  (select balance_kobo::bigint from public.v_ledger_account_balances
   where collection_id = 'e4000000-0000-4000-8000-000000000001' and code = 'collection_pending'),
  980000::bigint,
  'host absorbs: the collection holds the contribution less the shown fees'
);

select is(
  (select sum(case when e.direction = 'debit' then e.amount_kobo else -e.amount_kobo end)::bigint
   from public.ledger_entries e
   join public.ledger_journals j on j.id = e.journal_id
   join public.ledger_accounts a on a.id = e.account_id
   where j.source_id = (select id from tmp_c1) and a.code = 'provider_receivable'),
  990000::bigint,
  'the provider owes Kolekto what it charged less its reported fee'
);

select is(
  (select provider_fee_basis || ':' || provider_fee_kobo from public.contributions where id = (select id from tmp_c1)),
  'reported:10000',
  'the provider''s reported fee is the one posted (D-11)'
);

select is(
  pg_temp.provider_says(1, 'failed', 1000000, 'NGN', null),
  'completed'::public.payment_attempt_status,
  'a late failure never overwrites a completed payment'
);


-- ── Mismatches are recorded and parked, never accepted ─────────────────────

create temporary table tmp_a2 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0021', 21, null, null, 1000000,
                         1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') as id;

select is(
  pg_temp.provider_says(21, 'succeeded', 1000100, 'NGN', 10000),
  'needs_review'::public.payment_attempt_status,
  'a success for a different amount goes to needs_review'
);

select is(
  (select review_reason from public.payment_attempts where id = (select id from tmp_a2)),
  'amount_mismatch',
  'with the reason recorded'
);

select is(
  (select contribution_id from app.complete_payment_capture((select id from tmp_a2))),
  null,
  'and no contribution is created for it'
);

create temporary table tmp_a3 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0022', 22, null, null, 1000000,
                         1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') as id;

select is(
  pg_temp.provider_says(22, 'succeeded', 1000000, 'USD', 10000),
  'needs_review'::public.payment_attempt_status,
  'a success in another currency is parked, never converted (PA-15)'
);

select throws_like(
  $$ update public.payment_attempts set status = 'captured' where id = (select id from tmp_a3) $$,
  'PAYMENT_ATTEMPT_TRANSITION_REFUSED:%',
  'needs_review is left only by an operator path, not by an update'
);


-- ── A released hold frees stock; a late capture that finds it gone is parked ─

select is(
  pg_temp.provider_says(15, 'abandoned', 1020000, 'NGN', null),
  'failed'::public.payment_attempt_status,
  'an abandoned checkout fails the attempt'
);

select is(
  (select count(*)::integer from public.stock_reservations
   where attempt_id = (select id from tmp_t1) and status = 'released'),
  1,
  'and releases its stock'
);

create temporary table tmp_t2 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000002', 'checkout-key-tier-0023', 23, null,
                         '[{"tier_id":"e5000000-0000-4000-8000-000000000001","quantity":2}]', null,
                         1000000, 5000, 15000, 20000, 1020000, 1000000, 10000, 'contributor_pays') as id;

select isnt((select id from tmp_t2), null, 'the released places can be bought by someone else');

select is(
  pg_temp.provider_says(15, 'succeeded', 1020000, 'NGN', 10200),
  'captured'::public.payment_attempt_status,
  'a late success on a failed attempt is still captured — money is never refused'
);

select is(
  (select review_reason from app.complete_payment_capture((select id from tmp_t1))),
  'stock_exhausted',
  'but its places are gone, so it is parked for the host to decide'
);

select is(
  pg_temp.provider_says(23, 'succeeded', 1020000, 'NGN', 10200),
  'captured'::public.payment_attempt_status,
  'the second buyer''s payment captures'
);

select is(
  (select status::text from app.complete_payment_capture((select id from tmp_t2))),
  'completed',
  'and completes, converting its reservation'
);

select is(
  (select balance_kobo::bigint from public.v_ledger_account_balances
   where collection_id = 'e4000000-0000-4000-8000-000000000002' and code = 'collection_pending'),
  1000000::bigint,
  'contributor pays: the collection holds the full tier prices'
);

select is(
  (select count(*)::integer from public.contribution_lines cl
   join public.contributions c on c.id = cl.contribution_id
   where c.attempt_id = (select id from tmp_t2)
     and cl.tier_id = 'e5000000-0000-4000-8000-000000000001' and cl.quantity = 2),
  1,
  'the contribution records the tier by id and the quantity bought'
);


-- ── Obligations: paid only with the money to show for it ───────────────────

select throws_like(
  $$ update public.obligations set status = 'paid' where id = 'e6000000-0000-4000-8000-000000000002' $$,
  'NO_MANUAL_PAID:%',
  'an obligation with no contribution cannot be marked paid'
);

select is(
  pg_temp.provider_says(19, 'succeeded', 500000, 'NGN', null),
  'captured'::public.payment_attempt_status,
  'the dues payment captures'
);

select is(
  (select status::text from app.complete_payment_capture((select id from tmp_d1))),
  'completed',
  'and completes'
);

select is(
  (select status::text from public.obligations where id = 'e6000000-0000-4000-8000-000000000001'),
  'paid',
  'and the member''s obligation is now paid'
);

select is(
  (select provider_fee_basis || ':' || provider_fee_kobo from public.contributions where attempt_id = (select id from tmp_d1)),
  'estimated:5000',
  'with no reported fee, the schedule''s estimate is posted and labelled as such'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000003', 'checkout-key-dues-0024', 24,
                            'e3000000-0000-4000-8000-000000000001', null, null,
                            500000, 2500, 7500, 10000, 500000, 490000, 5000, 'community_absorbs') $$,
  'ALREADY_PAID:%',
  'a paid obligation cannot be paid again'
);


-- ── D-30: a fundraiser closes when a capture reaches its target ────────────

create temporary table tmp_f1 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000004', 'checkout-key-fund-0001', 25, null, null, 1000000,
                         1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') as id;

select is(
  pg_temp.provider_says(25, 'succeeded', 1000000, 'NGN', 10000),
  'captured'::public.payment_attempt_status,
  'the donation that reaches the target captures'
);

select is(
  (select status::text from app.complete_payment_capture((select id from tmp_f1))),
  'completed',
  'and completes in full — nothing is trimmed'
);

select is(
  (select status::text from public.collections where id = 'e4000000-0000-4000-8000-000000000004'),
  'closed',
  'and closes the fundraiser in the same transaction'
);

select throws_like(
  $$ select pg_temp.attempt('e4000000-0000-4000-8000-000000000004', 'checkout-key-fund-0002', 26, null, null, 100000,
                            100000, 500, 1500, 2000, 100000, 98000, 1000, 'community_absorbs') $$,
  'COLLECTION_NOT_ACTIVE:%',
  'new checkouts are refused once it has closed'
);


-- ── Expiry waits for the hold ───────────────────────────────────────────────

create temporary table tmp_a4 as
  select pg_temp.attempt('e4000000-0000-4000-8000-000000000001', 'checkout-key-open-0027', 27, null, null, 1000000,
                         1000000, 5000, 15000, 20000, 1000000, 980000, 10000, 'community_absorbs') as id;

select throws_like(
  $$ select app.expire_payment_attempt((select id from tmp_a4)) $$,
  'PAYMENT_ATTEMPT_STILL_HELD:%',
  'an attempt cannot be expired while its checkout hold is still running'
);

select is(
  app.mark_payment_attempt_failed((select id from tmp_a1), 'should_not_apply'),
  'completed'::public.payment_attempt_status,
  'marking a completed attempt failed changes nothing — money-known states never go back'
);


-- ── Who can see what ────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select count(*)::integer from public.payment_attempts where community_id = 'e2000000-0000-4000-8000-00000000000a'),
  8,
  'an owner sees the attempts on their own collections'
);

select throws_ok(
  $$ select count(*) from public.provider_transactions $$,
  '42501', null,
  'nobody reads provider payloads through a client role — they carry contributor PII'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::integer from public.payment_attempts) + (select count(*)::integer from public.contribution_intents)
    + (select count(*)::integer from public.contributions),
  0,
  'another community''s owner sees none of them'
);

reset role;
set local role anon;
select throws_ok(
  $$ select count(*) from public.payment_attempts $$,
  '42501', null,
  'anon cannot read payment attempts at all'
);
reset role;

select * from finish();
rollback;
