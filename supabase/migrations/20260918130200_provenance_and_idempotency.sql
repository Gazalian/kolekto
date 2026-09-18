-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130200 — Phase 1.5 / M3 + M4: provenance and idempotency
--
-- Migration Architecture section 7 and section 15 (M3, M4). Every migrated row
-- must be distinguishable from a row the new system created itself, and every
-- transform step must be safely re-runnable against the same snapshot without
-- creating duplicates. These two requirements are implemented together because
-- M4's uniqueness constraint is carved directly out of the columns M3 adds —
-- splitting them would leave a moment where the columns exist but nothing
-- prevents a re-run from double-importing.
--
-- Scope: public.collections and public.members, per the architecture
-- document's explicit "at minimum for migrated collections and members" (Part
-- C, M3). No Phase 1 file is edited — these are ALTER TABLE ADD COLUMN
-- statements against tables Phase 1 already created and verified.
--
-- No existing row is affected. Every column added here is nullable or
-- default-false, so `db reset` replaying the Phase 1 seed data (which contains
-- zero imported rows) continues to pass unchanged. This is checked explicitly
-- by 06_migration_provenance.sql in the test suite.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.collections
  add column is_imported   boolean not null default false,
  add column source_system text,
  add column source_table  text,
  add column source_id     uuid,
  add column imported_at   timestamptz,
  add column import_run_id uuid references migration.import_runs (id) on delete restrict;

alter table public.members
  add column is_imported   boolean not null default false,
  add column source_system text,
  add column source_table  text,
  add column source_id     uuid,
  add column imported_at   timestamptz,
  add column import_run_id uuid references migration.import_runs (id) on delete restrict;

comment on column public.collections.is_imported is
  'true for a collection carried forward from the old Kolekto platform. Distinguishable on sight everywhere this column is selected (Migration Architecture section 7). Immutable once true — see app.enforce_imported_row_immutability() in 20260918130700.';
comment on column public.members.is_imported is
  'true for a member record derived from old contributor contact details (architecture doc section 4.4) or an old profile (section 4.1). Immutable once true.';


-- ── M3: mandatory provenance for imported rows, never invented for others ──
-- "Do not make them optional if the migration architecture requires them to
-- be mandatory for imported rows. Do not create fake values for current
-- non-imported records." (Phase 1.5 brief, Part C, M3.)
--
-- A single CHECK expresses both halves of that sentence: when is_imported is
-- true, every provenance column must be present; when it is false (every row
-- created by the application itself, forever), every provenance column must
-- be NULL. There is no third state, and no default value pretends otherwise.
alter table public.collections
  add constraint collections_provenance_mandatory_when_imported
  check (
    is_imported = (
      source_system is not null and source_table is not null
      and source_id is not null and imported_at is not null
      and import_run_id is not null
    )
  );

alter table public.members
  add constraint members_provenance_mandatory_when_imported
  check (
    is_imported = (
      source_system is not null and source_table is not null
      and source_id is not null and imported_at is not null
      and import_run_id is not null
    )
  );


-- ── M4: (source_table, source_id) uniqueness, scoped to imported rows only ──
-- "The migration pipeline must be able to safely execute the same import run
-- more than once. Do not introduce uniqueness constraints that incorrectly
-- prevent legitimate current data." (Phase 1.5 brief, Part C, M4.)
--
-- PARTIAL, WHERE is_imported — this is what keeps the second sentence true.
-- Every row created by the application itself has source_id = NULL by the
-- CHECK constraint above; a partial index that only covers is_imported rows
-- never evaluates those rows at all, so ordinary collection and member
-- creation is completely unaffected. There is no current production data in
-- these tables (Phase 1 ships with zero imported rows), so there is nothing
-- for this index to conflict with today — the test suite proves the FUTURE
-- case: a transform step run twice for the same source row.
--
-- This is the index that makes `insert ... on conflict (source_table,
-- source_id) do nothing` — the exact idempotent pattern the architecture
-- document specifies (section 11) — a real, enforced guarantee rather than an
-- assumption about how the pipeline will behave.
create unique index collections_source_key
  on public.collections (source_table, source_id)
  where is_imported;

create unique index members_source_key
  on public.members (source_table, source_id)
  where is_imported;

create index collections_import_run_idx on public.collections (import_run_id) where is_imported;
create index members_import_run_idx     on public.members (import_run_id) where is_imported;
