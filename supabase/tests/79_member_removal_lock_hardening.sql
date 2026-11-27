-- ─────────────────────────────────────────────────────────────────────────────
-- 79 — Phase 3: membership removal serialises with checkout (Policy B)
--
-- Coverage for 20261126100000_member_removal_lock_hardening.sql:
--
--   · archive_member revokes the member's open membership-pass grants; the
--     old pass stops resolving; a new checkout is refused; history is kept;
--     an attempt created before the archive is untouched and still captures,
--     attributed to the member (Policy B)
--   · restore_member brings the member back as before, but a grant revoked by
--     the archive stays revoked; a fresh validation issues a new working pass
--   · remove_member_from_group and set_member_groups take the member-row lock
--     (FOR NO KEY UPDATE, which conflicts with checkout's FOR SHARE) before
--     changing group membership, and do not lock a member of another community
--   · signatures, SECURITY DEFINER, search_path and EXECUTE grants unchanged
--
-- Lock check: pgTAP is one session, so a lock cannot be made to block here.
-- Instead each fixture member is key-share locked by the top transaction, and
-- each officer call runs in pgTAP's own subtransaction; the row's xmax is then
-- a MultiXact whose members (pg_get_multixact_members, built in) name every
-- lock mode taken on it. 'fornokeyupd' appears only if the function locked
-- the row. The genuine two-session race is a separate script (not pgTAP).
--
-- Runs as the database owner (session role `none`), as the server's owner
-- connection does. Officer actions switch to the owner's authenticated
-- session and back. Everything is rolled back.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(47);

-- ── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, instance_id, aud, role, email) values
  ('a7910000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@m79.example.test');
insert into public.users (id, full_name, email) values
  ('a7910000-0000-4000-8000-000000000001', 'M79 Owner', 'owner@m79.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7920000-0000-4000-8000-00000000000a', 'm79-club',  'M79 Club',  'social_group', false, 'a7910000-0000-4000-8000-000000000001'),
  ('a7920000-0000-4000-8000-00000000000b', 'm79-other', 'M79 Other', 'social_group', false, 'a7910000-0000-4000-8000-000000000001');
insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7920000-0000-4000-8000-00000000000a', 'a7910000-0000-4000-8000-000000000001', 'owner', 'M79 Owner', 'created');
insert into public.community_membership_id_settings (community_id, prefix, separator, suffix_length, enabled) values
  ('a7920000-0000-4000-8000-00000000000a', 'MTE', '/', 5, true);

insert into public.members (id, community_id, full_name, phone_e164, status, joined_via) values
  ('a7940000-0000-4000-8000-000000000001', 'a7920000-0000-4000-8000-00000000000a', 'Ada Archive',  '+2348097790001', 'active', 'manual'),
  ('a7940000-0000-4000-8000-000000000002', 'a7920000-0000-4000-8000-00000000000a', 'Bola Restore', '+2348097790002', 'active', 'manual'),
  ('a7940000-0000-4000-8000-000000000003', 'a7920000-0000-4000-8000-00000000000a', 'Gina Group',   '+2348097790003', 'active', 'manual'),
  ('a7940000-0000-4000-8000-000000000004', 'a7920000-0000-4000-8000-00000000000a', 'Hana Groups',  '+2348097790004', 'active', 'manual'),
  ('a7940000-0000-4000-8000-000000000005', 'a7920000-0000-4000-8000-00000000000a', 'Kemi Keeps',   '+2348097790005', 'active', 'manual'),
  ('a7940000-0000-4000-8000-000000000009', 'a7920000-0000-4000-8000-00000000000b', 'Xavi Elsewhere', '+2348097790009', 'active', 'manual');

insert into public.membership_ids (community_id, member_id, membership_id, canonical_id, prefix, separator, last2)
select 'a7920000-0000-4000-8000-00000000000a'::uuid, m, id, app.canonical_membership_id(id), 'MTE', '/', right(id, 2)
from (values
  ('a7940000-0000-4000-8000-000000000001'::uuid, 'MTE/AAAA1'),
  ('a7940000-0000-4000-8000-000000000002', 'MTE/BBBB2'),
  ('a7940000-0000-4000-8000-000000000003', 'MTE/GGGG3'),
  ('a7940000-0000-4000-8000-000000000004', 'MTE/HHHH4'),
  ('a7940000-0000-4000-8000-000000000005', 'MTE/KKKK5')
) as t (m, id);

insert into public.member_groups (id, community_id, name, created_by) values
  ('a7950000-0000-4000-8000-000000000001', 'a7920000-0000-4000-8000-00000000000a', 'Committee', 'a7910000-0000-4000-8000-000000000001');
insert into public.member_group_memberships (group_id, member_id, added_by) values
  ('a7950000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000003', 'a7910000-0000-4000-8000-000000000001'),
  ('a7950000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000004', 'a7910000-0000-4000-8000-000000000001'),
  ('a7950000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000005', 'a7910000-0000-4000-8000-000000000001');

-- Managed ₦5,000 dues (all members, no obligations) and a managed committee
-- collection whose audience is the Committee group.
insert into public.collections
  (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo,
   min_amount_kobo, max_amount_kobo, target_amount_kobo, deadline_at, status, visibility, fee_mode,
   collect_attendee_details, close_when_target_reached, created_by)
values
  ('a7960000-0000-4000-8000-000000000001', 'a7920000-0000-4000-8000-00000000000a', 'm79-dues', 'M79 Dues',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'a7910000-0000-4000-8000-000000000001'),
  ('a7960000-0000-4000-8000-000000000003', 'a7920000-0000-4000-8000-00000000000a', 'm79-committee', 'M79 Committee',
   'dues', 'managed', 'fixed', 500000, null, null, null, null, 'active', 'unlisted', 'community_absorbs',
   false, false, 'a7910000-0000-4000-8000-000000000001');
update public.collections set audience_mode = 'groups' where id = 'a7960000-0000-4000-8000-000000000003';
insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by) values
  ('a7960000-0000-4000-8000-000000000003', 'a7950000-0000-4000-8000-000000000001', 'a7920000-0000-4000-8000-00000000000a', 'a7910000-0000-4000-8000-000000000001');

-- Every fixture member key-share locked by the top transaction, so a later
-- lock by a function (in a subtransaction) makes xmax a MultiXact.
select count(*) from (
  select 1 from public.members where id in (
    'a7940000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000002',
    'a7940000-0000-4000-8000-000000000003', 'a7940000-0000-4000-8000-000000000004',
    'a7940000-0000-4000-8000-000000000005', 'a7940000-0000-4000-8000-000000000009')
  for key share
) locked;

-- ── Helpers ─────────────────────────────────────────────────────────────────

create temporary table tmp_tok (label text primary key, token text);

-- A grant as app.validate_membership_id writes it.
create function pg_temp.issue_pass(p_label text, p_collection uuid, p_member uuid)
returns text language plpgsql as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.membership_access_grants (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
  select extensions.digest(v_token, 'sha256'), mi.id, mi.member_id, p_collection, mi.community_id,
         now(), now() + interval '30 minutes'
  from public.membership_ids mi where mi.member_id = p_member and mi.revoked_at is null;
  insert into tmp_tok values (p_label, v_token);
  return v_token;
end;
$$;

create function pg_temp.tok(p_label text) returns text language sql as $$
  select token from tmp_tok where label = p_label
$$;

create function pg_temp.ref(p_ref integer) returns text language sql as $$
  select 'KLK-' || lpad(p_ref::text, 26, '0')
$$;

-- ₦5,000 managed dues, host absorbs: 0.5% + 1.5% = ₦100; estimate 1% = ₦50.
create function pg_temp.dues(p_collection uuid, p_key text, p_ref integer, p_member uuid, p_token text)
returns uuid language sql as $$
  select attempt_id from app.create_payment_attempt(
    p_collection, 'checkout-key-m79-' || p_key, pg_temp.ref(p_ref), 'fake', p_member,
    'Test Payer', 'payer@m79.example.test', '+2348000000079', '{}'::jsonb, '{}'::text[],
    null, null, 500000, 2500, 7500, 0, 10000, 500000, 490000, 5000,
    'community_absorbs', '2026-11-founder', p_token)
$$;

-- Every row-lock mode on a member row, from its MultiXact (sorted, comma-joined).
create function pg_temp.lock_modes(p_member uuid) returns text language plpgsql as $$
declare
  v_xmax  xid;
  v_modes text;
begin
  select m.xmax into v_xmax from public.members m where m.id = p_member;
  begin
    select string_agg(mode, ',' order by mode) into v_modes from pg_get_multixact_members(v_xmax);
  exception when others then
    v_modes := 'not-a-multixact';
  end;
  return coalesce(v_modes, '');
end;
$$;

create function pg_temp.as_owner() returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"a7910000-0000-4000-8000-000000000001","role":"authenticated"}', true);
$$;

do $$ begin perform pg_temp.issue_pass('ada',  'a7960000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('ada-2','a7960000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000001'); end $$;
do $$ begin perform pg_temp.issue_pass('bola', 'a7960000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000002'); end $$;
do $$ begin perform pg_temp.issue_pass('gina', 'a7960000-0000-4000-8000-000000000003', 'a7940000-0000-4000-8000-000000000003'); end $$;
do $$ begin perform pg_temp.issue_pass('hana', 'a7960000-0000-4000-8000-000000000003', 'a7940000-0000-4000-8000-000000000004'); end $$;


-- ── The functions themselves ────────────────────────────────────────────────

select ok(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""']
                   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE'))
   from pg_proc p
   where p.oid in ('app.archive_member(uuid, text)'::regprocedure, 'app.restore_member(uuid, text)'::regprocedure,
                   'app.remove_member_from_group(uuid, uuid)'::regprocedure, 'app.set_member_groups(uuid, uuid[])'::regprocedure)),
  'the four functions keep their signatures, SECURITY DEFINER, empty search_path, and authenticated-only EXECUTE'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('archive_member', 'restore_member', 'remove_member_from_group', 'set_member_groups')),
  4, 'one overload each: no new signature was added'
);

select is(
  pg_get_function_result('app.restore_member(uuid, text)'::regprocedure) || '/' ||
  pg_get_function_result('app.set_member_groups(uuid, uuid[])'::regprocedure),
  'member_status/integer', 'return types unchanged'
);


-- ── Archive ─────────────────────────────────────────────────────────────────

select is(app.resolve_membership_access_grant('a7960000-0000-4000-8000-000000000001', pg_temp.tok('ada')),
  'a7940000-0000-4000-8000-000000000001'::uuid, 'before the archive, Ada''s pass resolves');

-- Policy B: an attempt Ada created before she is archived.
create temporary table tmp_ada_attempt as
  select pg_temp.dues('a7960000-0000-4000-8000-000000000001', 'ada-before', 7901,
                      'a7940000-0000-4000-8000-000000000001', pg_temp.tok('ada')) as id;
create temporary table tmp_ada_attempt_before as
  select to_jsonb(a) as row from public.payment_attempts a where a.id = (select id from tmp_ada_attempt);

select is((select status::text from public.payment_attempts where id = (select id from tmp_ada_attempt)),
  'created', 'Ada''s attempt exists before the archive');

create temporary table tmp_ada_member_before as
  select full_name, phone_e164, community_id, joined_via from public.members where id = 'a7940000-0000-4000-8000-000000000001';

set local role authenticated;
select pg_temp.as_owner();
select lives_ok($$ select app.archive_member('a7940000-0000-4000-8000-000000000001', 'left') $$, 'the owner archives Ada');
reset role;

select is(
  (select count(*)::int from public.membership_access_grants
   where member_id = 'a7940000-0000-4000-8000-000000000001' and revoked_at is null),
  0, 'archiving revokes every open membership-pass grant the member held'
);

select is(app.resolve_membership_access_grant('a7960000-0000-4000-8000-000000000001', pg_temp.tok('ada-2')),
  null::uuid, 'Ada''s pre-archive pass no longer resolves');

select throws_ok(
  $$ select pg_temp.dues('a7960000-0000-4000-8000-000000000001', 'ada-after', 7902,
                         'a7940000-0000-4000-8000-000000000001', pg_temp.tok('ada-2')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'an archived member cannot start a new checkout'
);

select is(
  (select row(m.status::text, m.archived_at is not null) from public.members m where m.id = 'a7940000-0000-4000-8000-000000000001'),
  row('archived'::text, true), 'Ada is archived (not deleted), with archived_at set'
);

select is(
  (select row(full_name, phone_e164, community_id, joined_via::text) from public.members where id = 'a7940000-0000-4000-8000-000000000001'),
  (select row(full_name, phone_e164, community_id, joined_via::text) from tmp_ada_member_before),
  'her record is kept as it was'
);

select is(
  (select count(*)::int from public.membership_ids where member_id = 'a7940000-0000-4000-8000-000000000001' and revoked_at is null),
  1, 'her membership ID is not revoked by archive (restore must be able to use it again)'
);

select is(
  (select count(*)::int from public.membership_access_grants where member_id = 'a7940000-0000-4000-8000-000000000001'),
  2, 'grant rows are revoked, not deleted'
);

select is(
  (select count(*)::int from public.audit_logs
   where action = 'member.archive' and object_id = 'a7940000-0000-4000-8000-000000000001'
     and before_state ->> 'status' = 'active' and after_state ->> 'status' = 'archived'),
  1, 'one member.archive audit row, before = active, after = archived (unchanged)'
);

select is(
  (select to_jsonb(a) from public.payment_attempts a where a.id = (select id from tmp_ada_attempt)),
  (select row from tmp_ada_attempt_before),
  'Ada''s existing attempt is not modified by the archive'
);

-- Policy B: the payment already in progress completes and is attributed.
select is(
  (select status::text from app.record_provider_transaction(
     pg_temp.ref(7901), 'fake', 'FAKE_TXN_7901', pg_temp.ref(7901), 'succeeded', 'success',
     500000, 'NGN', 7500, now(), 'card', null, '{"__fake": true}'::jsonb)),
  'captured', 'the provider''s success for that attempt is still recorded after the archive'
);

create temporary table tmp_ada_capture as
  select * from app.complete_payment_capture((select id from tmp_ada_attempt));

select is((select status::text from tmp_ada_capture), 'completed', 'capture completes (not gated on membership)');

select is(
  (select c.member_id from public.contributions c where c.id = (select contribution_id from tmp_ada_capture)),
  'a7940000-0000-4000-8000-000000000001'::uuid, 'and the contribution is attributed to Ada'
);

select is(
  (select count(*)::int from public.ledger_journals where idempotency_key = 'capture:' || (select id from tmp_ada_attempt)),
  1, 'the capture journal is posted'
);


-- ── Restore ─────────────────────────────────────────────────────────────────

set local role authenticated;
select pg_temp.as_owner();
select lives_ok($$ select app.archive_member('a7940000-0000-4000-8000-000000000002', 'left') $$, 'the owner archives Bola');
select is(app.restore_member('a7940000-0000-4000-8000-000000000002', 'came back'), 'active'::public.member_status,
  'the owner restores Bola, who returns as active (has a phone), as before');
select throws_ok(
  $$ select app.restore_member('a7940000-0000-4000-8000-000000000002', 'again') $$,
  'P0001', 'NOT_ARCHIVED: this member is active, so there is nothing to restore',
  'restoring a member who is not archived is still refused'
);
reset role;

select ok(
  (select revoked_at is not null from public.membership_access_grants
   where token_hash = extensions.digest(pg_temp.tok('bola'), 'sha256')),
  'the grant revoked by the archive stays revoked after the restore'
);

select is(app.resolve_membership_access_grant('a7960000-0000-4000-8000-000000000001', pg_temp.tok('bola')),
  null::uuid, 'Bola''s pre-archive pass does not come back to life');

select throws_ok(
  $$ select pg_temp.dues('a7960000-0000-4000-8000-000000000001', 'bola-old', 7910,
                         'a7940000-0000-4000-8000-000000000002', pg_temp.tok('bola')) $$,
  'P0001', 'MEMBER_PROOF_EXPIRED: no live membership pass for this collection',
  'checkout refuses the old pass: Bola is eligible again but must prove it again'
);

create temporary table tmp_bola_new as
  select * from app.validate_membership_id('a7960000-0000-4000-8000-000000000001', 'MTE/BBBB2',
                                           extensions.digest('m79-bola-' || gen_random_uuid()::text, 'sha256'));

select is((select valid from tmp_bola_new), true, 'a fresh validation of Bola''s membership ID succeeds');

select is(app.resolve_membership_access_grant('a7960000-0000-4000-8000-000000000001', (select access_token from tmp_bola_new)),
  'a7940000-0000-4000-8000-000000000002'::uuid, 'and its new pass resolves to Bola');

-- Created in its own statement: a row inserted by a function called from a
-- WHERE clause is not visible to that same statement's snapshot.
create temporary table tmp_bola_attempt as
  select pg_temp.dues('a7960000-0000-4000-8000-000000000001', 'bola-new', 7911,
                      'a7940000-0000-4000-8000-000000000002', (select access_token from tmp_bola_new)) as id;

select is(
  (select member_id from public.payment_attempts where id = (select id from tmp_bola_attempt)),
  'a7940000-0000-4000-8000-000000000002'::uuid, 'the new pass starts a checkout attributed to Bola'
);


-- ── Group removal ───────────────────────────────────────────────────────────

select is(app.resolve_membership_access_grant('a7960000-0000-4000-8000-000000000003', pg_temp.tok('gina')),
  'a7940000-0000-4000-8000-000000000003'::uuid, 'Gina holds a live committee pass');

select ok(pg_temp.lock_modes('a7940000-0000-4000-8000-000000000003') not like '%fornokeyupd%',
  'before the removal, nothing holds a no-key-update lock on Gina');

set local role authenticated;
select pg_temp.as_owner();
select lives_ok(
  $$ select app.remove_member_from_group('a7950000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000003') $$,
  'the owner removes Gina from the committee');
select lives_ok(
  $$ select app.remove_member_from_group('a7950000-0000-4000-8000-000000000001', 'a7940000-0000-4000-8000-000000000009') $$,
  'removing a member of another community is still a silent no-op');
reset role;

select ok(pg_temp.lock_modes('a7940000-0000-4000-8000-000000000003') like '%fornokeyupd%',
  'remove_member_from_group took the member-row lock (FOR NO KEY UPDATE: conflicts with checkout''s FOR SHARE)');

select ok(pg_temp.lock_modes('a7940000-0000-4000-8000-000000000009') not like '%fornokeyupd%',
  'it did not lock the other community''s member (SEC-18)');

select is(
  (select count(*)::int from public.member_group_memberships
   where group_id = 'a7950000-0000-4000-8000-000000000001' and member_id = 'a7940000-0000-4000-8000-000000000003'),
  0, 'Gina''s group membership is gone, as before');

select throws_ok(
  $$ select pg_temp.dues('a7960000-0000-4000-8000-000000000003', 'gina', 7920,
                         'a7940000-0000-4000-8000-000000000003', pg_temp.tok('gina')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'removed from the audience group, Gina cannot start a committee checkout'
);

select is(
  (select count(*)::int from public.audit_logs
   where action = 'group.remove_member' and object_id = 'a7950000-0000-4000-8000-000000000001'
     and before_state ->> 'member_id' = 'a7940000-0000-4000-8000-000000000003'),
  1, 'one group.remove_member audit row, as before'
);


-- ── Group assignment (set_member_groups) ────────────────────────────────────

select ok(pg_temp.lock_modes('a7940000-0000-4000-8000-000000000004') not like '%fornokeyupd%',
  'before set_member_groups, nothing holds a no-key-update lock on Hana');

set local role authenticated;
select pg_temp.as_owner();
-- In a subtransaction, so the lock it takes is recorded beside the top
-- transaction's key-share lock (a same-xid upgrade would leave no MultiXact).
savepoint set_groups;
select is(app.set_member_groups('a7940000-0000-4000-8000-000000000004', '{}'::uuid[]), 0,
  'the owner clears Hana''s groups (returns her group count, 0)');
release savepoint set_groups;
select is(app.set_member_groups('a7940000-0000-4000-8000-000000000005', array['a7950000-0000-4000-8000-000000000001'::uuid]), 1,
  'keeping Kemi in the committee leaves her one group, as before');
select throws_ok(
  $$ select app.set_member_groups('a7940000-0000-4000-8000-0000000000ff', '{}'::uuid[]) $$,
  'P0002', 'NOT_FOUND: member a7940000-0000-4000-8000-0000000000ff does not exist',
  'an unknown member is still NOT_FOUND'
);
reset role;

select ok(pg_temp.lock_modes('a7940000-0000-4000-8000-000000000004') like '%fornokeyupd%',
  'set_member_groups took the member-row lock before changing groups');

select is(
  (select count(*)::int from public.member_group_memberships where member_id = 'a7940000-0000-4000-8000-000000000004'),
  0, 'Hana is in no group');

select throws_ok(
  $$ select pg_temp.dues('a7960000-0000-4000-8000-000000000003', 'hana', 7930,
                         'a7940000-0000-4000-8000-000000000004', pg_temp.tok('hana')) $$,
  'P0001', 'MEMBER_NOT_ELIGIBLE: member cannot contribute to this collection',
  'out of the audience group, Hana cannot start a committee checkout'
);

select is(
  (select count(*)::int from public.member_group_memberships
   where member_id = 'a7940000-0000-4000-8000-000000000005' and group_id = 'a7950000-0000-4000-8000-000000000001'),
  1, 'Kemi is still in the committee');


-- ── Checkout's own lock is unchanged ────────────────────────────────────────

select ok(
  (select prosrc ~ 'from public\.members where id = p_member_id for share'
   from pg_proc where oid = 'app.create_payment_attempt(uuid, text, text, text, uuid, text, text, text, jsonb, text[], jsonb, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, public.fee_mode, text, text)'::regprocedure),
  'checkout still share-locks the member row (M10), the lock these functions now conflict with'
);

select ok(
  (select prosrc !~* 'public\.members|member_in_good_standing|resolve_collection_audience|get_collection_member_context'
   from pg_proc where oid = 'app.complete_payment_capture(uuid)'::regprocedure)
  and (select prosrc !~* 'public\.members|member_in_good_standing|resolve_collection_audience|get_collection_member_context' from pg_proc
       where oid = 'app.record_provider_transaction(text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb)'::regprocedure),
  'capture and provider recording still read no member status (Policy B: not gated on membership)'
);

select * from finish();
rollback;
