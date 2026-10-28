-- ─────────────────────────────────────────────────────────────────────────────
-- 46 — Host-controlled publish-time notification (M13.3)
--
-- Migrations 20261027210000 + 20261028100000. What is proved here:
--
--   A. Schema: `app.publish_collection(uuid, collection_status, text, text)`
--      exists (the boolean form was dropped in 20261028100000) and is
--      grantable to authenticated.
--   B. Behaviour of the three notify-targets:
--        · p_notify_target = 'all'    → audit `collection.publish`,
--          one pgmq message is enqueued, after_state.notify_target = 'all'.
--        · p_notify_target = 'unpaid' → audit
--          `collection.publish_remind_unpaid`, one pgmq message is enqueued
--          (the trigger watches this new action too),
--          after_state.notify_target = 'unpaid'.
--        · p_notify_target = 'none'   → audit `collection.publish_silent`,
--          NO pgmq message is enqueued (trigger ignores unwatched actions),
--          after_state.notify_target = 'none'.
--      Business state (status, published_at, published_by) is identical in
--      all three cases.
--   C. Preconditions:
--        · unknown collection → NOT_FOUND.
--        · unknown notify_target → INVALID_NOTIFY_TARGET.
--        · non-draft `p_expected` → INVALID_TRANSITION; the host-facing
--          publish is deliberately narrow (other transitions go through
--          app.transition_collection_status).
--        · stale `p_expected` → STATUS_CONFLICT.
--   D. Permission:
--        · an authenticated caller who does NOT hold collection.publish is
--          refused (42501). anon is refused by GRANT.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(20);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@m13.3.example.test'),
  ('f1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@m13.3.example.test');
insert into public.users (id, full_name, email) values
  ('f1000000-0000-4000-8000-000000000001', 'M13.3 Host', 'host@m13.3.example.test'),
  ('f1000000-0000-4000-8000-000000000002', 'M13.3 Outsider', 'outsider@m13.3.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('f2000000-0000-4000-8000-00000000000a', 'm13-3-tests', 'M13.3 Tests', 'social_group', false, 'f1000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'owner', 'M13.3 Host', 'created');

-- Five draft collections, identical shape; one each for all/unpaid/none and
-- two for the precondition/permission branches. One is already-active.
insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by) values
  ('f4000000-0000-4000-8000-000000000a01', 'f2000000-0000-4000-8000-00000000000a', 'notify-draft',    'Notify Draft',    'dues', 'open', 'fixed', 500000, 'draft',  'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a02', 'f2000000-0000-4000-8000-00000000000a', 'silent-draft',    'Silent Draft',    'dues', 'open', 'fixed', 500000, 'draft',  'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a03', 'f2000000-0000-4000-8000-00000000000a', 'conflict-draft',  'Conflict Draft',  'dues', 'open', 'fixed', 500000, 'draft',  'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a04', 'f2000000-0000-4000-8000-00000000000a', 'already-active',  'Already Active',  'dues', 'open', 'fixed', 500000, 'active', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a05', 'f2000000-0000-4000-8000-00000000000a', 'unpaid-draft',    'Unpaid Draft',    'dues', 'open', 'fixed', 500000, 'draft',  'f1000000-0000-4000-8000-000000000001');


-- ── A. Schema ────────────────────────────────────────────────────────────────
select has_function('app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'text'],
  'app.publish_collection(uuid, collection_status, text, text) exists');

select function_privs_are(
  'app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'text'],
  'authenticated', array['EXECUTE'],
  'authenticated holds EXECUTE on app.publish_collection');


-- ── B. notify_target='all' branch ────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  app.publish_collection(
    'f4000000-0000-4000-8000-000000000a01'::uuid, 'draft'::public.collection_status, 'ship it', 'all'),
  'active'::public.collection_status,
  'notify_target=all resolves to active (no future starts_at)');

reset role;

select is(
  (select action from public.audit_logs where object_id = 'f4000000-0000-4000-8000-000000000a01'
     order by created_at desc limit 1),
  'collection.publish',
  'notify_target=all writes audit action collection.publish');
select is(
  (select (after_state ->> 'notify_target') from public.audit_logs
     where object_id = 'f4000000-0000-4000-8000-000000000a01' order by created_at desc limit 1),
  'all',
  'after_state.notify_target = all');
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' =
       (select id::text from public.audit_logs
          where object_id = 'f4000000-0000-4000-8000-000000000a01' order by created_at desc limit 1)),
  1,
  'notify_target=all enqueued exactly one pgmq message');


-- ── B. notify_target='unpaid' branch ─────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  app.publish_collection(
    'f4000000-0000-4000-8000-000000000a05'::uuid, 'draft'::public.collection_status, 'remind', 'unpaid'),
  'active'::public.collection_status,
  'notify_target=unpaid resolves to active, same as all');

reset role;

select is(
  (select action from public.audit_logs where object_id = 'f4000000-0000-4000-8000-000000000a05'
     order by created_at desc limit 1),
  'collection.publish_remind_unpaid',
  'notify_target=unpaid writes audit action collection.publish_remind_unpaid');
select is(
  (select (after_state ->> 'notify_target') from public.audit_logs
     where object_id = 'f4000000-0000-4000-8000-000000000a05' order by created_at desc limit 1),
  'unpaid',
  'after_state.notify_target = unpaid');
-- The trigger NOW watches `collection.publish_remind_unpaid` (added by
-- 20261028100000), so the message IS enqueued. The worker's recipient plan
-- filters by obligation status; the trigger stays dumb.
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' =
       (select id::text from public.audit_logs
          where object_id = 'f4000000-0000-4000-8000-000000000a05' order by created_at desc limit 1)),
  1,
  'notify_target=unpaid enqueued exactly one pgmq message');


-- ── B. notify_target='none' branch (silent) ──────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  app.publish_collection(
    'f4000000-0000-4000-8000-000000000a02'::uuid, 'draft'::public.collection_status, 'quiet', 'none'),
  'active'::public.collection_status,
  'notify_target=none resolves to active, same as all');

reset role;

select is(
  (select action from public.audit_logs where object_id = 'f4000000-0000-4000-8000-000000000a02'
     order by created_at desc limit 1),
  'collection.publish_silent',
  'notify_target=none writes audit action collection.publish_silent');
select is(
  (select (after_state ->> 'notify_target') from public.audit_logs
     where object_id = 'f4000000-0000-4000-8000-000000000a02' order by created_at desc limit 1),
  'none',
  'after_state.notify_target = none');
-- `collection.publish_silent` is NOT in the trigger's watched list, so no
-- message is enqueued. This is the whole point of the silent path.
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' =
       (select id::text from public.audit_logs
          where object_id = 'f4000000-0000-4000-8000-000000000a02' order by created_at desc limit 1)),
  0,
  'notify_target=none enqueued NO pgmq message');


-- ── C. Preconditions ─────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select throws_matching(
  $$ select app.publish_collection('00000000-0000-0000-0000-000000000000'::uuid, 'draft'::public.collection_status, null, 'all') $$,
  'NOT_FOUND',
  'unknown collection raises NOT_FOUND');

select throws_matching(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a03'::uuid, 'draft'::public.collection_status, null, 'everyone') $$,
  'INVALID_NOTIFY_TARGET',
  'unknown notify_target raises INVALID_NOTIFY_TARGET');

select throws_matching(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a04'::uuid, 'active'::public.collection_status, null, 'all') $$,
  'INVALID_TRANSITION',
  'already-active collection raises INVALID_TRANSITION (narrow by design)');

select throws_matching(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a03'::uuid, 'active'::public.collection_status, null, 'all') $$,
  'STATUS_CONFLICT',
  'draft collection with stale p_expected raises STATUS_CONFLICT');

reset role;


-- ── D. Permission ───────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a03'::uuid, 'draft'::public.collection_status, null, 'all') $$,
  '42501',
  null,
  'authenticated outsider without collection.publish is refused');

reset role;

select function_privs_are(
  'app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'text'],
  'anon', array[]::text[],
  'anon holds no EXECUTE on app.publish_collection');


select finish();
rollback;
