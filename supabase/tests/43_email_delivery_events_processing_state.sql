-- ─────────────────────────────────────────────────────────────────────────────
-- 43 — email_delivery_events processing state (M13.2 P9-2.1)
--
-- Migration 20261024100000. What is proved here:
--
--   A. The five new columns and the partial processing index exist.
--      CHECK constraints enforce the vocabulary and shape (succeeded has
--      no error_code; failed requires one; attempts non-negative; error_code
--      is stable snake_case).
--   B. app.record_ses_notification on a new (provider, provider_event_id)
--      inserts the ledger row with processing_status='pending',
--      processing_attempts=0, and returns inserted=true,
--      previously_succeeded=false.
--   C. app.record_ses_notification on a duplicate (provider, provider_event_id)
--      returns the existing event_id with inserted=false,
--      previously_succeeded reflects current state.
--   D. app.mark_ses_notification_succeeded transitions a pending row to
--      succeeded, increments the attempt counter, stamps last_processed_at,
--      and clears last_error_code. Second call returns 0 (idempotent).
--   E. app.mark_ses_notification_failed transitions a pending row to failed
--      with a stable error_code and increments the attempt counter.
--   F. app.mark_ses_notification_failed never downgrades a succeeded row
--      (returns 0 and the row stays succeeded).
--   G. Marker-gated UPDATE allows processing-column changes.
--   H. Marker-gated UPDATE refuses changes to content columns.
--   I. UPDATE without the marker is still blocked (regression test for the
--      amended trigger).
--   J. DELETE and TRUNCATE remain unconditionally blocked.
--   K. Role gates: anon and authenticated cannot execute any of the three
--      new app.* functions.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(39);

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
select has_column('public', 'email_delivery_events', 'processing_status',
  'A: processing_status column exists');
select has_column('public', 'email_delivery_events', 'processing_attempts',
  'A: processing_attempts column exists');
select has_column('public', 'email_delivery_events', 'last_processed_at',
  'A: last_processed_at column exists');
select has_column('public', 'email_delivery_events', 'last_error_code',
  'A: last_error_code column exists');
select has_column('public', 'email_delivery_events', 'updated_at',
  'A: updated_at column exists');
select has_index('public', 'email_delivery_events',
  'email_delivery_events_unprocessed_idx',
  'A: partial unprocessed index exists');

-- CHECK constraints: refuse an invalid status via a direct insert.
select throws_ok($$
  insert into public.email_delivery_events
    (provider, provider_event_id, provider_event_type, normalized_event_type,
     payload, signature_verified, processing_status)
  values ('ses', 'A-INVALID-STATUS', 'Bounce', 'bounce_permanent', '{}'::jsonb, true, 'bogus')
$$, '23514', null, 'A: unknown processing_status is a check violation');

select throws_ok($$
  insert into public.email_delivery_events
    (provider, provider_event_id, provider_event_type, normalized_event_type,
     payload, signature_verified, processing_status, last_error_code)
  values ('ses', 'A-SUCCESS-WITH-ERROR', 'Bounce', 'bounce_permanent', '{}'::jsonb, true, 'succeeded', 'oops')
$$, '23514', null, 'A: succeeded row cannot carry last_error_code');

select throws_ok($$
  insert into public.email_delivery_events
    (provider, provider_event_id, provider_event_type, normalized_event_type,
     payload, signature_verified, processing_status)
  values ('ses', 'A-FAILED-NO-ERROR', 'Bounce', 'bounce_permanent', '{}'::jsonb, true, 'failed')
$$, '23514', null, 'A: failed row must have last_error_code');

select throws_ok($$
  insert into public.email_delivery_events
    (provider, provider_event_id, provider_event_type, normalized_event_type,
     payload, signature_verified, processing_status, last_error_code)
  values ('ses', 'A-BAD-ERROR-FORMAT', 'Bounce', 'bounce_permanent', '{}'::jsonb, true, 'failed', 'Not Snake Case')
$$, '23514', null, 'A: last_error_code must match the stable snake_case format');


-- ── B. record_ses_notification on a new event ──────────────────────────────
select is((select inserted from app.record_ses_notification(
    'SNS-NEW-001', 'Delivery', 'delivery', '{"Message": "ok"}'::jsonb, true,
    'ok@p921.example.test', null, 'SES-MSG-NEW-001',
    'arn:aws:sns:eu-west-1:123456789012:kolekto-ses-feedback'
  )), true, 'B: inserted = true for a new event');

select is((select processing_status
  from public.email_delivery_events where provider_event_id = 'SNS-NEW-001'),
  'pending', 'B: new row has processing_status = pending');

select is((select processing_attempts
  from public.email_delivery_events where provider_event_id = 'SNS-NEW-001'),
  0, 'B: new row has processing_attempts = 0');


-- ── C. record_ses_notification on a duplicate ──────────────────────────────
select is((select inserted from app.record_ses_notification(
    'SNS-NEW-001', 'Delivery', 'delivery', '{"Message": "ok"}'::jsonb, true,
    'ok@p921.example.test', null, 'SES-MSG-NEW-001', null
  )), false, 'C: inserted = false for a duplicate');

select is((select previously_succeeded from app.record_ses_notification(
    'SNS-NEW-001', 'Delivery', 'delivery', '{"Message": "ok"}'::jsonb, true,
    'ok@p921.example.test', null, 'SES-MSG-NEW-001', null
  )), false, 'C: previously_succeeded = false while the row is still pending');


-- ── D. mark_ses_notification_succeeded ──────────────────────────────────────
with r as (
  select event_id from app.record_ses_notification(
    'SNS-D-200', 'Delivery', 'delivery', '{}'::jsonb, true,
    null, null, null, null
  )
)
select is(app.mark_ses_notification_succeeded((select event_id from r)), 1::bigint,
  'D: marking a pending row succeeded updates 1 row');

select is((select processing_status
  from public.email_delivery_events where provider_event_id = 'SNS-D-200'),
  'succeeded', 'D: row is now succeeded');
select is((select processing_attempts
  from public.email_delivery_events where provider_event_id = 'SNS-D-200'),
  1, 'D: attempt counter advanced to 1');
select isnt((select last_processed_at
  from public.email_delivery_events where provider_event_id = 'SNS-D-200'),
  null, 'D: last_processed_at is set');

-- Idempotency: second mark succeeded is a no-op (predicate excludes it).
select is(app.mark_ses_notification_succeeded(
    (select id from public.email_delivery_events where provider_event_id = 'SNS-D-200')
  ), 0::bigint, 'D: second mark_succeeded returns 0');

-- A duplicate record_ses_notification call now returns previously_succeeded = true.
select is((select previously_succeeded from app.record_ses_notification(
    'SNS-D-200', 'Delivery', 'delivery', '{}'::jsonb, true, null, null, null, null
  )), true, 'D: previously_succeeded = true after mark succeeded');


-- ── E. mark_ses_notification_failed ─────────────────────────────────────────
with r as (
  select event_id from app.record_ses_notification(
    'SNS-E-300', 'Bounce', 'bounce_permanent', '{}'::jsonb, true,
    null, null, null, null
  )
)
select is(app.mark_ses_notification_failed(
    (select event_id from r), 'suppression_write_failed'
  ), 1::bigint, 'E: marking a pending row failed updates 1 row');

select is((select processing_status
  from public.email_delivery_events where provider_event_id = 'SNS-E-300'),
  'failed', 'E: row is now failed');
select is((select last_error_code
  from public.email_delivery_events where provider_event_id = 'SNS-E-300'),
  'suppression_write_failed', 'E: error_code recorded');

-- A null or malformed error_code is refused.
select throws_ok($$
  select app.mark_ses_notification_failed(
    (select id from public.email_delivery_events where provider_event_id = 'SNS-E-300'),
    null
  )
$$, '22023', null, 'E: null error_code is refused');
select throws_ok($$
  select app.mark_ses_notification_failed(
    (select id from public.email_delivery_events where provider_event_id = 'SNS-E-300'),
    'Not Snake Case'
  )
$$, '22023', null, 'E: non-snake-case error_code is refused');


-- ── F. mark_failed never downgrades a succeeded row ─────────────────────────
with r as (
  select event_id from app.record_ses_notification(
    'SNS-F-400', 'Delivery', 'delivery', '{}'::jsonb, true, null, null, null, null
  )
)
select app.mark_ses_notification_succeeded((select event_id from r));

select is(app.mark_ses_notification_failed(
    (select id from public.email_delivery_events where provider_event_id = 'SNS-F-400'),
    'delivery_write_failed'
  ), 0::bigint, 'F: mark_failed on an already-succeeded row returns 0');

select is((select processing_status
  from public.email_delivery_events where provider_event_id = 'SNS-F-400'),
  'succeeded', 'F: row stays succeeded (not downgraded)');


-- ── G/H. Marker-gated UPDATE semantics ───────────────────────────────────────
-- G: a legitimate processing-column UPDATE through the marker flag succeeds.
select app.record_ses_notification(
  'SNS-G-500', 'Delivery', 'delivery', '{}'::jsonb, true, null, null, null, null
);
-- The mark functions take the marker internally; here we test the trigger
-- directly to prove the content-immutability branch.
set local app.email_delivery_events_processing_marker = 'true';
update public.email_delivery_events
set processing_status = 'succeeded',
    processing_attempts = processing_attempts + 1,
    last_processed_at = now()
where provider_event_id = 'SNS-G-500';
select is((select processing_status from public.email_delivery_events
  where provider_event_id = 'SNS-G-500'), 'succeeded',
  'G: marker-gated processing-column UPDATE succeeded');

-- H: a content-column change with the marker set is still refused.
select throws_ok($$
  update public.email_delivery_events
  set normalized_event_type = 'bounce_permanent'
  where provider_event_id = 'SNS-G-500'
$$, 'P0001', null, 'H: content-column change refused even with the marker set');
set local app.email_delivery_events_processing_marker = 'false';


-- ── I. UPDATE without the marker is still blocked ───────────────────────────
select throws_ok($$
  update public.email_delivery_events
  set processing_status = 'pending'
  where provider_event_id = 'SNS-G-500'
$$, 'P0001', null, 'I: UPDATE without the marker remains blocked (regression check)');


-- ── J. DELETE and TRUNCATE unconditionally blocked ──────────────────────────
select throws_ok($$
  delete from public.email_delivery_events where provider_event_id = 'SNS-G-500'
$$, 'P0001', null, 'J: DELETE still blocked');

select throws_ok($$
  truncate table public.email_delivery_events
$$, 'P0001', null, 'J: TRUNCATE still blocked');


-- ── K. Role gates on the three new functions ────────────────────────────────
select is(pg_temp.try_as('anon',
  $$select app.record_ses_notification('x','Delivery','delivery','{}'::jsonb,true,null,null,null,null)$$),
  '42501', 'K: anon cannot execute record_ses_notification');
select is(pg_temp.try_as('authenticated',
  $$select app.record_ses_notification('x','Delivery','delivery','{}'::jsonb,true,null,null,null,null)$$),
  '42501', 'K: authenticated cannot execute record_ses_notification');

select is(pg_temp.try_as('anon',
  $$select app.mark_ses_notification_succeeded('00000000-0000-0000-0000-000000000000'::uuid)$$),
  '42501', 'K: anon cannot execute mark_ses_notification_succeeded');
select is(pg_temp.try_as('authenticated',
  $$select app.mark_ses_notification_succeeded('00000000-0000-0000-0000-000000000000'::uuid)$$),
  '42501', 'K: authenticated cannot execute mark_ses_notification_succeeded');

select is(pg_temp.try_as('anon',
  $$select app.mark_ses_notification_failed('00000000-0000-0000-0000-000000000000'::uuid, 'err')$$),
  '42501', 'K: anon cannot execute mark_ses_notification_failed');
select is(pg_temp.try_as('authenticated',
  $$select app.mark_ses_notification_failed('00000000-0000-0000-0000-000000000000'::uuid, 'err')$$),
  '42501', 'K: authenticated cannot execute mark_ses_notification_failed');


select * from finish();
rollback;
