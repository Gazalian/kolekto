-- ─────────────────────────────────────────────────────────────────────────────
-- 38 — Rate limits and deferred-backlog controls (M13.2 P5-2)
--
-- Migration 20261013200000. What is proved here:
--
--   A. The notification_send_attempts ledger table, its indexes, RLS and
--      deny-all policy exist.
--   B. app.notification_send_limits() returns the approved numbers.
--   C. L1 per-address limit: 3 granted, 4th address_limited (skipped,
--      address erased, attempt undone).
--   D. Rolling window: attempts older than 24 h do not count.
--   E. Case-insensitive and cross-community counting for L1.
--   F. L2 per-community limit: boundary at the configured number, deferral
--      sets next_retry_at, attempt undone, no ledger row for a deferral.
--   G. L3 platform-wide limit: community L2 OK but platform L3 hit defers.
--   H. Backlog cap: L2 hit with a full backlog skips with
--      community_backlog_full.
--   I. Deferred deliveries are not claimable before next_retry_at.
--   J. Purge function deletes old rows, preserves recent ones.
--   K. Append-only enforcement: UPDATE and DELETE are blocked.
--   L. No client role can read the ledger or execute the functions.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(47);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('ca000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p52.example.test', now());
insert into public.users (id, full_name, email) values
  ('ca000000-0000-4000-8000-000000000001', 'P52 Owner', 'owner@p52.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('ca100000-0000-4000-8000-000000000001', 'p52-rl-01', 'P52 RL 01', 'social_group', false, 'ca000000-0000-4000-8000-000000000001'),
  ('ca100000-0000-4000-8000-000000000002', 'p52-rl-02', 'P52 RL 02', 'social_group', false, 'ca000000-0000-4000-8000-000000000001'),
  ('ca100000-0000-4000-8000-000000000003', 'p52-rl-03', 'P52 RL 03', 'social_group', false, 'ca000000-0000-4000-8000-000000000001'),
  ('ca100000-0000-4000-8000-000000000004', 'p52-rl-04', 'P52 RL 04', 'social_group', false, 'ca000000-0000-4000-8000-000000000001');

-- One event per delivery (the per-event dedup index requires it).
insert into public.notification_events
  (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
values
  ('ca200000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000001', 'member.create', 'p52-01', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000001', '{}'),
  ('ca200000-0000-4000-8000-000000000002', 'ca100000-0000-4000-8000-000000000001', 'member.create', 'p52-02', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000002', '{}'),
  ('ca200000-0000-4000-8000-000000000003', 'ca100000-0000-4000-8000-000000000001', 'member.create', 'p52-03', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000003', '{}'),
  ('ca200000-0000-4000-8000-000000000004', 'ca100000-0000-4000-8000-000000000001', 'member.create', 'p52-04', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000004', '{}'),
  ('ca200000-0000-4000-8000-000000000005', 'ca100000-0000-4000-8000-000000000001', 'member.create', 'p52-05', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000005', '{}'),
  ('ca200000-0000-4000-8000-000000000006', 'ca100000-0000-4000-8000-000000000002', 'member.create', 'p52-06', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000006', '{}'),
  ('ca200000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'member.create', 'p52-07', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000007', '{}'),
  ('ca200000-0000-4000-8000-000000000008', 'ca100000-0000-4000-8000-000000000002', 'member.create', 'p52-08', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000008', '{}'),
  ('ca200000-0000-4000-8000-000000000009', 'ca100000-0000-4000-8000-000000000003', 'member.create', 'p52-09', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000009', '{}'),
  ('ca200000-0000-4000-8000-000000000010', 'ca100000-0000-4000-8000-000000000003', 'member.create', 'p52-10', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000010', '{}'),
  ('ca200000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'member.create', 'p52-11', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000011', '{}'),
  ('ca200000-0000-4000-8000-000000000012', 'ca100000-0000-4000-8000-000000000004', 'member.create', 'p52-12', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000012', '{}'),
  ('ca200000-0000-4000-8000-000000000013', 'ca100000-0000-4000-8000-000000000004', 'member.create', 'p52-13', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000013', '{}'),
  ('ca200000-0000-4000-8000-000000000014', 'ca100000-0000-4000-8000-000000000004', 'member.create', 'p52-14', 'officer', 'ca000000-0000-4000-8000-000000000001', 'member', 'ca300000-0000-4000-8000-000000000014', '{}');

-- D01-D04: same address, community 01 — for L1 boundary tests.
-- D05: different address, community 01 — for rolling-window test.
-- D06: upper-case same address, community 02 — for case / cross-community test.
-- D07-D08: unique addresses, community 02 — for L2 boundary test.
-- D09-D10: unique addresses, community 03 — for L3 test.
-- D11: unique address, community 04 — for backlog-cap test.
-- D12-D14: unique addresses, community 04, pending with next_retry_at —
--          pre-existing deferred deliveries that fill the backlog.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status,
   recipient_address, recipient_address_assurance, attempt_count,
   error_code, next_retry_at, created_at)
values
  ('ca300000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000001', 'email', 'pending', 'sam@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '10 minutes'),
  ('ca300000-0000-4000-8000-000000000002', 'ca200000-0000-4000-8000-000000000002', 'ca100000-0000-4000-8000-000000000001', 'email', 'pending', 'sam@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '9 minutes'),
  ('ca300000-0000-4000-8000-000000000003', 'ca200000-0000-4000-8000-000000000003', 'ca100000-0000-4000-8000-000000000001', 'email', 'pending', 'sam@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '8 minutes'),
  ('ca300000-0000-4000-8000-000000000004', 'ca200000-0000-4000-8000-000000000004', 'ca100000-0000-4000-8000-000000000001', 'email', 'pending', 'sam@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '7 minutes'),
  ('ca300000-0000-4000-8000-000000000005', 'ca200000-0000-4000-8000-000000000005', 'ca100000-0000-4000-8000-000000000001', 'email', 'pending', 'old@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '6 minutes'),
  ('ca300000-0000-4000-8000-000000000006', 'ca200000-0000-4000-8000-000000000006', 'ca100000-0000-4000-8000-000000000002', 'email', 'pending', 'SAM@P52.EXAMPLE.TEST', 'unverified_supplied', 0, null, null, now() - interval '5 minutes'),
  ('ca300000-0000-4000-8000-000000000007', 'ca200000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'email', 'pending', 'd07@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '4 minutes'),
  ('ca300000-0000-4000-8000-000000000008', 'ca200000-0000-4000-8000-000000000008', 'ca100000-0000-4000-8000-000000000002', 'email', 'pending', 'd08@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '3 minutes'),
  ('ca300000-0000-4000-8000-000000000009', 'ca200000-0000-4000-8000-000000000009', 'ca100000-0000-4000-8000-000000000003', 'email', 'pending', 'd09@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '2 minutes'),
  ('ca300000-0000-4000-8000-000000000010', 'ca200000-0000-4000-8000-000000000010', 'ca100000-0000-4000-8000-000000000003', 'email', 'pending', 'd10@p52.example.test', 'unverified_supplied', 0, null, null, now() - interval '1 minute'),
  ('ca300000-0000-4000-8000-000000000011', 'ca200000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'email', 'pending', 'd11@p52.example.test', 'unverified_supplied', 0, null, null, now()),
  ('ca300000-0000-4000-8000-000000000012', 'ca200000-0000-4000-8000-000000000012', 'ca100000-0000-4000-8000-000000000004', 'email', 'pending', 'd12@p52.example.test', 'unverified_supplied', 0, null, now() + interval '1 hour', now()),
  ('ca300000-0000-4000-8000-000000000013', 'ca200000-0000-4000-8000-000000000013', 'ca100000-0000-4000-8000-000000000004', 'email', 'pending', 'd13@p52.example.test', 'unverified_supplied', 0, null, now() + interval '1 hour', now()),
  ('ca300000-0000-4000-8000-000000000014', 'ca200000-0000-4000-8000-000000000014', 'ca100000-0000-4000-8000-000000000004', 'email', 'pending', 'd14@p52.example.test', 'unverified_supplied', 0, null, now() + interval '1 hour', now());

-- Pre-inserted ledger rows for boundary testing.
-- 3 rows for `old@...` from 24 h + 1 s ago (D section: must NOT count in L1).
-- 4 rows for community 02 within the last hour (F section: L2 pre-fill).
-- 1 row from 49 h ago (J section: purge target).
--
-- NOTE: community 04's 5 in-window ledger rows (H section: L2-hit pre-fill)
-- are intentionally NOT inserted here. L2 and L3 share the same 1-hour window,
-- so rows that pre-fill community 04's L2 budget also count platform-wide (L3).
-- Inserting them up-front would push the L3 platform count to 9 before section C
-- even runs, and the first granted reservation would then trip the L3 override
-- (10), cascading into the L1/L2/L3 sections that are meant to be tested in
-- isolation. They are inserted just before section H instead, which is the only
-- section that depends on them. See the fixture block at the H heading.
insert into public.notification_send_attempts
  (delivery_id, community_id, address_key, attempted_at)
values
  ('ca300000-0000-4000-8000-000000000005', 'ca100000-0000-4000-8000-000000000001', 'old@p52.example.test', now() - interval '24 hours 1 second'),
  ('ca300000-0000-4000-8000-000000000005', 'ca100000-0000-4000-8000-000000000001', 'old@p52.example.test', now() - interval '24 hours 1 second'),
  ('ca300000-0000-4000-8000-000000000005', 'ca100000-0000-4000-8000-000000000001', 'old@p52.example.test', now() - interval '24 hours 1 second'),
  ('ca300000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'l2pre1@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'l2pre2@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'l2pre3@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000007', 'ca100000-0000-4000-8000-000000000002', 'l2pre4@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000001', 'purge@p52.example.test', now() - interval '49 hours');

-- Helper: try a statement under a client role.
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

-- Helper: claim then reserve in one call, return the reservation result.
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


-- ── A. Schema ───────────────────────────────────────────────────────────────
select has_table('public', 'notification_send_attempts',
  'A: ledger table exists');
select has_index('public', 'notification_send_attempts',
  'notification_send_attempts_address_window_idx',
  'A: address-window index');
select has_index('public', 'notification_send_attempts',
  'notification_send_attempts_community_window_idx',
  'A: community-window index');
select has_index('public', 'notification_send_attempts',
  'notification_send_attempts_platform_window_idx',
  'A: platform-window index');
select ok(
  (select c.relrowsecurity and c.relforcerowsecurity
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'notification_send_attempts'),
  'A: RLS enabled and forced');
select ok(
  (select count(*) from pg_policy
   where polrelid = 'public.notification_send_attempts'::regclass) >= 1,
  'A: at least one policy (deny-all)');


-- ── B. Configuration ────────────────────────────────────────────────────────
select is((select l1_address     from app.notification_send_limits()), 3,    'B: L1 per-address = 3');
select is((select l1_window_hours from app.notification_send_limits()), 24,   'B: L1 window = 24 h');
select is((select l2_community   from app.notification_send_limits()), 100,  'B: L2 per-community = 100');
select is((select l2_window_hours from app.notification_send_limits()), 1,    'B: L2 window = 1 h');
select is((select l3_platform    from app.notification_send_limits()), 1000, 'B: L3 platform = 1000');
select is((select l3_window_hours from app.notification_send_limits()), 1,    'B: L3 window = 1 h');
select is((select backlog_max    from app.notification_send_limits()), 500,  'B: backlog cap = 500');
select is((select max_attempts   from app.notification_send_limits()), 3,    'B: max attempts = 3');


-- Override limits to small testable values.
-- L1 stays at 3; L2 = 5, L3 = 10, backlog = 3.
-- The boundary tests below exercise the same logic the real limits use;
-- section B proves the real numbers.
create or replace function app.notification_send_limits()
returns table (l1_address int, l1_window_hours int, l2_community int,
               l2_window_hours int, l3_platform int, l3_window_hours int,
               backlog_max int, max_attempts int)
language sql stable security definer set search_path = '' as $$
  select 3, 24, 5, 1, 10, 1, 3, 3;
$$;


-- ── C. L1 per-address limit (3/address/24 h) ───────────────────────────────
-- D01, D02, D03: same address sam@p52.example.test → all 3 granted.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000001'),
  'granted', 'C: 1st attempt for sam@ is granted');
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000002'),
  'granted', 'C: 2nd attempt for sam@ is granted');
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000003'),
  'granted', 'C: 3rd attempt for sam@ is granted');

-- D04: 4th → address_limited.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000004'),
  'address_limited', 'C: 4th attempt for sam@ is address_limited');

select is(
  (select status from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000004'),
  'skipped', 'C: address_limited row is skipped');
select is(
  (select error_code from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000004'),
  'recipient_rate_limited', 'C: error code is recipient_rate_limited');
select ok(
  (select recipient_address is null from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000004'),
  'C: address erased from skipped row');
select is(
  (select attempt_count from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000004'),
  0, 'C: attempt_count undone (rate-limit skip is not an attempt)');


-- ── D. Rolling window ───────────────────────────────────────────────────────
-- 3 ledger rows for old@... are 24 h + 1 s ago — outside the window.
-- D05 to the same address should be granted.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000005'),
  'granted', 'D: attempts > 24 h old do not count');


-- ── E. Case-insensitive and cross-community ─────────────────────────────────
-- D06 is SAM@P52.EXAMPLE.TEST in community 02. The 3 ledger rows for
-- sam@p52.example.test (community 01) should count against it.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000006'),
  'address_limited', 'E: upper-case address shares budget across communities');


-- ── F. L2 per-community limit (overridden to 5) ────────────────────────────
-- Community 02 has 4 pre-inserted ledger rows. D07 is the 5th → granted.
-- Platform total after this: 3 (C) + 1 (D) + 4 (pre) + 1 (F) = 9.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000007'),
  'granted', 'F: 5th in community (at L2 boundary) is granted');

-- D08 is the 6th in community 02 → deferred.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000008'),
  'community_deferred', 'F: 6th in community exceeds L2, deferred');
select ok(
  (select next_retry_at is not null from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000008'),
  'F: deferred delivery has next_retry_at');
select is(
  (select attempt_count from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000008'),
  0, 'F: deferral does not consume an attempt');
select ok(
  (select count(*) = 0 from public.notification_send_attempts
   where delivery_id = 'ca300000-0000-4000-8000-000000000008'),
  'F: no ledger row for a deferred delivery');


-- ── G. L3 platform-wide limit (overridden to 10) ───────────────────────────
-- Platform total is 9 (from C + D + F pre-inserts + F D07).
-- D09 in community 03: community count = 0 < 5 (L2 OK),
-- platform count = 9 < 10 (L3 OK) → granted. Platform → 10.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000009'),
  'granted', 'G: 10th platform reservation is granted (L3 boundary)');

-- D10 in community 03: community count = 1 < 5 (L2 OK),
-- platform count = 10 >= 10 (L3 hit) → deferred.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000010'),
  'community_deferred', 'G: 11th platform reservation exceeds L3, deferred');


-- ── H. Backlog cap (overridden to 3) ────────────────────────────────────────
-- Community 04's 5 in-window ledger rows are inserted HERE, not up-front, so
-- they fill community 04's L2 budget (5 → hit) without inflating the platform
-- L3 count during sections C-G (L2 and L3 share the 1-hour window).
insert into public.notification_send_attempts
  (delivery_id, community_id, address_key, attempted_at)
values
  ('ca300000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'bkpre1@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'bkpre2@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'bkpre3@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'bkpre4@p52.example.test', now() - interval '30 minutes'),
  ('ca300000-0000-4000-8000-000000000011', 'ca100000-0000-4000-8000-000000000004', 'bkpre5@p52.example.test', now() - interval '30 minutes');

-- Community 04 now has 5 in-window ledger rows (L2 = 5 → hit).
-- D12-D14 are pending with next_retry_at (3 deferred rows = backlog cap).
-- D11 → L2 hit → backlog check → 3 >= 3 → backlog_full.
select is(pg_temp.claim_and_reserve('ca300000-0000-4000-8000-000000000011'),
  'backlog_full', 'H: L2 hit with full backlog → backlog_full');
select is(
  (select status from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000011'),
  'skipped', 'H: backlog_full row is skipped');
select is(
  (select error_code from public.notification_deliveries
   where id = 'ca300000-0000-4000-8000-000000000011'),
  'community_backlog_full', 'H: error code is community_backlog_full');


-- ── I. Deferred not claimable before next_retry_at ──────────────────────────
-- D08 was deferred with next_retry_at in the future. The by-id claim
-- function refuses it with 'not_due'.
select is(
  (select reason from app.claim_notification_delivery(
    'ca300000-0000-4000-8000-000000000008', 300)),
  'not_due', 'I: deferred delivery is not claimable before next_retry_at');


-- ── J. Purge ────────────────────────────────────────────────────────────────
-- One row is 49 h old; three rows are 24 h + 1 s old (also > 48 h? No,
-- 24 h < 48 h). The purge target is the single row at 49 h.
select ok(
  (select app.purge_stale_send_attempts()) >= 1,
  'J: purge deletes at least one old row');
select ok(
  (select count(*) = 0 from public.notification_send_attempts
   where attempted_at < now() - interval '48 hours'),
  'J: no rows older than 48 h survive the purge');


-- ── K. Append-only enforcement ──────────────────────────────────────────────
select throws_ok($$
  update public.notification_send_attempts
  set address_key = 'tampered@evil.test'
  where true
$$, 'P0001', null, 'K: UPDATE is blocked on the ledger');

select throws_ok($$
  delete from public.notification_send_attempts
  where true
$$, 'P0001', null, 'K: DELETE is blocked without the purge flag');


-- ── L. Privileges ───────────────────────────────────────────────────────────
select is(pg_temp.try_as('anon',
  'select count(*) from public.notification_send_attempts'),
  '42501', 'L: anon cannot read the ledger');
select is(pg_temp.try_as('authenticated',
  'select count(*) from public.notification_send_attempts'),
  '42501', 'L: authenticated cannot read the ledger');
select is(pg_temp.try_as('anon',
  $$select app.reserve_email_attempt('ca300000-0000-4000-8000-000000000001')$$),
  '42501', 'L: anon cannot execute reserve_email_attempt');
select is(pg_temp.try_as('authenticated',
  $$select app.reserve_email_attempt('ca300000-0000-4000-8000-000000000001')$$),
  '42501', 'L: authenticated cannot execute reserve_email_attempt');
select is(pg_temp.try_as('anon',
  'select app.notification_send_limits()'),
  '42501', 'L: anon cannot execute notification_send_limits');
select is(pg_temp.try_as('authenticated',
  'select app.notification_send_limits()'),
  '42501', 'L: authenticated cannot execute notification_send_limits');
select is(pg_temp.try_as('anon',
  'select app.purge_stale_send_attempts()'),
  '42501', 'L: anon cannot execute purge_stale_send_attempts');
select is(pg_temp.try_as('authenticated',
  'select app.purge_stale_send_attempts()'),
  '42501', 'L: authenticated cannot execute purge_stale_send_attempts');


select * from finish();
rollback;
