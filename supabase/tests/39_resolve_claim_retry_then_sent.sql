-- ─────────────────────────────────────────────────────────────────────────────
-- 39 — Regression: retry then sent clears stale error fields
--
-- Migration 20261013200100. Proves that a delivery which fails transiently
-- (retry with error_code) and then succeeds (sent) does not violate the
-- notification_deliveries_sent_has_no_error constraint.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(6);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('d9000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@t39.example.test', now());
insert into public.users (id, full_name, email) values
  ('d9000000-0000-4000-8000-000000000001', 'T39 Owner', 'owner@t39.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('d9100000-0000-4000-8000-00000000000a', 't39-retry-sent', 'T39 Retry Sent', 'social_group', false, 'd9000000-0000-4000-8000-000000000001');
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('d9200000-0000-4000-8000-000000000001', 'd9100000-0000-4000-8000-00000000000a', 'member.create', 't39-retry-sent-01', 'officer', 'd9000000-0000-4000-8000-000000000001', 'member', 'd9300000-0000-4000-8000-000000000001', '{}');
insert into public.notification_deliveries
  (id, notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, attempt_count)
values
  ('d9300000-0000-4000-8000-000000000001', 'd9200000-0000-4000-8000-000000000001', 'd9100000-0000-4000-8000-00000000000a', 'email', 'pending', 'retry-then-sent@t39.example.test', 'unverified_supplied', 0);

create temporary table pg_temp.t39_lease (token text, expires timestamptz);


-- ── Step 1: claim attempt 1 ─────────────────────────────────────────────────
insert into pg_temp.t39_lease(token, expires)
select lease_token, lease_expires_at
from app.claim_notification_delivery('d9300000-0000-4000-8000-000000000001', 300);


-- ── Step 2: resolve attempt 1 as retry with a transient error ───────────────
select is(
  (select settled from app.resolve_notification_claim(
    'd9300000-0000-4000-8000-000000000001',
    (select token from pg_temp.t39_lease),
    'retry', 'provider_rejected_transient', null, null)),
  true, 'attempt 1 resolves as retry');

select ok(
  (select error_code from public.notification_deliveries where id = 'd9300000-0000-4000-8000-000000000001') = 'provider_rejected_transient',
  'retry sets error_code on the delivery row');


-- ── Step 3: claim attempt 2 ─────────────────────────────────────────────────
delete from pg_temp.t39_lease;
insert into pg_temp.t39_lease(token, expires)
select lease_token, lease_expires_at
from app.claim_notification_delivery('d9300000-0000-4000-8000-000000000001', 300);


-- ── Step 4: resolve attempt 2 as sent — must not violate the constraint ─────
select lives_ok($$
  select app.resolve_notification_claim(
    'd9300000-0000-4000-8000-000000000001',
    (select token from pg_temp.t39_lease),
    'sent', null, 'FAKE_EMAIL_T39', null)
$$, 'retry-then-sent does not violate notification_deliveries_sent_has_no_error');


-- ── Step 5: verify final state ──────────────────────────────────────────────
select is(
  (select status from public.notification_deliveries where id = 'd9300000-0000-4000-8000-000000000001'),
  'sent', 'delivery status is sent');

select ok(
  (select error_code from public.notification_deliveries where id = 'd9300000-0000-4000-8000-000000000001') is null
  and (select error_message from public.notification_deliveries where id = 'd9300000-0000-4000-8000-000000000001') is null,
  'error_code and error_message are both NULL after sent');

select is(
  (select attempt_count from public.notification_deliveries where id = 'd9300000-0000-4000-8000-000000000001'),
  2, 'attempt_count is 2 after retry then sent');


select * from finish();
rollback;
