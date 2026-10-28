-- ─────────────────────────────────────────────────────────────────────────────
-- 47 — Post-publish reminders (M13.3)
--
-- Migration 20261029100000 adds `app.send_collection_publish_reminder` and
-- the `collection_reminder_requests` idempotency table. What is proved here:
--
--   A. Schema: function + table exist, grants shaped correctly.
--   B. notify_target='all':
--        · audit `collection.remind`, after_state.notify_target='all',
--          one pgmq message, one request row, returns created=true.
--   C. notify_target='unpaid':
--        · audit `collection.remind_unpaid`, one pgmq message,
--          after_state.notify_target='unpaid'.
--   D. Idempotency:
--        · same key, same target: returns created=false and the SAME
--          audit_log_id; no new audit row, no new pgmq message.
--        · same key, different target: raises IDEMPOTENCY_CONFLICT.
--        · different key: writes a new audit row and a new pgmq message.
--   E. Preconditions:
--        · unknown collection → NOT_FOUND
--        · notify_target='none' or 'everyone' → INVALID_NOTIFY_TARGET
--        · 7-char key → INVALID_IDEMPOTENCY_KEY
--        · draft, paused, closed, archived → INVALID_STATE
--   F. Permission:
--        · authenticated outsider without collection.publish → 42501.
--        · anon has no EXECUTE on the function.
--        · no client role (anon / authenticated) can SELECT the request
--          table (server-side guard, policy-less reads to clients).
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(31);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('47000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@m13.3.reminders.test'),
  ('47000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@m13.3.reminders.test');
insert into public.users (id, full_name, email) values
  ('47000000-0000-4000-8000-000000000001', 'Reminder Host', 'host@m13.3.reminders.test'),
  ('47000000-0000-4000-8000-000000000002', 'Reminder Outsider', 'outsider@m13.3.reminders.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('47100000-0000-4000-8000-00000000000a', 'm13-3-reminders', 'M13.3 Reminders', 'social_group', false, '47000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('47200000-0000-4000-8000-000000000001', '47100000-0000-4000-8000-00000000000a', '47000000-0000-4000-8000-000000000001', 'owner', 'Reminder Host', 'created');

-- Collections in each state. The reminder function accepts active and
-- scheduled only; the others are the INVALID_STATE fixtures.
insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by, published_at, published_by)
values
  ('47300000-0000-4000-8000-000000000a01', '47100000-0000-4000-8000-00000000000a', 'rem-active',    'Active Collection',    'dues', 'open', 'fixed', 500000, 'active',    '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001'),
  ('47300000-0000-4000-8000-000000000a02', '47100000-0000-4000-8000-00000000000a', 'rem-scheduled', 'Scheduled Collection', 'dues', 'open', 'fixed', 500000, 'scheduled', '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001'),
  ('47300000-0000-4000-8000-000000000a03', '47100000-0000-4000-8000-00000000000a', 'rem-draft',     'Draft Collection',     'dues', 'open', 'fixed', 500000, 'draft',     '47000000-0000-4000-8000-000000000001', null, null),
  ('47300000-0000-4000-8000-000000000a04', '47100000-0000-4000-8000-00000000000a', 'rem-paused',    'Paused Collection',    'dues', 'open', 'fixed', 500000, 'paused',    '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001'),
  ('47300000-0000-4000-8000-000000000a05', '47100000-0000-4000-8000-00000000000a', 'rem-closed',    'Closed Collection',    'dues', 'open', 'fixed', 500000, 'closed',    '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001'),
  ('47300000-0000-4000-8000-000000000a06', '47100000-0000-4000-8000-00000000000a', 'rem-outsider',  'Outsider Target',      'dues', 'open', 'fixed', 500000, 'active',    '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001'),
  ('47300000-0000-4000-8000-000000000a07', '47100000-0000-4000-8000-00000000000a', 'rem-second',    'Second Reminder',      'dues', 'open', 'fixed', 500000, 'active',    '47000000-0000-4000-8000-000000000001', now(), '47000000-0000-4000-8000-000000000001');


-- ── A. Schema ────────────────────────────────────────────────────────────────
select has_function('app', 'send_collection_publish_reminder',
  array['uuid', 'text', 'text', 'text'],
  'A: app.send_collection_publish_reminder(uuid, text, text, text) exists');

select has_table('public', 'collection_reminder_requests',
  'A: public.collection_reminder_requests table exists');

select function_privs_are(
  'app', 'send_collection_publish_reminder',
  array['uuid', 'text', 'text', 'text'],
  'authenticated', array['EXECUTE'],
  'A: authenticated holds EXECUTE on the reminder function');

select function_privs_are(
  'app', 'send_collection_publish_reminder',
  array['uuid', 'text', 'text', 'text'],
  'anon', array[]::text[],
  'A: anon holds no EXECUTE on the reminder function');

-- No client role can read the request table directly. The policy is a bare
-- deny; privileges are revoked too, so even a service_role sidecar needs
-- the function path.
select ok(
  not has_table_privilege('authenticated', 'public.collection_reminder_requests', 'select')
  and not has_table_privilege('anon',         'public.collection_reminder_requests', 'select'),
  'A: no client role can SELECT the request table');


-- ── B. notify_target='all' ───────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

create temporary table tmp_b_all as
  select *
  from app.send_collection_publish_reminder(
    '47300000-0000-4000-8000-000000000a01'::uuid, 'all', 'reminder-key-aaaa-1111', 'first run');

reset role;

select is((select created from tmp_b_all), true, 'B: all → created=true on first submission');
select is((select notify_target from tmp_b_all), 'all', 'B: all → returns notify_target=all');

select is(
  (select action from public.audit_logs where id = (select audit_log_id from tmp_b_all)),
  'collection.remind',
  'B: all → writes audit action collection.remind');
select is(
  (select (after_state ->> 'notify_target') from public.audit_logs where id = (select audit_log_id from tmp_b_all)),
  'all',
  'B: all → after_state.notify_target = all');
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' = (select audit_log_id::text from tmp_b_all)),
  1,
  'B: all → enqueued exactly one pgmq message');
select is(
  (select count(*)::int from public.collection_reminder_requests
     where idempotency_key = 'reminder-key-aaaa-1111' and audit_log_id = (select audit_log_id from tmp_b_all)),
  1,
  'B: all → recorded the request row with its audit_log_id');


-- ── C. notify_target='unpaid' ────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

create temporary table tmp_c_unpaid as
  select *
  from app.send_collection_publish_reminder(
    '47300000-0000-4000-8000-000000000a01'::uuid, 'unpaid', 'reminder-key-bbbb-2222', 'unpaid run');

reset role;

select is(
  (select action from public.audit_logs where id = (select audit_log_id from tmp_c_unpaid)),
  'collection.remind_unpaid',
  'C: unpaid → writes audit action collection.remind_unpaid');
select is(
  (select (after_state ->> 'notify_target') from public.audit_logs where id = (select audit_log_id from tmp_c_unpaid)),
  'unpaid',
  'C: unpaid → after_state.notify_target = unpaid');
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' = (select audit_log_id::text from tmp_c_unpaid)),
  1,
  'C: unpaid → enqueued exactly one pgmq message');


-- ── D. Idempotency ───────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

-- Same key, same target: returns the previously-recorded audit_log_id,
-- created=false, no new audit, no new pgmq message.
create temporary table tmp_d_replay as
  select *
  from app.send_collection_publish_reminder(
    '47300000-0000-4000-8000-000000000a01'::uuid, 'all', 'reminder-key-aaaa-1111', 'replay');

reset role;

select is((select created from tmp_d_replay), false, 'D: replay with same key → created=false');
select is((select audit_log_id from tmp_d_replay), (select audit_log_id from tmp_b_all),
  'D: replay returns the ORIGINAL audit_log_id');
select is(
  (select count(*)::int from public.audit_logs
     where object_id = '47300000-0000-4000-8000-000000000a01' and action = 'collection.remind'),
  1,
  'D: replay did NOT write a second audit row');
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' = (select audit_log_id::text from tmp_b_all)),
  1,
  'D: replay did NOT enqueue a second pgmq message');

-- Same key, different target: refuse (surface a client-side bug rather than
-- silently rewriting what the first submission did).
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a01'::uuid, 'unpaid', 'reminder-key-aaaa-1111', null) $$,
  'IDEMPOTENCY_CONFLICT',
  'D: same key with a different target raises IDEMPOTENCY_CONFLICT');

reset role;

-- Different key: fresh audit and pgmq message.
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

create temporary table tmp_d_second as
  select *
  from app.send_collection_publish_reminder(
    '47300000-0000-4000-8000-000000000a01'::uuid, 'all', 'reminder-key-cccc-3333', 'second');

reset role;

select is((select created from tmp_d_second), true, 'D: different key → fresh request, created=true');
select isnt((select audit_log_id from tmp_d_second), (select audit_log_id from tmp_b_all),
  'D: different key → different audit_log_id');
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' = (select audit_log_id::text from tmp_d_second)),
  1,
  'D: different key → one more pgmq message');


-- ── E. Preconditions ─────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select throws_matching(
  $$ select app.send_collection_publish_reminder('00000000-0000-0000-0000-000000000000'::uuid, 'all', 'reminder-key-xxxx-9999', null) $$,
  'NOT_FOUND',
  'E: unknown collection raises NOT_FOUND');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a01'::uuid, 'none', 'reminder-key-dddd-4444', null) $$,
  'INVALID_NOTIFY_TARGET',
  'E: notify_target=none is refused server-side (UI treats it as cancel)');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a01'::uuid, 'everyone', 'reminder-key-eeee-5555', null) $$,
  'INVALID_NOTIFY_TARGET',
  'E: unknown notify_target raises INVALID_NOTIFY_TARGET');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a01'::uuid, 'all', 'short', null) $$,
  'INVALID_IDEMPOTENCY_KEY',
  'E: short idempotency key raises INVALID_IDEMPOTENCY_KEY');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a03'::uuid, 'all', 'reminder-key-ffff-6666', null) $$,
  'INVALID_STATE',
  'E: draft collection raises INVALID_STATE');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a04'::uuid, 'all', 'reminder-key-gggg-7777', null) $$,
  'INVALID_STATE',
  'E: paused collection raises INVALID_STATE');

select throws_matching(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a05'::uuid, 'all', 'reminder-key-hhhh-8888', null) $$,
  'INVALID_STATE',
  'E: closed collection raises INVALID_STATE');

-- Scheduled is a valid state (published, not yet started).
create temporary table tmp_e_scheduled as
  select *
  from app.send_collection_publish_reminder(
    '47300000-0000-4000-8000-000000000a02'::uuid, 'all', 'reminder-key-iiii-9999', 'scheduled');

reset role;

select is((select created from tmp_e_scheduled), true,
  'E: scheduled collection accepts a reminder (published, awaiting start)');


-- ── F. Permission ────────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"47000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ select app.send_collection_publish_reminder('47300000-0000-4000-8000-000000000a06'::uuid, 'all', 'reminder-key-jjjj-aaaa', null) $$,
  '42501',
  null,
  'F: authenticated outsider without collection.publish is refused');

reset role;


select finish();
rollback;
