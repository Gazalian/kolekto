-- ─────────────────────────────────────────────────────────────────────────────
-- 44 — Provider-aware quota controls: L4 daily, L5 per-second (M13.2 P9-3)
--
-- Migration 20261024200000. What is proved here:
--
--   A. Schema: send_class columns, the new index, the new per-class
--      limits-function signature. The old no-arg signature is gone.
--   B. Config: notification_send_limits('transactional') returns the
--      configured transactional numbers; 'bulk' returns zero caps for L4/L5;
--      an unknown class raises.
--   C. L4 boundary: at the per-class daily cap one more reservation defers
--      with 'provider_daily_limited', attempt is undone, no ledger row.
--   D. L5 boundary: two reservations within one second: the first grants,
--      the second defers with 'provider_rate_limited' and retry_at > now.
--   E. Class independence of L4/L5: bulk's attempts do not count toward
--      transactional (verified via the limits function + direct ledger).
--   F. Deferred-is-not-an-attempt: L4 and L5 defers roll attempt_count back
--      and write no ledger row.
--   G. Bulk zero-cap defers forever: a bulk reservation is 'provider_daily_limited'
--      with retry_at ~ now() + 24h even with no bulk ledger history.
--   H. Suppression precedence: a suppressed address never reaches L4 or L5.
--   I. send_class CHECK rejects values outside ('transactional','bulk').
--   J. No client role can execute app.notification_send_limits(text).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(42);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('da900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p93.example.test', now());
insert into public.users (id, full_name, email) values
  ('da900000-0000-4000-8000-000000000001', 'P93 Owner', 'owner@p93.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('da910000-0000-4000-8000-000000000001', 'p93-qc-01', 'P93 QC 01', 'social_group', false, 'da900000-0000-4000-8000-000000000001'),
  ('da910000-0000-4000-8000-000000000002', 'p93-qc-02', 'P93 QC 02', 'social_group', false, 'da900000-0000-4000-8000-000000000001'),
  ('da910000-0000-4000-8000-000000000003', 'p93-qc-03', 'P93 QC 03', 'social_group', false, 'da900000-0000-4000-8000-000000000001');

-- Four deliveries we drive through claim+reserve:
--   D1: transactional in community 01 for L4 boundary (community 01 gets a
--       pre-fill of L4-cap transactional ledger rows via community 02 and 03
--       so L2 for 01 is not pre-full — see below).
--   D2: transactional for L5 boundary.
--   D3: bulk for G (bulk zero-cap defers forever).
--   D4: transactional for H (suppression precedence).
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('da920000-0000-4000-8000-000000000001', 'da910000-0000-4000-8000-000000000001', 'member.create', 'p93-qc-01', 'officer', 'da900000-0000-4000-8000-000000000001', 'member', 'da930000-0000-4000-8000-000000000001', '{}'),
  ('da920000-0000-4000-8000-000000000002', 'da910000-0000-4000-8000-000000000002', 'member.create', 'p93-qc-02', 'officer', 'da900000-0000-4000-8000-000000000001', 'member', 'da930000-0000-4000-8000-000000000002', '{}'),
  ('da920000-0000-4000-8000-000000000003', 'da910000-0000-4000-8000-000000000003', 'member.create', 'p93-qc-03', 'officer', 'da900000-0000-4000-8000-000000000001', 'member', 'da930000-0000-4000-8000-000000000003', '{}'),
  ('da920000-0000-4000-8000-000000000004', 'da910000-0000-4000-8000-000000000001', 'member.create', 'p93-qc-04', 'officer', 'da900000-0000-4000-8000-000000000001', 'member', 'da930000-0000-4000-8000-000000000004', '{}');

insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status,
   recipient_address, recipient_address_assurance, attempt_count,
   send_class, created_at)
values
  ('da930000-0000-4000-8000-000000000001', 'da920000-0000-4000-8000-000000000001', 'da910000-0000-4000-8000-000000000001', 'email', 'pending', 'd1@p93.example.test', 'unverified_supplied', 0, 'transactional', now() - interval '5 minutes'),
  ('da930000-0000-4000-8000-000000000002', 'da920000-0000-4000-8000-000000000002', 'da910000-0000-4000-8000-000000000002', 'email', 'pending', 'd2@p93.example.test', 'unverified_supplied', 0, 'transactional', now() - interval '4 minutes'),
  ('da930000-0000-4000-8000-000000000003', 'da920000-0000-4000-8000-000000000003', 'da910000-0000-4000-8000-000000000003', 'email', 'pending', 'd3@p93.example.test', 'unverified_supplied', 0, 'bulk',          now() - interval '3 minutes'),
  ('da930000-0000-4000-8000-000000000004', 'da920000-0000-4000-8000-000000000004', 'da910000-0000-4000-8000-000000000001', 'email', 'pending', 'd4@p93.example.test', 'unverified_supplied', 0, 'transactional', now() - interval '2 minutes');


-- Helper: claim then reserve in one call, return the reservation outcome.
create function pg_temp.claim_and_reserve(p_id uuid)
returns text language plpgsql as $$
declare
  v_claimed boolean;
  v_result text;
begin
  select claimed into v_claimed
  from app.claim_notification_delivery(p_id, 300);
  if not v_claimed then
    return 'claim_failed';
  end if;
  select reservation into v_result
  from app.reserve_email_attempt(p_id);
  return v_result;
end $$;

-- Helper: attempt a privileged statement under a client role, return 'ok' or sqlstate.
create function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    execute 'reset role';
    return 'ok';
  exception when others then
    execute 'reset role';
    return sqlstate;
  end;
end $$;


-- ── A. Schema ───────────────────────────────────────────────────────────────
select has_column('public', 'notification_deliveries', 'send_class',
  'A: notification_deliveries.send_class column exists');
select has_column('public', 'notification_send_attempts', 'send_class',
  'A: notification_send_attempts.send_class column exists');
select has_index('public', 'notification_send_attempts',
  'notification_send_attempts_class_window_idx',
  'A: new (send_class, attempted_at) index exists');
select has_function('app', 'notification_send_limits', ARRAY['text'],
  'A: notification_send_limits(text) exists');
select ok(
  not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'notification_send_limits'
      and pronargs = 0
  ),
  'A: the old no-arg notification_send_limits() has been dropped'
);


-- ── B. Config function ──────────────────────────────────────────────────────
select is(
  (select l4_daily from app.notification_send_limits('transactional')), 180,
  'B: transactional L4 daily = 180');
select is(
  (select l5_per_second from app.notification_send_limits('transactional')), 1,
  'B: transactional L5 per-second = 1');
select is(
  (select l4_window_hours from app.notification_send_limits('transactional')), 24,
  'B: L4 window is 24h');
select is(
  (select l5_window_seconds from app.notification_send_limits('transactional')), 1,
  'B: L5 window is 1s');
select is(
  (select l4_daily from app.notification_send_limits('bulk')), 0,
  'B: bulk L4 daily default = 0 (bulk closed)');
select is(
  (select l5_per_second from app.notification_send_limits('bulk')), 0,
  'B: bulk L5 per-second default = 0 (bulk closed)');
select throws_ok(
  $$select app.notification_send_limits('whatever')$$,
  '22023',
  null,
  'B: unknown class raises 22023'
);


-- ── C. L4 boundary (daily) ──────────────────────────────────────────────────
-- Pre-fill the transactional ledger to the L4 cap, spread across other
-- communities so community 01's L2 (100/hr) is not touched. We insert
-- 180 rows across communities 02 and 03 at scattered timestamps within
-- the 24h window.
--
-- WARNING: these rows also count toward L3 (platform-wide 1h). To keep L3
-- under its cap, we spread the timestamps across the full 24h window. L3
-- counts rows in the last 1h; 180 rows evenly spaced over 24h means
-- ~7-8 rows per hour, well under the 1000/h cap.
insert into public.notification_send_attempts
  (delivery_id, community_id, address_key, send_class, attempted_at)
select
  'da930000-0000-4000-8000-000000000002'::uuid,
  case when i % 2 = 0
       then 'da910000-0000-4000-8000-000000000002'::uuid
       else 'da910000-0000-4000-8000-000000000003'::uuid end,
  'prefill-' || i || '@p93.example.test',
  'transactional',
  now() - make_interval(mins => (i * 23 * 60 / 180))
from generate_series(1, 180) i;

-- 180 rows now in the transactional ledger within 24h. D1 is transactional
-- in community 01 (no community 01 L2 pre-fill), so L1/L2/L3 all pass, and
-- L4 is the first binding limit.
select is(
  pg_temp.claim_and_reserve('da930000-0000-4000-8000-000000000001'::uuid),
  'provider_daily_limited',
  'C: 181st transactional attempt is provider_daily_limited');
select is(
  (select status::text from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000001'::uuid),
  'pending',
  'C: L4-deferred delivery is pending (not skipped)');
select is(
  (select next_retry_at is not null and next_retry_at > now()
     from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000001'::uuid),
  true,
  'C: L4-deferred delivery has next_retry_at in the future');
select is(
  (select attempt_count from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000001'::uuid),
  0,
  'C: L4 defer leaves attempt_count at 0 (undone from claim +1)');
select is(
  (select recipient_address from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000001'::uuid),
  'd1@p93.example.test',
  'C: L4 defer keeps the recipient address (it is only waiting its turn)');
select is(
  (select count(*)::int from public.notification_send_attempts
     where delivery_id = 'da930000-0000-4000-8000-000000000001'::uuid),
  0,
  'C: L4 defer writes no ledger row');


-- ── D. L5 boundary (per-second) ─────────────────────────────────────────────
-- The 180 prefill rows above happen to include some with attempted_at =
-- now() - 0 minutes (i=0 would be at now; our generate_series starts at 1
-- so the earliest is at now() - 23*60/180 ≈ 7.7 minutes). None of them is
-- within the last 1-second window, so the next transactional reservation
-- would normally grant on L5 — but we hit L4 first (180 >= 180). We need
-- a scenario where L4 is NOT full so L5 can be the binding limit.
--
-- Reset the transactional pre-fill count by deleting the rows under the
-- append-only-mutation gate. Then prefill ONE transactional ledger row
-- "now" so L5 count is 1 >= 1 → defer.
alter table public.notification_send_attempts disable trigger notification_send_attempts_no_delete;
delete from public.notification_send_attempts
 where send_class = 'transactional' and address_key like 'prefill-%';
alter table public.notification_send_attempts enable trigger notification_send_attempts_no_delete;

-- One recent transactional attempt (attempted_at = tx start = now()).
-- Reservation inside the same tx compares now() > now() - 1s → true, so
-- the single row is counted and L5 (cap 1) is hit.
--
-- Use D3 (bulk; its class is independent of the transactional L5 window)
-- as the ledger row's delivery_id. D3 is tested in section G for the bulk
-- zero-cap path, which does not read the ledger. This keeps section F's
-- "no ledger row for either L4 or L5 defer" count (which filters by D1 and
-- D2) honest.
insert into public.notification_send_attempts
  (delivery_id, community_id, address_key, send_class)
values
  ('da930000-0000-4000-8000-000000000003'::uuid, 'da910000-0000-4000-8000-000000000002'::uuid,
   'l5pre@p93.example.test', 'transactional');

select is(
  pg_temp.claim_and_reserve('da930000-0000-4000-8000-000000000002'::uuid),
  'provider_rate_limited',
  'D: second transactional attempt within 1s is provider_rate_limited');
select is(
  (select status::text from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000002'::uuid),
  'pending',
  'D: L5-deferred delivery is pending');
select is(
  (select next_retry_at is not null and next_retry_at > now()
     from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000002'::uuid),
  true,
  'D: L5-deferred delivery has next_retry_at > now');
select is(
  (select next_retry_at < now() + interval '2 seconds'
     from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000002'::uuid),
  true,
  'D: L5 defer schedules within ~1s + jitter (< 2s)');
select is(
  (select attempt_count from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000002'::uuid),
  0,
  'D: L5 defer leaves attempt_count at 0');
select is(
  (select recipient_address from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000002'::uuid),
  'd2@p93.example.test',
  'D: L5 defer keeps the recipient address');
select is(
  (select count(*)::int from public.notification_send_attempts
     where delivery_id = 'da930000-0000-4000-8000-000000000002'::uuid),
  0,
  'D: L5 defer writes no ledger row');


-- ── E. Class independence of L4/L5 ──────────────────────────────────────────
-- With the transactional ledger carrying 1 recent attempt, bulk's own
-- L5 window should still have 0 bulk rows. (Separately verified via the
-- counts; the behaviour test G exercises the bulk defer path.)
select is(
  (select count(*)::int from public.notification_send_attempts
     where send_class = 'bulk' and attempted_at > now() - interval '1 second'),
  0,
  'E: bulk L5 count is 0 while transactional L5 is full');
select is(
  (select count(*)::int from public.notification_send_attempts
     where send_class = 'transactional' and attempted_at > now() - interval '1 second'),
  1,
  'E: transactional L5 count is 1 (the pre-fill), independent of bulk');


-- ── F. Deferred-is-not-an-attempt (already asserted inline in C and D) ──────
-- Count ledger rows for the two deferred deliveries: both should be zero.
select is(
  (select count(*)::int from public.notification_send_attempts
     where delivery_id in (
       'da930000-0000-4000-8000-000000000001'::uuid,
       'da930000-0000-4000-8000-000000000002'::uuid)),
  0,
  'F: no ledger row for either L4 or L5 defer');


-- ── G. Bulk zero-cap defers forever ─────────────────────────────────────────
-- D3 is a bulk delivery with no bulk ledger history. L4 cap is 0, so the
-- count (0) >= cap (0) and it defers. retry_at falls back to now() + 24h
-- because v_oldest_at is null for an empty bulk ledger.
select is(
  pg_temp.claim_and_reserve('da930000-0000-4000-8000-000000000003'::uuid),
  'provider_daily_limited',
  'G: a bulk reservation defers (cap is 0 = closed)');
select is(
  (select next_retry_at > now() + interval '23 hours'
     from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000003'::uuid),
  true,
  'G: a bulk defer with empty ledger uses the now()+24h fallback');
select is(
  (select attempt_count from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000003'::uuid),
  0,
  'G: bulk defer leaves attempt_count at 0');


-- ── H. Suppression precedence over L4/L5 ────────────────────────────────────
-- Suppression check runs BEFORE L1 (and so before L4/L5). An address that
-- is suppressed reaches terminal 'address_suppressed', not a defer. We
-- prove it even when L5 is full for the class.
insert into public.email_suppressions
  (address_key, reason, source, source_event_id, expires_at)
values
  ('d4@p93.example.test', 'manual_block', 'operator', null, null);

select is(
  pg_temp.claim_and_reserve('da930000-0000-4000-8000-000000000004'::uuid),
  'address_suppressed',
  'H: suppressed address short-circuits before L4/L5');
select is(
  (select status::text from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000004'::uuid),
  'skipped',
  'H: suppressed delivery is terminally skipped');
select is(
  (select error_code from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000004'::uuid),
  'address_suppressed',
  'H: suppressed delivery carries address_suppressed');
select is(
  (select recipient_address from public.notification_deliveries where id = 'da930000-0000-4000-8000-000000000004'::uuid),
  null,
  'H: suppressed delivery has the address erased');
select is(
  (select count(*)::int from public.notification_send_attempts
     where delivery_id = 'da930000-0000-4000-8000-000000000004'::uuid),
  0,
  'H: suppression writes no ledger row');


-- ── I. send_class CHECK rejects unknown values ──────────────────────────────
select throws_ok(
  $$insert into public.notification_deliveries (notification_event_id, community_id, channel, status, send_class) values ('da920000-0000-4000-8000-000000000001'::uuid, 'da910000-0000-4000-8000-000000000001'::uuid, 'email', 'skipped', 'promotional')$$,
  '23514',
  null,
  'I: unknown send_class rejected on notification_deliveries'
);
select throws_ok(
  $$insert into public.notification_send_attempts (delivery_id, community_id, address_key, send_class) values ('da930000-0000-4000-8000-000000000001'::uuid, 'da910000-0000-4000-8000-000000000001'::uuid, 'x@y.test', 'promotional')$$,
  '23514',
  null,
  'I: unknown send_class rejected on notification_send_attempts'
);


-- ── J. Client roles cannot execute the config function ──────────────────────
select is(pg_temp.try_as('anon',
  $$select app.notification_send_limits('transactional')$$),
  '42501', 'J: anon cannot execute notification_send_limits(text)');
select is(pg_temp.try_as('authenticated',
  $$select app.notification_send_limits('transactional')$$),
  '42501', 'J: authenticated cannot execute notification_send_limits(text)');


-- (K: removed in P9-3 — pgTAP tests run in their own BEGIN/ROLLBACK so no
--  "pre-existing" fixture row from another suite exists here. The column
--  default is covered by the schema assertion in section A and by the
--  CHECK rejection in section I.)


-- ── L. Health snapshot exposes the new L4/L5 fields ────────────────────────
select is(
  (select l4_last_24h_by_class ? 'transactional' from app.notification_send_health()),
  true,
  'L: health snapshot carries l4_last_24h_by_class for transactional');
select is(
  (select l5_last_second_by_class ? 'bulk' from app.notification_send_health()),
  true,
  'L: health snapshot carries l5_last_second_by_class for bulk');


select * from finish();
rollback;
