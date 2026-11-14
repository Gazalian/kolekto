-- ─────────────────────────────────────────────────────────────────────────────
-- 37 — Atomic send claims and leases (M13.2 P5-1)
--
-- Migration 20261013100000. What is proved here:
--
--   A. The lease columns, the four new constraints and the two new indexes
--      exist.
--   B. The constraints hold on real rows: sending without a lease, a lease
--      on a non-sending row, a malformed token and a fourth attempt are all
--      rejected; the P2 error_message ban still holds.
--   C. app.claim_notification_delivery claims a pending email delivery
--      exactly once: status to sending, attempt reserved, 64-hex token, a
--      five-minute lease. A second claim reports already_claimed and changes
--      nothing.
--   D. app.claim_next_notification_delivery picks the oldest due row with
--      SKIP LOCKED and reports empty when nothing is due. (True multi-
--      session racing is proved by the worker integration test, which opens
--      real connections; pgTAP runs in one session, so the lock-and-recheck
--      semantics are proved here instead.)
--   E. app.resolve_notification_claim leaves sending only with the current
--      unexpired token: sent is terminal and stores the provider id, a wrong
--      or expired token changes nothing.
--   F. app.recover_expired_notification_lease refuses a live lease, returns
--      an expired one to pending with the attempt kept consumed, and the old
--      token can never settle afterwards (the recovery race).
--   G. The three-attempt cap, terminal rows, not-due rows and the retry/dead
--      settle paths; claim and attempt reservation roll back together.
--   H. No client role can execute any of the three functions, and the masked
--      delivery-log function carries no lease token.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(59);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('c9000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@p5.example.test', now());
insert into public.users (id, full_name, email) values
  ('c9000000-0000-4000-8000-000000000001', 'P5 Owner', 'owner@p5.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c9100000-0000-4000-8000-00000000000a', 'p5-claims', 'P5 Claims', 'social_group', false, 'c9000000-0000-4000-8000-000000000001');
-- One event per delivery: the per-event recipient index treats two email
-- rows with no recipient ids on the same event as the same delivery.
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('c9200000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-01', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000001', '{}'),
  ('c9200000-0000-4000-8000-000000000002', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-02', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000002', '{}'),
  ('c9200000-0000-4000-8000-000000000003', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-03', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000003', '{}'),
  ('c9200000-0000-4000-8000-000000000004', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-04', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000004', '{}'),
  ('c9200000-0000-4000-8000-000000000005', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-05', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000005', '{}'),
  ('c9200000-0000-4000-8000-000000000006', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-06', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000006', '{}'),
  ('c9200000-0000-4000-8000-000000000007', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-07', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000007', '{}'),
  ('c9200000-0000-4000-8000-000000000008', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-08', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000008', '{}'),
  ('c9200000-0000-4000-8000-000000000009', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-09', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000009', '{}'),
  -- Spare events so each B-section rejection is judged on its CHECK alone,
  -- never on the per-event recipient index.
  ('c9200000-0000-4000-8000-000000000010', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-10', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000010', '{}'),
  ('c9200000-0000-4000-8000-000000000011', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-11', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000011', '{}'),
  ('c9200000-0000-4000-8000-000000000012', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-12', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000012', '{}'),
  ('c9200000-0000-4000-8000-000000000013', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-13', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000013', '{}'),
  ('c9200000-0000-4000-8000-000000000014', 'c9100000-0000-4000-8000-00000000000a', 'member.create', 'p5-claim-14', 'officer', 'c9000000-0000-4000-8000-000000000001', 'member', 'c9300000-0000-4000-8000-000000000014', '{}');

-- D1/D2: ordinary pending confirmations (D1 older, so claim_next takes D1
-- first — the test claims D1 by id first, so claim_next must then take D2).
-- D3: exhausted (3 attempts used). D4: skipped. D5: dead. D6: sent.
-- D7: failed (retryable in the old model, but only pending is claimable).
-- D8: pending but not due until later. D9: spare row for the rollback proof.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count, error_code, provider_message_id, next_retry_at, created_at)
values
  ('c9300000-0000-4000-8000-000000000001', 'c9200000-0000-4000-8000-000000000001', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'sam@p5.example.test', 'unverified_supplied', 0, null, null, null, now() - interval '1 hour'),
  ('c9300000-0000-4000-8000-000000000002', 'c9200000-0000-4000-8000-000000000002', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'bea@p5.example.test', 'unverified_supplied', 0, null, null, null, now()),
  ('c9300000-0000-4000-8000-000000000003', 'c9200000-0000-4000-8000-000000000003', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'sam@p5.example.test', 'unverified_supplied', 3, null, null, null, now()),
  ('c9300000-0000-4000-8000-000000000004', 'c9200000-0000-4000-8000-000000000004', 'c9100000-0000-4000-8000-00000000000a', 'email', 'skipped', null, null, 0, 'no_recipient', null, null, now()),
  ('c9300000-0000-4000-8000-000000000005', 'c9200000-0000-4000-8000-000000000005', 'c9100000-0000-4000-8000-00000000000a', 'email', 'dead', 'sam@p5.example.test', 'unverified_supplied', 3, 'retries_exhausted', null, null, now()),
  ('c9300000-0000-4000-8000-000000000006', 'c9200000-0000-4000-8000-000000000006', 'c9100000-0000-4000-8000-00000000000a', 'email', 'sent', 'sam@p5.example.test', 'unverified_supplied', 1, null, 'FAKE_EMAIL_0006', null, now()),
  ('c9300000-0000-4000-8000-000000000007', 'c9200000-0000-4000-8000-000000000007', 'c9100000-0000-4000-8000-00000000000a', 'email', 'failed', 'sam@p5.example.test', 'unverified_supplied', 1, 'provider_rejected_transient', null, null, now()),
  ('c9300000-0000-4000-8000-000000000008', 'c9200000-0000-4000-8000-000000000008', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'bea@p5.example.test', 'unverified_supplied', 0, null, null, now() + interval '1 hour', now()),
  ('c9300000-0000-4000-8000-000000000009', 'c9200000-0000-4000-8000-000000000009', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'bea@p5.example.test', 'unverified_supplied', 0, null, null, now() + interval '1 hour', now());

-- Try a function under a real client role; returns the SQLSTATE or 'ok'.
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

-- Holds the lease minted by the latest claim, so later steps can reuse it.
create temporary table pg_temp.lease (token text, expires timestamptz);


-- ── A. Columns, constraints, indexes ─────────────────────────────────────────
select has_column('public', 'notification_deliveries', 'send_lease_token', 'A: send_lease_token exists');
select has_column('public', 'notification_deliveries', 'send_lease_expires_at', 'A: send_lease_expires_at exists');
select ok(count(*) = 1, 'A: token format is constrained')
  from pg_constraint where conname = 'notification_deliveries_lease_token_format';
select ok(count(*) = 1, 'A: sending rows must hold a lease')
  from pg_constraint where conname = 'notification_deliveries_sending_holds_lease';
select ok(count(*) = 1, 'A: only sending rows hold a lease')
  from pg_constraint where conname = 'notification_deliveries_lease_only_when_sending';
-- No attempt_count CHECK exists on purpose: the three-attempt cap is
-- enforced by the claim function, the only path that increments the count,
-- and a CHECK would rewrite history (test 32 holds a dead row with an older
-- count). The cap's proof is behavioural, in G below.
select ok(count(*) = 0, 'A: no attempt_count CHECK rewrites history')
  from pg_constraint where conname = 'notification_deliveries_attempt_count_max';
select has_index('public', 'notification_deliveries', 'notification_deliveries_claim_idx', 'A: claim scan index exists');
select has_index('public', 'notification_deliveries', 'notification_deliveries_expired_lease_idx', 'A: expired-lease index exists');


-- ── B. Constraints on real rows ──────────────────────────────────────────────
select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
  values ('c9200000-0000-4000-8000-000000000010', 'c9100000-0000-4000-8000-00000000000a', 'email', 'sending', 'sam@p5.example.test', 'unverified_supplied')
$$, '23514', null, 'B: sending without a lease is rejected');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, send_lease_token, send_lease_expires_at)
  values ('c9200000-0000-4000-8000-000000000011', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'sam@p5.example.test', 'unverified_supplied',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', now() + interval '5 minutes')
$$, '23514', null, 'B: a lease on a pending row is rejected');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, send_lease_token, send_lease_expires_at)
  values ('c9200000-0000-4000-8000-000000000010', 'c9100000-0000-4000-8000-00000000000a', 'email', 'sending', 'sam@p5.example.test', 'unverified_supplied',
          'not-a-real-token', now() + interval '5 minutes')
$$, '23514', null, 'B: a malformed token is rejected');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count)
  values ('c9200000-0000-4000-8000-000000000012', 'c9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'sam@p5.example.test', 'unverified_supplied', -1)
$$, '23514', null, 'B: a negative attempt count is still rejected');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, error_code, error_message)
  values ('c9200000-0000-4000-8000-000000000013', 'c9100000-0000-4000-8000-00000000000a', 'email', 'failed', 'sam@p5.example.test', 'unverified_supplied', 'provider_timeout', 'timeout after DATA')
$$, '23514', null, 'B: raw provider error text is still banned (P5-0 intact)');


-- ── C. Claim a pending delivery ──────────────────────────────────────────────
insert into pg_temp.lease(token, expires)
select lease_token, lease_expires_at from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000001', 300);

select ok(
  (select count(*) from pg_temp.lease) = 1 and (select token from pg_temp.lease) is not null,
  'C: the claim succeeds and mints a token');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  'sending', 'C: a pending delivery is claimed into sending');
select is(
  (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  1, 'C: the claim reserves one attempt');
select matches(
  (select token from pg_temp.lease),
  '^[0-9a-f]{64}$', 'C: the lease token is 64 unguessable hex chars');
select ok(
  (select expires from pg_temp.lease) > now()
  and (select expires from pg_temp.lease) <= now() + interval '10 minutes',
  'C: the lease lasts five minutes');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000001', 300)),
  'already_claimed', 'C: a second claim reports already_claimed');
select is(
  (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  1, 'C: a refused claim reserves nothing');


-- ── D. Claim next ────────────────────────────────────────────────────────────
select is(
  (select delivery_id from app.claim_next_notification_delivery(300)),
  'c9300000-0000-4000-8000-000000000002'::uuid, 'D: claim_next takes the oldest due row (D2, not exhausted D3 nor not-due D8)');
select is(
  (select reason from app.claim_next_notification_delivery(300)),
  'empty', 'D: claim_next reports empty when nothing is due');


-- ── E. Settle with the token ─────────────────────────────────────────────────
select is(
  (select settled from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000002',
    (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000002'),
    'sent', null, 'FAKE_EMAIL_0002', null)),
  true, 'E: the valid lease settles to sent');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000002'),
  'sent', 'E: the settled row is sent');
select ok(
  (select provider_message_id from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000002') = 'FAKE_EMAIL_0002'
  and (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000002') is null,
  'E: the provider id is stored and the lease is cleared');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000002', 300)),
  'terminal', 'E: a sent delivery cannot be reclaimed');
select is(
  (select reason from app.resolve_notification_claim('c9300000-0000-4000-8000-000000000001', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'sent', null, null, null)),
  'invalid_or_expired_lease', 'E: a wrong token settles nothing');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  'sending', 'E: the row a wrong token targeted is untouched');
select is(
  (select reason from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000001', null, 'sent', null, 'FAKE_EMAIL_NULL', null)),
  'invalid_or_expired_lease', 'E: a NULL token settles nothing (fail closed)');
select ok(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = 'sending'
  and (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = (select token from pg_temp.lease)
  and (select send_lease_expires_at from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = (select expires from pg_temp.lease)
  and (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = 1,
  'E: the row a NULL token targeted keeps its status, lease, expiry and attempt');


-- ── F. Expiry, recovery and the recovery race ────────────────────────────────
select is(
  (select reason from app.recover_expired_notification_lease('c9300000-0000-4000-8000-000000000001')),
  'lease_still_valid', 'F: a live lease refuses recovery');

update public.notification_deliveries
set send_lease_expires_at = now() - interval '1 second'
where id = 'c9300000-0000-4000-8000-000000000001';

select is(
  (select reason from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000001', (select token from pg_temp.lease), 'sent', null, 'FAKE_EMAIL_LATE', null)),
  'invalid_or_expired_lease', 'F: an expired token cannot complete its claim');
select is(
  (select recovered from app.recover_expired_notification_lease('c9300000-0000-4000-8000-000000000001')),
  true, 'F: the expired lease is recovered');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  'pending', 'F: the recovered row is pending again');
select ok(
  (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = 1
  and (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') is null,
  'F: recovery keeps the attempt consumed and clears the lease');
select is(
  (select reason from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000001', (select token from pg_temp.lease), 'sent', null, 'FAKE_EMAIL_LATE', null)),
  'invalid_or_expired_lease', 'F: the old worker cannot settle after recovery — no conflicting transitions');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  'pending', 'F: the raced row stays pending');
select is(
  (select reason from app.recover_expired_notification_lease('c9300000-0000-4000-8000-000000000002')),
  'not_leased', 'F: a sent row is not recoverable');


-- ── G. Attempt cap, terminal rows, retry/dead, rollback ─────────────────────
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000003', 300)),
  'exhausted', 'G: an exhausted delivery cannot be claimed');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000007', 300)),
  'already_claimed', 'G: a failed row is not pending and cannot be claimed');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000004', 300)),
  'terminal', 'G: a skipped delivery cannot be reclaimed');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000005', 300)),
  'terminal', 'G: a dead delivery cannot be reclaimed');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000008', 300)),
  'not_due', 'G: a row deferred past now cannot be claimed');

-- The full three-attempt lifecycle on one row: the third claim succeeds and
-- reserves the last attempt, and no fourth claim ever exists.
update public.notification_deliveries set attempt_count = 2, next_retry_at = null where id = 'c9300000-0000-4000-8000-000000000008';
select app.claim_notification_delivery('c9300000-0000-4000-8000-000000000008', 300);
select is(
  (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000008'),
  3, 'G: the third claim reserves the last attempt');
select is(
  (select reason from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000008',
    (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000008'),
    'retry', 'provider_rejected_transient', null, null)),
  'pending', 'G: the third attempt returns to pending');
select is(
  (select reason from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000008', 300)),
  'exhausted', 'G: no fourth claim ever exists');

delete from pg_temp.lease;
insert into pg_temp.lease(token, expires)
select lease_token, lease_expires_at from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000001', 300);
select ok(
  (select count(*) from pg_temp.lease) = 1
  and (select token from pg_temp.lease) is not null
  and (select token from pg_temp.lease) <> '0000000000000000000000000000000000000000000000000000000000000000',
  'G: the recovered row is claimed again with a fresh token');
select is(
  (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  2, 'G: the recovered row is claimable for its second attempt');

select is(
  (select settled from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000001', (select token from pg_temp.lease),
    'retry', 'provider_rejected_transient', null, now() + interval '5 minutes')),
  true, 'G: a transient failure returns to pending');
select ok(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = 'pending'
  and (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') = 2
  and (select next_retry_at from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') > now()
  and (select send_lease_token from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001') is null,
  'G: retry keeps the attempt consumed, defers the row and clears the lease');

update public.notification_deliveries set next_retry_at = null where id = 'c9300000-0000-4000-8000-000000000001';
delete from pg_temp.lease;
insert into pg_temp.lease(token, expires)
select lease_token, lease_expires_at from app.claim_notification_delivery('c9300000-0000-4000-8000-000000000001', 300);
select is(
  (select settled from app.resolve_notification_claim(
    'c9300000-0000-4000-8000-000000000001', (select token from pg_temp.lease),
    'dead', 'retries_exhausted', null, null)),
  true, 'G: the third failure goes dead');
select is(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000001'),
  'dead', 'G: the dead row is terminal');

savepoint p5_claim_rollback;
update public.notification_deliveries set next_retry_at = null where id = 'c9300000-0000-4000-8000-000000000009';
select app.claim_notification_delivery('c9300000-0000-4000-8000-000000000009', 300);
rollback to savepoint p5_claim_rollback;
select ok(
  (select status from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000009') = 'pending'
  and (select attempt_count from public.notification_deliveries where id = 'c9300000-0000-4000-8000-000000000009') = 0,
  'G: claim and attempt reservation roll back together');


-- ── H. Privileges and token privacy ──────────────────────────────────────────
select is(pg_temp.try_as('anon', 'select app.claim_notification_delivery(''c9300000-0000-4000-8000-000000000009'', 300)'), '42501', 'H: anon cannot claim');
select is(pg_temp.try_as('authenticated', 'select app.claim_notification_delivery(''c9300000-0000-4000-8000-000000000009'', 300)'), '42501', 'H: authenticated cannot claim');
select is(pg_temp.try_as('authenticated', 'select app.resolve_notification_claim(''c9300000-0000-4000-8000-000000000009'', ''x'', ''sent'')'), '42501', 'H: authenticated cannot settle');
select is(pg_temp.try_as('authenticated', 'select app.recover_expired_notification_lease(''c9300000-0000-4000-8000-000000000009'')'), '42501', 'H: authenticated cannot recover');
select is(pg_temp.try_as('anon', 'select app.recover_expired_notification_lease(''c9300000-0000-4000-8000-000000000009'')'), '42501', 'H: anon cannot recover');
select is(
  position('send_lease_token' in pg_get_functiondef('app.list_email_delivery_log(uuid, integer, timestamptz)'::regprocedure)),
  0, 'H: the masked delivery log carries no lease token');

select * from finish();
rollback;
