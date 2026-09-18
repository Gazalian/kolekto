-- ─────────────────────────────────────────────────────────────────────────────
-- 06 — Migration compatibility (Phase 1.5)
--
-- Covers M1–M9 as implemented in 20260918130000 through 20260918130800.
-- Structured in four parts, matching Phase 1.5 brief Part F items 6–9:
--   A. migration schema (M1)
--   B. imported-row immutability (M9), including its interaction with M4's
--      idempotent insert pattern — this is the test that proves the two
--      mechanisms compose rather than conflict, not merely that each works
--      alone.
--   C. legacy_links (M6)
--   D. provenance and idempotency (M2, M3, M4, M5, M8)
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(38);


-- ── A. The migration schema exists, is empty, and is unreachable ────────────

select has_schema('migration', 'the migration schema exists (M1)');

select has_table('migration', 'import_runs',            'migration.import_runs exists');
select has_table('migration', 'legacy_collection',       'migration.legacy_collection exists');
select has_table('migration', 'legacy_profile',          'migration.legacy_profile exists');
select has_table('migration', 'legacy_deposit',          'migration.legacy_deposit exists');
select has_table('migration', 'legacy_contribution',     'migration.legacy_contribution exists');
select has_table('migration', 'unattributed_payments',   'migration.unattributed_payments exists');

select is_empty(
  $$ select 1 from migration.unattributed_payments $$,
  'unattributed_payments is empty — Phase 1.5 populates no production data (Part E)'
);

select is_empty(
  $$
    select table_name from information_schema.role_table_grants
    where table_schema = 'migration' and grantee in ('anon', 'authenticated', 'PUBLIC')
  $$,
  'no client role holds any privilege on any table in the migration schema (M1: least privilege)'
);

-- Part E's explicit instruction, made structural: no collection_id column
-- exists on unattributed_payments, so no code path can populate one by
-- accident. "Do not invent collection attribution" enforced by absence.
select hasnt_column(
  'migration', 'unattributed_payments', 'collection_id',
  'unattributed_payments has NO collection_id column — attribution cannot be invented by construction (Part E)'
);

select has_column('migration', 'unattributed_payments', 'source_id',          'has source_id (original source identifier)');
select has_column('migration', 'unattributed_payments', 'payment_reference',  'has payment_reference (where available)');
select has_column('migration', 'unattributed_payments', 'amount_kobo',        'has amount_kobo (original amount, ADR 0003 typed)');
select has_column('migration', 'unattributed_payments', 'original_status',    'has original_status (preserved verbatim, never mapped to a Phase 3 enum)');
select has_column('migration', 'unattributed_payments', 'import_run_id',      'has import_run_id (provenance)');


-- ── B. Fixtures for the immutability and provenance tests ───────────────────
-- public.users.id references auth.users(id) — the auth row must exist first,
-- matching the pattern already established in 04_authorization.sql and
-- 05_guards.sql.

insert into auth.users (id, instance_id, aud, role, email) values
  ('66666666-6666-4666-8666-666666666666', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'migration-test@example.test');

-- ON CONFLICT DO UPDATE: the auth.users insert above already fired
-- app.handle_new_auth_user() (20260918140000), which created a placeholder
-- public.users row for this id.
insert into public.users (id, full_name, email) values
  ('66666666-6666-4666-8666-666666666666', 'Migration Test Owner', 'migration-test@example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('77777777-7777-4777-8777-777777777777', 'migration-test-assoc', 'Migration Test Association', 'university_association', false, '66666666-6666-4666-8666-666666666666');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666', 'owner', 'Migration Test Owner', 'migration');

insert into migration.import_runs (id, source_snapshot_label, status, completed_at) values
  ('88888888-8888-4888-8888-888888888888', 'pgtap-fixture-snapshot', 'completed', now());

-- M2: 'migration' is a real, usable enum value — the insert above already
-- proves it (it would have failed to parse otherwise), but assert it directly
-- too, so a future accidental removal of the value fails loudly here.
select ok(
  'migration' = any(enum_range(null::public.officer_term_start_reason)),
  E'\'migration\' is a valid officer_term_start_reason value (M2)'
);


-- ── B continued: imported-row immutability (M9) ──────────────────────────────

insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, status, created_by,
  is_imported, source_system, source_table, source_id, imported_at, import_run_id
) values (
  '99999999-9999-4999-8999-999999999999', '77777777-7777-4777-8777-777777777777',
  'imported-dues', 'Imported 2025 Dues', 'dues', 'managed', 'fixed',
  1000000, 'active', '66666666-6666-4666-8666-666666666666',
  true, 'kolekto-v1', 'collections', 'aaaaaaaa-0000-4000-8000-000000000001',
  now(), '88888888-8888-4888-8888-888888888888'
);

select throws_ok(
  $$ update public.collections set name = 'Renamed' where id = '99999999-9999-4999-8999-999999999999' $$,
  'P0001',
  null,
  'an imported collection cannot be UPDATEd (M9)'
);

select throws_ok(
  $$ delete from public.collections where id = '99999999-9999-4999-8999-999999999999' $$,
  'P0001',
  null,
  'an imported collection cannot be DELETEd (M9)'
);

-- The other half of the claim: this trigger is CONDITIONAL, not a blanket
-- lock on the whole table. An ordinary, non-imported collection — Phase 1's
-- entire existing behaviour — must be completely unaffected.
insert into public.collections (
  id, community_id, slug, name, category, participation_mode, amount_model,
  fixed_amount_kobo, status, created_by
) values (
  'a0000000-0000-4000-8000-00000000000a', '77777777-7777-4777-8777-777777777777',
  'ordinary-dues', 'An Ordinary Collection', 'dues', 'managed', 'fixed',
  500000, 'draft', '66666666-6666-4666-8666-666666666666'
);

select lives_ok(
  $$ update public.collections set name = 'Renamed Fine' where id = 'a0000000-0000-4000-8000-00000000000a' $$,
  'a NON-imported collection updates normally — M9''s trigger is conditional on is_imported, not a blanket lock'
);

select lives_ok(
  $$ delete from public.collections where id = 'a0000000-0000-4000-8000-00000000000a' $$,
  'a NON-imported collection deletes normally'
);

-- The trust-boundary claim from 20260918130700's header, proven rather than
-- asserted in prose: M4's idempotent re-run pattern against an ALREADY
-- imported row does not fire the trigger at all, because ON CONFLICT DO
-- NOTHING never issues an UPDATE when the row already exists.
select lives_ok(
  $$
    insert into public.collections (
      id, community_id, slug, name, category, participation_mode, amount_model,
      fixed_amount_kobo, status, created_by,
      is_imported, source_system, source_table, source_id, imported_at, import_run_id
    ) values (
      'a1111111-1111-4111-8111-111111111112', '77777777-7777-4777-8777-777777777777',
      'imported-dues-rerun-attempt', 'Should never land', 'dues', 'managed', 'fixed',
      1000000, 'active', '66666666-6666-4666-8666-666666666666',
      true, 'kolekto-v1', 'collections', 'aaaaaaaa-0000-4000-8000-000000000001',
      now(), '88888888-8888-4888-8888-888888888888'
    )
    on conflict (source_table, source_id) where is_imported do nothing
  $$,
  'ON CONFLICT (source_table, source_id) DO NOTHING against an already-imported source_id succeeds silently — the idempotent re-run pattern (M4) never triggers the immutability guard (M9)'
);

select is(
  (select name from public.collections where id = '99999999-9999-4999-8999-999999999999'),
  'Imported 2025 Dues',
  'the original imported row is completely untouched by the re-run attempt — no partial write, no silent overwrite'
);

select is(
  (select count(*)::int from public.collections where source_id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  1,
  'exactly one collection carries that source_id — the conflicting insert truly did nothing, not a second row'
);

-- Same guarantee, on members.
insert into public.members (
  id, community_id, full_name, phone_e164, status,
  is_imported, source_system, source_table, source_id, imported_at, import_run_id
) values (
  'b0000000-0000-4000-8000-00000000000b', '77777777-7777-4777-8777-777777777777',
  'Imported Member', '+2348099999999', 'unclaimed',
  true, 'kolekto-v1', 'contributions', 'bbbbbbbb-0000-4000-8000-000000000001',
  now(), '88888888-8888-4888-8888-888888888888'
);

select throws_ok(
  $$ update public.members set full_name = 'Renamed' where id = 'b0000000-0000-4000-8000-00000000000b' $$,
  'P0001', null,
  'an imported member cannot be UPDATEd (M9)'
);

select throws_ok(
  $$ delete from public.members where id = 'b0000000-0000-4000-8000-00000000000b' $$,
  'P0001', null,
  'an imported member cannot be DELETEd (M9)'
);

-- Unconditional immutability: migration.unattributed_payments.
insert into migration.unattributed_payments (
  id, source_id, payment_reference, amount_kobo, original_created_at, original_status,
  raw_payload, import_run_id
) values (
  'c0000000-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000001',
  'KLK-TEST-REF-0001', 500000, now(), 'success',
  '{"note": "pgTAP fixture"}'::jsonb, '88888888-8888-4888-8888-888888888888'
);

select throws_ok(
  $$ update migration.unattributed_payments set original_status = 'edited' where id = 'c0000000-0000-4000-8000-00000000000c' $$,
  'P0001', null,
  'an unattributed_payments row cannot be UPDATEd — unconditional immutability (M9)'
);

select throws_ok(
  $$ delete from migration.unattributed_payments where id = 'c0000000-0000-4000-8000-00000000000c' $$,
  'P0001', null,
  'an unattributed_payments row cannot be DELETEd'
);


-- ── C. legacy_links (M6) ──────────────────────────────────────────────────────

select has_table('public', 'legacy_links', 'public.legacy_links exists');

insert into public.legacy_links (old_path, new_path, kind, collection_id) values
  ('imported-dues', '/migration-test-assoc/imported-dues', 'collection_slug', '99999999-9999-4999-8999-999999999999');

select throws_ok(
  $$ insert into public.legacy_links (old_path, new_path, kind)
     values ('imported-dues', '/somewhere/else', 'collection_slug') $$,
  '23505',
  null,
  'old_path is unique — two old paths cannot both claim to redirect from the same address'
);

select throws_ok(
  $$ insert into public.legacy_links (old_path, new_path, kind)
     values ('/leading-slash', '/x', 'other') $$,
  '23514',
  null,
  'an old_path with a leading slash is rejected — the stored form is always slash-free'
);

-- Prove the deny-by-default is real, not merely absent-by-omission: grant
-- SELECT to authenticated INSIDE this rolled-back transaction (simulating the
-- "a future GRANT is added by mistake" scenario the Phase 1 grants file
-- itself warns about), and confirm the RLS policy still denies. Two
-- independent layers, both tested.
grant select on public.legacy_links to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.legacy_links $$,
  'even WITH a hypothetical SELECT grant, the using(false) policy denies authenticated access — defense in depth actually works, not just in theory'
);

reset role;
revoke select on public.legacy_links from authenticated;


-- ── D. Provenance and idempotency (M3, M4) ───────────────────────────────────

select throws_ok(
  $$ insert into public.collections (
       id, community_id, slug, name, category, participation_mode, amount_model,
       fixed_amount_kobo, status, created_by, is_imported
     ) values (
       'd0000000-0000-4000-8000-00000000000d', '77777777-7777-4777-8777-777777777777',
       'bad-imported', 'Missing provenance', 'dues', 'managed', 'fixed',
       100000, 'active', '66666666-6666-4666-8666-666666666666', true
     ) $$,
  '23514',
  null,
  'is_imported = true with no source_id (or any other provenance field) is rejected (M3: mandatory when imported)'
);

select throws_ok(
  $$ insert into public.collections (
       id, community_id, slug, name, category, participation_mode, amount_model,
       fixed_amount_kobo, status, created_by,
       source_system, source_table, source_id, imported_at, import_run_id
     ) values (
       'e0000000-0000-4000-8000-00000000000e', '77777777-7777-4777-8777-777777777777',
       'bad-not-imported', 'Fake provenance on a fresh row', 'dues', 'managed', 'fixed',
       100000, 'active', '66666666-6666-4666-8666-666666666666',
       'kolekto-v1', 'collections', 'ffffffff-0000-4000-8000-000000000001', now(),
       '88888888-8888-4888-8888-888888888888'
     ) $$,
  '23514',
  null,
  'is_imported = false (the default) with provenance fields populated is rejected (M3: forbidden when NOT imported — no fake values on current records)'
);

select throws_ok(
  $$ insert into public.collections (
       id, community_id, slug, name, category, participation_mode, amount_model,
       fixed_amount_kobo, status, created_by,
       is_imported, source_system, source_table, source_id, imported_at, import_run_id
     ) values (
       'f0000000-0000-4000-8000-00000000000f', '77777777-7777-4777-8777-777777777777',
       'dup-source', 'Same source row, different collection', 'dues', 'managed', 'fixed',
       100000, 'active', '66666666-6666-4666-8666-666666666666',
       true, 'kolekto-v1', 'collections', 'aaaaaaaa-0000-4000-8000-000000000001', now(),
       '88888888-8888-4888-8888-888888888888'
     ) $$,
  '23505',
  null,
  'a second collection cannot claim the same (source_table, source_id) as an existing one — M4 uniqueness holds for a genuinely different row, not only for an identical ON CONFLICT re-run'
);

-- M5: users.avatar_url.
select has_column('public', 'users', 'avatar_url', 'users.avatar_url exists (M5)');
select col_type_is('public', 'users', 'avatar_url', 'text', 'avatar_url is text');

-- col_is_null is not part of pgTAP's core API — queried directly via
-- information_schema instead of guessing at a helper function name.
select is(
  (select is_nullable from information_schema.columns
   where table_schema = 'public' and table_name = 'users' and column_name = 'avatar_url'),
  'YES',
  'avatar_url is nullable — never defaulted or invented (M5)'
);

-- M8: collection_code_settings.next_number.
select has_column('public', 'collection_code_settings', 'next_number', 'collection_code_settings.next_number exists (M8)');

select * from finish();
rollback;
