-- Promoted 2026-11-09 from docs/database/proposals/MEMBER-ANNOUNCEMENTS.proposed.test.sql (body unchanged; only this
-- status header replaced). Apply order: 20261109100000 policy -> 20261109100100 announcements -> 20261109100200 R3.
--
-- REVISION M13.3 R2: consent is no longer a requirement (the M13.2 version is kept as
-- MEMBER-ANNOUNCEMENTS.M13.2-v1.superseded.test.sql). The community must be attested
-- (community_notice_missing otherwise), and opt-outs come from member_communication_choices as well
-- as the legacy notification_preferences flags, reported before the notice gap.
--
-- Covers:
--   A. Schema and privileges (worker-only functions are not client-callable).
--   B0. Before attestation: nobody is eligible; opt-outs still reported as opted_out.
--   B. Recipient resolution from member records — no account needed, no consent needed — and each
--      skip reason: opted_out (choices log, channel and category flags), no_recipient,
--      invalid_recipient_address, unverified_account_email; account holders use the confirmed
--      auth address only; consent_missing never appears.
--   C. Tenancy (another community's members never appear) and archived members excluded.
--   D. Reachability: members-only and draft collections are not reachable; open (public-audience)
--      collections reach every current member.
--   E. Preview: counts only, "once live" for a draft, permission-checked.
--   F. announce_collection_update: audit + one enqueue, idempotent replay, allow-list, state.

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(35);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('49000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@announce.test',      now()),
  ('49000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'holder@announce.test',    now()),
  ('49000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'unconfirmed@announce.test', null),
  ('49000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@announce.test',  now());
insert into public.users (id, full_name, email) values
  ('49000000-0000-4000-8000-000000000001', 'Announce Host',  'host@announce.test'),
  ('49000000-0000-4000-8000-000000000002', 'Account Holder', 'holder@announce.test'),
  ('49000000-0000-4000-8000-000000000003', 'Unconfirmed',    'unconfirmed@announce.test'),
  ('49000000-0000-4000-8000-000000000004', 'Outsider',       'outsider@announce.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('49100000-0000-4000-8000-00000000000a', 'announce-a', 'Announce A', 'social_group', false, '49000000-0000-4000-8000-000000000001'),
  ('49100000-0000-4000-8000-00000000000b', 'announce-b', 'Announce B', 'social_group', false, '49000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('49200000-0000-4000-8000-000000000001', '49100000-0000-4000-8000-00000000000a', '49000000-0000-4000-8000-000000000001', 'owner', 'Announce Host', 'created');

insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, visibility, created_by, published_at, published_by) values
  ('49300000-0000-4000-8000-000000000a01', '49100000-0000-4000-8000-00000000000a', 'managed-unlisted', 'Managed Unlisted', 'dues', 'managed', 'fixed', 500000, 'active', 'unlisted',     '49000000-0000-4000-8000-000000000001', now(), '49000000-0000-4000-8000-000000000001'),
  ('49300000-0000-4000-8000-000000000a02', '49100000-0000-4000-8000-00000000000a', 'members-only',     'Members Only',     'dues', 'managed', 'fixed', 500000, 'active', 'members_only', '49000000-0000-4000-8000-000000000001', now(), '49000000-0000-4000-8000-000000000001'),
  ('49300000-0000-4000-8000-000000000a03', '49100000-0000-4000-8000-00000000000a', 'open-public',      'Open Public',      'dues', 'open',    'fixed', 500000, 'active', 'public',       '49000000-0000-4000-8000-000000000001', now(), '49000000-0000-4000-8000-000000000001'),
  ('49300000-0000-4000-8000-000000000a04', '49100000-0000-4000-8000-00000000000a', 'managed-draft',    'Managed Draft',    'dues', 'managed', 'fixed', 500000, 'draft',  'unlisted',     '49000000-0000-4000-8000-000000000001', null, null);

insert into public.members (id, community_id, full_name, email, consent_messages_at, user_id, claimed_at, status, archived_at) values
  ('49400000-0000-4000-8000-000000000001', '49100000-0000-4000-8000-00000000000a', 'No Account',      'chidi@announce.test',     now(), null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000002', '49100000-0000-4000-8000-00000000000a', 'No Consent',      'noconsent@announce.test', null,  null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000003', '49100000-0000-4000-8000-00000000000a', 'No Email',        null,                      now(), null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000004', '49100000-0000-4000-8000-00000000000a', 'Bad Email',       'not an address',          now(), null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000005', '49100000-0000-4000-8000-00000000000a', 'Email Off',       'off@announce.test',       now(), null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000006', '49100000-0000-4000-8000-00000000000a', 'No Announcements','noann@announce.test',     now(), null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000007', '49100000-0000-4000-8000-00000000000a', 'Account Holder',  'typed@announce.test',     now(), '49000000-0000-4000-8000-000000000002', now(), 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000008', '49100000-0000-4000-8000-00000000000a', 'Unconfirmed',     'typed2@announce.test',    now(), '49000000-0000-4000-8000-000000000003', now(), 'unclaimed', null),
  ('49400000-0000-4000-8000-000000000009', '49100000-0000-4000-8000-00000000000a', 'Archived',        'gone@announce.test',      now(), null, null, 'archived',  now()),
  ('49400000-0000-4000-8000-00000000000c', '49100000-0000-4000-8000-00000000000a', 'Choice Out',      'choiceout@announce.test', null,  null, null, 'unclaimed', null),
  ('49400000-0000-4000-8000-00000000000b', '49100000-0000-4000-8000-00000000000b', 'Other Community', 'other@announce.test',     now(), null, null, 'unclaimed', null);

insert into public.notification_preferences (community_id, member_id, email_enabled, announcements_enabled) values
  ('49100000-0000-4000-8000-00000000000a', '49400000-0000-4000-8000-000000000005', false, null),
  ('49100000-0000-4000-8000-00000000000a', '49400000-0000-4000-8000-000000000006', null,  false);

-- M13.3 R2: "Choice Out" asked the organiser to stop community email (choices log).
set local request.jwt.claims = '{"sub":"49000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table fx_optout as
  select app.record_member_communication_opt_out_on_request('49400000-0000-4000-8000-00000000000c', 'community_operational', 'email', 'in_person') as id;
reset role;

-- B0: evaluated BEFORE the community attests.
create temporary table r_pre as
  select * from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a01'::uuid, 'announcement');

-- The owner attests (M13.3-COMMUNICATION-POLICY.proposed.sql).
set local request.jwt.claims = '{"sub":"49000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table fx_attest as
  select app.attest_community_communication_notice('49100000-0000-4000-8000-00000000000a', 'community-notice-v1') as id;
reset role;

create temporary table r_ann as
  select * from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a01'::uuid, 'announcement');
create temporary table r_rem as
  select * from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a01'::uuid, 'reminder');

-- ── A. Schema and privileges ─────────────────────────────────────────────────
select has_function('app', 'evaluate_collection_email_recipients', array['uuid', 'text'], 'A: evaluate exists');
select function_privs_are('app', 'evaluate_collection_email_recipients', array['uuid', 'text'], 'authenticated', array[]::text[], 'A: authenticated cannot call evaluate (addresses are worker-only)');
select function_privs_are('app', 'evaluate_collection_email_recipients', array['uuid', 'text'], 'anon', array[]::text[], 'A: anon cannot call evaluate');
select function_privs_are('app', 'collection_announcement_context', array['uuid'], 'authenticated', array[]::text[], 'A: authenticated cannot call the context function');
select function_privs_are('app', 'preview_collection_announcement_recipients', array['uuid', 'text'], 'authenticated', array['EXECUTE'], 'A: authenticated may call the counts-only preview');
select function_privs_are('app', 'announce_collection_update', array['uuid', 'text[]', 'text'], 'anon', array[]::text[], 'A: anon cannot announce');

-- ── B0. Before attestation ───────────────────────────────────────────────────
select is((select count(*)::int from r_pre where eligible), 0, 'B0: no member is eligible until the community attests');
select is((select skip_reason from r_pre where member_id = '49400000-0000-4000-8000-000000000001'), 'community_notice_missing', 'B0: an otherwise eligible member is skipped community_notice_missing');
select is((select skip_reason from r_pre where member_id = '49400000-0000-4000-8000-000000000005'), 'opted_out', 'B0: a member''s own opt-out is reported before the notice gap');
select ok(not exists (select 1 from r_pre where skip_reason = 'consent_missing') and not exists (select 1 from r_ann where skip_reason = 'consent_missing'), 'B0: consent_missing never appears');

-- ── B. Resolution from member records ────────────────────────────────────────
select is((select count(*)::int from r_ann), 9, 'B: one row per current audience member (archived excluded)');
select results_eq(
  $$ select eligible, address, assurance, skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000001' $$,
  $$ values (true, 'chidi@announce.test'::text, 'unverified_supplied'::text, null::text) $$,
  'B: a member with NO account is eligible at the member-record address');
select results_eq(
  $$ select eligible, address, skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000002' $$,
  $$ values (true, 'noconsent@announce.test'::text, null::text) $$,
  'B: a member with no consent value is eligible — consent is not a requirement for community email');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-00000000000c'), 'opted_out', 'B: an opt-out in member_communication_choices is honoured');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000003'), 'no_recipient', 'B: no email → no_recipient');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000004'), 'invalid_recipient_address', 'B: malformed email → invalid_recipient_address');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000005'), 'opted_out', 'B: email_enabled=false → opted_out');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000006'), 'opted_out', 'B: announcements_enabled=false → opted_out for announcements');
select is((select eligible from r_rem where member_id = '49400000-0000-4000-8000-000000000006'), true, 'B: … but still eligible for reminders (per-category)');
select results_eq(
  $$ select eligible, address, assurance from r_ann where member_id = '49400000-0000-4000-8000-000000000007' $$,
  $$ values (true, 'holder@announce.test'::text, 'verified_account'::text) $$,
  'B: an account holder is emailed at the confirmed account address, not the typed member email');
select is((select skip_reason from r_ann where member_id = '49400000-0000-4000-8000-000000000008'), 'unverified_account_email', 'B: an unconfirmed account email is skipped');
select ok(not exists (select 1 from r_ann where skip_reason is not null and address is not null), 'B: no skipped row carries an address');
select is((select count(*)::int from public.members where consent_messages_at is null and community_id = '49100000-0000-4000-8000-00000000000a'), 2, 'B: consent is never written by evaluation (the two fixtures without it still have none)');

-- ── C. Tenancy ───────────────────────────────────────────────────────────────
select ok(not exists (select 1 from r_ann where member_id = '49400000-0000-4000-8000-00000000000b'), 'C: another community''s member never appears');
select ok(not exists (select 1 from r_ann where member_id = '49400000-0000-4000-8000-000000000009'), 'C: an archived member never appears');

-- ── D. Reachability ──────────────────────────────────────────────────────────
select is(
  (select count(*)::int from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a02'::uuid, 'announcement') where skip_reason = 'collection_not_reachable'),
  9, 'D: a members-only collection reaches nobody by email (its page needs an account)');
select is(
  (select count(*)::int from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a04'::uuid, 'announcement') where eligible),
  0, 'D: a draft is not reachable at send time');
select is(
  (select count(*)::int from app.evaluate_collection_email_recipients('49300000-0000-4000-8000-000000000a03'::uuid, 'announcement')),
  9, 'D: an open (public-audience) collection reaches every current member of the community');

-- ── E. Preview ───────────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"49000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table p_draft as
  select * from app.preview_collection_announcement_recipients('49300000-0000-4000-8000-000000000a04'::uuid, 'announcement');
reset role;
select results_eq(
  $$ select audience_total, email_eligible, collection_reachable, skipped_notice_missing, skipped_opted_out, starts_later, community_notice_attested from p_draft $$,
  $$ values (9, 3, true, 0, 3, false, true) $$,
  'E: a draft previews as "once live": 3 of 9 emailable, 3 opted out, attested, nobody skipped for notice');

set local request.jwt.claims = '{"sub":"49000000-0000-4000-8000-000000000004","role":"authenticated"}';
set local role authenticated;
select throws_ok(
  $$ select * from app.preview_collection_announcement_recipients('49300000-0000-4000-8000-000000000a01'::uuid, 'announcement') $$,
  '42501', null, 'E: an outsider cannot preview');
reset role;

-- ── F. announce_collection_update ────────────────────────────────────────────
set local request.jwt.claims = '{"sub":"49000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;
create temporary table f_first as
  select * from app.announce_collection_update('49300000-0000-4000-8000-000000000a01'::uuid, array['description', 'deadline', 'deadline'], 'announce-key-aaaa-1111');
create temporary table f_replay as
  select * from app.announce_collection_update('49300000-0000-4000-8000-000000000a01'::uuid, array['description', 'deadline'], 'announce-key-aaaa-1111');
select throws_ok(
  $$ select * from app.announce_collection_update('49300000-0000-4000-8000-000000000a01'::uuid, array['the price went up'], 'announce-key-bbbb-2222') $$,
  '22023', null, 'F: a change outside the allow-list is refused');
select throws_ok(
  $$ select * from app.announce_collection_update('49300000-0000-4000-8000-000000000a04'::uuid, array['deadline'], 'announce-key-cccc-3333') $$,
  'P0001', null, 'F: a draft cannot announce changes');
reset role;

select results_eq(
  $$ select a.action, a.after_state -> 'changed_fields' from public.audit_logs a where a.id = (select audit_log_id from f_first) $$,
  $$ values ('collection.announce_update'::text, '["deadline", "description"]'::jsonb) $$,
  'F: audited as collection.announce_update with the de-duplicated, sorted change list');
select is(
  (select count(*)::int from pgmq.q_notification_events where message ->> 'audit_log_id' = (select audit_log_id::text from f_first)),
  1, 'F: exactly one message enqueued');
select results_eq(
  $$ select r.created, r.audit_log_id = (select audit_log_id from f_first) from f_replay r $$,
  $$ values (false, true) $$,
  'F: a replay under the same key reuses the first event and writes nothing new');

select * from finish();
rollback;
