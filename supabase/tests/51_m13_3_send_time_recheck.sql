-- Promoted 2026-11-09 from docs/database/proposals/M13.3-R3-SEND-TIME-RECHECK.proposed.test.sql (body unchanged; only this
-- status header replaced). Apply order: 20261109100000 policy -> 20261109100100 announcements -> 20261109100200 R3.
--
-- Every case queues a delivery FIRST, then changes the world (opt-out, archive, address change,
-- legacy preference, visibility, revocation), then drives the real claim → reserve path that the
-- sender uses, and asserts the outcome. Bulk caps are zero on every environment today, so an
-- ELIGIBLE community row reserves `provider_daily_limited` (deferred), never `granted`; an
-- INELIGIBLE one reserves `ineligible` and is settled skipped with a stable code.
--
-- Covers: A schema/privileges/invariant; B eligible rows; C post-queue withdrawals and changes;
-- D essential unaffected; E payment / unknown / mismatched categories; F settled-row shape and no
-- re-claim; G WhatsApp/SMS (permission never implied by attestation); H revocation.

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(41);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('d3000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@r3.test',  now()),
  ('d3000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'holder@r3.test', now());
insert into public.users (id, full_name, email) values
  ('d3000000-0000-4000-8000-000000000001', 'R3 Owner',  'owner@r3.test'),
  ('d3000000-0000-4000-8000-000000000002', 'R3 Holder', 'holder@r3.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('d3100000-0000-4000-8000-00000000000a', 'r3-send-time', 'R3 Community', 'social_group', false, 'd3000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('d3200000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'owner', 'R3 Owner', 'created');

insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, visibility, created_by, published_at, published_by) values
  ('d3300000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'r3-open',  'R3 Open',  'dues', 'managed', 'fixed', 500000, 'active', 'unlisted', 'd3000000-0000-4000-8000-000000000001', now(), 'd3000000-0000-4000-8000-000000000001'),
  ('d3300000-0000-4000-8000-000000000002', 'd3100000-0000-4000-8000-00000000000a', 'r3-later', 'R3 Later', 'dues', 'managed', 'fixed', 500000, 'active', 'unlisted', 'd3000000-0000-4000-8000-000000000001', now(), 'd3000000-0000-4000-8000-000000000001');

-- Accountless members (no consent values anywhere) and one account holder.
insert into public.members (id, community_id, full_name, email, user_id, claimed_at, status) values
  ('d3400000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'OK',          'ok@r3.test',      null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000002', 'd3100000-0000-4000-8000-00000000000a', 'Opts Out',    'out@r3.test',     null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000003', 'd3100000-0000-4000-8000-00000000000a', 'Archived',    'arch@r3.test',    null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000004', 'd3100000-0000-4000-8000-00000000000a', 'Changes',     'old@r3.test',     null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000005', 'd3100000-0000-4000-8000-00000000000a', 'Legacy Pref', 'pref@r3.test',    null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000006', 'd3100000-0000-4000-8000-00000000000a', 'Holder',      'typed@r3.test',   'd3000000-0000-4000-8000-000000000002', now(), 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000007', 'd3100000-0000-4000-8000-00000000000a', 'Essential',   'ess@r3.test',     null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000008', 'd3100000-0000-4000-8000-00000000000a', 'Mismatch',    'mis@r3.test',     null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-000000000009', 'd3100000-0000-4000-8000-00000000000a', 'Channels',    'wa@r3.test',      null, null, 'unclaimed'),
  ('d3400000-0000-4000-8000-00000000000a', 'd3100000-0000-4000-8000-00000000000a', 'Notice',      'notice@r3.test',  null, null, 'unclaimed');

-- The owner attests (M13.3-COMMUNICATION-POLICY).
set local request.jwt.claims = '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table fx_attest as
  select app.attest_community_communication_notice('d3100000-0000-4000-8000-00000000000a', 'community-notice-v1') as id;
reset role;

insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('d3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'collection.publish',       'r3-ev-pub',     'officer', 'd3000000-0000-4000-8000-000000000001', 'collection', 'd3300000-0000-4000-8000-000000000001', '{}'),
  ('d3500000-0000-4000-8000-000000000002', 'd3100000-0000-4000-8000-00000000000a', 'collection.publish',       'r3-ev-pub2',    'officer', 'd3000000-0000-4000-8000-000000000001', 'collection', 'd3300000-0000-4000-8000-000000000002', '{}'),
  ('d3500000-0000-4000-8000-000000000003', 'd3100000-0000-4000-8000-00000000000a', 'collection.remind_unpaid', 'r3-ev-unpaid',  'officer', 'd3000000-0000-4000-8000-000000000001', 'collection', 'd3300000-0000-4000-8000-000000000001', '{}'),
  ('d3500000-0000-4000-8000-000000000004', 'd3100000-0000-4000-8000-00000000000a', 'community.mystery',        'r3-ev-unknown', 'officer', 'd3000000-0000-4000-8000-000000000001', 'community',  'd3100000-0000-4000-8000-00000000000a', '{}'),
  ('d3500000-0000-4000-8000-000000000005', 'd3100000-0000-4000-8000-00000000000a', 'member.create',            'r3-ev-ess',     'officer', 'd3000000-0000-4000-8000-000000000001', 'member',     'd3400000-0000-4000-8000-000000000007', '{}');

-- Queued deliveries (pending), written BEFORE the world changes.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, recipient_member_id, recipient_user_id, recipient_address, recipient_address_assurance, channel, status, send_class, communication_category)
values
  ('d3600000-0000-4000-8000-000000000001', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000001', null, 'ok@r3.test',     'unverified_supplied', 'email', 'pending', 'bulk', 'community_operational'),
  ('d3600000-0000-4000-8000-000000000002', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000002', null, 'out@r3.test',    'unverified_supplied', 'email', 'pending', 'bulk', 'community_operational'),
  ('d3600000-0000-4000-8000-000000000003', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000003', null, 'arch@r3.test',   'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-000000000004', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000004', null, 'old@r3.test',    'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-000000000005', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000005', null, 'pref@r3.test',   'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-000000000006', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000006', 'd3000000-0000-4000-8000-000000000002', 'holder@r3.test', 'verified_account', 'email', 'pending', 'bulk', 'community_operational'),
  ('d3600000-0000-4000-8000-000000000007', 'd3500000-0000-4000-8000-000000000002', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000001', null, 'ok@r3.test',     'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-000000000008', 'd3500000-0000-4000-8000-000000000003', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000001', null, 'ok@r3.test',     'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-000000000009', 'd3500000-0000-4000-8000-000000000004', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000001', null, 'ok@r3.test',     'unverified_supplied', 'email', 'pending', 'bulk', null),
  ('d3600000-0000-4000-8000-00000000000a', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000008', null, 'mis@r3.test',    'unverified_supplied', 'email', 'pending', 'bulk', 'payment'),
  ('d3600000-0000-4000-8000-00000000000b', 'd3500000-0000-4000-8000-000000000005', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000007', null, 'ess@r3.test',    'unverified_supplied', 'email', 'pending', 'transactional', 'essential'),
  ('d3600000-0000-4000-8000-00000000000c', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000009', null, null,             null,                  'whatsapp', 'pending', 'bulk', 'community_operational'),
  ('d3600000-0000-4000-8000-00000000000d', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000009', null, null,             null,                  'sms',      'pending', 'bulk', 'community_operational'),
  ('d3600000-0000-4000-8000-00000000000e', 'd3500000-0000-4000-8000-000000000001', 'd3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-00000000000a', null, 'notice@r3.test', 'unverified_supplied', 'email', 'pending', 'bulk', null);

-- ── The world changes AFTER queueing ─────────────────────────────────────────
set local request.jwt.claims = '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table fx_optouts as select
  app.record_member_communication_opt_out_on_request('d3400000-0000-4000-8000-000000000002', 'community_operational', 'email', 'phone') as a,
  app.record_member_communication_opt_out_on_request('d3400000-0000-4000-8000-000000000007', 'community_operational', 'all',   'in_person') as b;
reset role;
update public.members set status = 'archived', archived_at = now() where id = 'd3400000-0000-4000-8000-000000000003';
update public.members set email = 'new@r3.test' where id = 'd3400000-0000-4000-8000-000000000004';
insert into public.notification_preferences (community_id, member_id, email_enabled) values
  ('d3100000-0000-4000-8000-00000000000a', 'd3400000-0000-4000-8000-000000000005', false);
update public.collections set visibility = 'members_only' where id = 'd3300000-0000-4000-8000-000000000002';

-- The sender's path: claim (row lock, status → sending) then reserve, in this transaction.
create function pg_temp.claim_and_reserve(p_id uuid) returns text
language plpgsql as $$
declare c record; r record;
begin
  select * into c from app.claim_notification_delivery(p_id, 300);
  if not coalesce(c.claimed, false) then return 'not_claimed:' || coalesce(c.reason, '?'); end if;
  select * into r from app.reserve_email_attempt(p_id);
  return r.reservation;
end $$;

create temporary table outcome as
  select v.k, v.id, pg_temp.claim_and_reserve(v.id) as reservation
  from (values
    ('ok',       'd3600000-0000-4000-8000-000000000001'::uuid),
    ('opt',      'd3600000-0000-4000-8000-000000000002'),
    ('arch',     'd3600000-0000-4000-8000-000000000003'),
    ('chg',      'd3600000-0000-4000-8000-000000000004'),
    ('pref',     'd3600000-0000-4000-8000-000000000005'),
    ('holder',   'd3600000-0000-4000-8000-000000000006'),
    ('reach',    'd3600000-0000-4000-8000-000000000007'),
    ('unpaid',   'd3600000-0000-4000-8000-000000000008'),
    ('unknown',  'd3600000-0000-4000-8000-000000000009'),
    ('mismatch', 'd3600000-0000-4000-8000-00000000000a'),
    ('ess',      'd3600000-0000-4000-8000-00000000000b')
  ) as v (k, id);

create temporary table settled as
  select o.k, o.reservation, d.status::text as status, d.error_code, d.recipient_address, d.send_lease_token, d.attempt_count,
         (select count(*) from public.notification_send_attempts a where a.delivery_id = d.id)::int as ledger
  from outcome o join public.notification_deliveries d on d.id = o.id;

-- ── A. Schema, privileges, invariant ─────────────────────────────────────────
select has_function('app', 'recheck_delivery_eligibility', array['uuid'], 'A: recheck exists');
select has_function('app', 'communication_category_for_event', array['text'], 'A: event category map exists');
select function_privs_are('app', 'recheck_delivery_eligibility', array['uuid'], 'authenticated', array[]::text[], 'A: authenticated cannot call the recheck');
select function_privs_are('app', 'recheck_delivery_eligibility', array['uuid'], 'anon', array[]::text[], 'A: anon cannot call the recheck');
select ok(not has_function_privilege('service_role', 'app.recheck_delivery_eligibility(uuid)', 'EXECUTE'), 'A: service_role cannot call the recheck');
select ok((select prosrc like '%app.recheck_delivery_eligibility(p_delivery_id)%' from pg_proc where oid = 'app.reserve_email_attempt(uuid)'::regprocedure), 'A: reserve_email_attempt calls the recheck (the invariant the worker relies on)');
select ok((select prosecdef from pg_proc where oid = 'app.recheck_delivery_eligibility(uuid)'::regprocedure) and (select provolatile = 'v' from pg_proc where oid = 'app.recheck_delivery_eligibility(uuid)'::regprocedure), 'A: recheck is SECURITY DEFINER and VOLATILE (fresh snapshot after its locks)');
select is((select count(*)::int from (values ('member.create'), ('member.approve_join'), ('officer_invitation.accept'), ('officer_term.end'), ('member.reject_join'), ('member.join_via_invite'), ('collection.publish'), ('collection.announce_update'), ('collection.remind'), ('collection.publish_remind_unpaid'), ('collection.remind_unpaid')) e(t) cross join lateral app.communication_category_for_event(e.t)), 11, 'A: every watched event is classified');

-- ── B. Eligible rows pass the recheck (and hit the zero bulk cap) ────────────
select is((select reservation from settled where k = 'ok'), 'provider_daily_limited', 'B: an eligible community row passes the recheck and is deferred by the zero bulk cap, not sent');
select is((select reservation from settled where k = 'holder'), 'provider_daily_limited', 'B: an account holder at the confirmed account address passes the recheck');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-000000000001'), null, 'B: recheck returns NULL for the eligible row');
select results_eq($$ select status, recipient_address is not null, ledger from settled where k = 'ok' $$, $$ values ('pending'::text, true, 0) $$, 'B: the deferred row keeps its address and consumed no ledger row');

-- ── C. Changes after queueing are honoured at send time ──────────────────────
select is((select reservation from settled where k = 'opt'), 'ineligible', 'C: an opt-out recorded after queueing blocks the send');
select is((select error_code from settled where k = 'opt'), 'opted_out', 'C: … with error_code opted_out');
select is((select error_code from settled where k = 'arch'), 'member_unavailable', 'C: a member archived after queueing is not sent to');
select is((select error_code from settled where k = 'chg'), 'recipient_changed', 'C: an address corrected after queueing is not used');
select is((select error_code from settled where k = 'pref'), 'opted_out', 'C: the legacy email_enabled=false preference is honoured');
select is((select error_code from settled where k = 'reach'), 'collection_not_reachable', 'C: a collection made members-only after queueing is not linked');
select ok(not exists (select 1 from settled where error_code in ('consent_missing', 'legacy_consent_gate')), 'C: consent is never a send-time reason');

-- ── D. Essential messages are unaffected ─────────────────────────────────────
select is((select reservation from settled where k = 'ess'), 'granted', 'D: a membership confirmation is granted although the member opted out of community email on all channels');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000b'), null, 'D: recheck is NULL for essential');

-- ── E. Payment, unknown and mismatched categories ────────────────────────────
select is((select error_code from settled where k = 'unpaid'), 'payment_attribution_unavailable', 'E: a payment-targeted reminder stays blocked');
select is((select error_code from settled where k = 'unknown'), 'category_unknown', 'E: an unclassified event is not sent (fail closed)');
select is((select error_code from settled where k = 'mismatch'), 'category_mismatch', 'E: a stored category that disagrees with the event is not sent');

-- ── F. Shape of a settled ineligible row; no re-claim; no double ledger ──────
select results_eq(
  $$ select count(*)::int from settled where reservation = 'ineligible' and status = 'skipped' and recipient_address is null and send_lease_token is null and attempt_count = 0 and ledger = 0 $$,
  $$ values (8) $$,
  'F: all eight ineligible rows are skipped, address erased, lease cleared, attempt undone, no ledger row');
select is((select reservation from settled where k = 'ess'), 'granted', 'F: (control) the granted row is the only one with a ledger row');
select is((select ledger from settled where k = 'ess'), 1, 'F: … exactly one');
select is((select claimed from app.claim_notification_delivery('d3600000-0000-4000-8000-000000000002', 300)), false, 'F: a row skipped at send time can never be claimed again');
select throws_ok($$ select * from app.reserve_email_attempt('d3600000-0000-4000-8000-000000000002') $$, 'P0001', null, 'F: reserve still refuses a row that is not sending');
select is(app.recheck_delivery_eligibility('d3ffffff-0000-4000-8000-000000000000'), 'delivery_not_found', 'F: an unknown delivery is never eligible');

-- ── G. WhatsApp and SMS ──────────────────────────────────────────────────────
select ok(app.community_communication_notice_attested('d3100000-0000-4000-8000-00000000000a'), 'G: (control) the community is attested');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000c'), 'channel_permission_missing', 'G: WhatsApp needs the member''s own permission — the attestation does not substitute');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000d'), 'channel_disabled', 'G: SMS is disabled');
create temporary table fx_wa as
  select app.record_member_communication_choice('d3400000-0000-4000-8000-000000000009', 'community_operational', 'whatsapp', 'grant_permission', 'whatsapp_permission', 'member_verified_link', 'whatsapp-optin-v1', 'd3600000-0000-4000-8000-00000000000c') as id;
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000c'), null, 'G: with the member''s own WhatsApp permission the row passes');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000d'), 'channel_disabled', 'G: … SMS stays disabled regardless');
create temporary table fx_wa_stop as
  select app.record_member_communication_choice('d3400000-0000-4000-8000-000000000009', 'community_operational', 'whatsapp', 'withdraw_permission', 'whatsapp_permission', 'channel_stop_reply', null, null) as id;
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000c'), 'channel_permission_missing', 'G: a STOP reply withdraws it again at send time');

-- ── H. Revocation after queueing ─────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table fx_revoke as
  select app.revoke_community_communication_notice('d3100000-0000-4000-8000-00000000000a', 'attested_in_error') as id;
reset role;
create temporary table h_outcome as
  select pg_temp.claim_and_reserve('d3600000-0000-4000-8000-00000000000e') as reservation;
select is((select reservation from h_outcome), 'ineligible', 'H: a revocation after queueing blocks the send');
select is((select error_code from public.notification_deliveries where id = 'd3600000-0000-4000-8000-00000000000e'), 'community_notice_missing', 'H: … with error_code community_notice_missing');
select is(app.recheck_delivery_eligibility('d3600000-0000-4000-8000-00000000000b'), null, 'H: essential is still unaffected after the revocation');
select is((select count(*)::int from public.notification_deliveries where community_id = 'd3100000-0000-4000-8000-00000000000a' and status::text in ('sent', 'delivered')), 0, 'H: nothing in this community was sent');
select is((select count(*)::int from public.members where community_id = 'd3100000-0000-4000-8000-00000000000a' and consent_messages_at is not null), 0, 'H: no consent value was written');

select * from finish();
rollback;
