-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130000 — Phase 1.5 / M1: the `migration` schema
--
-- Kolekto Migration Architecture (2026-09-18), section 15, M1. A dedicated
-- schema for migration-specific structures, separate from `public` (the
-- application domain), `app` (server-side helpers) and `private` (staff
-- operational views). Not part of the application domain, not exposed through
-- PostgREST, least privilege.
--
-- This migration is ADDITIVE ONLY. No Phase 1 file (20260917*) is edited,
-- reordered or reinterpreted — Phase 1 is applied and verified, and stays
-- immutable (Phase 1.5 brief, Part B).
--
-- What this migration does NOT do, on purpose: it does not populate any table
-- with production data. Every table below is empty when this migration
-- finishes running, and stays empty until a human runs the migration pipeline
-- described in the architecture document — which is not this phase.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists migration;

comment on schema migration is
  'Migration-compatibility structures: legacy field overflow, import provenance, and the known unattributed-payments exception. Not part of the public application domain. Not exposed via PostgREST. USAGE revoked from anon/authenticated in 20260918130800_phase1_5_grants.sql — the single file that decides what a client role can reach (see that file''s header).';


-- ── import_runs: the unit of repeatability ──────────────────────────────────
-- Migration Architecture section 11: "Every step is idempotent and tagged with
-- an import_run_id... A run is deleted by its import_run_id, which is why that
-- column exists." This is that column's target. Every provenance column added
-- in this Phase 1.5 batch (M3, and later the Phase 3 money tables per the
-- architecture's M10) references a row here.
--
-- Operational metadata, not a historical record — status legitimately changes
-- as a run progresses, so this table does NOT get the M9 immutability trigger.
create type migration.import_run_status as enum (
  'running',
  'completed',
  'failed',
  'rolled_back'
);

create table migration.import_runs (
  id                    uuid primary key default app.uuid_generate_v7(),
  source_system         text not null default 'kolekto-v1',
  -- Which snapshot this run transformed. Architecture section 11: the pipeline
  -- reads a checksummed, dated pg_dump file, never a live connection. This is
  -- that file's identity, so a run is traceable to an exact point in time.
  source_snapshot_label text not null,
  status                migration.import_run_status not null default 'running',
  started_at            timestamptz not null default now(),
  completed_at          timestamptz,
  notes                 text,
  created_by            uuid references public.users (id) on delete set null,

  constraint import_runs_completed_consistently
    check ((status in ('completed', 'failed', 'rolled_back')) = (completed_at is not null))
);

comment on table migration.import_runs is
  'One row per migration pipeline execution. import_run_id on every imported row references this, which is what makes a run identifiable and reversible (delete by import_run_id) per the architecture document section 11.';

alter table migration.import_runs enable row level security;
alter table migration.import_runs force row level security;

-- Service-role only, by design — least privilege (M1). Stated as a policy
-- rather than left as a silent zero-policy gap, matching the discipline
-- 01_rls_coverage.sql already enforces for public.* tables.
create policy import_runs_deny_client_access
  on migration.import_runs for select to authenticated
  using (false);

-- No set_updated_at trigger: import_runs has no updated_at column by design
-- (started_at/completed_at already carry the relevant timestamps). Attaching
-- app.set_updated_at() here would fail on the first status transition, since
-- that function assumes the column exists.


-- ── Legacy field overflow ────────────────────────────────────────────────────
-- Migration Architecture section 9, "Fields with no home in the new model."
-- None of these fields are silently dropped. Each old row's fields that have
-- no Phase 1 equivalent land here as immutable JSON, keyed back to the row
-- they came from, queryable and exportable — never merged into the domain
-- schema, never guessed at.
--
-- One table per old source table, because the overflow shape differs per
-- source and a single polymorphic table would hide that.

create table migration.legacy_collection (
  id             uuid primary key default app.uuid_generate_v7(),
  -- The NEW collection this overflow belongs to, once migrated (M3's
  -- provenance columns land on public.collections). Nullable because this
  -- table can be populated before the owning collection row exists, during a
  -- staged transform.
  collection_id  uuid references public.collections (id) on delete cascade,
  source_table   text not null default 'collections',
  source_id      uuid not null,
  -- event_date, ticket_mode, allow_multiple_quantity, max_contributions,
  -- is_open_ended, auto_close, story, story_images, campaign_*, social_links,
  -- support_phone_number, rejection_reason — see the architecture document
  -- section 9 for the full field-by-field accounting.
  fields         jsonb not null,
  import_run_id  uuid not null references migration.import_runs (id) on delete restrict,
  imported_at    timestamptz not null default now(),

  constraint legacy_collection_fields_is_object check (jsonb_typeof(fields) = 'object')
);

comment on table migration.legacy_collection is
  'Old collection fields with no Phase 1 equivalent (event_date, ticketing flags, fundraiser presentation fields, support_phone_number, rejection_reason). Preserved, never merged into public.collections. Architecture doc section 9.';

create unique index legacy_collection_source_key on migration.legacy_collection (source_table, source_id);

alter table migration.legacy_collection enable row level security;
alter table migration.legacy_collection force row level security;

create policy legacy_collection_deny_client_access
  on migration.legacy_collection for select to authenticated
  using (false);


create table migration.legacy_profile (
  id             uuid primary key default app.uuid_generate_v7(),
  user_id        uuid references public.users (id) on delete cascade,
  source_table   text not null default 'profiles',
  source_id      uuid not null,
  -- address, date_of_birth, signup_ip, blocked_until — trust/KYC-adjacent
  -- fields with no home until DEC-04 and the risk engine exist.
  fields         jsonb not null,
  import_run_id  uuid not null references migration.import_runs (id) on delete restrict,
  imported_at    timestamptz not null default now(),

  constraint legacy_profile_fields_is_object check (jsonb_typeof(fields) = 'object')
);

comment on table migration.legacy_profile is
  'Old profile fields with no Phase 1 equivalent (address, date_of_birth, signup_ip, blocked_until). KYC-adjacent; DEC-04 decides what may eventually be stored in the domain schema. Architecture doc section 4.1.';

create unique index legacy_profile_source_key on migration.legacy_profile (source_table, source_id);

alter table migration.legacy_profile enable row level security;
alter table migration.legacy_profile force row level security;

create policy legacy_profile_deny_client_access
  on migration.legacy_profile for select to authenticated
  using (false);


create table migration.legacy_deposit (
  id             uuid primary key default app.uuid_generate_v7(),
  source_table   text not null default 'deposits',
  source_id      uuid not null,
  -- access_code, authorization_url — Paystack init artefacts with no ongoing
  -- value once a transaction has resolved.
  fields         jsonb not null,
  import_run_id  uuid not null references migration.import_runs (id) on delete restrict,
  imported_at    timestamptz not null default now(),

  constraint legacy_deposit_fields_is_object check (jsonb_typeof(fields) = 'object')
);

comment on table migration.legacy_deposit is
  'Old deposit (transaction) fields with no Phase 1 equivalent. Architecture doc section 4.5. The financial fields themselves (reference, amount, status, timestamps) belong in the Phase 3 transactions table, not here — this is overflow only.';

create unique index legacy_deposit_source_key on migration.legacy_deposit (source_table, source_id);

alter table migration.legacy_deposit enable row level security;
alter table migration.legacy_deposit force row level security;

create policy legacy_deposit_deny_client_access
  on migration.legacy_deposit for select to authenticated
  using (false);


create table migration.legacy_contribution (
  id             uuid primary key default app.uuid_generate_v7(),
  source_table   text not null default 'contributions',
  source_id      uuid not null,
  -- contributor_information overflow — whatever does not map to a member
  -- attribute defined in public.member_attribute_definitions.
  fields         jsonb not null,
  import_run_id  uuid not null references migration.import_runs (id) on delete restrict,
  imported_at    timestamptz not null default now(),

  constraint legacy_contribution_fields_is_object check (jsonb_typeof(fields) = 'object')
);

comment on table migration.legacy_contribution is
  'Old contribution fields with no Phase 1 equivalent. Architecture doc section 4.4/4.5. The financial fields themselves belong in the Phase 3 contributions table, not here.';

create unique index legacy_contribution_source_key on migration.legacy_contribution (source_table, source_id);

alter table migration.legacy_contribution enable row level security;
alter table migration.legacy_contribution force row level security;

create policy legacy_contribution_deny_client_access
  on migration.legacy_contribution for select to authenticated
  using (false);


-- ── The known legacy financial exception ─────────────────────────────────────
-- Migration Architecture section 7 and section 15 (M11), and the explicit
-- instruction for this phase: 923 successful `deposits` rows, ₦19,799,220,
-- with no collection attribution. This is a KNOWN, ALREADY-INVESTIGATED
-- historical early-system data-loss issue. This table exists to PRESERVE those
-- records with full provenance — not to re-open, re-classify or re-investigate
-- them, and not to make them financial truth in the new system.
--
-- Deliberately absent: any collection_id column. Adding one, even nullable,
-- invites a future well-meaning migration to "helpfully" backfill an
-- attribution that was never a documented fact. The Phase 1.5 brief is
-- explicit: "Do not invent collection attribution." The absence of the column
-- is what makes that impossible by construction, not merely by convention.
--
-- Also deliberately absent: any relationship to a ledger, wallet or balance
-- table. None exist yet (ADR 0006). When they do, this table must never be
-- joined into a balance calculation — it is a preserved historical exception,
-- not a source of financial truth. That rule is stated here so it travels with
-- the table into Phase 3 code review, not only in a document that may not be
-- open at the time.
create table migration.unattributed_payments (
  id                 uuid primary key default app.uuid_generate_v7(),

  -- "Original source identifier" (Phase 1.5 brief, Part E item 1).
  source_table       text not null default 'deposits',
  source_id          uuid not null,

  -- "Payment reference where available" — old deposits.payment_reference is
  -- NOT NULL in production, but the column is nullable here because a future
  -- source table might not guarantee one, and a nullable column that happens
  -- to always be filled is safer than a NOT NULL that has to be relaxed later.
  payment_reference  text,

  -- "Original amount" — ADR 0003 governs money representation project-wide;
  -- preserving the VALUE faithfully does not require preserving the OLD
  -- TYPE. Converted to kobo at import time, exactly as every other migrated
  -- money value is (architecture doc section 4, "asserted integral, never a
  -- silent round").
  amount_kobo        app.kobo not null,
  net_amount_kobo    app.kobo,

  -- "Original timestamps."
  original_created_at timestamptz not null,
  original_paid_at    timestamptz,

  -- "Original status" — the OLD status string, verbatim, never mapped to a
  -- Phase 3 enum. Mapping would imply this is a transaction the new system
  -- understands; it is explicitly not.
  original_status    text not null,

  -- The complete original row, for the case some future question needs a
  -- field nobody thought to name above.
  raw_payload        jsonb not null,

  -- "Provenance... import run" (Phase 1.5 brief, Part E item 1).
  import_run_id      uuid not null references migration.import_runs (id) on delete restrict,
  imported_at        timestamptz not null default now(),

  -- Free-text space for the classification already done outside this schema
  -- (the brief: "already investigated and understood by Kolekto"). Recording
  -- the existing conclusion here, once the migration runs, is documentation —
  -- not new investigation.
  notes              text,

  constraint unattributed_payments_amount_not_negative check (amount_kobo >= 0),
  constraint unattributed_payments_source_id_present check (source_id is not null)
);

comment on table migration.unattributed_payments is
  'The known legacy exception: successful payments preserved from the old system with no collection attribution (Migration Architecture section 7/9, item U1). Preservation and auditability only — never a source for a collection_id, a ledger entry, or a wallet balance. Not re-investigated by this migration; the classification already reached outside this schema is recorded in the notes column when the pipeline runs.';

create unique index unattributed_payments_source_key on migration.unattributed_payments (source_table, source_id);
create index unattributed_payments_reference_idx on migration.unattributed_payments (payment_reference) where payment_reference is not null;

alter table migration.unattributed_payments enable row level security;
alter table migration.unattributed_payments force row level security;

create policy unattributed_payments_deny_client_access
  on migration.unattributed_payments for select to authenticated
  using (false);
