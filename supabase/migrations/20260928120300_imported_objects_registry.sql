-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120300 — migration.imported_objects: which live rows an import created
--
-- Import Foundations, Phase 7 (provenance review). The full classification is in
-- docs/migration/IMPORT-FOUNDATIONS-REPORT.md §6.
--
-- THE GAP. Only `collections` and `members` carry provenance columns. An import
-- also creates rows in `users`, `communities` (one personal community per
-- organizer, F-L1), `officer_terms`, `collection_tiers`, `collection_fields`,
-- `collection_code_sequences` and `legacy_links` — and once created, those are
-- indistinguishable from rows made by people using the product. Reconciliation
-- ("exactly 623 users and 623 personal communities were created by run R") and
-- re-run safety ("this organizer already has their imported community") both need
-- to tell them apart.
--
-- WHY A REGISTRY, NOT COLUMNS. Adding is_imported / source_* to every live table
-- would put migration concerns into the business domain permanently, for a
-- one-time event, and each table would need its own immutability rule. Instead,
-- one append-only table records the mapping: this source row became that target
-- row, in that run. Live tables stay as they are.
--
-- Two uniqueness rules, and what each guarantees:
--   (target_table, target_id)                         a live row is claimed by at
--                                                     most one source
--   (source_project, source_table, source_id,         one source row yields at most
--    target_table)                                    one row per target table —
--                                                     so a re-run finds the existing
--                                                     community instead of making a
--                                                     second one
-- ─────────────────────────────────────────────────────────────────────────────

create table migration.imported_objects (
  id              uuid primary key default app.uuid_generate_v7(),

  source_project  text        not null,
  import_run_id   uuid        not null,
  source_table    text        not null,
  source_id       text        not null,

  target_table    text        not null,
  target_id       uuid        not null,

  created_at      timestamptz not null default now(),

  constraint imported_objects_run_fk
    foreign key (import_run_id, source_project)
    references migration.import_runs (id, source_project) on delete restrict,
  constraint imported_objects_source_table_qualified
    check (source_table ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  constraint imported_objects_target_table_qualified
    check (target_table ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  constraint imported_objects_source_id_present
    check (length(source_id) > 0)
);

create unique index imported_objects_target_key
  on migration.imported_objects (target_table, target_id);
create unique index imported_objects_source_key
  on migration.imported_objects (source_project, source_table, source_id, target_table);
create index imported_objects_run_idx
  on migration.imported_objects (import_run_id);

comment on table migration.imported_objects is
  'Provenance registry: which live-domain row an import created from which source row. Used for reconciliation and re-run safety for tables that carry no provenance columns of their own (users, communities, officer_terms, tiers, fields, code sequences, legacy_links). Append-only.';

alter table migration.imported_objects enable row level security;
alter table migration.imported_objects force row level security;

create policy imported_objects_deny_client_access
  on migration.imported_objects for select to authenticated using (false);

revoke all on migration.imported_objects from public, anon, authenticated, service_role;

create trigger imported_objects_no_update
  before update on migration.imported_objects
  for each row execute function app.block_row_mutation();
create trigger imported_objects_no_delete
  before delete on migration.imported_objects
  for each row execute function app.block_row_mutation();
