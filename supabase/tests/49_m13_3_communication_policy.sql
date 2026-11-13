-- Promoted 2026-11-09 from docs/database/proposals/M13.3-COMMUNICATION-POLICY.proposed.test.sql (body unchanged; only this
-- status header replaced). Apply order: 20261109100000 policy -> 20261109100100 announcements -> 20261109100200 R3.
--
-- Covers:
--   A. Schema, RLS and privileges (evidence tables are deny-all; worker/internal functions are not
--      client-callable; officer/member entry points are).
--   B. The policy matrix (identical to apps/worker/src/communication-policy.ts today).
--   C. The communication.attest_notice permission (owner + admin only; owner still holds everything).
--   D. Attestation: who may attest, versions, idempotency, revocation, supersede, append-only,
--      restrictive reads (no row / revoked / unaccepted version / inactive community / unknown id).
--   E. Member choices: organiser opt-out on request only; CHECK-enforced role rules; linked-member
--      self-service; accountless verified-link and STOP paths; category/channel specificity;
--      permissions never implied by attestation; append-only; audit; no consent written.
--   F. notification_deliveries.communication_category: nullable, constrained, nothing inferred.
--   G. consent_messages_at kept, marked legacy.

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(89);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Users: O owner (A + suspended S), A admin, T treasurer, X outsider, L linked member, B owner of community B.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('c3000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@policy.test',    now()),
  ('c3000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@policy.test',    now()),
  ('c3000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@policy.test', now()),
  ('c3000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@policy.test', now()),
  ('c3000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'linked@policy.test',   now()),
  ('c3000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bowner@policy.test',   now());
insert into public.users (id, full_name, email) values
  ('c3000000-0000-4000-8000-000000000001', 'Policy Owner',     'owner@policy.test'),
  ('c3000000-0000-4000-8000-000000000002', 'Policy Admin',     'admin@policy.test'),
  ('c3000000-0000-4000-8000-000000000003', 'Policy Treasurer', 'treasurer@policy.test'),
  ('c3000000-0000-4000-8000-000000000005', 'Policy Outsider',  'outsider@policy.test'),
  ('c3000000-0000-4000-8000-000000000006', 'Linked Member',    'linked@policy.test'),
  ('c3000000-0000-4000-8000-000000000007', 'B Owner',          'bowner@policy.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by, status) values
  ('c3100000-0000-4000-8000-00000000000a', 'policy-a', 'Policy A', 'social_group', false, 'c3000000-0000-4000-8000-000000000001', 'active'),
  ('c3100000-0000-4000-8000-00000000000b', 'policy-b', 'Policy B', 'social_group', false, 'c3000000-0000-4000-8000-000000000007', 'active'),
  ('c3100000-0000-4000-8000-00000000000c', 'policy-s', 'Policy S', 'social_group', false, 'c3000000-0000-4000-8000-000000000001', 'suspended');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('c3200000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000001', 'owner',     'Policy Owner',     'created'),
  ('c3200000-0000-4000-8000-000000000002', 'c3100000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'admin',     'Policy Admin',     'created'),
  ('c3200000-0000-4000-8000-000000000003', 'c3100000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000003', 'treasurer', 'Policy Treasurer', 'created'),
  ('c3200000-0000-4000-8000-000000000004', 'c3100000-0000-4000-8000-00000000000c', 'c3000000-0000-4000-8000-000000000001', 'owner',     'Policy Owner',     'created'),
  ('c3200000-0000-4000-8000-000000000005', 'c3100000-0000-4000-8000-00000000000b', 'c3000000-0000-4000-8000-000000000007', 'owner',     'B Owner',          'created');

-- Members: M1 and M3 accountless; M2 linked to L; MB in community B. No consent values anywhere.
insert into public.members (id, community_id, full_name, email, user_id, claimed_at, status) values
  ('c3400000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'Accountless One', 'one@policy.test',   null, null, 'unclaimed'),
  ('c3400000-0000-4000-8000-000000000002', 'c3100000-0000-4000-8000-00000000000a', 'Linked Member',   'two@policy.test',   'c3000000-0000-4000-8000-000000000006', now(), 'unclaimed'),
  ('c3400000-0000-4000-8000-000000000003', 'c3100000-0000-4000-8000-00000000000a', 'Accountless Three','three@policy.test', null, null, 'unclaimed'),
  ('c3400000-0000-4000-8000-00000000000b', 'c3100000-0000-4000-8000-00000000000b', 'Other Community', 'b@policy.test',     null, null, 'unclaimed');

-- R2-verify: a collector K scoped to one collection in which M3 has no obligation.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('c3000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@policy.test', now());
insert into public.users (id, full_name, email) values
  ('c3000000-0000-4000-8000-000000000008', 'Policy Collector', 'collector@policy.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by) values
  ('c3800000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'policy-scoped', 'Policy Scoped', 'dues', 'managed', 'fixed', 500000, 'draft', 'c3000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason, scope) values
  ('c3200000-0000-4000-8000-000000000008', 'c3100000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000008', 'collector', 'Policy Collector', 'created',
   '{"collection_ids": ["c3800000-0000-4000-8000-000000000001"]}');

-- One skipped email delivery each to M1 and M3 (the source of a verified-link choice).
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('c3500000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'collection.publish', 'm133-r2-ev-1', 'officer', 'c3000000-0000-4000-8000-000000000001', 'collection', 'c3600000-0000-4000-8000-000000000001', '{}');
insert into public.notification_deliveries (id, notification_event_id, community_id, recipient_member_id, channel, status, error_code, send_class) values
  ('c3700000-0000-4000-8000-000000000001', 'c3500000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000001', 'email', 'skipped', 'community_notice_missing', 'bulk'),
  ('c3700000-0000-4000-8000-000000000003', 'c3500000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000003', 'email', 'skipped', 'community_notice_missing', 'bulk');

-- ── A. Schema, RLS and privileges ────────────────────────────────────────────
select has_table('public', 'community_communication_attestations', 'A: attestation table exists');
select has_table('public', 'member_communication_choices', 'A: choices table exists');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.community_communication_attestations'::regclass), 'A: attestations RLS enabled and forced');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.member_communication_choices'::regclass), 'A: choices RLS enabled and forced');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('community_communication_attestations', 'member_communication_choices')), 0, 'A: no RLS policy on either evidence table (deny-all)');
select ok(
  not has_table_privilege('authenticated', 'public.community_communication_attestations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.community_communication_attestations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.member_communication_choices', 'SELECT')
  and not has_table_privilege('authenticated', 'public.member_communication_choices', 'INSERT'),
  'A: authenticated holds no table privilege on the evidence tables');
select ok(
  not has_table_privilege('anon', 'public.community_communication_attestations', 'SELECT')
  and not has_table_privilege('anon', 'public.member_communication_choices', 'SELECT'),
  'A: anon holds no table privilege on the evidence tables');
select function_privs_are('app', 'community_communication_notice_attested', array['uuid'], 'authenticated', array[]::text[], 'A: authenticated cannot call the worker attestation read');
select function_privs_are('app', 'community_communication_notice_attested', array['uuid'], 'anon', array[]::text[], 'A: anon cannot call the worker attestation read');
select function_privs_are('app', 'record_member_communication_choice', array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid'], 'authenticated', array[]::text[], 'A: the accountless/STOP writer is callable by no client role (caller decided in R4)');
select function_privs_are('app', 'insert_member_communication_choice', array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'uuid', 'uuid', 'uuid', 'text', 'text', 'uuid'], 'authenticated', array[]::text[], 'A: the internal writer is not client-callable');
select function_privs_are('app', 'communication_requirement', array['text', 'text', 'text'], 'authenticated', array[]::text[], 'A: the matrix function is internal');
select function_privs_are('app', 'attest_community_communication_notice', array['uuid', 'text'], 'authenticated', array['EXECUTE'], 'A: authenticated may call attest (permission-checked inside)');
select function_privs_are('app', 'attest_community_communication_notice', array['uuid', 'text'], 'anon', array[]::text[], 'A: anon cannot attest');
select function_privs_are('app', 'record_member_communication_opt_out_on_request', array['uuid', 'text', 'text', 'text', 'text', 'text'], 'authenticated', array['EXECUTE'], 'A: authenticated may call the organiser opt-out (permission-checked inside)');
select function_privs_are('app', 'record_own_communication_choice', array['uuid', 'text', 'text', 'text', 'text', 'text'], 'authenticated', array['EXECUTE'], 'A: authenticated may call own-choice (identity-checked inside)');
select function_privs_are('app', 'member_communication_opted_out', array['uuid', 'text', 'text'], 'authenticated', array[]::text[], 'A: the opt-out read is internal');

-- ── B. Policy matrix ─────────────────────────────────────────────────────────
create temporary table b_matrix as
  select c0.cat, coalesce(c0.pp, '-') as pp, ch0.ch, r.requirement, coalesce(r.detail, '-') as detail
  from (values
    ('essential', null::text), ('community_operational', null), ('marketing', null),
    ('payment', 'status'), ('payment', 'targeted_reminder')
  ) as c0 (cat, pp)
  cross join (values ('in_app'), ('email'), ('whatsapp'), ('sms')) as ch0 (ch)
  cross join lateral app.communication_requirement(c0.cat, ch0.ch, c0.pp) as r;

select results_eq(
  $$ select cat, pp, ch, requirement, detail from b_matrix order by cat, pp, ch $$,
  $$ values
    ('community_operational'::text, '-'::text, 'email'::text,    'default_on'::text, 'community_notice'::text),
    ('community_operational', '-', 'in_app',   'always',     '-'),
    ('community_operational', '-', 'sms',      'disabled',   'channel_disabled'),
    ('community_operational', '-', 'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('essential',             '-', 'email',    'always',     '-'),
    ('essential',             '-', 'in_app',   'always',     '-'),
    ('essential',             '-', 'sms',      'disabled',   'channel_disabled'),
    ('essential',             '-', 'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('marketing',             '-', 'email',    'opt_in',     'marketing_consent'),
    ('marketing',             '-', 'in_app',   'disabled',   'category_not_on_channel'),
    ('marketing',             '-', 'sms',      'disabled',   'channel_disabled'),
    ('marketing',             '-', 'whatsapp', 'opt_in',     'marketing_consent,whatsapp_permission'),
    ('payment', 'status',            'email',    'disabled', 'payment_attribution_unavailable'),
    ('payment', 'status',            'in_app',   'disabled', 'payment_attribution_unavailable'),
    ('payment', 'status',            'sms',      'disabled', 'payment_attribution_unavailable'),
    ('payment', 'status',            'whatsapp', 'disabled', 'payment_attribution_unavailable'),
    ('payment', 'targeted_reminder', 'email',    'disabled', 'payment_attribution_unavailable'),
    ('payment', 'targeted_reminder', 'in_app',   'disabled', 'payment_attribution_unavailable'),
    ('payment', 'targeted_reminder', 'sms',      'disabled', 'payment_attribution_unavailable'),
    ('payment', 'targeted_reminder', 'whatsapp', 'disabled', 'payment_attribution_unavailable')
  $$,
  'B: every category × channel cell matches the approved policy (and the worker)');
select is((select requirement || ':' || detail from app.communication_requirement('payment', 'email')), 'disabled:payment_attribution_unavailable', 'B: a payment communication with no purpose is a blocked targeted reminder');
select throws_ok($$ select * from app.communication_requirement('promotions', 'email') $$, '22023', null, 'B: an unknown category is refused');
select throws_ok($$ select * from app.communication_requirement('essential', 'pigeon') $$, '22023', null, 'B: an unknown channel is refused');
select ok(not exists (select 1 from b_matrix where detail like '%marketing_consent%' and cat <> 'marketing'), 'B: only marketing ever requires marketing consent (no universal consent gate)');
select ok(not exists (select 1 from b_matrix where ch = 'whatsapp' and not (requirement = 'disabled' or detail like '%whatsapp_permission%')), 'B: WhatsApp always needs the member''s WhatsApp permission');
select ok(not exists (select 1 from b_matrix where ch = 'sms' and requirement <> 'disabled'), 'B: SMS is disabled for every category');

-- ── C. Permission catalogue ──────────────────────────────────────────────────
select ok(exists (select 1 from public.permissions where key = 'communication.attest_notice'), 'C: communication.attest_notice is in the catalogue');
select results_eq(
  $$ select role::text from public.role_permissions where permission = 'communication.attest_notice' order by 1 $$,
  $$ values ('admin'::text), ('owner'::text) $$,
  'C: held by owner and admin only');
select is((select count(*) from public.role_permissions where role = 'owner'), (select count(*) from public.permissions), 'C: owner still holds every permission (04_authorization invariant)');

-- ── D. Attestation ───────────────────────────────────────────────────────────
select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000a'), false, 'D: no attestation row → not attested');

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000003","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') $$, '42501', null, 'D: a treasurer (no communication.attest_notice) cannot attest');
reset role;

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000005","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') $$, '42501', null, 'D: an outsider cannot attest');
reset role;

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000008","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') $$, '42501', null, 'D: a collector cannot attest (owner and admin only)');
reset role;

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table d1 as select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') as id;
create temporary table d2 as select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') as id;
select throws_ok($$ select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v9') $$, '22023', null, 'D: an unaccepted notice version is refused');
select throws_ok($$ select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000c', 'community-notice-v1') $$, 'P0001', null, 'D: a suspended community cannot attest');
create temporary table d_status as select * from app.community_communication_notice_status('c3100000-0000-4000-8000-00000000000a');
reset role;

select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000a'), true, 'D: an owner''s attestation of an accepted version counts');
select results_eq(
  $$ select action, notice_version, recorded_by, officer_term_id, officer_role::text from public.community_communication_attestations where id = (select id from d1) $$,
  $$ values ('attest'::text, 'community-notice-v1'::text, 'c3000000-0000-4000-8000-000000000001'::uuid, 'c3200000-0000-4000-8000-000000000001'::uuid, 'owner'::text) $$,
  'D: the row records the officer, their term and role');
select is(
  (select al.action from public.audit_logs al join public.community_communication_attestations a on a.audit_log_id = al.id where a.id = (select id from d1)),
  'community.communication_notice_attest', 'D: the attestation is audited');
select ok(
  (select id from d2) = (select id from d1)
  and (select count(*) from public.community_communication_attestations where community_id = 'c3100000-0000-4000-8000-00000000000a') = 1,
  'D: re-attesting the version in force is a no-op (same id, no new row)');
select results_eq(
  $$ select attested, notice_version, latest_action, recorded_by_name, accepted_versions from d_status $$,
  $$ values (true, 'community-notice-v1'::text, 'attest'::text, 'Policy Owner'::text, array['community-notice-v1']::text[]) $$,
  'D: the officer status function reports the state');
select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000b'), false, 'D: another community is unaffected');

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
create temporary table r1 as select app.revoke_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'notice_changed') as id;
create temporary table r2 as select app.revoke_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'notice_changed') as id;
select throws_ok($$ select app.revoke_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'because') $$, '22023', null, 'D: a revocation reason outside the list is refused');
reset role;

select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000a'), false, 'D: an admin''s revocation makes the community not attested');
select ok(
  (select id from r1) is not null and (select id from r2) is null
  and (select count(*) from public.community_communication_attestations where community_id = 'c3100000-0000-4000-8000-00000000000a') = 2,
  'D: revoking when nothing is in force writes nothing');

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
create temporary table d3 as select app.attest_community_communication_notice('c3100000-0000-4000-8000-00000000000a', 'community-notice-v1') as id;
reset role;
select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000a'), true, 'D: re-attesting after a revocation counts again (latest row decides)');

select throws_ok($$ update public.community_communication_attestations set notice_version = 'community-notice-v2' $$, 'P0001', null, 'D: attestations cannot be updated');
select throws_ok($$ delete from public.community_communication_attestations $$, 'P0001', null, 'D: attestations cannot be deleted');

-- Restrictive reads for rows the functions would never write.
insert into public.community_communication_attestations (community_id, action, notice_version, recorded_by, officer_term_id, officer_role, audit_log_id)
  select 'c3100000-0000-4000-8000-00000000000b', 'attest', 'community-notice-v0', 'c3000000-0000-4000-8000-000000000007', 'c3200000-0000-4000-8000-000000000005', 'owner', a.audit_log_id
  from public.community_communication_attestations a where a.id = (select id from d1);
insert into public.community_communication_attestations (community_id, action, notice_version, recorded_by, officer_term_id, officer_role, audit_log_id)
  select 'c3100000-0000-4000-8000-00000000000c', 'attest', 'community-notice-v1', 'c3000000-0000-4000-8000-000000000001', 'c3200000-0000-4000-8000-000000000004', 'owner', a.audit_log_id
  from public.community_communication_attestations a where a.id = (select id from d1);
select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000b'), false, 'D: an attestation of an unaccepted version does not count');
select is(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000c'), false, 'D: an inactive (suspended) community is never attested');
select is(app.community_communication_notice_attested('c3ffffff-0000-4000-8000-000000000000'), false, 'D: an unknown community is not attested');
select is(app.community_communication_notice_attested(null), false, 'D: NULL is not attested');

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000005","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select * from app.community_communication_notice_status('c3100000-0000-4000-8000-00000000000a') $$, '42501', null, 'D: an outsider cannot read the status');
reset role;

-- ── E. Member choices ────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;
create temporary table e1 as select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'phone') as id;
create temporary table e2 as select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'phone') as id;
select throws_ok($$ select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'phone', 'opt_in') $$, '42501', null, 'E: an organiser cannot record an opt-in (cannot reverse an opt-out)');
select throws_ok($$ select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000001', 'community_operational', 'whatsapp', 'phone', 'grant_permission', 'whatsapp_permission') $$, '42501', null, 'E: an organiser cannot grant a permission');
select throws_ok($$ select app.record_own_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'opt_in') $$, '42501', null, 'E: an officer cannot use the member self-service path for a member');
reset role;

select is(app.member_communication_opted_out('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email'), true, 'E: the requested opt-out is in force');
select is(app.member_communication_opted_out('c3400000-0000-4000-8000-000000000001', 'community_operational', 'whatsapp'), false, 'E: opt-outs are channel-specific');
select is(app.member_communication_opted_out('c3400000-0000-4000-8000-000000000001', 'payment', 'email'), false, 'E: opt-outs are category-specific');
select results_eq(
  $$ select actor_type, source, choice, recorded_by_user_id, request_channel, officer_term_id from public.member_communication_choices where id = (select id from e1) $$,
  $$ values ('officer'::text, 'organiser_on_member_request'::text, 'opt_out'::text, 'c3000000-0000-4000-8000-000000000002'::uuid, 'phone'::text, 'c3200000-0000-4000-8000-000000000002'::uuid) $$,
  'E: the organiser row records who, how the member asked, and the officer term');
select ok((select id from e2) is null and (select count(*) from public.member_communication_choices where member_id = 'c3400000-0000-4000-8000-000000000001') = 1, 'E: recording the same opt-out twice writes nothing');

set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000007","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000003', 'community_operational', 'email', 'phone') $$, '42501', null, 'E: another community''s officer cannot record for this member');
reset role;
set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000005","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000003', 'community_operational', 'email', 'phone') $$, '42501', null, 'E: an outsider cannot record an opt-out');
reset role;
set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000008","role":"authenticated"}';
set local role authenticated;
select throws_ok($$ select app.record_member_communication_opt_out_on_request('c3400000-0000-4000-8000-000000000003', 'community_operational', 'email', 'phone') $$, '42501', null, 'E: a scoped collector cannot record for a member outside its scope (R2-verify fix)');
reset role;

-- Role rules hold even for a direct write that bypasses the functions.
select throws_ok(
  $$ insert into public.member_communication_choices (community_id, member_id, category, channel, choice, source, actor_type, recorded_by_user_id, officer_term_id, request_channel)
     values ('c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000003', 'community_operational', 'email', 'opt_in', 'organiser_on_member_request', 'officer', 'c3000000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'phone') $$,
  '23514', null, 'E: CHECK — an officer row can never be an opt-in');
select throws_ok(
  $$ insert into public.member_communication_choices (community_id, member_id, category, channel, choice, permission, source, actor_type, recorded_by_user_id, officer_term_id, request_channel, wording_version)
     values ('c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000003', 'community_operational', 'whatsapp', 'grant_permission', 'whatsapp_permission', 'organiser_on_member_request', 'officer', 'c3000000-0000-4000-8000-000000000002', 'c3200000-0000-4000-8000-000000000002', 'phone', 'whatsapp-optin-v1') $$,
  '23514', null, 'E: CHECK — an officer row can never grant a permission');
select throws_ok(
  $$ insert into public.member_communication_choices (community_id, member_id, category, channel, choice, permission, source, actor_type, wording_version)
     values ('c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000003', 'community_operational', 'whatsapp', 'grant_permission', 'whatsapp_permission', 'channel_stop_reply', 'system', 'whatsapp-optin-v1') $$,
  '23514', null, 'E: CHECK — a system row can never grant');

-- Linked member (account) — one path; accountless members use the verified link below.
set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000006","role":"authenticated"}';
set local role authenticated;
create temporary table e_own1 as select app.record_own_communication_choice('c3400000-0000-4000-8000-000000000002', 'community_operational', 'all', 'opt_out') as id;
reset role;
-- The opt-out read is internal (not client-callable), so it is read as the owner.
create temporary table e_all as select app.member_communication_opted_out('c3400000-0000-4000-8000-000000000002', 'community_operational', 'email') as v;
set local request.jwt.claims = '{"sub":"c3000000-0000-4000-8000-000000000006","role":"authenticated"}';
set local role authenticated;
create temporary table e_own2 as select app.record_own_communication_choice('c3400000-0000-4000-8000-000000000002', 'community_operational', 'email', 'opt_in') as id;
select throws_ok($$ select app.record_own_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'opt_in') $$, '42501', null, 'E: a member cannot record a choice for another member');
reset role;
select is((select v from e_all), true, 'E: an opt-out on all channels covers email');
select is(app.member_communication_opted_out('c3400000-0000-4000-8000-000000000002', 'community_operational', 'email'), false, 'E: the member''s own later opt-in on email reverses it there');
select is(app.member_communication_opted_out('c3400000-0000-4000-8000-000000000002', 'community_operational', 'sms'), true, 'E: … and only there');

-- WhatsApp permission: never implied by membership or attestation.
select ok(app.community_communication_notice_attested('c3100000-0000-4000-8000-00000000000a') and not app.member_communication_permission('c3400000-0000-4000-8000-000000000001', 'whatsapp_permission'), 'E: an attested community gives no member WhatsApp permission');

-- Accountless verified-link path (executed here as the database owner; no client role can call it).
create temporary table e_grant as select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'whatsapp', 'grant_permission', 'whatsapp_permission', 'member_verified_link', 'whatsapp-optin-v1', 'c3700000-0000-4000-8000-000000000001') as id;
select is(app.member_communication_permission('c3400000-0000-4000-8000-000000000001', 'whatsapp_permission'), true, 'E: an accountless member grants WhatsApp permission through a verified link — no account needed');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'opt_out', null, 'member_verified_link', null, null) $$, '22023', null, 'E: a verified-link choice must name its delivery');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'opt_out', null, 'member_verified_link', null, 'c3700000-0000-4000-8000-000000000003') $$, '42501', null, 'E: a delivery addressed to another member cannot carry this member''s choice');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'opt_out', null, 'organiser_on_member_request', null, null) $$, '22023', null, 'E: the accountless writer refuses organiser sources');
create temporary table e_stop as select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'whatsapp', 'withdraw_permission', 'whatsapp_permission', 'channel_stop_reply', null, null) as id;
select is(app.member_communication_permission('c3400000-0000-4000-8000-000000000001', 'whatsapp_permission'), false, 'E: a STOP reply withdraws the permission');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'whatsapp', 'grant_permission', 'whatsapp_permission', 'channel_stop_reply', 'whatsapp-optin-v1', null) $$, '23514', null, 'E: a STOP reply can never grant');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'community_operational', 'email', 'grant_permission', 'marketing_consent', 'member_verified_link', 'marketing-v1', 'c3700000-0000-4000-8000-000000000001') $$, '23514', null, 'E: marketing consent belongs to the marketing category only');
select throws_ok($$ select app.record_member_communication_choice('c3400000-0000-4000-8000-000000000001', 'marketing', 'email', 'grant_permission', 'marketing_consent', 'member_verified_link', null, 'c3700000-0000-4000-8000-000000000001') $$, '23514', null, 'E: a grant must name the wording the member agreed to');
select is(app.member_communication_permission('c3400000-0000-4000-8000-000000000001', 'marketing_consent'), false, 'E: no marketing consent exists unless the member gave it');

select throws_ok($$ update public.member_communication_choices set choice = 'opt_in' $$, 'P0001', null, 'E: choices cannot be updated');
select throws_ok($$ delete from public.member_communication_choices $$, 'P0001', null, 'E: choices cannot be deleted');
select ok(
  (select count(*) from public.audit_logs where action = 'member.communication_choice' and object_id = 'c3400000-0000-4000-8000-000000000001') >= 3
  and not exists (select 1 from public.audit_logs where action = 'member.communication_choice' and after_state::text like '%@%'),
  'E: every choice is audited, with codes only (no address)');
select is((select count(*)::int from public.members where community_id in ('c3100000-0000-4000-8000-00000000000a', 'c3100000-0000-4000-8000-00000000000b') and consent_messages_at is not null), 0, 'E: no consent value is written by any path');
select is((select count(*)::int from public.notification_preferences where member_id in ('c3400000-0000-4000-8000-000000000001', 'c3400000-0000-4000-8000-000000000002')), 0, 'E: the legacy preferences table is not written');

-- ── F. Delivery category ─────────────────────────────────────────────────────
select has_column('public', 'notification_deliveries', 'communication_category', 'F: communication_category exists');
select col_is_null('public', 'notification_deliveries', 'communication_category', 'F: communication_category is nullable');
select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, channel, status, error_code, send_class, communication_category)
     values ('c3500000-0000-4000-8000-000000000001', 'c3100000-0000-4000-8000-00000000000a', 'c3400000-0000-4000-8000-000000000002', 'email', 'skipped', 'opted_out', 'bulk', 'promotions') $$,
  '23514', null, 'F: only the four categories are accepted');
select ok((select communication_category from public.notification_deliveries where id = 'c3700000-0000-4000-8000-000000000001') is null, 'F: a row written without a category stays NULL (nothing inferred)');

-- ── G. Legacy consent column ─────────────────────────────────────────────────
select has_column('public', 'members', 'consent_messages_at', 'G: consent_messages_at is kept');
select matches(
  col_description('public.members'::regclass, (select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'consent_messages_at')),
  '^LEGACY', 'G: its comment marks it legacy');

select * from finish();
rollback;
