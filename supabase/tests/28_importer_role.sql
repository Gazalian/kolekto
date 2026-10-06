-- ─────────────────────────────────────────────────────────────────────────────
-- 28 — kolekto_importer: the privilege boundary
--
-- Coverage for 20260928120600_importer_role.sql. Matrix:
-- docs/migration/IMPORT-FOUNDATIONS-REPORT.md §5.
--
-- Part 1 asserts what the role holds, from the catalog. Part 2 becomes the role
-- (SET ROLE — the only way in; it cannot log in) and tries things.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(24);

-- ── Part 1 — what the role is ────────────────────────────────────────────────
select ok(exists (select 1 from pg_roles where rolname = 'kolekto_importer'), 'kolekto_importer exists');
select ok(
  (select not rolcanlogin and not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb
   from pg_roles where rolname = 'kolekto_importer'),
  'it cannot log in, bypass RLS, or create roles or databases'
);
select ok(pg_has_role('postgres', 'kolekto_importer', 'SET'),
  'the migration connection can SET ROLE to it');
select ok(not pg_has_role('postgres', 'kolekto_importer', 'USAGE'),
  'the migration connection does not silently inherit its privileges');

select is(
  (select count(*)::integer
   from pg_class c
   cross join unnest(array['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv
   where c.relkind in ('r','p','v','m')
     and c.relnamespace::regnamespace::text in ('public','app','private','migration','auth','storage')
     and has_table_privilege('kolekto_importer', c.oid, priv)),
  0,
  'no UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on any table, in any schema'
);

-- Tests 6-9 reflect the full grant surface after the importer grant migrations
-- (20260929100000-20260929100300). The nine migration-schema tables plus nine
-- public destination tables, community_slug_history for read, and six functions.
select set_eq(
  $$ select c.relname::text from pg_class c
     where c.relkind in ('r','p') and c.relnamespace::regnamespace::text in ('public','app','private','migration','auth','storage')
       and has_table_privilege('kolekto_importer', c.oid, 'INSERT') $$,
  $$ values ('import_runs'), ('legacy_profile'), ('legacy_collection'), ('legacy_contribution'), ('legacy_deposit'),
            ('unattributed_payments'), ('legacy_withdrawal'), ('legacy_overflow'), ('imported_objects'),
            ('users'), ('communities'), ('officer_terms'), ('collections'), ('members'),
            ('collection_tiers'), ('collection_fields'), ('collection_code_sequences'), ('legacy_links') $$,
  'INSERT is held on exactly the migration nine + nine public destination tables'
);
select set_eq(
  $$ select c.relname::text from pg_class c
     where c.relkind in ('r','p') and c.relnamespace::regnamespace::text in ('public','app','private','migration','auth','storage')
       and has_table_privilege('kolekto_importer', c.oid, 'SELECT') $$,
  $$ values ('import_runs'), ('legacy_profile'), ('legacy_collection'), ('legacy_contribution'), ('legacy_deposit'),
            ('unattributed_payments'), ('legacy_withdrawal'), ('legacy_overflow'), ('imported_objects'),
            ('users'), ('communities'), ('officer_terms'), ('collections'), ('members'),
            ('collection_tiers'), ('collection_fields'), ('collection_code_sequences'), ('legacy_links'),
            ('community_slug_history') $$,
  'SELECT is held on the same tables plus community_slug_history'
);
select is(
  (select count(*)::integer from pg_class c
   where c.relkind in ('r','p') and c.relnamespace::regnamespace::text = 'public'
     and (has_table_privilege('kolekto_importer', c.oid, 'SELECT') or has_table_privilege('kolekto_importer', c.oid, 'INSERT'))),
  10,
  'the nine public destination tables + community_slug_history are granted'
);
select set_eq(
  $$ select p.proname::text from pg_proc p
     where p.pronamespace::regnamespace::text in ('public','app','private','migration')
       and has_function_privilege('kolekto_importer', p.oid, 'EXECUTE') $$,
  $$ values ('uuid_generate_v7'), ('is_running_import_context'),
            ('generate_unique_collection_slug'), ('generate_unique_community_slug'),
            ('slugify'), ('all_amounts_positive') $$,
  'it executes the id default + slug generation + is_running_import_context + all_amounts_positive'
);
select ok(
  not exists (select 1 from pg_policies where 'kolekto_importer' = any(roles) and cmd in ('UPDATE','DELETE','ALL')),
  'no RLS policy grants it UPDATE, DELETE or ALL'
);
select is(
  (select count(*)::integer from pg_class c
   cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as priv
   where c.relkind in ('r','p') and c.relnamespace::regnamespace::text in ('public','app','private','migration')
     and has_table_privilege('service_role', c.oid, priv)),
  0,
  'service_role still holds nothing on application tables (F-1 is not reopened)'
);

-- A completed run to test against, made by the owner.
insert into migration.import_runs (id, source_project, source_snapshot_label, status, completed_at)
values ('8a000000-0000-4000-8000-000000000001', 'synthetic:importer-role', 'finished', 'completed', now());


-- ── Part 2 — acting as the role ──────────────────────────────────────────────
set local role kolekto_importer;

select lives_ok(
  $$ insert into migration.import_runs (id, source_project, source_snapshot_label)
     values ('8a000000-0000-4000-8000-000000000002', 'synthetic:importer-role', 'open') $$,
  'it can open a run'
);
select throws_ok(
  $$ insert into migration.import_runs (source_project, source_snapshot_label, status, completed_at)
     values ('synthetic:importer-role', 'born-finished', 'completed', now()) $$,
  '42501', null,
  'it cannot create a run that is already finished'
);
select lives_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields)
     values ('synthetic:importer-role', 'public.wallets', '1', '{id}', '8a000000-0000-4000-8000-000000000002', '{}') $$,
  'it can write history into an open run'
);
select throws_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields)
     values ('synthetic:importer-role', 'public.wallets', '2', '{id}', '8a000000-0000-4000-8000-000000000001', '{}') $$,
  '42501', null,
  'it cannot write into a finished run'
);
select is(
  (select count(*)::integer from migration.legacy_overflow where import_run_id = '8a000000-0000-4000-8000-000000000002'),
  1,
  'it can read back what it wrote, for reconciliation'
);
select throws_ok($$ update migration.legacy_overflow set fields = '{"x":1}' $$, '42501', null, 'it cannot UPDATE history');
select throws_ok($$ delete from migration.legacy_overflow $$,                  '42501', null, 'it cannot DELETE history');
select throws_ok($$ truncate migration.legacy_overflow $$,                     '42501', null, 'it cannot TRUNCATE history');
select throws_ok(
  $$ update migration.import_runs set status = 'completed', completed_at = now() where id = '8a000000-0000-4000-8000-000000000002' $$,
  '42501', null,
  'it cannot close a run — the lifecycle belongs to the orchestrating connection'
);
select lives_ok($$ select count(*) from public.users $$,            'it CAN read users (needed for ON CONFLICT DO NOTHING / WHERE NOT EXISTS)');
select throws_ok($$ select count(*) from public.ledger_entries $$,  '42501', null, 'it cannot read the ledger');
select throws_ok(
  $$ insert into public.ledger_journals (id) values (gen_random_uuid()) $$,
  '42501', null,
  'it cannot write the ledger'
);
select throws_ok($$ select app.normalise_phone('+2348000000000') $$, '42501', null, 'it cannot execute application functions');

reset role;

select * from finish();
rollback;
