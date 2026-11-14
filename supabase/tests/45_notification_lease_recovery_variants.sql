-- ─────────────────────────────────────────────────────────────────────────────
-- 45 — Ambiguous lease recovery (M13.2 P9-4)
--
-- Migration 20261025100000. What is proved here:
--
--   A. Schema: app.resolve_lease_ambiguous(uuid) exists.
--   B. Preconditions:
--        · a non-sending row returns (false, 'not_leased')
--        · a sending row with a live (future) lease returns
--          (false, 'lease_still_valid') and is unchanged
--        · a sending row with an expired lease transitions to
--          dead / outcome_unknown and clears the lease
--   C. Serialisation: a second call on the same expired-lease row (after a
--      first call has turned it dead) returns 'not_leased' and does not
--      disturb the terminal state.
--   D. dead_by_code in the health snapshot includes outcome_unknown after
--      the resolve runs.
--   E. recover_expired_notification_lease is untouched: an expired-lease
--      row it processes still goes back to pending (sibling path intact).
--   F. No client role (anon, authenticated) can execute the new function.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(22);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('eb000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p94.example.test', now());
insert into public.users (id, full_name, email) values
  ('eb000000-0000-4000-8000-000000000001', 'P94 Owner', 'owner@p94.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('eb100000-0000-4000-8000-000000000001', 'p94-lease', 'P94 Lease', 'social_group', false, 'eb000000-0000-4000-8000-000000000001');

insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('eb200000-0000-4000-8000-000000000001', 'eb100000-0000-4000-8000-000000000001', 'member.create', 'p94-01', 'officer', 'eb000000-0000-4000-8000-000000000001', 'member', 'eb300000-0000-4000-8000-000000000001', '{}'),
  ('eb200000-0000-4000-8000-000000000002', 'eb100000-0000-4000-8000-000000000001', 'member.create', 'p94-02', 'officer', 'eb000000-0000-4000-8000-000000000001', 'member', 'eb300000-0000-4000-8000-000000000002', '{}'),
  ('eb200000-0000-4000-8000-000000000003', 'eb100000-0000-4000-8000-000000000001', 'member.create', 'p94-03', 'officer', 'eb000000-0000-4000-8000-000000000001', 'member', 'eb300000-0000-4000-8000-000000000003', '{}'),
  ('eb200000-0000-4000-8000-000000000004', 'eb100000-0000-4000-8000-000000000001', 'member.create', 'p94-04', 'officer', 'eb000000-0000-4000-8000-000000000001', 'member', 'eb300000-0000-4000-8000-000000000004', '{}');

-- D1: sending with EXPIRED lease (target of a happy-path ambiguous resolve).
-- D2: sending with LIVE lease (must be refused).
-- D3: pending (not sending — must return 'not_leased').
-- D4: sending with EXPIRED lease (used by section E to prove the sibling
--     recover_expired_notification_lease still routes to pending).
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status,
   recipient_address, recipient_address_assurance, attempt_count,
   send_lease_token, send_lease_expires_at, send_class)
values
  ('eb300000-0000-4000-8000-000000000001', 'eb200000-0000-4000-8000-000000000001', 'eb100000-0000-4000-8000-000000000001', 'email', 'sending',
   'd1@p94.example.test', 'unverified_supplied', 1,
   lpad('a', 64, 'a'), now() - interval '1 minute', 'transactional'),
  ('eb300000-0000-4000-8000-000000000002', 'eb200000-0000-4000-8000-000000000002', 'eb100000-0000-4000-8000-000000000001', 'email', 'sending',
   'd2@p94.example.test', 'unverified_supplied', 1,
   lpad('b', 64, 'b'), now() + interval '5 minutes', 'transactional'),
  ('eb300000-0000-4000-8000-000000000003', 'eb200000-0000-4000-8000-000000000003', 'eb100000-0000-4000-8000-000000000001', 'email', 'pending',
   'd3@p94.example.test', 'unverified_supplied', 0,
   null, null, 'transactional'),
  ('eb300000-0000-4000-8000-000000000004', 'eb200000-0000-4000-8000-000000000004', 'eb100000-0000-4000-8000-000000000001', 'email', 'sending',
   'd4@p94.example.test', 'unverified_supplied', 1,
   lpad('c', 64, 'c'), now() - interval '2 minutes', 'transactional');


-- Helper: role-switched call.
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
select has_function('app', 'resolve_lease_ambiguous', ARRAY['uuid'],
  'A: app.resolve_lease_ambiguous(uuid) exists');


-- ── B. Preconditions ────────────────────────────────────────────────────────

-- Pending row (D3): not_leased.
select is(
  (select reason from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000003'::uuid)),
  'not_leased',
  'B: a pending row returns not_leased');
select is(
  (select resolved from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000003'::uuid)),
  false,
  'B: a pending row is NOT resolved');
select is(
  (select status::text from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000003'::uuid),
  'pending',
  'B: a pending row stays pending (untouched)');

-- Live-lease row (D2): lease_still_valid, row unchanged.
select is(
  (select reason from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000002'::uuid)),
  'lease_still_valid',
  'B: a live-lease sending row returns lease_still_valid');
select is(
  (select resolved from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000002'::uuid)),
  false,
  'B: a live-lease row is NOT resolved');
select is(
  (select status::text from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000002'::uuid),
  'sending',
  'B: a live-lease row stays sending');
select is(
  (select send_lease_token from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000002'::uuid),
  lpad('b', 64, 'b'),
  'B: a live-lease row keeps its token');

-- Expired-lease row (D1): happy-path resolve. The function is state-
-- mutating, so a single call captures reason + resolved for assertion;
-- a second call would see the now-terminal row and return not_leased
-- (that behaviour is proved separately in section C).
create temp table d1_result as
  select * from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000001'::uuid);

select is((select reason   from d1_result), 'dead',
  'B: an expired-lease row returns reason=dead');
select is((select resolved from d1_result), true,
  'B: an expired-lease row IS resolved');
select is(
  (select status::text from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  'dead',
  'B: resolved row is dead');
select is(
  (select error_code from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  'outcome_unknown',
  'B: resolved row carries outcome_unknown');
select is(
  (select send_lease_token from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  null,
  'B: resolved row has its lease token cleared (old holder can never settle)');
select is(
  (select send_lease_expires_at from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  null,
  'B: resolved row has its lease expiry cleared');
select is(
  (select provider_message_id from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  null,
  'B: resolved row has no provider_message_id (crash before record)');


-- ── C. A second call on the now-dead row is a no-op ────────────────────────
select is(
  (select reason from app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000001'::uuid)),
  'not_leased',
  'C: second call on the resolved row returns not_leased');
select is(
  (select status::text from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000001'::uuid),
  'dead',
  'C: resolved row stays dead after second call');


-- ── D. Health snapshot picks up outcome_unknown ────────────────────────────
-- The dead_24h tally is a count by code within the last 24 hours; the row
-- just resolved should land in dead_by_code['outcome_unknown'].
select is(
  (select coalesce((dead_by_code->>'outcome_unknown')::int, 0) >= 1
     from app.notification_send_health()),
  true,
  'D: dead_by_code includes outcome_unknown >= 1 after the resolve');


-- ── E. Sibling recover_expired_notification_lease still routes to pending ──
-- D4 is an expired-lease sending row, same shape as D1 was. The sibling
-- function remains the idempotent-provider path and must still return it
-- to pending.
select is(
  (select recovered from app.recover_expired_notification_lease('eb300000-0000-4000-8000-000000000004'::uuid)),
  true,
  'E: sibling recover_expired_notification_lease still recovers an expired-lease row');
select is(
  (select status::text from public.notification_deliveries where id = 'eb300000-0000-4000-8000-000000000004'::uuid),
  'pending',
  'E: sibling path still routes to pending (idempotent-provider recovery)');


-- ── F. No client role may execute the new function ─────────────────────────
select is(pg_temp.try_as('anon',
  $$select app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000001'::uuid)$$),
  '42501', 'F: anon cannot execute resolve_lease_ambiguous');
select is(pg_temp.try_as('authenticated',
  $$select app.resolve_lease_ambiguous('eb300000-0000-4000-8000-000000000001'::uuid)$$),
  '42501', 'F: authenticated cannot execute resolve_lease_ambiguous');


select * from finish();
rollback;
