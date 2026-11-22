-- ─────────────────────────────────────────────────────────────────────────────
-- 61 — Who is expected to pay and what is still owed (20261117120000), and
--      the ledger filtered by kind (20261117120100)
--
--   · obligations expect expected − waived; exempt and cancelled are not counted
--   · received is applied contributions on the obligation, capped at what it expects
--   · audience members with no obligation are not paid and expect the fixed amount
--   · a non-fixed amount model with such members reports outstanding as incomplete
--   · open-link and recurring collections are reported as unsupported
--   · transaction.view required; another community's officer and anon get nothing
--   · collection_ledger_by_kind filters before paging, refuses unknown kinds and outsiders
--   · reading changes no money figure
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(17);

insert into auth.users (id, instance_id, aud, role, email) values
  ('a6110000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@expect.example.test'),
  ('a6110000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@expect.example.test'),
  ('a6110000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@expect.example.test');
insert into public.users (id, full_name, email) values
  ('a6110000-0000-4000-8000-000000000001', 'Expect Owner',  'owner@expect.example.test'),
  ('a6110000-0000-4000-8000-000000000002', 'Expect Viewer', 'viewer@expect.example.test'),
  ('a6110000-0000-4000-8000-000000000003', 'Other Owner',   'outsider@expect.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6120000-0000-4000-8000-00000000000a', 'expect-tests', 'Expect Tests', 'social_group', false, 'a6110000-0000-4000-8000-000000000001'),
  ('a6120000-0000-4000-8000-00000000000b', 'expect-other', 'Expect Other', 'social_group', false, 'a6110000-0000-4000-8000-000000000003');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6120000-0000-4000-8000-00000000000a', 'a6110000-0000-4000-8000-000000000001', 'owner',  'Expect Owner',  'created', null),
  ('a6120000-0000-4000-8000-00000000000a', 'a6110000-0000-4000-8000-000000000002', 'viewer', 'Expect Viewer', 'invited', null),
  ('a6120000-0000-4000-8000-00000000000b', 'a6110000-0000-4000-8000-000000000003', 'owner',  'Other Owner',   'created', null);

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a6150000-0000-4000-8000-000000000001', 'a6120000-0000-4000-8000-00000000000a', 'levy', 'Levy',
   'dues', 'managed', 'all_members', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6110000-0000-4000-8000-000000000001'),
  ('a6150000-0000-4000-8000-000000000002', 'a6120000-0000-4000-8000-00000000000a', 'open-link', 'Open Link',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6110000-0000-4000-8000-000000000001');

insert into public.members (id, community_id, full_name, email, phone_e164, member_code, status, joined_via) values
  ('a6130000-0000-4000-8000-000000000001', 'a6120000-0000-4000-8000-00000000000a', 'Ade Paid',    'ade@expect.example.test',  '+2348000006101', 'E1', 'active', 'manual'),
  ('a6130000-0000-4000-8000-000000000002', 'a6120000-0000-4000-8000-00000000000a', 'Bisi Owes',   'bisi@expect.example.test', '+2348000006102', 'E2', 'active', 'manual'),
  ('a6130000-0000-4000-8000-000000000003', 'a6120000-0000-4000-8000-00000000000a', 'Chidi Exempt', null,                      '+2348000006103', 'E3', 'active', 'manual'),
  ('a6130000-0000-4000-8000-000000000004', 'a6120000-0000-4000-8000-00000000000a', 'Dayo New',     null,                      '+2348000006104', 'E4', 'active', 'manual'),
  ('a6130000-0000-4000-8000-000000000005', 'a6120000-0000-4000-8000-00000000000a', 'Efe Waived',   null,                      '+2348000006105', 'E5', 'active', 'manual');

-- Bisi owes the full amount; Chidi is exempt; Efe has ₦1,000 waived.
-- Dayo has no obligation yet (newly eligible). Ade's is created on capture.
insert into public.obligations (collection_id, community_id, member_id, expected_amount_kobo, waived_amount_kobo,
                                waived_reason, waived_by, waived_at, exempt, exempt_reason, exempt_at, status)
values
  ('a6150000-0000-4000-8000-000000000001', 'a6120000-0000-4000-8000-00000000000a', 'a6130000-0000-4000-8000-000000000002',
   500000, 0, null, null, null, false, null, null, 'unpaid'),
  ('a6150000-0000-4000-8000-000000000001', 'a6120000-0000-4000-8000-00000000000a', 'a6130000-0000-4000-8000-000000000003',
   500000, 0, null, null, null, true, 'Founding member', now(), 'exempt'),
  ('a6150000-0000-4000-8000-000000000001', 'a6120000-0000-4000-8000-00000000000a', 'a6130000-0000-4000-8000-000000000005',
   500000, 100000, 'Hardship', 'a6110000-0000-4000-8000-000000000001', now(), false, null, null, 'unpaid');

create function pg_temp.pay(p_member uuid, p_ref integer, p_kobo bigint default 500000) returns void language plpgsql as $$
declare
  v_attempt uuid;
  v_ref text := 'KLK-' || lpad(p_ref::text, 26, '0');
  v_platform bigint := p_kobo * 50 / 10000;
  v_gateway  bigint := p_kobo * 150 / 10000;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a6150000-0000-4000-8000-000000000001', 'checkout-key-expect-' || p_ref, v_ref, 'fake', p_member,
    'Payer ' || p_ref, 'payer' || p_ref || '@expect.example.test', '+2348000000061', '{}'::jsonb, '{}'::text[],
    null, null, p_kobo, v_platform, v_gateway, 0, v_platform + v_gateway, p_kobo, p_kobo - v_platform - v_gateway,
    p_kobo / 100, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    v_ref, 'fake', 'FAKE_TXN_' || p_ref, v_ref, 'succeeded', 'succeeded',
    p_kobo, 'NGN', null, now(), 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
end;
$$;
select pg_temp.pay('a6130000-0000-4000-8000-000000000001', 6101) is not null;



-- ── The organiser's view ───────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select supported || ':' || expected_count || ':' || paid_count || ':' || partly_paid_count || ':' || unpaid_count || ':' || exempt_count
   from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  'true:4:1:0:3:1',
  'four expected (Ade, Bisi, Efe, Dayo), one paid, three not paid, one exempt');

select is(
  (select expected_kobo || ':' || received_kobo || ':' || outstanding_kobo || ':' || outstanding_complete
   from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  '1900000:500000:1400000:true',
  'expected ₦19,000 (5,000 + 5,000 + 4,000 waived-down + 5,000 newly eligible), received ₦5,000, ₦14,000 outstanding');

select is(
  (select received_kobo from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  (select total_raised_kobo::bigint from app.collection_financial_overview('a6150000-0000-4000-8000-000000000001')),
  'received against expectations equals Total raised when every payment names an obligation');

select is(
  (select supported || ':' || unsupported_reason from app.collection_expected_summary('a6150000-0000-4000-8000-000000000002')),
  'false:no_member_list', 'an open-link collection has no expected list');


-- ── A waived-down obligation is paid at what it expects ───────────────────

reset role;
-- Efe pays exactly what is expected after the waiver (the database refuses more).
select pg_temp.pay('a6130000-0000-4000-8000-000000000005', 6102, 400000) is not null;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select paid_count || ':' || unpaid_count || ':' || received_kobo || ':' || outstanding_kobo
   from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  '2:2:900000:1000000',
  'Efe is paid after the waiver; Bisi and Dayo still owe ₦10,000');


-- ── Non-fixed amounts: newly eligible members make the total a floor ────────

reset role;
update public.collections set amount_model = 'per_member', fixed_amount_kobo = null
 where id = 'a6150000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select outstanding_kobo || ':' || outstanding_complete
   from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  '500000:false',
  'without a fixed amount, Dayo''s amount is unknown: ₦5,000 is a floor and says so');

reset role;
update public.collections set schedule = 'recurring' where id = 'a6150000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select supported || ':' || unsupported_reason from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')),
  'false:recurring_collection', 'a recurring collection is reported as unsupported');
reset role;
update public.collections set schedule = 'one_time', amount_model = 'fixed', fixed_amount_kobo = 500000
 where id = 'a6150000-0000-4000-8000-000000000001';


-- ── Who may read ───────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select expected_count from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001')), 4,
  'a viewer (transaction.view) can read it');

set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001') $$,
  '42501', null, 'another community''s owner is refused');

reset role;
set local role anon;
select throws_ok($$ select * from app.collection_expected_summary('a6150000-0000-4000-8000-000000000001') $$,
  '42501', null, 'anon cannot execute it');
reset role;

select ok(not has_function_privilege('anon', 'app.collection_expected_summary(uuid)', 'execute'),
  'no execute grant to anon');




-- ── The ledger, filtered before paging (20261117120100) ────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select count(*)::integer || ':' || min(total_count)
   from app.collection_ledger_by_kind('a6150000-0000-4000-8000-000000000001', 'contributions', 50, 0)),
  '2:2', 'two payments, and the filtered total counts only payments');
select is(
  (select bool_and(source_type = 'fee')
   from app.collection_ledger_by_kind('a6150000-0000-4000-8000-000000000001', 'fees', 50, 0)),
  true, 'the fees filter returns fee journals only');
select is(
  (select min(total_count) from app.collection_ledger_by_kind('a6150000-0000-4000-8000-000000000001', 'all', 1, 0)),
  (select min(total_count) from app.collection_ledger('a6150000-0000-4000-8000-000000000001', 1, 0)),
  '"all" is the unfiltered ledger');
select throws_ok($$ select * from app.collection_ledger_by_kind('a6150000-0000-4000-8000-000000000001', 'everything', 50, 0) $$,
  '22023', null, 'an unknown filter is refused');
set local request.jwt.claims = '{"sub":"a6110000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$ select * from app.collection_ledger_by_kind('a6150000-0000-4000-8000-000000000001', 'all', 50, 0) $$,
  '42501', null, 'another community''s owner cannot read the ledger');
reset role;

-- ── Reading moved nothing ──────────────────────────────────────────────────

select is(
  (select count(*)::integer from public.v_ledger_imbalances), 0, 'the ledger still balances');

select * from finish();
rollback;
