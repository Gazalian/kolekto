-- ─────────────────────────────────────────────────────────────────────────────
-- 57 — T+1 settlement lifecycle, ledger activity and reconciliation
--      (20261117100000 / 100100 / 100300)
--
--   · D-09 vectors: 05:00 Africa/Lagos on the following calendar day
--   · capture schedules exactly one settlement row with net + expected amounts
--   · nothing is released before it is due AND the provider confirmed it
--   · provider confirmation: idempotent; mismatch → discrepancy (held, audited);
--     a different second statement → conflict, nothing changes
--   · release posts one balanced balance_release journal, once
--   · settlement facts are immutable; operator functions refuse client roles
--   · organiser reads: summary splits pending, reconciliation holds, the
--     ledger view hides platform-only journals and platform legs (D-28)
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(44);

-- ── D-09 vectors (2026-11-16 is a Monday) ───────────────────────────────────

select is(app.settlement_due_at('2026-11-16 14:00+01', '2026-11-t1-0500-lagos'), '2026-11-17 05:00+01'::timestamptz, 'Mon 14:00 → Tue 05:00');
select is(app.settlement_due_at('2026-11-20 23:00+01', '2026-11-t1-0500-lagos'), '2026-11-21 05:00+01'::timestamptz, 'Fri 23:00 → Sat 05:00 (calendar days, weekends included)');
select is(app.settlement_due_at('2026-11-22 23:59+01', '2026-11-t1-0500-lagos'), '2026-11-23 05:00+01'::timestamptz, 'Sun 23:59 → Mon 05:00');
select is(app.settlement_due_at('2026-11-16 00:00+01', '2026-11-t1-0500-lagos'), '2026-11-17 05:00+01'::timestamptz, 'Mon 00:00 exactly → Tue 05:00');
select is(app.settlement_due_at('2026-11-16 05:00+01', '2026-11-t1-0500-lagos'), '2026-11-17 05:00+01'::timestamptz, 'Mon 05:00 exactly → Tue 05:00');
select is(app.settlement_due_at('2026-11-16 23:50+01', '2026-11-t1-0500-lagos'), '2026-11-17 05:00+01'::timestamptz, 'Mon 23:50 → Tue 05:00');
select is(app.settlement_due_at('2026-11-16 23:30+00', '2026-11-t1-0500-lagos'), '2026-11-18 05:00+01'::timestamptz,
  'UTC 23:30 Monday is 00:30 Tuesday in Lagos → Wednesday 05:00 (the Lagos day decides, not UTC)');

select throws_ok($$ update public.settlement_schedules set release_time = '06:00' $$,
  'P0001', null, 'a settlement schedule cannot be edited (a change is a new version)');


-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a5710000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@settle.example.test'),
  ('a5710000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@settle.example.test'),
  ('a5710000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@settle.example.test');
insert into public.users (id, full_name, email) values
  ('a5710000-0000-4000-8000-000000000001', 'Settle Owner',     'owner@settle.example.test'),
  ('a5710000-0000-4000-8000-000000000003', 'Settle Viewer',    'viewer@settle.example.test'),
  ('a5710000-0000-4000-8000-000000000004', 'Settle Collector', 'collector@settle.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a5720000-0000-4000-8000-00000000000a', 'settle-tests', 'Settle Tests', 'social_group', false, 'a5710000-0000-4000-8000-000000000001');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a5750000-0000-4000-8000-000000000001', 'a5720000-0000-4000-8000-00000000000a', 'settle-dues', 'Settle Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a5710000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a5720000-0000-4000-8000-00000000000a', 'a5710000-0000-4000-8000-000000000001', 'owner',     'Settle Owner',     'created', null),
  ('a5720000-0000-4000-8000-00000000000a', 'a5710000-0000-4000-8000-000000000003', 'viewer',    'Settle Viewer',    'invited', null),
  ('a5720000-0000-4000-8000-00000000000a', 'a5710000-0000-4000-8000-000000000004', 'collector', 'Settle Collector', 'invited', null);

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;

-- ₦5,000, host absorbs: fees ₦100 (net ₦4,900); provider fee estimate ₦50 → expected settlement ₦4,950.
create function pg_temp.pay(p_ref integer, p_paid_at timestamptz) returns uuid language plpgsql as $$
declare
  v_attempt uuid;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a5750000-0000-4000-8000-000000000001', 'checkout-key-settle-' || p_ref, pg_temp.ref(p_ref), 'fake', null,
    'Payer ' || p_ref, 'payer' || p_ref || '@settle.example.test', '+2348000000057', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), 'fake', 'FAKE_TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'succeeded',
    500000, 'NGN', null, p_paid_at, 'card', null, '{"__fake": true}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
  return (select c.id from public.contributions c where c.attempt_id = v_attempt);
end;
$$;

create temporary table tmp_c (label text primary key, id uuid);
insert into tmp_c values
  ('old1', pg_temp.pay(5701, now() - interval '2 days')),
  ('old2', pg_temp.pay(5702, now() - interval '2 days')),
  ('odd',  pg_temp.pay(5703, now() - interval '2 days')),
  ('new',  pg_temp.pay(5704, now()));
create function pg_temp.c(p text) returns uuid language sql as $$ select id from tmp_c where label = p $$;


-- ── Scheduling ──────────────────────────────────────────────────────────────

select is((select count(*)::integer from public.contribution_settlements
           where collection_id = 'a5750000-0000-4000-8000-000000000001'), 4,
  'every captured payment has exactly one settlement row');

select is(
  (select net_kobo::bigint || ':' || expected_provider_kobo || ':' || status::text
   from public.contribution_settlements where contribution_id = pg_temp.c('new')),
  '490000:495000:pending',
  'net ₦4,900 to release; ₦4,950 expected from the provider (charged − provider fee); pending');

select is(
  (select s.scheduled_release_at = app.settlement_due_at(c.captured_at, s.schedule_version)
   from public.contribution_settlements s join public.contributions c on c.id = s.contribution_id
   where s.contribution_id = pg_temp.c('new')),
  true, 'scheduled_release_at is D-09 applied to the capture time');


-- ── Nothing released without the provider ───────────────────────────────────

select is((select released || ':' || awaiting_provider from app.release_due_settlements(500)), '0:3',
  'three payments are due, none confirmed: nothing released, three awaiting the provider');

select is((select available_kobo::bigint from public.v_collection_position
           where collection_id = 'a5750000-0000-4000-8000-000000000001'), 0::bigint,
  'available stays ₦0: a due time alone never makes money available');


-- ── Provider confirmation ───────────────────────────────────────────────────

select is((select outcome from app.record_provider_settlement(pg_temp.ref(5701), 'STL-1', 495000, now() - interval '1 day')),
  'confirmed', 'a matching provider settlement is confirmed');
select is((select outcome from app.record_provider_settlement(pg_temp.ref(5701), 'STL-1', 495000, now() - interval '1 day')),
  'already_confirmed', 'the same statement again changes nothing');
select is((select outcome from app.record_provider_settlement(pg_temp.ref(5701), 'STL-9', 400000, now())),
  'conflict', 'a different statement for a confirmed payment is a conflict');
select is((select count(*)::integer from public.ledger_journals where idempotency_key like 'provider_settlement:%'
           and collection_id = 'a5750000-0000-4000-8000-000000000001'), 1,
  'one provider_settlement journal, whatever was replayed');

select is((select outcome from app.record_provider_settlement(pg_temp.ref(5703), 'STL-2', 480000, now() - interval '1 day')),
  'discrepancy', 'a provider amount that differs from Kolekto''s record is a discrepancy');
select is((select status::text || ':' || discrepancy_reason from public.contribution_settlements where contribution_id = pg_temp.c('odd')),
  'discrepancy:amount_mismatch', 'the discrepancy is recorded on the settlement');
select is((select count(*)::integer from public.audit_logs where action = 'settlement.discrepancy' and object_id = pg_temp.c('odd')), 1,
  'and audited');

select throws_ok($$ select * from app.record_provider_settlement('KLK-NOPE', 'STL-3', 1, now()) $$,
  'P0001', null, 'an unknown payment reference is refused');

select is((select outcome from app.record_provider_settlement(pg_temp.ref(5704), 'STL-4', 495000, now())),
  'confirmed', 'the payment captured today is confirmed, but is not due until tomorrow 05:00');


-- ── Release ─────────────────────────────────────────────────────────────────

select is((select released || ':' || released_kobo || ':' || awaiting_provider from app.release_due_settlements(500)), '1:490000:1',
  'only the payment that is due AND confirmed is released; one due payment still awaits the provider');

select is((select released from app.release_due_settlements(500)), 0, 'a second run releases nothing');
select is((select count(*)::integer from public.ledger_journals where idempotency_key = 'balance_release:' || pg_temp.c('old1')), 1,
  'exactly one balance_release journal for the released payment');

select is(
  (select pending_kobo::bigint || ':' || available_kobo from public.v_collection_position
   where collection_id = 'a5750000-0000-4000-8000-000000000001'),
  '1470000:490000',
  'pending ₦14,700 (two awaiting + one discrepancy + today''s) and available ₦4,900');

select is((select status::text from public.contribution_settlements where contribution_id = pg_temp.c('new')), 'pending',
  'confirmed but not yet due stays pending');
select is((select status::text from public.contribution_settlements where contribution_id = pg_temp.c('odd')), 'discrepancy',
  'a discrepancy is never released');

select is((select count(*)::integer from public.v_ledger_imbalances), 0, 'every journal balances');

select throws_ok(format($$ update public.contribution_settlements set scheduled_release_at = now() where contribution_id = %L $$, pg_temp.c('new')),
  'P0001', null, 'a scheduled release time cannot be moved');
select throws_ok(format($$ update public.contribution_settlements set status = 'pending' where contribution_id = %L $$, pg_temp.c('old1')),
  'P0001', null, 'a released settlement cannot be un-released');
select throws_ok(format($$ delete from public.contribution_settlements where contribution_id = %L $$, pg_temp.c('old1')),
  'P0001', null, 'a settlement row cannot be deleted');


-- ── Platform reconciliation (operator) ──────────────────────────────────────

select is((select count(*)::integer from app.platform_reconciliation() where not ok), 0,
  'every platform identity holds after confirmations, a discrepancy and a release');


-- ── Organiser reads ─────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a5710000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok($$ select * from app.release_due_settlements(10) $$, '42501', null,
  'a client role cannot run the release');
select throws_ok($$ select * from app.record_provider_settlement('x', 'y', 1, now()) $$, '42501', null,
  'a client role cannot record a provider settlement');

select is(
  (select scheduled_count || ':' || scheduled_kobo || ':' || awaiting_provider_count || ':' || awaiting_provider_kobo
          || ':' || discrepancy_count || ':' || released_kobo || ':' || reconciled
   from app.collection_settlement_summary('a5750000-0000-4000-8000-000000000001')),
  '1:490000:1:490000:1:490000:true',
  'summary: one scheduled, one awaiting the provider, one discrepancy, one released; reconciles');

select is(
  (select schedule_timezone || ' ' || schedule_release_time::text || ' +' || schedule_day_offset
   from app.collection_settlement_summary('a5750000-0000-4000-8000-000000000001')),
  'Africa/Lagos 05:00:00 +1', 'the summary states the rule from the schedule row, not a constant');

select is((select count(*)::integer from app.collection_reconciliation('a5750000-0000-4000-8000-000000000001') where not ok), 0,
  'every collection identity holds');

select is(
  (select pending_change || ':' || available_change
   from app.collection_ledger('a5750000-0000-4000-8000-000000000001', 50, 0) where source_type = 'balance_release'),
  '-490000:490000', 'the ledger view shows the release moving ₦4,900 from pending to available');

select is(
  (select count(*)::integer from app.collection_ledger('a5750000-0000-4000-8000-000000000001', 200, 0)
   where source_type = 'provider_settlement'
      or entries::text like '%provider_fee_expense%' or entries::text like '%provider_receivable%'
      or entries::text like '%platform_fee_income%'),
  0, 'no platform-only journal and no platform leg is shown to organisers (D-28)');

select is(
  (select max(total_count)::integer from app.collection_ledger('a5750000-0000-4000-8000-000000000001', 1, 0)),
  9, 'paging returns the full count: 4 captures + 4 fee journals + 1 release');

set local request.jwt.claims = '{"sub":"a5710000-0000-4000-8000-000000000003","role":"authenticated"}';
select lives_ok($$ select * from app.collection_ledger('a5750000-0000-4000-8000-000000000001', 10, 0) $$,
  'a viewer (balance.view) reads the ledger');

set local request.jwt.claims = '{"sub":"a5710000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$ select * from app.collection_ledger('a5750000-0000-4000-8000-000000000001', 10, 0) $$,
  '42501', null, 'a collector (no balance.view) cannot read the ledger');

select throws_ok($$ select count(*) from public.contribution_settlements $$, '42501', null,
  'clients cannot read contribution_settlements directly');

select * from finish();
rollback;
