-- ─────────────────────────────────────────────────────────────────────────────
-- 53 — A member who pays before being assigned stays paid (20261114100000)
--
-- The scenario: on an all_members / groups collection, a member with no
-- obligation pays. Later the organiser runs "Add members". The roll must show
-- that member as paid, not as a fresh unpaid obligation.
--
--   · capture creates the member's obligation for the amount paid, links the
--     contribution to it, and moves it to paid through block_manual_paid_status
--   · a later sync leaves it alone; other members are assigned as before
--   · a second in-flight payment from the same member is parked (already_paid)
--   · an obligation assigned while the member was at checkout is linked and
--     paid if unchanged, parked (obligation_changed) if not
--   · groups audiences get the same treatment; selected_members does not —
--     an unlisted member still cannot pay, and a capture that finds the
--     collection switched to selected_members creates nothing
--   · open-amount collections create nothing
--   · no obligation can be INSERTED as paid (CASH-02 / SEC-20a)
--
-- Runs as the database owner (session role `none`), like 52_payments.sql.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(34);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5310000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@lazy.example.test');

insert into public.users (id, full_name, email) values
  ('a5310000-0000-4000-8000-000000000001', 'Lazy Owner', 'owner@lazy.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5320000-0000-4000-8000-00000000000a', 'lazy-tests', 'Lazy Tests', 'social_group', false, 'a5310000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a5320000-0000-4000-8000-00000000000a', 'a5310000-0000-4000-8000-000000000001', 'owner', 'Lazy Owner', 'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('a5330000-0000-4000-8000-000000000001', 'a5320000-0000-4000-8000-00000000000a', 'Ada Early',  '+2348097775301', 'LZ/0001', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000002', 'a5320000-0000-4000-8000-00000000000a', 'Bola Later', '+2348097775302', 'LZ/0002', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000003', 'a5320000-0000-4000-8000-00000000000a', 'Chi Twice',  '+2348097775303', 'LZ/0003', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000004', 'a5320000-0000-4000-8000-00000000000a', 'Dayo Race',  '+2348097775304', 'LZ/0004', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000005', 'a5320000-0000-4000-8000-00000000000a', 'Ebi Waived', '+2348097775305', 'LZ/0005', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000006', 'a5320000-0000-4000-8000-00000000000a', 'Femi Group', '+2348097775306', 'LZ/0006', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000008', 'a5320000-0000-4000-8000-00000000000a', 'Hadi Unlisted', '+2348097775308', 'LZ/0008', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000009', 'a5320000-0000-4000-8000-00000000000a', 'Ife Switched', '+2348097775309', 'LZ/0009', 'active', 'manual'),
  ('a5330000-0000-4000-8000-000000000010', 'a5320000-0000-4000-8000-00000000000a', 'Jide Open',  '+2348097775310', 'LZ/0010', 'active', 'manual');

insert into public.member_groups (id, community_id, name, sort_order) values
  ('a5340000-0000-4000-8000-000000000001', 'a5320000-0000-4000-8000-00000000000a', 'Choir', 0);

insert into public.member_group_memberships (member_id, group_id) values
  ('a5330000-0000-4000-8000-000000000006', 'a5340000-0000-4000-8000-000000000001');

-- All managed, ₦5,000 fixed, host absorbs, one-time, unless stated.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, deadline_at, status, visibility, fee_mode, created_by)
values
  ('a5350000-0000-4000-8000-000000000001', 'a5320000-0000-4000-8000-00000000000a', 'all-dues',      'All Dues',
   'dues', 'managed', 'all_members', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001'),
  ('a5350000-0000-4000-8000-000000000002', 'a5320000-0000-4000-8000-00000000000a', 'race-dues',     'Race Dues',
   'dues', 'managed', 'all_members', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001'),
  ('a5350000-0000-4000-8000-000000000003', 'a5320000-0000-4000-8000-00000000000a', 'choir-dues',    'Choir Dues',
   'dues', 'managed', 'groups',      'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001'),
  ('a5350000-0000-4000-8000-000000000004', 'a5320000-0000-4000-8000-00000000000a', 'picked-dues',   'Picked Dues',
   'dues', 'managed', 'selected_members', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001'),
  ('a5350000-0000-4000-8000-000000000005', 'a5320000-0000-4000-8000-00000000000a', 'switched-dues', 'Switched Dues',
   'dues', 'managed', 'all_members', 'fixed', 500000, null, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001'),
  -- open amount, min ₦100
  ('a5350000-0000-4000-8000-000000000006', 'a5320000-0000-4000-8000-00000000000a', 'open-levy',     'Open Levy',
   'contribution', 'managed', 'all_members', 'open_amount', null, 10000, null, 'active', 'unlisted', 'community_absorbs', 'a5310000-0000-4000-8000-000000000001');

insert into public.collection_audience_groups (collection_id, group_id, community_id) values
  ('a5350000-0000-4000-8000-000000000003', 'a5340000-0000-4000-8000-000000000001', 'a5320000-0000-4000-8000-00000000000a');

-- Picked Dues names Ada only.
insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo) values
  ('a5360000-0000-4000-8000-000000000001', 'a5320000-0000-4000-8000-00000000000a', 'a5350000-0000-4000-8000-000000000004', 'a5330000-0000-4000-8000-000000000001', 500000);

create function pg_temp.ref(n integer) returns text language sql as $$
  select 'KLK-' || lpad(n::text, 26, '0')
$$;

-- A ₦5,000 attempt for a member, host absorbs: 0.5% + 1.5% = ₦100; estimate 1% = ₦50.
create function pg_temp.dues(p_collection uuid, p_ref integer, p_member uuid) returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, 'checkout-key-lazy-' || p_ref, pg_temp.ref(p_ref), 'fake', p_member,
    'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000,
    'community_absorbs', '2026-11-founder')
$$;

-- The provider says it succeeded (T1), then T2. Returns "status" or "status:reason".
create function pg_temp.capture(p_ref integer, p_amount bigint, p_attempt uuid) returns text language plpgsql as $$
declare
  v_result text;
begin
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    p_amount, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
  select c.status::text || coalesce(':' || c.review_reason, '') into v_result
  from app.complete_payment_capture(p_attempt) c;
  return v_result;
end;
$$;

create function pg_temp.obligation_of(p_collection uuid, p_member uuid) returns public.obligations language sql as $$
  select * from public.obligations where collection_id = p_collection and member_id = p_member and cycle_key is null
$$;

create temporary table tmp_att (label text primary key, id uuid);
insert into tmp_att values
  ('ada',   pg_temp.dues('a5350000-0000-4000-8000-000000000001', 5301, 'a5330000-0000-4000-8000-000000000001')),
  ('chi1',  pg_temp.dues('a5350000-0000-4000-8000-000000000001', 5302, 'a5330000-0000-4000-8000-000000000003')),
  ('chi2',  pg_temp.dues('a5350000-0000-4000-8000-000000000001', 5303, 'a5330000-0000-4000-8000-000000000003')),
  ('dayo',  pg_temp.dues('a5350000-0000-4000-8000-000000000002', 5304, 'a5330000-0000-4000-8000-000000000004')),
  ('ebi',   pg_temp.dues('a5350000-0000-4000-8000-000000000002', 5305, 'a5330000-0000-4000-8000-000000000005')),
  ('femi',  pg_temp.dues('a5350000-0000-4000-8000-000000000003', 5306, 'a5330000-0000-4000-8000-000000000006')),
  ('ife',   pg_temp.dues('a5350000-0000-4000-8000-000000000005', 5309, 'a5330000-0000-4000-8000-000000000009'));

-- ₦1,000 open-amount attempt, host absorbs: fees ₦20, estimate ₦10.
insert into tmp_att values
  ('jide', (select attempt_id from app.create_payment_attempt(
     'a5350000-0000-4000-8000-000000000006', 'checkout-key-lazy-5310', pg_temp.ref(5310), 'fake',
     'a5330000-0000-4000-8000-000000000010',
     'Test Payer', 'payer@example.test', '+2348000000000', '{}'::jsonb, '{}'::text[],
     null, 100000, 100000, 500, 1500, 0, 2000, 100000, 98000, 1000,
     'community_absorbs', '2026-11-founder')));

create function pg_temp.att(p_label text) returns uuid language sql as $$
  select id from tmp_att where label = p_label
$$;


-- ── A member with no obligation pays; the roll remembers ────────────────────

select is(
  (select count(*)::integer from public.payment_attempts
   where id in (select id from tmp_att) and obligation_id is null),
  8,
  'every fixture attempt starts with no obligation — these members were never assigned'
);

select is(pg_temp.capture(5301, 500000, pg_temp.att('ada')), 'completed', 'Ada''s payment completes');

select is(
  (select status::text || ':' || expected_amount_kobo || ':' || waived_amount_kobo
   from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000001')),
  'paid:500000:0',
  'capture created Ada''s obligation for exactly what she paid, and it is paid'
);

select is(
  (select obligation_id from public.contributions where attempt_id = pg_temp.att('ada')),
  (select id from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000001')),
  'the contribution was written already pointing at that obligation'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'obligation.assign_on_payment' and actor_type = 'system'
     and object_id = (select id from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000001'))),
  1,
  'the creation is audited under its own action'
);

select is(
  (select assigned_by from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000001')),
  null::uuid,
  'no officer is named as having assigned it'
);

select is(
  (select status::text from app.complete_payment_capture(pg_temp.att('ada'))),
  'completed',
  'running T2 again returns the same completion'
);

select is(
  (select count(*)::integer from public.obligations
   where collection_id = 'a5350000-0000-4000-8000-000000000001' and member_id = 'a5330000-0000-4000-8000-000000000001'),
  1,
  'and creates nothing more'
);

select throws_like(
  $$ select pg_temp.dues('a5350000-0000-4000-8000-000000000001', 5311, 'a5330000-0000-4000-8000-000000000001') $$,
  'ALREADY_PAID:%',
  'Ada cannot start paying again — the obligation now says paid'
);


-- ── Two payments in flight from the same member ─────────────────────────────

select is(pg_temp.capture(5302, 500000, pg_temp.att('chi1')), 'completed', 'Chi''s first payment completes');

select is(
  pg_temp.capture(5303, 500000, pg_temp.att('chi2')),
  'needs_review:already_paid',
  'Chi''s second, started before the first captured, is parked as already_paid'
);

select is(
  (select count(*)::integer from public.contributions where attempt_id = pg_temp.att('chi2')),
  0,
  'and writes no contribution'
);

select is(
  (select count(*)::integer from public.obligations
   where collection_id = 'a5350000-0000-4000-8000-000000000001' and member_id = 'a5330000-0000-4000-8000-000000000003'),
  1,
  'Chi has exactly one obligation'
);


-- ── "Add members" afterwards ────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5310000-0000-4000-8000-000000000001","role":"authenticated"}';

select ok(
  app.sync_collection_obligations('a5350000-0000-4000-8000-000000000001') > 0,
  'the organiser syncs the audience'
);

reset role;

select is(
  (select status::text from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000001')),
  'paid',
  'Ada still reads paid after the sync — the gap this migration closes'
);

select is(
  (select count(*)::integer from public.obligations
   where collection_id = 'a5350000-0000-4000-8000-000000000001' and member_id = 'a5330000-0000-4000-8000-000000000001'),
  1,
  'the sync did not add a second, unpaid obligation for her'
);

select is(
  (select status::text from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000001', 'a5330000-0000-4000-8000-000000000002')),
  'unpaid',
  'Bola, who has not paid, is assigned as before'
);

select throws_like(
  $$ update public.obligations set status = 'paid'
     where collection_id = 'a5350000-0000-4000-8000-000000000001' and member_id = 'a5330000-0000-4000-8000-000000000002' $$,
  'NO_MANUAL_PAID:%',
  'and Bola''s obligation still cannot be marked paid by hand'
);


-- ── Assigned while the member was at checkout ───────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5310000-0000-4000-8000-000000000001","role":"authenticated"}';

select ok(
  app.sync_collection_obligations('a5350000-0000-4000-8000-000000000002') >= 2,
  'the organiser syncs Race Dues while Dayo and Ebi are at checkout'
);

reset role;

update public.obligations
set waived_amount_kobo = 100000, waived_reason = 'hardship', waived_by = 'a5310000-0000-4000-8000-000000000001', waived_at = now()
where collection_id = 'a5350000-0000-4000-8000-000000000002' and member_id = 'a5330000-0000-4000-8000-000000000005';

create temporary table tmp_dayo_obligation as
  select id from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000002', 'a5330000-0000-4000-8000-000000000004');

select is(pg_temp.capture(5304, 500000, pg_temp.att('dayo')), 'completed', 'Dayo''s payment completes');

select is(
  (select obligation_id from public.contributions where attempt_id = pg_temp.att('dayo')),
  (select id from tmp_dayo_obligation),
  'it is linked to the obligation the sync assigned, not a new one'
);

select is(
  (select status::text from public.obligations where id = (select id from tmp_dayo_obligation)),
  'paid',
  'which is now paid'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'obligation.assign_on_payment' and object_id = (select id from tmp_dayo_obligation)),
  0,
  'and is not recorded as created on payment — the organiser assigned it'
);

select is(
  pg_temp.capture(5305, 500000, pg_temp.att('ebi')),
  'needs_review:obligation_changed',
  'Ebi''s obligation was waived to ₦4,000 meanwhile, so her ₦5,000 is parked for the host'
);

select is(
  (select status::text from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000002', 'a5330000-0000-4000-8000-000000000005')),
  'unpaid',
  'and her obligation is untouched'
);


-- ── Groups: same rule ───────────────────────────────────────────────────────

select is(pg_temp.capture(5306, 500000, pg_temp.att('femi')), 'completed', 'Femi pays Choir Dues');

select is(
  (select status::text from pg_temp.obligation_of('a5350000-0000-4000-8000-000000000003', 'a5330000-0000-4000-8000-000000000006')),
  'paid',
  'a groups audience gets the obligation on capture too'
);


-- ── selected_members: unchanged ─────────────────────────────────────────────

select throws_like(
  $$ select pg_temp.dues('a5350000-0000-4000-8000-000000000004', 5308, 'a5330000-0000-4000-8000-000000000008') $$,
  'MEMBER_NOT_ELIGIBLE:%',
  'a member not on a hand-picked list still cannot pay'
);

update public.collections set audience_mode = 'selected_members' where id = 'a5350000-0000-4000-8000-000000000005';

select is(
  pg_temp.capture(5309, 500000, pg_temp.att('ife')),
  'completed',
  'a payment in flight when the collection became hand-picked is still recorded'
);

select is(
  (select count(*)::integer from public.obligations where collection_id = 'a5350000-0000-4000-8000-000000000005'),
  0,
  'but capture does not add Ife to a hand-picked list — naming members stays a human act'
);

select is(
  (select obligation_id from public.contributions where attempt_id = pg_temp.att('ife')),
  null::uuid,
  'the contribution is recorded without an obligation, as before'
);


-- ── Open amount: no single amount owed, so no obligation ────────────────────

select is(pg_temp.capture(5310, 100000, pg_temp.att('jide')), 'completed', 'Jide''s open-amount payment completes');

select is(
  (select count(*)::integer from public.obligations where collection_id = 'a5350000-0000-4000-8000-000000000006'),
  0,
  'and creates no obligation'
);


-- ── CASH-02 / SEC-20a on INSERT ─────────────────────────────────────────────

select throws_like(
  $$ insert into public.obligations (community_id, collection_id, member_id, expected_amount_kobo, status)
     values ('a5320000-0000-4000-8000-00000000000a', 'a5350000-0000-4000-8000-000000000006',
             'a5330000-0000-4000-8000-000000000002', 500000, 'paid') $$,
  'NO_MANUAL_PAID:%',
  'an obligation cannot be inserted already paid'
);

select * from finish();
rollback;
