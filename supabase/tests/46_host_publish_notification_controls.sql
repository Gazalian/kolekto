-- ─────────────────────────────────────────────────────────────────────────────
-- 46 — Host-controlled publish-time notification (M13.3)
--
-- Migration 20261027210000. What is proved here:
--
--   A. Schema: `app.publish_collection(uuid, collection_status, text, boolean)`
--      exists and is grantable to authenticated.
--   B. Behaviour:
--        · p_notify=true  → audit action `collection.publish`,
--          one pgmq message is enqueued (trigger watches that action),
--          and the audit row's after_state carries `notified: true`.
--        · p_notify=false → audit action `collection.publish_silent`,
--          NO pgmq message is enqueued (trigger ignores unwatched actions),
--          and the audit row's after_state carries `notified: false`.
--      Business state (status, published_at, published_by) is identical in
--      both cases.
--   C. Preconditions:
--        · unknown collection → NOT_FOUND.
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
select plan(17);


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

-- Two draft collections, identical shape; one for notify-publish, one for silent.
insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by) values
  ('f4000000-0000-4000-8000-000000000a01', 'f2000000-0000-4000-8000-00000000000a', 'notify-draft', 'Notify Draft', 'dues', 'open', 'fixed', 500000, 'draft', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a02', 'f2000000-0000-4000-8000-00000000000a', 'silent-draft', 'Silent Draft', 'dues', 'open', 'fixed', 500000, 'draft', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a03', 'f2000000-0000-4000-8000-00000000000a', 'conflict-draft', 'Conflict Draft', 'dues', 'open', 'fixed', 500000, 'draft', 'f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000a04', 'f2000000-0000-4000-8000-00000000000a', 'already-active', 'Already Active', 'dues', 'open', 'fixed', 500000, 'active', 'f1000000-0000-4000-8000-000000000001');


-- ── A. Schema ────────────────────────────────────────────────────────────────
select has_function('app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'boolean'],
  'app.publish_collection(uuid, collection_status, text, boolean) exists');

select function_privs_are(
  'app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'boolean'],
  'authenticated', array['EXECUTE'],
  'authenticated holds EXECUTE on app.publish_collection');


-- ── B. notify=true branch ────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  app.publish_collection(
    'f4000000-0000-4000-8000-000000000a01'::uuid, 'draft'::public.collection_status, 'ship it', true),
  'active'::public.collection_status,
  'notify-publish resolves to active (no future starts_at)');

reset role;

-- Business state updated.
select is(
  (select status from public.collections where id = 'f4000000-0000-4000-8000-000000000a01'),
  'active'::public.collection_status,
  'collection row shows status=active after notify-publish');
select isnt(
  (select published_at from public.collections where id = 'f4000000-0000-4000-8000-000000000a01'),
  null,
  'published_at is set after notify-publish');

-- Audit action is `collection.publish` and after_state records the choice.
select is(
  (select action from public.audit_logs where object_id = 'f4000000-0000-4000-8000-000000000a01'
     order by created_at desc limit 1),
  'collection.publish',
  'notify=true writes audit action collection.publish');
select is(
  (select (after_state ->> 'notified') from public.audit_logs
     where object_id = 'f4000000-0000-4000-8000-000000000a01' order by created_at desc limit 1),
  'true',
  'after_state.notified = true in the notify-publish audit row');

-- Trigger enqueued exactly one message for this audit row.
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' =
       (select id::text from public.audit_logs
          where object_id = 'f4000000-0000-4000-8000-000000000a01' order by created_at desc limit 1)),
  1,
  'notify-publish enqueued exactly one pgmq message');


-- ── B. notify=false branch (silent) ──────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  app.publish_collection(
    'f4000000-0000-4000-8000-000000000a02'::uuid, 'draft'::public.collection_status, 'quiet', false),
  'active'::public.collection_status,
  'silent-publish resolves to active, same as notify-publish');

reset role;

select is(
  (select action from public.audit_logs where object_id = 'f4000000-0000-4000-8000-000000000a02'
     order by created_at desc limit 1),
  'collection.publish_silent',
  'notify=false writes audit action collection.publish_silent');
select is(
  (select (after_state ->> 'notified') from public.audit_logs
     where object_id = 'f4000000-0000-4000-8000-000000000a02' order by created_at desc limit 1),
  'false',
  'after_state.notified = false in the silent-publish audit row');

-- The trigger watches a fixed list; `collection.publish_silent` is NOT on it,
-- so no message is enqueued. This is the whole point of this slice.
select is(
  (select count(*)::int from pgmq.q_notification_events
     where message ->> 'audit_log_id' =
       (select id::text from public.audit_logs
          where object_id = 'f4000000-0000-4000-8000-000000000a02' order by created_at desc limit 1)),
  0,
  'silent-publish enqueued NO pgmq message');


-- ── C. Preconditions ─────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select throws_matching(
  $$ select app.publish_collection('00000000-0000-0000-0000-000000000000'::uuid, 'draft'::public.collection_status, null, true) $$,
  'NOT_FOUND',
  'unknown collection raises NOT_FOUND');

select throws_matching(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a04'::uuid, 'active'::public.collection_status, null, true) $$,
  'INVALID_TRANSITION',
  'already-active collection raises INVALID_TRANSITION (narrow by design)');

select throws_matching(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a03'::uuid, 'active'::public.collection_status, null, true) $$,
  'STATUS_CONFLICT',
  'draft collection with stale p_expected raises STATUS_CONFLICT');

reset role;


-- ── D. Permission ───────────────────────────────────────────────────────────
-- The outsider is authenticated but holds no officer term in this community,
-- so app.require_permission(collection.publish) refuses with 42501.
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ select app.publish_collection('f4000000-0000-4000-8000-000000000a03'::uuid, 'draft'::public.collection_status, null, true) $$,
  '42501',
  null,
  'authenticated outsider without collection.publish is refused');

reset role;

select function_privs_are(
  'app', 'publish_collection',
  array['uuid', 'public.collection_status', 'text', 'boolean'],
  'anon', array[]::text[],
  'anon holds no EXECUTE on app.publish_collection');


select finish();
rollback;
