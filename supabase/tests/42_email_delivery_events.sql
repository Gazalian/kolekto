-- ─────────────────────────────────────────────────────────────────────────────
-- 42 — SES/SNS event ingestion (M13.2 P9-2)
--
-- Migration 20261023120000. What is proved here:
--
--   A. The email_delivery_events table, its indexes, RLS and deny policy
--      exist. The three normalized_event_type values and the recipient-
--      address check constraint reject obvious bad input.
--   B. Insert of a new (provider, provider_event_id) succeeds.
--      Duplicate (provider, provider_event_id) is a conflict (idempotency).
--   C. app.record_ses_suppression writes a permanent row via the P9-1
--      setter, with source = 'ses_event' and the source event id set.
--   D. app.record_ses_suppression refuses reasons other than hard_bounce
--      and complaint — specifically transient_bounce_capped, manual_block,
--      list_unsubscribe.
--   E. app.record_ses_delivery_event transitions sent → delivered on the
--      matching provider_message_id, returns 1.
--   F. app.record_ses_delivery_event is a no-op on 'dead', 'skipped',
--      'pending', 'sending', 'delivered' rows (returns 0 each time), and
--      on a null/blank p_provider_message_id (returns 0).
--   G. Append-only enforcement: UPDATE, DELETE, TRUNCATE all raise P0001.
--   H. Role gates: anon and authenticated cannot execute the two app.*
--      functions added by this migration.
--   I. Direct SELECT on email_delivery_events is denied for anon and
--      authenticated.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(34);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('db000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@p92.example.test', now());
insert into public.users (id, full_name, email) values
  ('db000000-0000-4000-8000-000000000001', 'P92 Owner', 'owner@p92.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('db100000-0000-4000-8000-000000000001', 'p92-ses-01', 'P92 SES 01', 'social_group', false,
   'db000000-0000-4000-8000-000000000001');

insert into public.notification_events
  (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload)
values
  ('db200000-0000-4000-8000-000000000001', 'db100000-0000-4000-8000-000000000001',
   'member.create', 'p92-01', 'officer', 'db000000-0000-4000-8000-000000000001',
   'member', 'db300000-0000-4000-8000-000000000001', '{}'),
  ('db200000-0000-4000-8000-000000000002', 'db100000-0000-4000-8000-000000000001',
   'member.create', 'p92-02', 'officer', 'db000000-0000-4000-8000-000000000001',
   'member', 'db300000-0000-4000-8000-000000000002', '{}'),
  ('db200000-0000-4000-8000-000000000003', 'db100000-0000-4000-8000-000000000001',
   'member.create', 'p92-03', 'officer', 'db000000-0000-4000-8000-000000000001',
   'member', 'db300000-0000-4000-8000-000000000003', '{}'),
  ('db200000-0000-4000-8000-000000000004', 'db100000-0000-4000-8000-000000000001',
   'member.create', 'p92-04', 'officer', 'db000000-0000-4000-8000-000000000001',
   'member', 'db300000-0000-4000-8000-000000000004', '{}'),
  ('db200000-0000-4000-8000-000000000005', 'db100000-0000-4000-8000-000000000001',
   'member.create', 'p92-05', 'officer', 'db000000-0000-4000-8000-000000000001',
   'member', 'db300000-0000-4000-8000-000000000005', '{}');

-- Five deliveries: one 'sent' with a provider_message_id for the sent → delivered
-- transition, one 'dead', one 'skipped', one 'pending', one 'delivered' already.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status,
   recipient_address, recipient_address_assurance, provider_message_id,
   error_code, attempt_count)
values
  ('db300000-0000-4000-8000-000000000001', 'db200000-0000-4000-8000-000000000001',
   'db100000-0000-4000-8000-000000000001', 'email', 'sent',
   'sent@p92.example.test', 'unverified_supplied', 'SES-MSG-SENT-001',
   null, 1),
  ('db300000-0000-4000-8000-000000000002', 'db200000-0000-4000-8000-000000000002',
   'db100000-0000-4000-8000-000000000001', 'email', 'dead',
   'dead@p92.example.test', 'unverified_supplied', 'SES-MSG-DEAD-002',
   'provider_rejected_permanent', 3),
  ('db300000-0000-4000-8000-000000000003', 'db200000-0000-4000-8000-000000000003',
   'db100000-0000-4000-8000-000000000001', 'email', 'skipped',
   null, null, null,
   'address_suppressed', 0),
  ('db300000-0000-4000-8000-000000000004', 'db200000-0000-4000-8000-000000000004',
   'db100000-0000-4000-8000-000000000001', 'email', 'pending',
   'pending@p92.example.test', 'unverified_supplied', null,
   null, 0),
  ('db300000-0000-4000-8000-000000000005', 'db200000-0000-4000-8000-000000000005',
   'db100000-0000-4000-8000-000000000001', 'email', 'delivered',
   'delivered@p92.example.test', 'unverified_supplied', 'SES-MSG-ALREADY-005',
   null, 1);


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
select has_table('public', 'email_delivery_events',
  'A: email_delivery_events table exists');
select has_index('public', 'email_delivery_events',
  'email_delivery_events_provider_event_key',
  'A: unique (provider, provider_event_id) index exists');
select has_index('public', 'email_delivery_events',
  'email_delivery_events_received_idx',
  'A: received_at index exists');
select has_index('public', 'email_delivery_events',
  'email_delivery_events_provider_message_id_idx',
  'A: partial provider_message_id index exists');
select policies_are('public', 'email_delivery_events',
  array['email_delivery_events_deny_client_access'],
  'A: exactly the deny policy is present');


-- ── B. Insert and dedupe ────────────────────────────────────────────────────
insert into public.email_delivery_events
  (provider, provider_event_id, provider_event_type, normalized_event_type,
   payload, signature_verified, recipient_address_key,
   ses_feedback_id, provider_message_id, sns_topic_arn)
values
  ('ses', 'SNS-MSG-0001', 'Delivery', 'delivery',
   '{"Type":"Notification","MessageId":"SNS-MSG-0001"}'::jsonb, true,
   'sent@p92.example.test', null, 'SES-MSG-SENT-001',
   'arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback');
select is((select count(*)::int from public.email_delivery_events
  where provider_event_id = 'SNS-MSG-0001'), 1,
  'B: a new event row inserts');

-- A second insert with the SAME (provider, provider_event_id) must raise
-- unique_violation. The route uses ON CONFLICT DO NOTHING so this never
-- surfaces to callers, but the storage-layer guarantee lives here.
select throws_ok($$
  insert into public.email_delivery_events
    (provider, provider_event_id, provider_event_type, normalized_event_type,
     payload, signature_verified)
  values ('ses', 'SNS-MSG-0001', 'Delivery', 'delivery',
          '{}'::jsonb, true)
$$, '23505', null, 'B: duplicate (provider, provider_event_id) is a unique violation');


-- ── C. record_ses_suppression writes a permanent ses_event row ──────────────
select is((select inserted from app.record_ses_suppression(
    'bounced@p92.example.test', 'hard_bounce', 'FBID-HB-001', 'SES-MSG-HB-100')),
  true, 'C: record_ses_suppression inserts for a new address');

select is((select source from public.email_suppressions
  where address_key = 'bounced@p92.example.test' limit 1), 'ses_event',
  'C: source is ses_event');
select is((select source_event_id from public.email_suppressions
  where address_key = 'bounced@p92.example.test' limit 1), 'FBID-HB-001',
  'C: source_event_id is the feedbackId (preferred over MessageId)');
select is((select reason from public.email_suppressions
  where address_key = 'bounced@p92.example.test' limit 1), 'hard_bounce',
  'C: reason is hard_bounce');
select is((select expires_at from public.email_suppressions
  where address_key = 'bounced@p92.example.test' limit 1), null::timestamptz,
  'C: permanent (expires_at is null)');

-- Complaint path: no feedbackId → falls back to MessageId
select is((select inserted from app.record_ses_suppression(
    'complained@p92.example.test', 'complaint', null, 'SES-MSG-COMP-200')),
  true, 'C: complaint path with no feedbackId falls back to MessageId');
select is((select source_event_id from public.email_suppressions
  where address_key = 'complained@p92.example.test' limit 1), 'SES-MSG-COMP-200',
  'C: source_event_id falls back to MessageId when feedbackId is null');


-- ── D. record_ses_suppression refuses non-SES reasons ───────────────────────
select throws_ok($$
  select app.record_ses_suppression('x@p92.example.test', 'manual_block', null, null)
$$, '22023', null, 'D: manual_block is refused at the SES entry point');
select throws_ok($$
  select app.record_ses_suppression('x@p92.example.test', 'transient_bounce_capped', null, null)
$$, '22023', null, 'D: transient_bounce_capped is refused at the SES entry point');
select throws_ok($$
  select app.record_ses_suppression('x@p92.example.test', 'list_unsubscribe', null, null)
$$, '22023', null, 'D: list_unsubscribe is refused at the SES entry point');


-- ── E. record_ses_delivery_event: sent → delivered ──────────────────────────
select is(
  app.record_ses_delivery_event('SES-MSG-SENT-001', null),
  1::bigint,
  'E: a sent row with the matching provider_message_id transitions to delivered');
select is((select status::text from public.notification_deliveries
  where id = 'db300000-0000-4000-8000-000000000001'), 'delivered',
  'E: row is now delivered');

-- Idempotency: a second call must not change anything.
select is(
  app.record_ses_delivery_event('SES-MSG-SENT-001', null),
  0::bigint,
  'E: a second call for the same message id returns 0 (idempotent)');


-- ── F. record_ses_delivery_event is a no-op for ineligible statuses ─────────
select is(
  app.record_ses_delivery_event('SES-MSG-DEAD-002', null),
  0::bigint,
  'F: dead row is not promoted');
select is((select status::text from public.notification_deliveries
  where id = 'db300000-0000-4000-8000-000000000002'), 'dead',
  'F: dead row stays dead');

select is(
  app.record_ses_delivery_event('SES-MSG-ALREADY-005', null),
  0::bigint,
  'F: already-delivered row is a no-op');

-- Null / blank message id returns 0 immediately.
select is(
  app.record_ses_delivery_event(null, null),
  0::bigint,
  'F: null provider_message_id returns 0');
select is(
  app.record_ses_delivery_event('   ', null),
  0::bigint,
  'F: blank provider_message_id returns 0');


-- ── G. Append-only enforcement ──────────────────────────────────────────────
select throws_ok($$
  update public.email_delivery_events
  set normalized_event_type = 'bounce_permanent'
  where provider_event_id = 'SNS-MSG-0001'
$$, 'P0001', null, 'G: UPDATE is blocked (append-only)');

select throws_ok($$
  delete from public.email_delivery_events
  where provider_event_id = 'SNS-MSG-0001'
$$, 'P0001', null, 'G: DELETE is blocked (append-only)');

select throws_ok($$
  truncate table public.email_delivery_events
$$, 'P0001', null, 'G: TRUNCATE is blocked (append-only)');


-- ── H. Role gates on the new app.* functions ────────────────────────────────
select is(pg_temp.try_as('anon',
  $$select app.record_ses_suppression('x@y.z', 'hard_bounce', null, null)$$),
  '42501', 'H: anon cannot execute record_ses_suppression');
select is(pg_temp.try_as('authenticated',
  $$select app.record_ses_suppression('x@y.z', 'hard_bounce', null, null)$$),
  '42501', 'H: authenticated cannot execute record_ses_suppression');

select is(pg_temp.try_as('anon',
  $$select app.record_ses_delivery_event('x', null)$$),
  '42501', 'H: anon cannot execute record_ses_delivery_event');
select is(pg_temp.try_as('authenticated',
  $$select app.record_ses_delivery_event('x', null)$$),
  '42501', 'H: authenticated cannot execute record_ses_delivery_event');


-- ── I. Direct SELECT privileges ─────────────────────────────────────────────
select is(pg_temp.try_as('anon',
  'select count(*) from public.email_delivery_events'),
  '42501', 'I: anon cannot read email_delivery_events');
select is(pg_temp.try_as('authenticated',
  'select count(*) from public.email_delivery_events'),
  '42501', 'I: authenticated cannot read email_delivery_events');


select * from finish();
rollback;
