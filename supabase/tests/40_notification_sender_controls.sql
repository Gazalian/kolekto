-- ─────────────────────────────────────────────────────────────────────────────
-- 40 — Sender controls: pause switch, 72-hour expiry, health view (M13.2 P5/P5-5)
--
-- Migration 20261019140000. What is proved here:
--
--   A. The notification_sender_state table, the five app.* functions and the
--      private.v_notification_send_health view exist, and the table has RLS
--      enabled and forced.
--   B. The pause switch defaults OFF, and the setter flips it both ways.
--   C. The heartbeat records a tick, and only a claiming tick advances
--      last_claim_at.
--   D. 72-hour expiry turns a stale pending email row into dead / event_too_old,
--      leaves a row still within its 72-hour life pending, and never touches a
--      sending (in-flight) row regardless of age.
--   E. The health snapshot returns exactly one row that reflects the pause
--      state, counts a due pending row, and breaks terminal outcomes down by
--      code.
--   F. No client role can read the state table or the view, or execute any of
--      the five functions.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(41);


-- ── A. Objects exist ─────────────────────────────────────────────────────────
select has_table('public', 'notification_sender_state', 'A: sender-state table exists');
select has_view('private', 'v_notification_send_health', 'A: health view exists');
select has_function('app', 'email_sending_enabled', 'A: email_sending_enabled() exists');
select has_function('app', 'set_email_sending_enabled', ARRAY['boolean'], 'A: set_email_sending_enabled(boolean) exists');
select has_function('app', 'record_sender_heartbeat', ARRAY['boolean'], 'A: record_sender_heartbeat(boolean) exists');
select has_function('app', 'expire_stale_notification_deliveries', ARRAY['integer'], 'A: expire_stale_notification_deliveries(integer) exists');
select has_function('app', 'notification_send_health', 'A: notification_send_health() exists');

select is(
  (select relrowsecurity from pg_class where oid = 'public.notification_sender_state'::regclass),
  true, 'A: RLS enabled on the state table');
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.notification_sender_state'::regclass),
  true, 'A: RLS forced on the state table');


-- ── B. Pause switch defaults off and flips both ways ─────────────────────────
select is(app.email_sending_enabled(), false, 'B: pause switch defaults OFF');
select is(app.set_email_sending_enabled(true), true, 'B: setter returns the new value (on)');
select is(app.email_sending_enabled(), true, 'B: switch now ON');
select is(app.set_email_sending_enabled(false), false, 'B: setter returns the new value (off)');
select is(app.email_sending_enabled(), false, 'B: switch OFF again');


-- ── C. Heartbeat ─────────────────────────────────────────────────────────────
-- Reset the singleton's timestamps first: the live row may already carry a
-- heartbeat from an earlier committed run, and this transaction rolls back.
update public.notification_sender_state set last_heartbeat_at = null, last_claim_at = null where id;
do $$ begin perform app.record_sender_heartbeat(false); end $$;
select is(
  (select last_heartbeat_at is not null from public.notification_sender_state where id),
  true, 'C: a tick stamps last_heartbeat_at');
select is(
  (select last_claim_at is null from public.notification_sender_state where id),
  true, 'C: a non-claiming tick leaves last_claim_at null');
do $$ begin perform app.record_sender_heartbeat(true); end $$;
select is(
  (select last_claim_at is not null from public.notification_sender_state where id),
  true, 'C: a claiming tick advances last_claim_at');


-- ── Fixtures for expiry and health ───────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('da000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p55.example.test', now());
insert into public.users (id, full_name, email) values
  ('da000000-0000-4000-8000-000000000001', 'P55 Owner', 'owner@p55.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('da100000-0000-4000-8000-000000000001', 'p55-01', 'P55 01', 'social_group', false, 'da000000-0000-4000-8000-000000000001');

insert into public.notification_events
  (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
values
  ('da200000-0000-4000-8000-000000000001', 'da100000-0000-4000-8000-000000000001', 'member.create', 'p55-stale', 'officer', 'da000000-0000-4000-8000-000000000001', 'member', 'da300000-0000-4000-8000-000000000001', '{}'),
  ('da200000-0000-4000-8000-000000000002', 'da100000-0000-4000-8000-000000000001', 'member.create', 'p55-fresh', 'officer', 'da000000-0000-4000-8000-000000000001', 'member', 'da300000-0000-4000-8000-000000000002', '{}'),
  ('da200000-0000-4000-8000-000000000003', 'da100000-0000-4000-8000-000000000001', 'member.create', 'p55-send',  'officer', 'da000000-0000-4000-8000-000000000001', 'member', 'da300000-0000-4000-8000-000000000003', '{}');

-- stale: 73 h old pending (past its 72-hour life).  fresh: 71 h old pending (within it).
-- send:  1 h old pending, claimed below into `sending`, then aged to 100 h.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count, created_at)
values
  ('da300000-0000-4000-8000-000000000001', 'da200000-0000-4000-8000-000000000001', 'da100000-0000-4000-8000-000000000001', 'email', 'pending', 'stale@p55.example.test', 'unverified_supplied', 0, now() - interval '73 hours'),
  ('da300000-0000-4000-8000-000000000002', 'da200000-0000-4000-8000-000000000002', 'da100000-0000-4000-8000-000000000001', 'email', 'pending', 'fresh@p55.example.test', 'unverified_supplied', 0, now() - interval '71 hours'),
  ('da300000-0000-4000-8000-000000000003', 'da200000-0000-4000-8000-000000000003', 'da100000-0000-4000-8000-000000000001', 'email', 'pending', 'send@p55.example.test',  'unverified_supplied', 0, now() - interval '1 hour');

-- Put the send row into `sending` with a lease, then age it past 72 h.
do $$ begin perform * from app.claim_notification_delivery('da300000-0000-4000-8000-000000000003', 300); end $$;
update public.notification_deliveries
  set created_at = now() - interval '100 hours'
  where id = 'da300000-0000-4000-8000-000000000003';


-- ── D. 72-hour expiry ────────────────────────────────────────────────────────
select ok(
  app.expire_stale_notification_deliveries(72) >= 1,
  'D: at least one stale delivery expired');
select is(
  (select status::text from public.notification_deliveries where id = 'da300000-0000-4000-8000-000000000001'),
  'dead', 'D: the 73h pending row is dead');
select is(
  (select error_code from public.notification_deliveries where id = 'da300000-0000-4000-8000-000000000001'),
  'event_too_old', 'D: expired row carries event_too_old');
select is(
  (select status::text from public.notification_deliveries where id = 'da300000-0000-4000-8000-000000000002'),
  'pending', 'D: the 71h row is still within its 72-hour life');
select is(
  (select status::text from public.notification_deliveries where id = 'da300000-0000-4000-8000-000000000003'),
  'sending', 'D: an in-flight (sending) row is never expired by age');


-- ── E. Health snapshot ───────────────────────────────────────────────────────
select is(
  (select count(*)::int from app.notification_send_health()),
  1, 'E: health returns exactly one row');
select is(
  (select email_sending_enabled from app.notification_send_health()),
  false, 'E: health reflects the pause state (off)');
select ok(
  (select pending_due from app.notification_send_health()) >= 1,
  'E: health counts the due pending row');
select is(
  (select (dead_by_code ? 'event_too_old') from app.notification_send_health()),
  true, 'E: dead outcomes are broken down by code');
select is(
  (select count(*)::int from private.v_notification_send_health),
  1, 'E: the view returns one row over the owner connection');


-- ── F. No client role may read or execute ────────────────────────────────────
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

select is(pg_temp.try_as('anon',          'select * from public.notification_sender_state'), '42501', 'F: anon cannot read the state table');
select is(pg_temp.try_as('authenticated', 'select * from public.notification_sender_state'), '42501', 'F: authenticated cannot read the state table');
select is(pg_temp.try_as('anon',          'select * from private.v_notification_send_health'), '42501', 'F: anon cannot read the health view');
select is(pg_temp.try_as('authenticated', 'select * from private.v_notification_send_health'), '42501', 'F: authenticated cannot read the health view');
select is(pg_temp.try_as('anon',          'select app.email_sending_enabled()'), '42501', 'F: anon cannot execute email_sending_enabled');
select is(pg_temp.try_as('authenticated', 'select app.email_sending_enabled()'), '42501', 'F: authenticated cannot execute email_sending_enabled');
select is(pg_temp.try_as('anon',          'select app.set_email_sending_enabled(true)'), '42501', 'F: anon cannot execute set_email_sending_enabled');
select is(pg_temp.try_as('authenticated', 'select app.set_email_sending_enabled(true)'), '42501', 'F: authenticated cannot execute set_email_sending_enabled');
select is(pg_temp.try_as('anon',          'select app.record_sender_heartbeat(false)'), '42501', 'F: anon cannot execute record_sender_heartbeat');
select is(pg_temp.try_as('authenticated', 'select app.record_sender_heartbeat(false)'), '42501', 'F: authenticated cannot execute record_sender_heartbeat');
select is(pg_temp.try_as('anon',          'select app.expire_stale_notification_deliveries(72)'), '42501', 'F: anon cannot execute expire_stale_notification_deliveries');
select is(pg_temp.try_as('authenticated', 'select app.expire_stale_notification_deliveries(72)'), '42501', 'F: authenticated cannot execute expire_stale_notification_deliveries');
select is(pg_temp.try_as('anon',          'select * from app.notification_send_health()'), '42501', 'F: anon cannot execute notification_send_health');
select is(pg_temp.try_as('authenticated', 'select * from app.notification_send_health()'), '42501', 'F: authenticated cannot execute notification_send_health');


select * from finish();
rollback;
