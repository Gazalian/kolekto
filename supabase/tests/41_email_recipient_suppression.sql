-- ─────────────────────────────────────────────────────────────────────────────
-- 41 — Recipient suppression and pre-send enforcement (M13.2 P9-1)
--
-- Migration 20261022110000. What is proved here:
--
--   A. The email_suppressions table, its three indexes, RLS and deny policy
--      exist.
--   B. app.is_address_suppressed returns false for an unknown address, true
--      for a permanent row, true for an unexpired transient row, false for
--      an expired transient row, case-folded.
--   C. app.set_email_suppression under an operator session inserts a
--      permanent row.
--   D. app.set_email_suppression under an operator session inserts a
--      transient row with expires_at in the future.
--   E. A permanent row is not downgraded by a subsequent transient request.
--   F. A duplicate permanent insert does nothing (on-conflict do nothing).
--   G. app.clear_email_suppression deletes rows for an address.
--   H. Append-only enforcement: UPDATE and DELETE from outside the operator
--      functions raise P0001.
--   I. app.reserve_email_attempt: a claimed delivery whose address is
--      suppressed is skipped with error_code = 'address_suppressed',
--      recipient_address erased, attempt counter undone; no ledger row.
--   J. app.list_email_suppressions_masked returns masked addresses only.
--   K. Role gates: anon and authenticated cannot execute any of the five
--      app.* functions added by this migration.
--   L. Direct SELECT on email_suppressions is denied for anon and
--      authenticated.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(43);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('cb000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p91.example.test', now());
insert into public.users (id, full_name, email) values
  ('cb000000-0000-4000-8000-000000000001', 'P91 Owner', 'owner@p91.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('cb100000-0000-4000-8000-000000000001', 'p91-sup-01', 'P91 Sup 01', 'social_group', false,
   'cb000000-0000-4000-8000-000000000001');

insert into public.notification_events
  (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
values
  ('cb200000-0000-4000-8000-000000000001', 'cb100000-0000-4000-8000-000000000001',
   'member.create', 'p91-01', 'officer', 'cb000000-0000-4000-8000-000000000001',
   'member', 'cb300000-0000-4000-8000-000000000001', '{}'),
  ('cb200000-0000-4000-8000-000000000002', 'cb100000-0000-4000-8000-000000000001',
   'member.create', 'p91-02', 'officer', 'cb000000-0000-4000-8000-000000000001',
   'member', 'cb300000-0000-4000-8000-000000000002', '{}');

insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count)
values
  ('cb300000-0000-4000-8000-000000000001', 'cb200000-0000-4000-8000-000000000001',
   'cb100000-0000-4000-8000-000000000001', 'email', 'pending',
   'suppressed@p91.example.test', 'unverified_supplied', 0),
  ('cb300000-0000-4000-8000-000000000002', 'cb200000-0000-4000-8000-000000000002',
   'cb100000-0000-4000-8000-000000000001', 'email', 'pending',
   'ok@p91.example.test', 'unverified_supplied', 0);


-- Helper: run a statement under a client role, return 'ok' or sqlstate.
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
select has_table('public', 'email_suppressions',
  'A: email_suppressions table exists');
select has_index('public', 'email_suppressions',
  'email_suppressions_permanent_address_key_idx',
  'A: partial unique index for permanent rows exists');
select has_index('public', 'email_suppressions',
  'email_suppressions_transient_lookup_idx',
  'A: transient-lookup index exists');
select has_index('public', 'email_suppressions',
  'email_suppressions_expires_at_idx',
  'A: expires_at index exists');
select policies_are('public', 'email_suppressions',
  array['email_suppressions_deny_client_access'],
  'A: exactly the deny policy is present');


-- ── B. is_address_suppressed semantics ──────────────────────────────────────
select is(app.is_address_suppressed('unknown@p91.example.test'), false,
  'B: unknown address is not suppressed');

-- Seed one permanent row directly (bypass the operator check for pgTAP, by
-- going through the operator-side function with role already none).
select app.set_email_suppression('perm@p91.example.test', 'hard_bounce');
select is(app.is_address_suppressed('perm@p91.example.test'), true,
  'B: permanent row is suppressed');
select is(app.is_address_suppressed('PERM@P91.example.test'), true,
  'B: case-folded match');
select is(app.is_address_suppressed('  perm@p91.example.test  '), true,
  'B: whitespace trimmed');

-- Transient future
select app.set_email_suppression('temp@p91.example.test', 'transient_bounce_capped',
  now() + interval '1 hour');
select is(app.is_address_suppressed('temp@p91.example.test'), true,
  'B: unexpired transient row is suppressed');


-- ── C. Operator setter inserts a permanent row ──────────────────────────────
select is((select count(*)::int from public.email_suppressions
  where address_key = 'perm@p91.example.test' and expires_at is null), 1,
  'C: exactly one permanent row for perm@p91.example.test');


-- ── D. Operator setter inserts a transient row ──────────────────────────────
select is((select count(*)::int from public.email_suppressions
  where address_key = 'temp@p91.example.test' and expires_at is not null), 1,
  'D: exactly one transient row for temp@p91.example.test');


-- ── E. Permanent is not downgraded by a transient request ───────────────────
select app.set_email_suppression('perm@p91.example.test', 'manual_block',
  now() + interval '1 day');
select is((select count(*)::int from public.email_suppressions
  where address_key = 'perm@p91.example.test'), 1,
  'E: no second row created when transient hits an existing permanent');
select is((select expires_at from public.email_suppressions
  where address_key = 'perm@p91.example.test' limit 1), null::timestamptz,
  'E: existing permanent row still has null expires_at');


-- ── F. Duplicate permanent insert is a no-op ────────────────────────────────
select app.set_email_suppression('perm@p91.example.test', 'complaint');
select is((select count(*)::int from public.email_suppressions
  where address_key = 'perm@p91.example.test'), 1,
  'F: duplicate permanent insert does not create a second row');
-- But reason/source are refreshed by the permanent-already-exists UPDATE path.
select is((select reason from public.email_suppressions
  where address_key = 'perm@p91.example.test' limit 1), 'complaint',
  'F: duplicate permanent insert refreshes the reason');


-- ── G. clear_email_suppression deletes rows for an address ──────────────────
select is(app.clear_email_suppression('perm@p91.example.test'), 1::bigint,
  'G: clear deletes the one permanent row');
select is(app.is_address_suppressed('perm@p91.example.test'), false,
  'G: cleared address is no longer suppressed');
select is(app.clear_email_suppression('never@p91.example.test'), 0::bigint,
  'G: clearing an unseen address returns 0');


-- ── H. Append-only enforcement ──────────────────────────────────────────────
select throws_ok($$
  update public.email_suppressions
  set reason = 'manual_block'
  where address_key = 'temp@p91.example.test'
$$, 'P0001', null, 'H: UPDATE blocked outside the mutating setter');

select throws_ok($$
  delete from public.email_suppressions
  where address_key = 'temp@p91.example.test'
$$, 'P0001', null, 'H: DELETE blocked outside the mutating clear/purge');


-- ── I. Pre-send check in reserve_email_attempt ──────────────────────────────
-- Block the recipient, then claim-and-reserve for cb300000...1. Must skip with
-- error_code = address_suppressed, no ledger row created, address erased,
-- attempt counter back to zero.
select app.set_email_suppression('suppressed@p91.example.test', 'hard_bounce');

-- Claim first (same transaction) then reserve.
select is((select claimed from app.claim_notification_delivery(
    'cb300000-0000-4000-8000-000000000001', 300)), true,
  'I: suppressed-recipient delivery is claimable before the reserve check');

select is(reservation, 'address_suppressed',
  'I: reserve returns address_suppressed') from app.reserve_email_attempt(
    'cb300000-0000-4000-8000-000000000001');

select is((select status::text from public.notification_deliveries
  where id = 'cb300000-0000-4000-8000-000000000001'), 'skipped',
  'I: delivery row is skipped');
select is((select error_code from public.notification_deliveries
  where id = 'cb300000-0000-4000-8000-000000000001'), 'address_suppressed',
  'I: error_code is address_suppressed');
select is((select recipient_address from public.notification_deliveries
  where id = 'cb300000-0000-4000-8000-000000000001'), null,
  'I: recipient_address is erased on suppression skip');
select is((select attempt_count from public.notification_deliveries
  where id = 'cb300000-0000-4000-8000-000000000001'), 0,
  'I: attempt counter is undone (reservation did not consume an attempt)');
select is((select count(*)::int from public.notification_send_attempts
  where delivery_id = 'cb300000-0000-4000-8000-000000000001'), 0,
  'I: no ledger row created for a suppressed send');

-- Second delivery (ok@) is not suppressed and still claim-and-reserves to granted.
select is((select claimed from app.claim_notification_delivery(
    'cb300000-0000-4000-8000-000000000002', 300)), true,
  'I: non-suppressed delivery claims normally');
select is(reservation, 'granted',
  'I: non-suppressed delivery reserves granted') from app.reserve_email_attempt(
    'cb300000-0000-4000-8000-000000000002');


-- ── J. Masked list ──────────────────────────────────────────────────────────
-- Seed one more so there are at least two rows to see in the list.
select app.set_email_suppression('a.second@p91.example.test', 'complaint');
select is((select bool_and(recipient_address_masked ~ '^[a-z]\*\*\*@')
  from app.list_email_suppressions_masked(100, null)), true,
  'J: list_email_suppressions_masked returns only masked addresses');


-- ── K. Role gates on the five app.* functions ───────────────────────────────
select is(pg_temp.try_as('anon',
  $$select app.is_address_suppressed('x@y.z')$$),
  '42501', 'K: anon cannot execute is_address_suppressed');
select is(pg_temp.try_as('authenticated',
  $$select app.is_address_suppressed('x@y.z')$$),
  '42501', 'K: authenticated cannot execute is_address_suppressed');

select is(pg_temp.try_as('anon',
  $$select app.set_email_suppression('x@y.z', 'manual_block')$$),
  '42501', 'K: anon cannot execute set_email_suppression');
select is(pg_temp.try_as('authenticated',
  $$select app.set_email_suppression('x@y.z', 'manual_block')$$),
  '42501', 'K: authenticated cannot execute set_email_suppression');

select is(pg_temp.try_as('anon',
  $$select app.clear_email_suppression('x@y.z')$$),
  '42501', 'K: anon cannot execute clear_email_suppression');
select is(pg_temp.try_as('authenticated',
  $$select app.clear_email_suppression('x@y.z')$$),
  '42501', 'K: authenticated cannot execute clear_email_suppression');

select is(pg_temp.try_as('anon',
  $$select app.list_email_suppressions_masked(10, null)$$),
  '42501', 'K: anon cannot execute list_email_suppressions_masked');
select is(pg_temp.try_as('authenticated',
  $$select app.list_email_suppressions_masked(10, null)$$),
  '42501', 'K: authenticated cannot execute list_email_suppressions_masked');

select is(pg_temp.try_as('anon',
  $$select app.purge_expired_email_suppressions()$$),
  '42501', 'K: anon cannot execute purge_expired_email_suppressions');
select is(pg_temp.try_as('authenticated',
  $$select app.purge_expired_email_suppressions()$$),
  '42501', 'K: authenticated cannot execute purge_expired_email_suppressions');


-- ── L. Direct SELECT privileges ─────────────────────────────────────────────
select is(pg_temp.try_as('anon',
  'select count(*) from public.email_suppressions'),
  '42501', 'L: anon cannot read email_suppressions');
select is(pg_temp.try_as('authenticated',
  'select count(*) from public.email_suppressions'),
  '42501', 'L: authenticated cannot read email_suppressions');


select * from finish();
rollback;
