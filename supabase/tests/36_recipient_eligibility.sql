-- ─────────────────────────────────────────────────────────────────────────────
-- 36 — Centralized email recipient eligibility (M13.2 P4)
--
-- Migration 20261012100000. What is proved here:
--
--   A. app.email_address_usable accepts one plain mailbox and refuses blanks,
--      whitespace/control characters, oversized values and non-addresses.
--   B. A non-account member is eligible for member.create / member.approve_join
--      with assurance unverified_supplied; missing and malformed addresses skip
--      with no_recipient / invalid_recipient_address and no stored address.
--   C. A linked member whose Auth email is confirmed is eligible with assurance
--      verified_account, using the Auth address — even when public.users.email
--      is a stale copy of something else.
--   D. An unconfirmed, missing or deleted Auth email skips with
--      unverified_account_email and no address — even when public.users.email
--      and members.email both hold usable addresses (Q-FALLBACK).
--   E. A null or mismatched asserted user id skips with
--      ambiguous_recipient_relationship and no address; a missing member or
--      term skips with missing_membership_relationship.
--   F. Officer notices resolve through officer_terms.user_id, never a supplied
--      address; rejections, redemptions, collection lifecycle and unknown
--      actions return unsupported_event (they file no email row at all).
--   G. Neither function is executable by anon or authenticated (42501).
--   H. The delivery-table guards accept the rows P4 files: skipped rows with a
--      stable code and no address, eligible rows with address, assurance and a
--      shared membership dedupe key that collapses creation and approval.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(35);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('a8000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@p4.example.test', now()),
  ('a8000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated', 'admin@p4.example.test', null),
  ('a8000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated', 'current@p4.example.test', now());
insert into public.users (id, full_name, email) values
  ('a8000000-0000-4000-8000-000000000001', 'P4 Owner', 'owner@p4.example.test'),
  ('a8000000-0000-4000-8000-000000000002', 'P4 Admin', 'admin@p4.example.test'),
  -- Stale copy on purpose: the Auth address above is current@p4, the copy says stale.
  ('a8000000-0000-4000-8000-000000000003', 'P4 Moved', 'stale-copy@p4.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a8200000-0000-4000-8000-00000000000a', 'p4-tests', 'P4 Tests', 'social_group', false, 'a8000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a8300000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'owner', 'P4 Owner', 'created'),
  ('a8300000-0000-4000-8000-000000000002', 'a8200000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000002', 'admin', 'P4 Admin', 'invited');
-- Non-account member, linked member (confirmed), linked member (unconfirmed),
-- linked member with a stale public.users copy.
insert into public.members (id, community_id, full_name, email, phone_e164, user_id, claimed_at) values
  ('a8400000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'Supplied Sam', 'sam@p4.example.test', '+2348095552001', null, null),
  ('a8400000-0000-4000-8000-000000000002', 'a8200000-0000-4000-8000-00000000000a', 'Linked Lou', 'lou@p4.example.test', '+2348095552002', 'a8000000-0000-4000-8000-000000000001', now()),
  ('a8400000-0000-4000-8000-000000000003', 'a8200000-0000-4000-8000-00000000000a', 'Unconfirmed Una', 'una@p4.example.test', '+2348095552003', 'a8000000-0000-4000-8000-000000000002', now()),
  ('a8400000-0000-4000-8000-000000000004', 'a8200000-0000-4000-8000-00000000000a', 'Moved Max', 'max@p4.example.test', '+2348095552004', 'a8000000-0000-4000-8000-000000000003', now()),
  ('a8400000-0000-4000-8000-000000000005', 'a8200000-0000-4000-8000-00000000000a', 'No Address Ned', null, '+2348095552005', null, null),
  ('a8400000-0000-4000-8000-000000000006', 'a8200000-0000-4000-8000-00000000000a', 'Bad Address Bea', 'not an address', '+2348095552006', null, null);

-- One verdict row per call, so assertions stay readable.
create function pg_temp.elig(p_event text, p_object uuid, p_user uuid)
returns table (eligible boolean, address text, assurance text, skip_reason text)
language sql as $$
  select eligible, address, assurance, skip_reason
  from app.evaluate_email_eligibility(p_event, p_object, p_user);
$$;

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


-- ── A. The plausibility check ────────────────────────────────────────────────
select ok(app.email_address_usable('sam@p4.example.test'), 'A: one plain mailbox is usable');
select ok(not app.email_address_usable(null), 'A: null is not usable');
select ok(not app.email_address_usable('not an address'), 'A: a non-address is not usable');
select ok(not app.email_address_usable('two@boxes@p4.example.test'), 'A: two mailboxes are not usable');
select ok(not app.email_address_usable('line' || chr(10) || 'break@p4.example.test'), 'A: a line break is not usable');
select ok(not app.email_address_usable(repeat('a', 250) || '@p4.example.test'), 'A: an oversized address is not usable');


-- ── B. Non-account confirmations ─────────────────────────────────────────────
select is(
  (select eligible from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000001', null)),
  true, 'B: a supplied address makes member.create eligible');
select is(
  (select address from pg_temp.elig('member.approve_join', 'a8400000-0000-4000-8000-000000000001', null)),
  'sam@p4.example.test', 'B: the supplied address is returned');
select is(
  (select assurance from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000001', null)),
  'unverified_supplied', 'B: a supplied address is never described as verified');
select is(
  (select skip_reason from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000005', null)),
  'no_recipient', 'B: a missing address skips as no_recipient');
select is(
  (select address from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000005', null)),
  null, 'B: the no_recipient skip carries no address');
select is(
  (select skip_reason from pg_temp.elig('member.approve_join', 'a8400000-0000-4000-8000-000000000006', null)),
  'invalid_recipient_address', 'B: a malformed address skips as invalid_recipient_address');


-- ── C. Linked member, confirmed Auth email ───────────────────────────────────
select is(
  (select address from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001')),
  'owner@p4.example.test', 'C: the current Auth address is used');
select is(
  (select assurance from pg_temp.elig('member.approve_join', 'a8400000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000001')),
  'verified_account', 'C: a confirmed Auth address is verified_account');
select is(
  (select address from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000004', 'a8000000-0000-4000-8000-000000000003')),
  'current@p4.example.test', 'C: a stale public.users copy never overrides the Auth address');


-- ── D. Unconfirmed Auth email: skip, never fall back (Q-FALLBACK) ────────────
select is(
  (select skip_reason from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000002')),
  'unverified_account_email', 'D: an unconfirmed Auth email skips');
select is(
  (select address from pg_temp.elig('member.approve_join', 'a8400000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000002')),
  null, 'D: the skip carries no address even though members.email and public.users.email are both usable');


-- ── E. Missing, mismatched and ambiguous relationships ───────────────────────
select is(
  (select skip_reason from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000002')),
  'ambiguous_recipient_relationship', 'E: a mismatched asserted user never yields an address');
select is(
  (select address from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000002')),
  null, 'E: the mismatch carries no address');
select is(
  (select skip_reason from pg_temp.elig('member.approve_join', 'a8400000-0000-4000-8000-000000000002', null)),
  'ambiguous_recipient_relationship', 'E: a linked member with no asserted user is ambiguous, not non-account');
select is(
  (select skip_reason from pg_temp.elig('member.create', 'a8400000-0000-4000-8000-000000000009', null)),
  'missing_membership_relationship', 'E: a missing member skips without guessing');


-- ── F. Officer notices and non-evaluation events ─────────────────────────────
select is(
  (select address from pg_temp.elig('officer_term.end', 'a8300000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001')),
  'owner@p4.example.test', 'F: an officer notice resolves through the term holder');
select is(
  (select skip_reason from pg_temp.elig('officer_invitation.accept', 'a8300000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000002')),
  'unverified_account_email', 'F: an unconfirmed officer skips like any account holder');
select is(
  (select skip_reason from pg_temp.elig('officer_term.end', 'a8300000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000002')),
  'ambiguous_recipient_relationship', 'F: the term must belong to the asserted holder');
select is(
  (select skip_reason from pg_temp.elig('member.reject_join', 'a8400000-0000-4000-8000-000000000001', null)),
  'unsupported_event', 'F: rejections yield no address (R-E3 stays open)');
select is(
  (select skip_reason from pg_temp.elig('member.join_via_invite', 'a8400000-0000-4000-8000-000000000001', null)),
  'unsupported_event', 'F: redemptions yield no address (R1)');
select is(
  (select skip_reason from pg_temp.elig('collection.publish', 'a8400000-0000-4000-8000-000000000001', null)),
  'unsupported_event', 'F: collection lifecycle yields no address');


-- ── G. Client roles cannot call either function ──────────────────────────────
select is(pg_temp.try_as('authenticated', 'select app.evaluate_email_eligibility(''member.create'', ''a8400000-0000-4000-8000-000000000001'', null)'), '42501', 'G: authenticated cannot evaluate eligibility');
select is(pg_temp.try_as('anon', 'select app.evaluate_email_eligibility(''member.create'', ''a8400000-0000-4000-8000-000000000001'', null)'), '42501', 'G: anon cannot evaluate eligibility');
select is(pg_temp.try_as('authenticated', 'select app.email_address_usable(''sam@p4.example.test'')'), '42501', 'G: authenticated cannot use the helper');
select is(pg_temp.try_as('anon', 'select app.email_address_usable(''sam@p4.example.test'')'), '42501', 'G: anon cannot use the helper');


-- ── H. The rows P4 files satisfy the delivery guards ─────────────────────────
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, actor_user_id, object_type, object_id, payload) values
  ('a8600000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'member.create', 'member.create:a8400000-0000-4000-8000-000000000001', 'officer', 'a8000000-0000-4000-8000-000000000001', 'member', 'a8400000-0000-4000-8000-000000000001', '{}'),
  ('a8600000-0000-4000-8000-000000000002', 'a8200000-0000-4000-8000-00000000000a', 'member.approve_join', 'member.approve_join:a8400000-0000-4000-8000-000000000001', 'officer', 'a8000000-0000-4000-8000-000000000001', 'member', 'a8400000-0000-4000-8000-000000000001', '{}');

select lives_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, channel, status, error_code)
  values ('a8600000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'a8400000-0000-4000-8000-000000000005', 'email', 'skipped', 'no_recipient')
$$, 'H: a skipped row with a stable code and no address is accepted');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_address, channel, status, error_code)
  values ('a8600000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'a8400000-0000-4000-8000-000000000005', 'ned@p4.example.test', 'email', 'skipped', 'no_recipient')
$$, '23514', null, 'H: a skipped row carrying an address is rejected');

select lives_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_address, recipient_address_assurance, channel, status, dedupe_key)
  values ('a8600000-0000-4000-8000-000000000001', 'a8200000-0000-4000-8000-00000000000a', 'a8400000-0000-4000-8000-000000000001', 'sam@p4.example.test', 'unverified_supplied', 'email', 'pending', 'membership_confirmation:a8400000-0000-4000-8000-000000000001')
$$, 'H: an eligible confirmation with address, assurance and dedupe key is accepted');

select throws_ok($$
  insert into public.notification_deliveries (notification_event_id, community_id, recipient_member_id, recipient_address, recipient_address_assurance, channel, status, dedupe_key)
  values ('a8600000-0000-4000-8000-000000000002', 'a8200000-0000-4000-8000-00000000000a', 'a8400000-0000-4000-8000-000000000001', 'sam@p4.example.test', 'unverified_supplied', 'email', 'pending', 'membership_confirmation:a8400000-0000-4000-8000-000000000001')
$$, '23505', null, 'H: creation and approval collapse onto one confirmation key');

select * from finish();
rollback;
