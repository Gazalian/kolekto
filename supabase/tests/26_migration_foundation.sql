-- ─────────────────────────────────────────────────────────────────────────────
-- 26 — Migration foundation: runs, withdrawals, overflow, registry, immutability
--
-- Coverage for 20260928120000 … 20260928120400. Report:
-- docs/migration/IMPORT-FOUNDATIONS-REPORT.md.
--
-- Every row inserted here is synthetic and rolled back. No legacy data.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(40);

-- ── import_runs.source_project (E-P1) ────────────────────────────────────────
select col_not_null('migration', 'import_runs', 'source_project', 'import_runs.source_project is required');

select lives_ok(
  $$ insert into migration.import_runs (id, source_project, source_snapshot_label) values
       ('7a000000-0000-4000-8000-000000000001', 'legacy-production:busfgcmbndleljklrcbd', '2026-09-27-busfgcmbndleljklrcbd'),
       ('7a000000-0000-4000-8000-000000000002', 'legacy-test:lpeeckqsltxohppheucz', 'legacy-test-snapshot'),
       ('7a000000-0000-4000-8000-000000000003', 'synthetic:volume-1', 'synthetic-v1') $$,
  'the three recognised kinds of source are accepted'
);
select throws_ok(
  $$ insert into migration.import_runs (source_project, source_snapshot_label) values ('legacy-production', 'x') $$,
  '23514', null,
  'a legacy source without its project ref is ambiguous and refused'
);
select throws_ok(
  $$ insert into migration.import_runs (source_project, source_snapshot_label) values ('legacy-production:abcdefghijklmnopqrst', 'x') $$,
  '23514', null,
  'an unrecognised project ref is refused'
);
select throws_ok(
  $$ insert into migration.import_runs (source_project, source_snapshot_label) values ('Synthetic:Volume 1', 'x') $$,
  '23514', null,
  'a malformed synthetic label is refused'
);

-- The run guard: identity fixed, lifecycle allowed while running, frozen after.
select throws_like(
  $$ update migration.import_runs set source_project = 'synthetic:other' where id = '7a000000-0000-4000-8000-000000000003' $$,
  '%IMPORT_RUN_IDENTITY_IS_FIXED%',
  'a run''s source_project cannot be changed'
);
select throws_like(
  $$ update migration.import_runs set source_snapshot_label = 'rewritten' where id = '7a000000-0000-4000-8000-000000000003' $$,
  '%IMPORT_RUN_IDENTITY_IS_FIXED%',
  'a run''s snapshot label cannot be changed'
);
select lives_ok(
  $$ update migration.import_runs set notes = 'progress note' where id = '7a000000-0000-4000-8000-000000000003' $$,
  'a running run may record notes'
);
select lives_ok(
  $$ update migration.import_runs set status = 'completed', completed_at = now() where id = '7a000000-0000-4000-8000-000000000002' $$,
  'a running run may be completed'
);
select throws_like(
  $$ update migration.import_runs set notes = 'after the fact' where id = '7a000000-0000-4000-8000-000000000002' $$,
  '%IMPORT_RUN_IS_FINISHED%',
  'a finished run cannot change at all'
);
select throws_like(
  $$ delete from migration.import_runs where id = '7a000000-0000-4000-8000-000000000003' $$,
  '%IMPORT_RUN_IS_PERMANENT%',
  'an import run cannot be deleted'
);


-- ── migration.legacy_withdrawal (F-M2) ───────────────────────────────────────
create temporary table tmp_ledger_before as
  select (select count(*) from public.ledger_journals) as journals,
         (select count(*) from public.ledger_entries)  as entries,
         (select count(*) from public.ledger_accounts) as accounts;

select lives_ok(
  $$ insert into migration.legacy_withdrawal
       (source_project, source_id, import_run_id, amount_kobo, original_status,
        legacy_collection_id, legacy_user_id, provider_transfer_code, fields)
     values ('synthetic:volume-1', '7c000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000003',
             4165349580, 'approved', '7d000000-0000-4000-8000-000000000001', '7d000000-0000-4000-8000-000000000002',
             'TRF_synthetic', '{"destination_account_redacted": {"bank": "Synthetic Bank", "last4": "0000"}}') $$,
  'a legacy withdrawal is recorded with amount in kobo and its verbatim status'
);
select is(
  (select original_status from migration.legacy_withdrawal where source_id = '7c000000-0000-4000-8000-000000000001'),
  'approved',
  'the legacy status word is kept exactly as written (F-L5 is a reading, not a rewrite)'
);
select throws_ok(
  $$ insert into migration.legacy_withdrawal
       (source_project, source_id, import_run_id, amount_kobo, original_status, legacy_collection_id, legacy_user_id, fields)
     values ('synthetic:volume-1', '7c000000-0000-4000-8000-000000000002', '7a000000-0000-4000-8000-000000000003',
             100, 'approved', gen_random_uuid(), gen_random_uuid(),
             '{"destination_account": {"account_number": "0123456789"}}') $$,
  '23514', null,
  'full bank details are refused (L-3): destination_account may not be stored'
);
select throws_ok(
  $$ insert into migration.legacy_withdrawal
       (source_project, source_id, import_run_id, amount_kobo, original_status, legacy_collection_id, legacy_user_id, fields)
     values ('synthetic:volume-1', '7c000000-0000-4000-8000-000000000003', '7a000000-0000-4000-8000-000000000003',
             -1, 'approved', gen_random_uuid(), gen_random_uuid(), '{}') $$,
  '23514', null,
  'a negative amount is refused'
);
select throws_ok(
  $$ insert into migration.legacy_withdrawal
       (source_project, source_id, import_run_id, amount_kobo, original_status, legacy_collection_id, legacy_user_id, fields)
     values ('legacy-test:lpeeckqsltxohppheucz', '7c000000-0000-4000-8000-000000000004', '7a000000-0000-4000-8000-000000000003',
             100, 'approved', gen_random_uuid(), gen_random_uuid(), '{}') $$,
  '23503', null,
  'a row cannot claim a different source project from its run'
);
select throws_ok(
  $$ insert into migration.legacy_withdrawal
       (source_project, source_id, import_run_id, amount_kobo, original_status, legacy_collection_id, legacy_user_id, fields)
     values ('synthetic:volume-1', '7c000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000003',
             100, 'approved', gen_random_uuid(), gen_random_uuid(), '{}') $$,
  '23505', null,
  'the same source withdrawal cannot be imported twice into one project'
);
select ok(
  (select journals from tmp_ledger_before) = (select count(*) from public.ledger_journals)
  and (select entries  from tmp_ledger_before) = (select count(*) from public.ledger_entries)
  and (select accounts from tmp_ledger_before) = (select count(*) from public.ledger_accounts),
  'recording a legacy withdrawal creates no ledger account, journal or entry'
);
select ok(
  not exists (
    select 1 from pg_constraint c
    where c.confrelid = 'migration.legacy_withdrawal'::regclass
  ),
  'nothing in the live schema references legacy_withdrawal — it cannot feed a balance'
);


-- ── migration.legacy_overflow (E-O1) ─────────────────────────────────────────
select lives_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields) values
       ('synthetic:volume-1', 'public.wallets',   '7e000000-0000-4000-8000-000000000001', '{id}', '7a000000-0000-4000-8000-000000000003', '{"available_balance": "1140.38"}'),
       ('synthetic:volume-1', 'public.campuses',  '47',                                   '{campus_id}', '7a000000-0000-4000-8000-000000000003', '{"name": "Synthetic Campus"}'),
       ('synthetic:volume-1', 'public.pair_table', 'a|b',                                 '{left_id,right_id}', '7a000000-0000-4000-8000-000000000003', '{}') $$,
  'overflow preserves uuid, integer and composite-keyed rows from any legacy table'
);
select is(
  (select fields->>'available_balance' from migration.legacy_overflow where source_table = 'public.wallets'),
  '1140.38',
  'a legacy wallet is preserved verbatim, as history — never as a balance'
);
select lives_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields)
     values ('synthetic:volume-1', 'public.wallets', '7e000000-0000-4000-8000-000000000001', '{id}', '7a000000-0000-4000-8000-000000000003', '{"changed": true}')
     on conflict (source_project, source_table, source_id) do nothing $$,
  're-importing the same source row is a no-op'
);
select is(
  (select count(*)::integer from migration.legacy_overflow where source_table = 'public.wallets'),
  1,
  '…and leaves exactly one row, unchanged'
);
select throws_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields)
     values ('synthetic:volume-1', 'wallets', 'x', '{id}', '7a000000-0000-4000-8000-000000000003', '{}') $$,
  '23514', null,
  'source_table must be schema-qualified'
);
select throws_ok(
  $$ insert into migration.legacy_overflow (source_project, source_table, source_id, source_key_columns, import_run_id, fields)
     values ('synthetic:volume-1', 'public.wallets', 'y', '{id}', '7a000000-0000-4000-8000-000000000003', '[1,2]') $$,
  '23514', null,
  'fields must be a jsonb object'
);
select is(
  (select count(*)::integer from pg_attribute
   where attrelid = 'migration.legacy_overflow'::regclass and attnum > 0 and not attisdropped),
  8,
  'overflow has no business columns — provenance and fields only'
);


-- ── migration.imported_objects (provenance registry) ─────────────────────────
select lives_ok(
  $$ insert into migration.imported_objects (source_project, import_run_id, source_table, source_id, target_table, target_id)
     values ('synthetic:volume-1', '7a000000-0000-4000-8000-000000000003', 'auth.users', '7f000000-0000-4000-8000-000000000001',
             'public.communities', '7f000000-0000-4000-8000-0000000000c1') $$,
  'the registry records which live row an import created from which source row'
);
select throws_ok(
  $$ insert into migration.imported_objects (source_project, import_run_id, source_table, source_id, target_table, target_id)
     values ('synthetic:volume-1', '7a000000-0000-4000-8000-000000000003', 'auth.users', '7f000000-0000-4000-8000-000000000001',
             'public.communities', '7f000000-0000-4000-8000-0000000000c2') $$,
  '23505', null,
  'one source row yields at most one row per target table — a re-run finds the existing community'
);
select throws_ok(
  $$ insert into migration.imported_objects (source_project, import_run_id, source_table, source_id, target_table, target_id)
     values ('synthetic:volume-1', '7a000000-0000-4000-8000-000000000003', 'auth.users', '7f000000-0000-4000-8000-000000000009',
             'public.communities', '7f000000-0000-4000-8000-0000000000c1') $$,
  '23505', null,
  'a live row is claimed by at most one source'
);


-- ── Immutability: every migration.* history table refuses UPDATE and DELETE ──
insert into migration.legacy_profile (source_table, source_id, fields, import_run_id)
  values ('profiles', '7f100000-0000-4000-8000-000000000001', '{}', '7a000000-0000-4000-8000-000000000003');
insert into migration.legacy_collection (source_table, source_id, fields, import_run_id)
  values ('collections', '7f100000-0000-4000-8000-000000000002', '{}', '7a000000-0000-4000-8000-000000000003');
insert into migration.legacy_contribution (source_table, source_id, fields, import_run_id)
  values ('contributions', '7f100000-0000-4000-8000-000000000003', '{}', '7a000000-0000-4000-8000-000000000003');
insert into migration.legacy_deposit (source_table, source_id, fields, import_run_id)
  values ('deposits', '7f100000-0000-4000-8000-000000000004', '{}', '7a000000-0000-4000-8000-000000000003');
insert into migration.unattributed_payments (source_table, source_id, amount_kobo, original_created_at, original_status, raw_payload, import_run_id)
  values ('deposits', '7f100000-0000-4000-8000-000000000005', 100, now(), 'success', '{}', '7a000000-0000-4000-8000-000000000003');

select throws_like($$ update migration.legacy_profile      set fields = '{"x":1}' $$, '%APPEND-ONLY%', 'legacy_profile refuses UPDATE');
select throws_like($$ delete from migration.legacy_profile $$,                     '%APPEND-ONLY%', 'legacy_profile refuses DELETE');
select throws_like($$ update migration.legacy_collection   set fields = '{"x":1}' $$, '%APPEND-ONLY%', 'legacy_collection refuses UPDATE');
select throws_like($$ delete from migration.legacy_collection $$,                  '%APPEND-ONLY%', 'legacy_collection refuses DELETE');
select throws_like($$ update migration.legacy_contribution set fields = '{"x":1}' $$, '%APPEND-ONLY%', 'legacy_contribution refuses UPDATE');
select throws_like($$ delete from migration.legacy_contribution $$,                '%APPEND-ONLY%', 'legacy_contribution refuses DELETE');
select throws_like($$ update migration.legacy_deposit      set fields = '{"x":1}' $$, '%APPEND-ONLY%', 'legacy_deposit refuses UPDATE');
select throws_like($$ delete from migration.legacy_deposit $$,                     '%APPEND-ONLY%', 'legacy_deposit refuses DELETE');
select throws_like($$ delete from migration.unattributed_payments $$,              '%APPEND-ONLY%', 'unattributed_payments still refuses DELETE');
select throws_like($$ update migration.legacy_withdrawal   set original_status = 'success' $$, '%APPEND-ONLY%', 'legacy_withdrawal refuses UPDATE — a paid withdrawal is not editable history');
select throws_like($$ delete from migration.legacy_overflow $$,                    '%APPEND-ONLY%', 'legacy_overflow refuses DELETE');

select * from finish();
rollback;
