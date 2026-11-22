-- ─────────────────────────────────────────────────────────────────────────────
-- 65 — catch-up for payments stuck on the provider-confirmed rule
--      (20261119100000, owner decision 2026-11-19)
--
--   · dry run lists due, unconfirmed payments and writes nothing
--   · only verified, non-fake charges are approved; fake ones are skipped
--   · approval is write-once, audited, and not a provider confirmation
--   · the normal release moves approved payments to available, exactly once
--   · not-yet-due and provider-confirmed payments are untouched
--   · platform reconciliation still holds; client roles are refused
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
-- Pin the provider-confirmed rule for this file's captures (as 57 does),
-- whatever today is; rolled back at the end.
insert into public.settlement_schedules
  (version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes)
-- The pin must also start after the newest migration schedule (the verified-
-- charge rule starts 2026-11-17 23:00 UTC); a bare now() - 3 days lost to it
-- whenever the test ran before 2026-11-20 23:00 UTC (session 40).
values ('test-pin-provider-confirmed-65', greatest(now() - interval '3 days', (select max(s.effective_from) from public.settlement_schedules s) + interval '1 second'), 'Africa/Lagos', 1, time '05:00', true, 'test only');
select plan(24);

insert into auth.users (id, instance_id, aud, role, email) values
  ('a6510000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@catchup.example.test');
insert into public.users (id, full_name, email) values
  ('a6510000-0000-4000-8000-000000000001', 'Catchup Owner', 'owner@catchup.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a6520000-0000-4000-8000-00000000000a', 'catchup-tests', 'Catchup Tests', 'social_group', false, 'a6510000-0000-4000-8000-000000000001');

insert into public.collections
  (id, community_id, slug, name, category, participation_mode, audience_mode, amount_model, fixed_amount_kobo,
   status, visibility, fee_mode, created_by)
values
  ('a6550000-0000-4000-8000-000000000001', 'a6520000-0000-4000-8000-00000000000a', 'catchup-dues', 'Catchup Dues',
   'dues', 'open', 'public', 'fixed', 500000, 'active', 'unlisted', 'community_absorbs', 'a6510000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('a6520000-0000-4000-8000-00000000000a', 'a6510000-0000-4000-8000-000000000001', 'owner', 'Catchup Owner', 'created', null);

create function pg_temp.ref(n integer) returns text language sql as $$ select 'KLK-' || lpad(n::text, 26, '0') $$;

-- ₦5,000, host absorbs: net ₦4,900.
create function pg_temp.pay(p_ref integer, p_paid_at timestamptz, p_provider text) returns uuid language plpgsql as $$
declare
  v_attempt uuid;
begin
  select attempt_id into v_attempt from app.create_payment_attempt(
    'a6550000-0000-4000-8000-000000000001', 'checkout-key-catchup-' || p_ref, pg_temp.ref(p_ref), p_provider, null,
    'Payer ' || p_ref, 'payer' || p_ref || '@catchup.example.test', '+2348000000065', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000, 'community_absorbs', '2026-11-founder');
  perform app.record_provider_transaction(
    pg_temp.ref(p_ref), p_provider, 'TXN_' || p_ref, pg_temp.ref(p_ref), 'succeeded', 'success',
    500000, 'NGN', 5000, p_paid_at, 'card', null, '{"test": 65}'::jsonb);
  perform app.complete_payment_capture(v_attempt);
  return (select c.id from public.contributions c where c.attempt_id = v_attempt);
end;
$$;

create temporary table tmp_c (label text primary key, id uuid);
insert into tmp_c values
  ('ok',        pg_temp.pay(6501, now() - interval '2 days', 'paystack')),
  ('ok2',       pg_temp.pay(6502, now() - interval '2 days', 'paystack')),
  ('fake',      pg_temp.pay(6503, now() - interval '2 days', 'fake')),
  ('confirmed', pg_temp.pay(6504, now() - interval '2 days', 'paystack')),
  ('new',       pg_temp.pay(6505, now(),                     'paystack'));
create function pg_temp.c(p text) returns uuid language sql as $$ select id from tmp_c where label = p $$;
create function pg_temp.coll() returns uuid language sql as $$ select 'a6550000-0000-4000-8000-000000000001'::uuid $$;

select is((select count(*)::integer from public.contribution_settlements s
           join public.settlement_schedules sch on sch.version = s.schedule_version
           where s.contribution_id in (pg_temp.c('ok'), pg_temp.c('ok2'), pg_temp.c('fake'), pg_temp.c('confirmed'))
             and sch.requires_provider_confirmation), 4,
  'the four captures from two days ago sit on a provider-confirmed rule');

select is((select outcome from app.record_provider_settlement(pg_temp.ref(6504), 'STL-65', 495000, now() - interval '1 day')),
  'confirmed', 'one payment has a real provider settlement recorded');


-- ── Dry run ─────────────────────────────────────────────────────────────────

select set_eq(
  $$ select outcome || ':' || reference from app.approve_verified_charge_settlements(false, 500)
     where collection_id = 'a6550000-0000-4000-8000-000000000001' $$,
  $$ values ('eligible:KLK-00000000000000000000006501'), ('eligible:KLK-00000000000000000000006502'),
            ('skipped_fake_provider:KLK-00000000000000000000006503') $$,
  'dry run lists the due unconfirmed payments; not the confirmed one, not the one captured today');

select is((select count(*)::integer from public.contribution_settlements
           where collection_id = pg_temp.coll() and verified_charge_approved_at is not null), 0,
  'a dry run writes nothing');

select is((select count(*)::integer from public.audit_logs where action = 'settlement.verified_charge_approved'
           and object_id in (pg_temp.c('ok'), pg_temp.c('ok2'))), 0,
  'and audits nothing');

select is((select available_kobo::bigint from public.v_collection_position where collection_id = pg_temp.coll()), 0::bigint,
  'nothing is available yet');


-- ── Apply with a limit, then the rest ──────────────────────────────────────

select is(
  (select count(*)::integer from app.approve_verified_charge_settlements(true, 1)
   where collection_id = pg_temp.coll() and outcome = 'approved'),
  1, 'p_limit bounds one run');

select set_eq(
  $$ select outcome || ':' || reference from app.approve_verified_charge_settlements(true, 500)
     where collection_id = 'a6550000-0000-4000-8000-000000000001' $$,
  $$ values ('approved:KLK-00000000000000000000006502'), ('skipped_fake_provider:KLK-00000000000000000000006503') $$,
  'the next run approves only what is left; the fake payment is skipped again');

select is((select count(*)::integer from app.approve_verified_charge_settlements(true, 500)
           where collection_id = pg_temp.coll() and outcome = 'approved'), 0,
  'a third run approves nothing (idempotent)');

select is((select count(*)::integer from public.audit_logs where action = 'settlement.verified_charge_approved'
           and object_id in (pg_temp.c('ok'), pg_temp.c('ok2'))), 2,
  'each approval is audited once');

select is((select count(*)::integer from public.contribution_settlements
           where collection_id = pg_temp.coll() and provider_confirmed_at is not null), 1,
  'approval is not a provider confirmation: only the really settled payment carries one');

select is((select verified_charge_approved_at is null from public.contribution_settlements where contribution_id = pg_temp.c('fake')),
  true, 'the fake payment is never approved');

select throws_ok(format($$ update public.contribution_settlements set verified_charge_approved_at = now() + interval '1 hour' where contribution_id = %L $$, pg_temp.c('ok')),
  'P0001', format('SETTLEMENT_APPROVAL_IMMUTABLE: release approval for %s is already recorded', pg_temp.c('ok')),
  'an approval cannot be rewritten');
select throws_ok(format($$ update public.contribution_settlements set verified_charge_approved_at = null where contribution_id = %L $$, pg_temp.c('ok')),
  'P0001', format('SETTLEMENT_APPROVAL_IMMUTABLE: release approval for %s is already recorded', pg_temp.c('ok')),
  'an approval cannot be cleared');


-- ── Release ─────────────────────────────────────────────────────────────────

select is((select released || ':' || released_kobo from app.release_due_settlements(500)), '3:1470000',
  'the release moves the two approved payments and the confirmed one (3 × ₦4,900)');

select is((select released from app.release_due_settlements(500)), 0, 'a second run releases nothing');

select is((select count(*)::integer from public.ledger_journals
           where idempotency_key in ('balance_release:' || pg_temp.c('ok'), 'balance_release:' || pg_temp.c('ok2'))), 2,
  'exactly one balance_release journal per approved payment');

select is(
  (select pending_kobo::bigint || ':' || available_kobo from public.v_collection_position where collection_id = pg_temp.coll()),
  '980000:1470000',
  'pending ₦9,800 (fake + today''s), available ₦14,700 (two approved + one confirmed)');

select is((select status::text from public.contribution_settlements where contribution_id = pg_temp.c('fake')), 'pending',
  'the fake payment stays pending');
select is((select status::text from public.contribution_settlements where contribution_id = pg_temp.c('new')), 'pending',
  'today''s payment stays pending until its T+1 time');

select is((select count(*)::integer from app.platform_reconciliation() where not ok), 0,
  'every platform identity holds after approval and release');


-- ── Guard ───────────────────────────────────────────────────────────────────

-- A fresh, still pending payment on the confirmed path: approval refused by the guard.
select is((select outcome from app.record_provider_settlement(pg_temp.ref(6505), 'STL-65b', 495000, now())),
  'confirmed', 'today''s payment gets a provider settlement');
select throws_ok(format($$ update public.contribution_settlements set verified_charge_approved_at = now() where contribution_id = %L $$, pg_temp.c('new')),
  'P0001', 'SETTLEMENT_APPROVAL_NOT_ALLOWED: only a pending, unconfirmed payment can be approved for release',
  'a provider-confirmed payment cannot also be approved');


-- ── Client roles ────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"a6510000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select * from app.approve_verified_charge_settlements(false, 10) $$, '42501', null,
  'a client role cannot run the catch-up');
reset role;

select * from finish();
rollback;
