-- ─────────────────────────────────────────────────────────────────────────────
-- 05 — Structural guards
--
-- The rules that must hold even when application code is wrong, absent, or
-- being written by someone in a hurry at 2am during an incident. Each one
-- corresponds to a way the previous system could lose or invent money, or lose
-- a community's history.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(9);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('55555555-5555-4555-8555-555555555555', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'guard@example.test');

-- ON CONFLICT DO UPDATE: the auth.users insert above already fired
-- app.handle_new_auth_user() (20260918140000), which created a placeholder
-- public.users row for this id.
insert into public.users (id, full_name, email) values
  ('55555555-5555-4555-8555-555555555555', 'Guard Person', 'guard@example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'guard-assoc', 'Guard Association', 'fellowship', false, '55555555-5555-4555-8555-555555555555');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '55555555-5555-4555-8555-555555555555', 'owner', 'Guard Person', 'created');

insert into public.members (id, community_id, full_name, phone_e164, identifier, status) values
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'A Member', '+2348031234567', 'CSC/2026/001', 'active');

insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, fixed_amount_kobo, status, created_by) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dues-2026', '2026 Departmental Dues', 'dues', 'managed', 'fixed', 2000000, 'active', '55555555-5555-4555-8555-555555555555');

insert into public.obligations (id, community_id, collection_id, member_id, expected_amount_kobo) values
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2000000);


-- ── CASH-02 / SEC-20a: nobody marks an obligation paid ───────────────────────
-- The most important guard in the schema. Kolekto is cashless: an obligation
-- becomes paid through a Paystack-verified contribution and no other way. Not
-- by an owner, not by Kolekto staff, not by a support script.
select throws_ok(
  $$ update public.obligations set status = 'paid'
     where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' $$,
  'P0001',
  null,
  'an obligation cannot be marked paid by hand (CASH-02, SEC-20a)'
);

-- The sanctioned alternatives still work, and say what they are.
select lives_ok(
  $$ update public.obligations
     set exempt = true, exempt_reason = 'Hardship, approved at the March meeting',
         exempt_at = now(), status = 'exempt'
     where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' $$,
  'an officer can exempt a member with a reason (OBL-07)'
);

select throws_ok(
  $$ update public.obligations set exempt = true, status = 'exempt', exempt_reason = null, exempt_at = null
     where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' $$,
  '23514',
  null,
  'an exemption without a reason is rejected (OBL-07)'
);


-- ── Financial history is never deleted ───────────────────────────────────────
select throws_ok(
  $$ delete from public.obligations where id = 'ffffffff-ffff-4fff-8fff-ffffffffffff' $$,
  'P0001',
  null,
  'an obligation cannot be deleted — cancel or exempt it instead (OBL-05)'
);

select throws_ok(
  $$ delete from public.members where id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' $$,
  'P0001',
  null,
  'a member with an obligation cannot be deleted — archive instead (MEM-13)'
);

select throws_ok(
  $$ delete from public.collections where id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' $$,
  'P0001',
  null,
  'a collection with obligations cannot be deleted (COL-14)'
);


-- ── ADR 0010: the 2026-08-06 incident cannot recur ───────────────────────────
-- Two tiers sharing a display name is what made every tier selection collapse
-- onto one price. Five collections in the old production database still have
-- duplicate tier names. Here it is a constraint violation.
insert into public.collections (id, community_id, slug, name, category, participation_mode, amount_model, status, created_by)
values ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dinner-2026', 'Dinner Night', 'event', 'open', 'tiers', 'active', '55555555-5555-4555-8555-555555555555');

insert into public.collection_tiers (collection_id, community_id, name, price_kobo)
values ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'UI/UX — first payment', 1500000);

select throws_ok(
  $$ insert into public.collection_tiers (collection_id, community_id, name, price_kobo)
     values ('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ui/ux — FIRST PAYMENT', 3000000) $$,
  '23505',
  null,
  'two tiers cannot share a name within one collection, case-insensitively (ADR 0010)'
);


-- ── Tenancy cannot be crossed ────────────────────────────────────────────────
-- SEC-18: an ID supplied by a caller never implies which community a row
-- belongs to. The database re-derives it and refuses a mismatch.
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', 'other-guard', 'Other Guard', 'social_group', false, '55555555-5555-4555-8555-555555555555');

select throws_ok(
  $$ insert into public.obligations (community_id, collection_id, member_id, expected_amount_kobo)
     values ('c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
             'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
             'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 100000) $$,
  'P0001',
  null,
  'an obligation cannot join a collection and a member from different communities (SEC-18)'
);


-- ── ROLE-02: a community always keeps an owner ───────────────────────────────
-- `officer_terms_assert_owner` is DEFERRABLE INITIALLY DEFERRED, because a
-- handover legitimately ends the outgoing owner's term and starts the incoming
-- one in the same transaction — checking per-statement would reject the valid
-- case. The consequence for testing is that the trigger fires at COMMIT, and
-- pgTAP never commits: it wraps each file in a transaction and rolls back. So
-- without this line the UPDATE below succeeds, the exception is never raised,
-- and the test reports a guard that does not work when in fact it does.
--
-- SET CONSTRAINTS ALL IMMEDIATE moves the check to statement end for the rest
-- of this transaction, which is what lets throws_ok see it.
set constraints all immediate;

select throws_ok(
  $$ update public.officer_terms
     set ended_at = now(), end_reason = 'resigned'
     where community_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and role = 'owner' $$,
  'P0001',
  null,
  'the last owner cannot end their term and leave the community without one (ROLE-02)'
);

select * from finish();
rollback;
