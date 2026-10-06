-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120200 — migration.legacy_overflow (E-O1)
--
-- Zero data loss (F-M3) needs a destination for every legacy table, and 38 of
-- them — wallets, payment_recovery_log, pending_payment_context, the email
-- engine, notifications, snapshots and the rest — have no shape in the new
-- product. This is where they are preserved: one row per legacy row, verbatim.
--
-- NOT PART OF THE BUSINESS DOMAIN. No application code reads it. Nothing here is
-- flattened into invented columns — a legacy table's meaning is its own, and
-- guessing at it would be a transformation nobody decided on.
--
-- Wallets land here and only here. A legacy wallet balance is a cache that
-- drifted (the 359-kobo finding); it never becomes a balance, an opening
-- position or a ledger entry in the new system.
--
-- DESIGN
--   · source_table is free text, so any legacy table can be preserved without a
--     schema change. It is schema-qualified (e.g. `public.wallets`), which keeps
--     `auth.x` and `public.x` apart.
--   · source_id is TEXT, not uuid: legacy primary keys are uuids, integers
--     (campuses, students) and composites. A composite key is written as its
--     columns joined deterministically by the importer and documented in
--     `source_key_columns`, so re-running produces the same text.
--   · (source_project, source_table, source_id) is unique. Re-import is
--     `insert … on conflict do nothing` — a no-op, never a duplicate.
--   · source_project is bound to the run by a composite foreign key.
--   · Append-only, like every other migration.* history table.
--
-- What is excluded from Rehearsal #1 on legal grounds (KYC, user_identity, bank
-- details — L-1, L-2, L-3) is excluded by the importer and recorded in the run's
-- notes; this table does not decide it. Credentials the architecture already
-- ruled out of the copy (ambassador_profiles.pin_hash, push endpoint keys) are
-- likewise the importer's responsibility, per legacy-to-new-mapping.md §5.
-- ─────────────────────────────────────────────────────────────────────────────

create table migration.legacy_overflow (
  id                  uuid primary key default app.uuid_generate_v7(),

  source_project      text        not null,
  source_table        text        not null,
  source_id           text        not null,
  source_key_columns  text[]      not null,
  import_run_id       uuid        not null,
  imported_at         timestamptz not null default now(),

  fields              jsonb       not null,

  constraint legacy_overflow_run_fk
    foreign key (import_run_id, source_project)
    references migration.import_runs (id, source_project) on delete restrict,
  constraint legacy_overflow_source_table_qualified
    check (source_table ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  constraint legacy_overflow_source_id_present
    check (length(source_id) > 0),
  constraint legacy_overflow_key_columns_present
    check (cardinality(source_key_columns) > 0),
  constraint legacy_overflow_fields_is_object
    check (jsonb_typeof(fields) = 'object')
);

create unique index legacy_overflow_source_key
  on migration.legacy_overflow (source_project, source_table, source_id);
create index legacy_overflow_table_idx
  on migration.legacy_overflow (source_table);
create index legacy_overflow_run_idx
  on migration.legacy_overflow (import_run_id);

comment on table migration.legacy_overflow is
  'F-M3 zero data loss. Verbatim legacy rows from tables with no new-product shape, one row per legacy row. Not business data; nothing reads it for decisions. Wallets live here and never become balances. Append-only.';
comment on column migration.legacy_overflow.source_id is
  'The legacy primary key as text — uuid, integer or a deterministic join of a composite key (see source_key_columns).';

alter table migration.legacy_overflow enable row level security;
alter table migration.legacy_overflow force row level security;

create policy legacy_overflow_deny_client_access
  on migration.legacy_overflow for select to authenticated using (false);

revoke all on migration.legacy_overflow from public, anon, authenticated, service_role;

create trigger legacy_overflow_no_update
  before update on migration.legacy_overflow
  for each row execute function app.block_row_mutation();
create trigger legacy_overflow_no_delete
  before delete on migration.legacy_overflow
  for each row execute function app.block_row_mutation();
