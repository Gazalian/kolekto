-- ─────────────────────────────────────────────────────────────────────────────
-- 31 — Notification foundation (M13.1)
--
-- Behavioural coverage for the notification infrastructure (migrations
-- 20261007100000 + the 20261007110000 QA fixes). Structure is asserted, but the
-- bulk is behaviour: append-only enforcement actually blocking, idempotency
-- actually deduping, the audit→pgmq trigger actually enqueueing the real domain
-- actions, personal isolation under RLS, and multiple distinct recipients each
-- getting their own delivery (the BUG-3 fix).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(24);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- auth.users first (public.users references them); the auth insert fires
-- handle_new_auth_user, so public.users is upserted.
insert into auth.users (id, instance_id, aud, role, email) values
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n1@notif.example.test'),
  ('e0000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n2@notif.example.test'),
  ('e0000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'n3@notif.example.test');

insert into public.users (id, full_name, email) values
  ('e0000000-0000-4000-8000-000000000001', 'Notif One',   'n1@notif.example.test'),
  ('e0000000-0000-4000-8000-000000000002', 'Notif Two',   'n2@notif.example.test'),
  ('e0000000-0000-4000-8000-000000000003', 'Notif Three', 'n3@notif.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('e0000000-0000-4000-8000-0000000000c1', 'notif-tests', 'Notif Tests', 'fellowship', false, 'e0000000-0000-4000-8000-000000000001');

insert into public.notification_events (id, community_id, event_type, event_key, actor_type, object_type, object_id, payload) values
  ('e0000000-0000-4000-8000-0000000000e1', 'e0000000-0000-4000-8000-0000000000c1', 'collection.publish', 'qa.evt:main',  'officer', 'collection', 'e0000000-0000-4000-8000-0000000000b1', '{}'),
  ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000c1', 'collection.publish', 'qa.evt:iso',   'officer', 'collection', 'e0000000-0000-4000-8000-0000000000b2', '{}'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', 'member.join_via_invite', 'qa.evt:multi', 'member', 'member', 'e0000000-0000-4000-8000-0000000000b3', '{}');


-- ── A. Tables and B. enums exist (1–5) ──────────────────────────────────────
select has_table('public', 'notification_events', 'notification_events table exists');
select has_table('public', 'notification_deliveries', 'notification_deliveries table exists');
select has_table('public', 'notification_preferences', 'notification_preferences table exists');
select has_type('public', 'notification_channel', 'notification_channel enum exists');
select has_type('public', 'notification_delivery_status', 'notification_delivery_status enum exists');


-- ── B. RLS enabled (6–8) ─────────────────────────────────────────────────────
-- Read the catalog directly (this pgTAP build has no row_security_active/2):
-- both ENABLE and FORCE row level security must be on.
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.notification_events'::regclass),
  'RLS is enabled and forced on notification_events');
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.notification_deliveries'::regclass),
  'RLS is enabled and forced on notification_deliveries');
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.notification_preferences'::regclass),
  'RLS is enabled and forced on notification_preferences');


-- ── Idempotency indexes present (9–10) ──────────────────────────────────────
select has_index('public', 'notification_events', 'notification_events_event_key_unique',
  'event_key unique index is the idempotency gate');
select has_index('public', 'notification_deliveries', 'notification_deliveries_event_recipient_channel_key',
  'delivery dedup index on (event, recipient, channel)');


-- ── C. Append-only event protection (11–12) ─────────────────────────────────
select throws_ok(
  $$ update public.notification_events set payload = '{"x":1}' where event_key = 'qa.evt:main' $$,
  'P0001', NULL,
  'UPDATE on notification_events is blocked (append-only)');
select throws_ok(
  $$ delete from public.notification_events where event_key = 'qa.evt:main' $$,
  'P0001', NULL,
  'DELETE on notification_events is blocked (append-only)');


-- ── D. Duplicate event_key protection (13–14) ───────────────────────────────
insert into public.notification_events (community_id, event_type, event_key, actor_type, object_type, object_id, payload)
values ('e0000000-0000-4000-8000-0000000000c1', 'collection.publish', 'qa.evt:main', 'officer', 'collection', 'e0000000-0000-4000-8000-0000000000b1', '{}')
on conflict (event_key) do nothing;
select is(
  (select count(*) from public.notification_events where event_key = 'qa.evt:main')::int,
  1,
  'ON CONFLICT (event_key) DO NOTHING keeps a single event row');
select throws_ok(
  $$ insert into public.notification_events (community_id, event_type, event_key, actor_type, object_type, object_id, payload)
     values ('e0000000-0000-4000-8000-0000000000c1', 'collection.publish', 'qa.evt:main', 'officer', 'collection', 'e0000000-0000-4000-8000-0000000000b1', '{}') $$,
  '23505', NULL,
  'a plain duplicate event_key raises unique_violation');


-- ── E. Delivery idempotency (15) ─────────────────────────────────────────────
insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status)
values ('e0000000-0000-4000-8000-0000000000e1', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000001', 'in_app', 'sent')
on conflict (notification_event_id, coalesce(recipient_member_id, recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) do nothing;
insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status)
values ('e0000000-0000-4000-8000-0000000000e1', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000001', 'in_app', 'sent')
on conflict (notification_event_id, coalesce(recipient_member_id, recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) do nothing;
select is(
  (select count(*) from public.notification_deliveries where notification_event_id = 'e0000000-0000-4000-8000-0000000000e1' and recipient_user_id = 'e0000000-0000-4000-8000-000000000001')::int,
  1,
  'a duplicate (event, recipient, channel) delivery is deduped');


-- ── F/G/H/I. audit_log → pgmq enqueue for the real domain actions (16–19) ────
insert into public.audit_logs (actor_type, actor_name_snapshot, action, object_type, object_id, community_id)
values ('officer', 'QA', 'collection.publish', 'collection', 'e0000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000c1');
select is(
  (select count(*) from pgmq.q_notification_events where (message->>'community_id') = 'e0000000-0000-4000-8000-0000000000c1' and (message->>'action') = 'collection.publish')::int,
  1,
  'collection.publish audit row enqueues a notification event');

insert into public.audit_logs (actor_type, actor_name_snapshot, action, object_type, object_id, community_id)
values ('officer', 'QA', 'member.approve_join', 'member', 'e0000000-0000-4000-8000-0000000000a2', 'e0000000-0000-4000-8000-0000000000c1');
select is(
  (select count(*) from pgmq.q_notification_events where (message->>'community_id') = 'e0000000-0000-4000-8000-0000000000c1' and (message->>'action') = 'member.approve_join')::int,
  1,
  'member.approve_join audit row enqueues a notification event');

insert into public.audit_logs (actor_type, actor_name_snapshot, action, object_type, object_id, community_id)
values ('member', 'QA', 'member.join_via_invite', 'member', 'e0000000-0000-4000-8000-0000000000a3', 'e0000000-0000-4000-8000-0000000000c1');
select is(
  (select count(*) from pgmq.q_notification_events where (message->>'community_id') = 'e0000000-0000-4000-8000-0000000000c1' and (message->>'action') = 'member.join_via_invite')::int,
  1,
  'member.join_via_invite audit row enqueues a notification event');

insert into public.audit_logs (actor_type, actor_name_snapshot, action, object_type, object_id, community_id)
values ('officer', 'QA', 'member.edit', 'member', 'e0000000-0000-4000-8000-0000000000a4', 'e0000000-0000-4000-8000-0000000000c1');
select is(
  (select count(*) from pgmq.q_notification_events where (message->>'community_id') = 'e0000000-0000-4000-8000-0000000000c1' and (message->>'action') = 'member.edit')::int,
  0,
  'an unrelated audit action does NOT enqueue a notification event');


-- ── J. Personal isolation under RLS (20–21) ─────────────────────────────────
insert into public.notification_deliveries (id, notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status) values
  ('e0000000-0000-4000-8000-00000000d001', 'e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000001', 'in_app', 'sent'),
  ('e0000000-0000-4000-8000-00000000d002', 'e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000002', 'in_app', 'sent');

set local role authenticated;
set local request.jwt.claims = '{"sub":"e0000000-0000-4000-8000-000000000001","role":"authenticated"}';
create temporary table iso_visible as
  select id from public.notification_deliveries
  where id in ('e0000000-0000-4000-8000-00000000d001', 'e0000000-0000-4000-8000-00000000d002');
reset role;

select is((select count(*) from iso_visible)::int, 1,
  'a non-officer user sees only their own in-app delivery');
select is((select count(*) from iso_visible where id = 'e0000000-0000-4000-8000-00000000d002')::int, 0,
  'a non-officer user cannot see another user''s personal delivery');


-- ── K. Anonymous access denied (22) ──────────────────────────────────────────
select ok(
  not has_table_privilege('anon', 'public.notification_deliveries', 'SELECT'),
  'anon has no SELECT privilege on notification_deliveries');


-- ── L. Multiple distinct recipients each get a delivery (BUG-3) (23–24) ──────
-- Three distinct in-app recipients (e.g. officers) with a NULL recipient_member_id.
insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status) values
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000001', 'in_app', 'sent'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000002', 'in_app', 'sent'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000003', 'in_app', 'sent')
on conflict (notification_event_id, coalesce(recipient_member_id, recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) do nothing;
select is(
  (select count(*) from public.notification_deliveries where notification_event_id = 'e0000000-0000-4000-8000-0000000000e3')::int,
  3,
  'three distinct recipients produce three deliveries (not collapsed)');

-- Replay the identical three: idempotency must keep three, not make six.
insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status) values
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000001', 'in_app', 'sent'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000002', 'in_app', 'sent'),
  ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-0000000000c1', null, 'e0000000-0000-4000-8000-000000000003', 'in_app', 'sent')
on conflict (notification_event_id, coalesce(recipient_member_id, recipient_user_id, '00000000-0000-0000-0000-000000000000'::uuid), channel) do nothing;
select is(
  (select count(*) from public.notification_deliveries where notification_event_id = 'e0000000-0000-4000-8000-0000000000e3')::int,
  3,
  'replaying the same three recipients keeps three deliveries (idempotent)');


select * from finish();
rollback;
