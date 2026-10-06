-- ─────────────────────────────────────────────────────────────────────────────
-- 22 — Provider event processing (M8.2)
--
-- The M8.1 audit found that `financial_events` is immutable while processing
-- state is not. This decides whether the resolution actually holds: processing
-- state lives in append-only attempt rows, the provider's own words stay
-- untouched, and the eight questions an operator asks are all answerable.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(41);

-- ── Structure ───────────────────────────────────────────────────────────────

select has_table('public', 'financial_event_processing_attempts',
  'processing state is its own append-only table, not columns on the immutable event');
select has_view('public', 'v_financial_event_processing',
  'and one view answers the questions an operator asks');

select has_index('public', 'financial_event_processing_attempts',
  'financial_event_processing_attempts_event_attempt_key',
  'attempt numbers are unique per event, so two concurrent processors cannot both be attempt 3');

-- The point of the whole design: the events table gained nothing mutable.
select hasnt_column('public', 'financial_events', 'processed_at',
  'the immutable event table did NOT gain a processing timestamp');
select hasnt_column('public', 'financial_events', 'processing_status',
  'nor a status');
select hasnt_column('public', 'financial_events', 'attempt_count',
  'nor a counter — the history is the record, and a count is a count(*) over it');

-- `unknown` is the value the whole D-27 rule rests on.
select ok(
  'unknown' = any (enum_range(null::public.event_processing_outcome)::text[]),
  'an attempt can end `unknown`, which is not `failed` (D-27)'
);
select ok(
  'ignored' = any (enum_range(null::public.event_processing_outcome)::text[]),
  'and an unhandled event type can be `ignored`, which is terminal and not a problem'
);


-- ── Fixtures: four events in four processing states ─────────────────────────

insert into public.financial_events
  (id, provider, provider_event_id, provider_event_type, payload, signature_verified)
values
  ('b1000000-0000-4000-8000-000000000001', 'fake', 'evt_never_attempted', 'charge.success',
   '{"__fake":true,"data":{"reference":"KLK-A"}}'::jsonb, true),
  ('b1000000-0000-4000-8000-000000000002', 'fake', 'evt_failed_then_ok',  'charge.success',
   '{"__fake":true,"data":{"reference":"KLK-B"}}'::jsonb, true),
  ('b1000000-0000-4000-8000-000000000003', 'fake', 'evt_unknown',         'transfer.success',
   '{"__fake":true,"data":{"transfer_code":"KLK-TRF-1"}}'::jsonb, true),
  ('b1000000-0000-4000-8000-000000000004', 'fake', 'evt_ignored',         'some.event.we.do.not.handle',
   '{"__fake":true}'::jsonb, true);


-- ── An event nobody has processed ───────────────────────────────────────────
--
-- The reading that matters: an event with no attempt and an event whose
-- processing failed are BOTH unprocessed, and both need picking up.

select is(
  (select attempt_count from public.v_financial_event_processing
   where provider_event_id = 'evt_never_attempted'),
  0::bigint,
  'an unattempted event reports zero attempts rather than no row'
);

select is(
  (select processed_at from public.v_financial_event_processing
   where provider_event_id = 'evt_never_attempted'),
  null,
  'and is not processed'
);

select is(
  (select needs_retry from public.v_financial_event_processing
   where provider_event_id = 'evt_never_attempted'),
  true,
  'and needs picking up — an event nobody has looked at is not a finished event'
);


-- ── Failed, then retried, then succeeded ────────────────────────────────────

insert into public.financial_event_processing_attempts
  (financial_event_id, attempt_no, outcome, error_code, error_message, started_at, finished_at, next_retry_at)
values
  ('b1000000-0000-4000-8000-000000000002', 1, 'failed', 'COLLECTION_NOT_FOUND',
   'the reference resolved to no collection', now() - interval '10 minutes', now() - interval '10 minutes',
   now() - interval '5 minutes');

select is(
  (select latest_outcome::text from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  'failed',
  'after one failed attempt the latest outcome is failed'
);

select is(
  (select latest_error_code from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  'COLLECTION_NOT_FOUND',
  'and the error is a Kolekto code, so an alert can count one class of problem over time'
);

select is(
  (select needs_retry from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  true,
  'and it needs a retry'
);

select is(
  (select processed_at from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  null,
  'and it is not processed'
);

-- The retry succeeds. The failure is NOT edited — a second row is appended.
insert into public.financial_event_processing_attempts
  (financial_event_id, attempt_no, outcome, started_at, finished_at)
values
  ('b1000000-0000-4000-8000-000000000002', 2, 'succeeded', now(), now());

select is(
  (select attempt_count from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  2::bigint,
  'both attempts are counted — the failure is history, not something overwritten'
);

select is(
  (select latest_outcome::text from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  'succeeded',
  'the latest outcome is the success'
);

select isnt(
  (select processed_at from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  null,
  'and it is now processed, with a timestamp'
);

select is(
  (select needs_retry from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  false,
  'and no longer needs a retry'
);

-- The earlier failure is still readable. "Why did this take two tries?" has an
-- answer, which a mutable status column would have destroyed.
select is(
  (select count(*)::integer from public.financial_event_processing_attempts
   where financial_event_id = 'b1000000-0000-4000-8000-000000000002' and outcome = 'failed'),
  1,
  'and the original failure is still on the record'
);


-- ── Unknown: the one that must not be retried blindly (D-27) ────────────────

insert into public.financial_event_processing_attempts
  (financial_event_id, attempt_no, outcome, error_code, error_message, started_at, finished_at, next_retry_at)
values
  ('b1000000-0000-4000-8000-000000000003', 1, 'unknown', 'PROVIDER_TIMEOUT',
   'the provider did not respond; the transfer may or may not have been sent',
   now(), now(), now() + interval '5 minutes');

select is(
  (select awaiting_provider_resolution from public.v_financial_event_processing
   where provider_event_id = 'evt_unknown'),
  true,
  'an unknown outcome is surfaced separately, because it is resolved by QUERYING the provider, not by retrying'
);

select is(
  (select latest_outcome::text from public.v_financial_event_processing
   where provider_event_id = 'evt_unknown'),
  'unknown',
  'and it is not recorded as a failure — a timeout on a transfer may mean the money moved'
);

select is(
  (select awaiting_provider_resolution from public.v_financial_event_processing
   where provider_event_id = 'evt_failed_then_ok'),
  false,
  'while a genuine failure is not awaiting provider resolution'
);


-- ── Ignored: terminal, and not a problem ────────────────────────────────────

insert into public.financial_event_processing_attempts
  (financial_event_id, attempt_no, outcome, started_at, finished_at)
values
  ('b1000000-0000-4000-8000-000000000004', 1, 'ignored', now(), now());

select is(
  (select needs_retry from public.v_financial_event_processing
   where provider_event_id = 'evt_ignored'),
  false,
  'an event type Kolekto does not handle is stored, passed over, and not retried for ever'
);

select is(
  (select processed_at from public.v_financial_event_processing
   where provider_event_id = 'evt_ignored'),
  null,
  'and it is not claimed as processed either — it was deliberately not processed'
);


-- ── Append-only ─────────────────────────────────────────────────────────────

select throws_ok(
  $$ update public.financial_event_processing_attempts
     set outcome = 'succeeded'
     where financial_event_id = 'b1000000-0000-4000-8000-000000000002' and attempt_no = 1 $$,
  'P0001',
  null,
  'an attempt cannot be edited — it is a fact about what happened at a moment'
);

select throws_ok(
  $$ delete from public.financial_event_processing_attempts
     where financial_event_id = 'b1000000-0000-4000-8000-000000000002' and attempt_no = 1 $$,
  'P0001',
  null,
  'nor deleted, so the processing history cannot be tidied up'
);

select is(
  (select outcome::text from public.financial_event_processing_attempts
   where financial_event_id = 'b1000000-0000-4000-8000-000000000002' and attempt_no = 1),
  'failed',
  'and after both refusals the first attempt still says what it said'
);

-- And the whole reason this table exists: the event itself stayed immutable.
select throws_ok(
  $$ update public.financial_events set provider_event_type = 'something.else'
     where provider_event_id = 'evt_failed_then_ok' $$,
  'P0001',
  null,
  'the provider event is still immutable — processing state never bought an UPDATE path onto it'
);


-- ── Concurrency and integrity ───────────────────────────────────────────────

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000002', 2, 'succeeded', now(), now()) $$,
  '23505',
  null,
  'two processors cannot both claim attempt 2 — the second conflicts instead of both proceeding'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at)
     values ('b1000000-0000-4000-8000-0000000000ff', 1, 'succeeded', now(), now()) $$,
  '23503',
  null,
  'an attempt cannot belong to an event that does not exist'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000001', 0, 'succeeded', now(), now()) $$,
  '23514',
  null,
  'attempts are numbered from 1'
);


-- ── Constraints that keep the record unambiguous ────────────────────────────

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, error_code, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000001', 1, 'succeeded', 'SOMETHING_WRONG', now(), now()) $$,
  '23514',
  null,
  'a successful attempt cannot carry an error — that would make "did this work?" ambiguous'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000001', 1, 'failed', now(), now()) $$,
  '23514',
  null,
  'a failure must say why — an unexplained one has to be reproduced to be understood'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, error_message, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000001', 1, 'unknown', null, now(), now()) $$,
  '23514',
  null,
  'and so must an unknown outcome'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at, next_retry_at)
     values ('b1000000-0000-4000-8000-000000000001', 1, 'succeeded', now(), now(), now() + interval '1 hour') $$,
  '23514',
  null,
  'a succeeded attempt does not schedule a retry — that would mean redoing work already done'
);

select throws_ok(
  $$ insert into public.financial_event_processing_attempts
       (financial_event_id, attempt_no, outcome, started_at, finished_at)
     values ('b1000000-0000-4000-8000-000000000001', 1, 'succeeded', now(), now() - interval '1 hour') $$,
  '23514',
  null,
  'an attempt cannot finish before it started'
);


-- ── Security ────────────────────────────────────────────────────────────────
--
-- An error message may quote a provider payload, and a payload may carry
-- contributor PII (ADR 0009). The staff realm is not built, so nothing
-- client-side reads this.

select ok(
  not has_table_privilege('authenticated', 'public.financial_event_processing_attempts', 'SELECT'),
  'no signed-in caller reads processing attempts: an error message may quote a payload carrying PII'
);

select ok(
  not has_table_privilege('anon', 'public.financial_event_processing_attempts', 'SELECT'),
  'and anon certainly does not'
);

select ok(
  not has_table_privilege('authenticated', 'public.v_financial_event_processing', 'SELECT'),
  'and the view is not a way around that'
);

select is(
  (select count(*)::integer from pg_policy p
   join pg_class c on c.oid = p.polrelid
   where c.relname = 'financial_event_processing_attempts'),
  1,
  'the table carries an explicit policy, so "no client reads this" is recorded rather than accidental'
);

select * from finish();
rollback;
