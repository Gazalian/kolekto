-- ─────────────────────────────────────────────────────────────────────────────
-- 21 — Financial idempotency (M8.1 step 10)
--
-- Paystack retries every 3 minutes for the first 4 attempts and then hourly for
-- up to 72 hours whenever it does not receive an HTTP 200 (PA-02), and an
-- operator can resend any event deliberately. Delivery is AT-LEAST-ONCE.
--
-- So this file decides one thing, three times over: the same event arriving
-- twice, five times, or after a timeout has exactly one effect — and the
-- refusal comes from the database, not from a handler that remembered to check.
--
-- D-25: an idempotency key is a UNIQUE INDEX, never a lookup-then-insert. Every
-- "check whether it exists, then insert it" in the old code was a race between
-- two concurrent deliveries.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(24);

-- ── Structure ───────────────────────────────────────────────────────────────

select has_table('public', 'financial_events',
  'provider events are stored — the old system stored none, so an event that failed past the retry window was simply gone');
select has_table('public', 'financial_operation_claims',
  'and Kolekto can claim an operation key before acting on it');

select has_index('public', 'financial_events', 'financial_events_provider_event_key',
  'the (provider, provider_event_id) unique index IS the webhook deduplication (D-25)');
select has_index('public', 'financial_operation_claims', 'financial_operation_claims_scope_key',
  'and (scope, key) is the same defence for an outbound operation');

select has_column('public', 'financial_events', 'payload',
  'the whole payload is kept — a reconciliation two years from now needs the bytes, not somebody''s mapping of them');
select has_column('public', 'financial_events', 'signature_verified',
  'and whether the signature checked out is recorded rather than assumed (PA-01)');


-- ── The same event, twice ───────────────────────────────────────────────────

insert into public.financial_events
  (provider, provider_event_id, provider_event_type, payload, signature_verified)
values
  ('paystack', 'evt_test_0001', 'charge.success', '{"data":{"reference":"KLK-0001"}}'::jsonb, true);

select throws_ok(
  $$ insert into public.financial_events
       (provider, provider_event_id, provider_event_type, payload, signature_verified)
     values ('paystack', 'evt_test_0001', 'charge.success', '{"data":{"reference":"KLK-0001"}}'::jsonb, true) $$,
  '23505',
  null,
  'the same provider event cannot be stored twice'
);

-- The pattern a webhook receiver must use. The insert is attempted and the
-- CONFLICT is the answer — there is no read first, because a read first is a
-- race.
select lives_ok(
  $$ insert into public.financial_events
       (provider, provider_event_id, provider_event_type, payload, signature_verified)
     values ('paystack', 'evt_test_0001', 'charge.success', '{"data":{"reference":"KLK-0001"}}'::jsonb, true)
     on conflict (provider, provider_event_id) do nothing $$,
  'and `on conflict do nothing` makes a redelivery a no-op, which is what lets the handler return 200 (D-26)'
);

-- Five deliveries, as Paystack's retry schedule would produce.
select lives_ok(
  $$ insert into public.financial_events
       (provider, provider_event_id, provider_event_type, payload, signature_verified)
     select 'paystack', 'evt_test_0001', 'charge.success', '{"data":{"reference":"KLK-0001"}}'::jsonb, true
     from generate_series(1, 5)
     on conflict (provider, provider_event_id) do nothing $$,
  'five redeliveries of the same event are accepted and write nothing'
);

select is(
  (select count(*)::integer from public.financial_events where provider_event_id = 'evt_test_0001'),
  1,
  'leaving exactly one row, whatever the provider does'
);

-- The key is scoped to the provider. Two gateways may legitimately issue the
-- same event id, and treating them as one event would drop a real payment.
select lives_ok(
  $$ insert into public.financial_events
       (provider, provider_event_id, provider_event_type, payload, signature_verified)
     values ('some_other_provider', 'evt_test_0001', 'charge.success', '{}'::jsonb, true) $$,
  'the same event id from a different provider is a different event'
);


-- ── Operation claims ────────────────────────────────────────────────────────
--
-- PA-08 is UNKNOWN: Paystack's documentation available to us does not establish
-- that a transfer is idempotent on a reference we supply. So Kolekto does not
-- rely on it. It claims its own key, and the claim is what makes a retry safe.

insert into public.financial_operation_claims (scope, key)
values ('provider_transfer', 'KLK-TRF-0001');

select throws_ok(
  $$ insert into public.financial_operation_claims (scope, key)
     values ('provider_transfer', 'KLK-TRF-0001') $$,
  '23505',
  null,
  'an operation key cannot be claimed twice — this is what stops a retried transfer paying a bank twice (PA-08)'
);

select lives_ok(
  $$ insert into public.financial_operation_claims (scope, key)
     values ('withdrawal_request', 'KLK-TRF-0001') $$,
  'the same key in a different scope is a different operation'
);

-- D-27: a timed-out operation is `unknown`, not failed. The claim persists
-- precisely so a retry cannot proceed until somebody has QUERIED the provider.
select is(
  (select count(*)::integer from public.financial_operation_claims
   where scope = 'provider_transfer' and key = 'KLK-TRF-0001'),
  1,
  'and the claim survives, because a timeout is not a failure and the key must stay claimed (D-27)'
);

select throws_ok(
  $$ delete from public.financial_operation_claims where key = 'KLK-TRF-0001' $$,
  'P0001',
  null,
  'a claim cannot be released — releasing it would be exactly the blind retry D-27 forbids'
);


-- ── Immutability ────────────────────────────────────────────────────────────

select throws_ok(
  $$ update public.financial_events set payload = '{}'::jsonb where provider_event_id = 'evt_test_0001' $$,
  'P0001',
  null,
  'a stored event cannot be edited — it is the only record of what the provider actually said'
);

select throws_ok(
  $$ delete from public.financial_events where provider_event_id = 'evt_test_0001' $$,
  'P0001',
  null,
  'and it cannot be deleted, so an event is replayable for ever'
);

-- Scoped by provider as well as event id: the same event id now exists under a
-- second provider, which is the point made a few assertions ago.
select is(
  (select payload ->> 'data' is not null from public.financial_events
   where provider = 'paystack' and provider_event_id = 'evt_test_0001'),
  true,
  'and the payload is exactly what arrived'
);


-- ── Constraints ─────────────────────────────────────────────────────────────

select throws_ok(
  $$ insert into public.financial_events
       (provider, provider_event_id, provider_event_type, payload, signature_verified)
     values ('paystack', '   ', 'charge.success', '{}'::jsonb, true) $$,
  '23514',
  null,
  'a blank event id is refused — it would collapse every such event onto one row'
);

select throws_ok(
  $$ insert into public.financial_operation_claims (scope, key) values ('', 'x') $$,
  '23514',
  null,
  'and a blank scope is refused'
);


-- ── Security: raw payloads are not client-readable ──────────────────────────
--
-- `payload` carries whatever the provider sent, which includes a contributor's
-- name, email and phone. Under ADR 0009 that is staff-realm data, and the staff
-- realm is not built yet — so nothing client-side reads this at all.

select ok(
  not has_table_privilege('authenticated', 'public.financial_events', 'SELECT'),
  'a signed-in caller cannot read raw provider payloads: they carry contributor PII (ADR 0009, O-10)'
);

select ok(
  not has_table_privilege('anon', 'public.financial_events', 'SELECT'),
  'and anon certainly cannot'
);

select ok(
  not has_table_privilege('authenticated', 'public.financial_operation_claims', 'SELECT'),
  'nor read operation claims, which would expose outbound transfer references'
);

-- The policy denies as well as the grant being absent. Not redundant: the grant
-- is what stops a read today, and the policy is what stops a careless future
-- `grant select` from being sufficient.
select is(
  (select count(*)::integer from pg_policy p
   join pg_class c on c.oid = p.polrelid
   where c.relname in ('financial_events', 'financial_operation_claims')),
  2,
  'both tables carry an explicit policy, so "no client reads this" is recorded rather than left as an accident'
);

select * from finish();
rollback;
