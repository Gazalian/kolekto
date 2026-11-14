-- ─────────────────────────────────────────────────────────────────────────────
-- 48 — app.count_collection_publish_recipients returns rows (regression)
--
-- The function shipped in 20261028100000 (PR #27) had a bare `SELECT` at
-- the end of its plpgsql body and threw `42601` whenever an authorised
-- caller invoked it. The publish dialog's preview silently fell back to
-- "Unknown number of" (nothing in the publish e2e asserted the actual
-- number), so the regression went unseen until the post-publish
-- reminder's e2e started asserting on the resolved count.
-- 20261029100100 rewrites the body with `return query`.
--
-- What this proves:
--   A. The function exists with the fixed body.
--   B. It returns one row of two integers for an authorised caller.
--   C. eligible = audience ∩ members-with-user_id.
--   D. unpaid = audience ∩ obligations in (unpaid, in_installments, overdue).
--   E. exempt / paid / cancelled obligations are excluded from unpaid.
--   F. Unknown collection → NOT_FOUND.
--   G. An authenticated caller without collection.publish → 42501.
--   H. anon has no EXECUTE.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(10);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('48000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'host@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owing@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'paid@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@m13.3.counts.test');
insert into public.users (id, full_name, email) values
  ('48000000-0000-4000-8000-000000000001', 'Counts Host',     'host@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000002', 'Counts Owing',    'owing@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000003', 'Counts Paid',     'paid@m13.3.counts.test'),
  ('48000000-0000-4000-8000-000000000004', 'Counts Outsider', 'outsider@m13.3.counts.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('48100000-0000-4000-8000-00000000000a', 'm13-3-counts', 'M13.3 Counts', 'social_group', false, '48000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('48200000-0000-4000-8000-000000000001', '48100000-0000-4000-8000-00000000000a', '48000000-0000-4000-8000-000000000001', 'owner', 'Counts Host', 'created');

-- Three members: two linked to accounts (owing and paid), one not linked
-- at all. Only the linked ones should count as `eligible` — the function
-- filters by `m.user_id is not null`.
insert into public.members (id, community_id, full_name, phone_e164, status, user_id, claimed_at) values
  ('48300000-0000-4000-8000-000000000001', '48100000-0000-4000-8000-00000000000a', 'Owing Member',    '+2348097771001', 'active', '48000000-0000-4000-8000-000000000002', now()),
  ('48300000-0000-4000-8000-000000000002', '48100000-0000-4000-8000-00000000000a', 'Paid Member',     '+2348097771002', 'active', '48000000-0000-4000-8000-000000000003', now()),
  ('48300000-0000-4000-8000-000000000003', '48100000-0000-4000-8000-00000000000a', 'Unlinked Member', '+2348097771003', 'active', null,                                   null);

insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by, audience_mode) values
  ('48400000-0000-4000-8000-000000000a01', '48100000-0000-4000-8000-00000000000a', 'rem-counts', 'Reminder Counts', 'dues', 'managed', 'fixed', 500000, 'active', '48000000-0000-4000-8000-000000000001', 'all_members');

-- Obligations: owing stays unpaid; paid becomes exempt (stands in for
-- 'paid' which only Paystack-verified cash can produce). Both must be
-- excluded from the `unpaid` count, so eligible = 2, unpaid = 1.
insert into public.obligations (collection_id, community_id, member_id, expected_amount_kobo, status) values
  ('48400000-0000-4000-8000-000000000a01', '48100000-0000-4000-8000-00000000000a', '48300000-0000-4000-8000-000000000001', 500000, 'unpaid');

insert into public.obligations (collection_id, community_id, member_id, expected_amount_kobo, status, exempt, exempt_reason, exempt_at, exempt_by) values
  ('48400000-0000-4000-8000-000000000a01', '48100000-0000-4000-8000-00000000000a', '48300000-0000-4000-8000-000000000002', 500000, 'exempt', true, 'pgTAP: exempt stands in for paid', now(), '48000000-0000-4000-8000-000000000001');


-- ── A. Schema + grants ───────────────────────────────────────────────────────
select has_function('app', 'count_collection_publish_recipients',
  array['uuid'],
  'A: app.count_collection_publish_recipients(uuid) exists');

select function_privs_are(
  'app', 'count_collection_publish_recipients',
  array['uuid'],
  'authenticated', array['EXECUTE'],
  'A: authenticated holds EXECUTE on the function');

select function_privs_are(
  'app', 'count_collection_publish_recipients',
  array['uuid'],
  'anon', array[]::text[],
  'A: anon holds no EXECUTE on the function');


-- ── B–E. Returns the right row for the owner ────────────────────────────────
set local request.jwt.claims = '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

create temporary table tmp_counts as
  select * from app.count_collection_publish_recipients('48400000-0000-4000-8000-000000000a01'::uuid);

reset role;

select is((select count(*)::int from tmp_counts), 1,
  'B: returns exactly one row (RETURN QUERY in place of a bare SELECT)');

select is((select eligible from tmp_counts), 2,
  'C: eligible = 2 (two members with user_id; the unlinked one is excluded)');

select is((select unpaid from tmp_counts), 1,
  'D: unpaid = 1 (only the unpaid obligation, exempt is excluded)');

-- Confirm `cancelled` is also excluded. Manual `paid` is blocked by
-- app.block_manual_paid_status (Paystack-verified cash only), so this
-- stops at exempt + cancelled; the `paid` status reaches the same code
-- path and is excluded by the same `status in (…)` filter.
update public.obligations set status = 'cancelled', cancelled_at = now(),
  exempt = false, exempt_reason = null, exempt_at = null, exempt_by = null
where collection_id = '48400000-0000-4000-8000-000000000a01' and member_id = '48300000-0000-4000-8000-000000000002';

set local request.jwt.claims = '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select is(
  (select unpaid from app.count_collection_publish_recipients('48400000-0000-4000-8000-000000000a01'::uuid)),
  1,
  'E: a cancelled obligation is also excluded from the unpaid count');

reset role;


-- ── F. Unknown collection → NOT_FOUND ────────────────────────────────────────
set local request.jwt.claims = '{"sub":"48000000-0000-4000-8000-000000000001","role":"authenticated"}';
set local role authenticated;

select throws_matching(
  $$ select * from app.count_collection_publish_recipients('00000000-0000-0000-0000-000000000000'::uuid) $$,
  'NOT_FOUND',
  'F: unknown collection raises NOT_FOUND');

reset role;


-- ── G. Permission (42501) for an authenticated outsider ─────────────────────
set local request.jwt.claims = '{"sub":"48000000-0000-4000-8000-000000000004","role":"authenticated"}';
set local role authenticated;

select throws_ok(
  $$ select * from app.count_collection_publish_recipients('48400000-0000-4000-8000-000000000a01'::uuid) $$,
  '42501',
  null,
  'G: authenticated outsider without collection.publish is refused');

reset role;


-- ── H. anon has no EXECUTE (already asserted above; add the direct call too)
set local request.jwt.claims = '{"role":"anon"}';
set local role anon;

select throws_ok(
  $$ select * from app.count_collection_publish_recipients('48400000-0000-4000-8000-000000000a01'::uuid) $$,
  '42501',
  null,
  'H: anon cannot execute the function');

reset role;


select finish();
rollback;
