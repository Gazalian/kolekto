-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120100 — migration.legacy_withdrawal (F-M2, E-W1)
--
-- Founder decision F-M2: preserve legacy withdrawals. Design:
-- docs/migration/legacy/legacy-withdrawal-model.md §3, implemented as written
-- except where noted.
--
-- HISTORICAL MIGRATION STORAGE ONLY. This is not a withdrawal table. Nothing reads
-- it to decide a balance, nothing posts a journal from it, and no live withdrawal
-- ever lands here. The new ledger starts at zero (D-23); a legacy withdrawal is a
-- record that money once left, not an instruction or an opening position.
--
-- Typed columns only for what a reconciliation must compare — amount, status,
-- dates, the legacy ids and the provider references. Everything else is verbatim
-- jsonb in `fields`.
--
-- Differences from the §3 draft, and why:
--   · source_project, bound to the run by a composite foreign key — a row cannot
--     claim a different source from the run that imported it.
--   · uniqueness is (source_project, source_table, source_id), so a synthetic
--     rehearsal and a legacy-production run can never collide.
--   · `fields` may not contain `destination_account`. Every legacy row holds bank
--     details there. The §4 recommendation — carry only a redacted form — is now
--     enforced by the database rather than left to the importer; the key name the
--     redacted form uses is `destination_account_redacted`. Whether the full value
--     may ever be preserved is L-3 (counsel); if it may, it must be encrypted at
--     rest in its own column, not plaintext in jsonb, and this check stays.
--   · original_status stays free text, verbatim. F-L5 decided that `approved` and
--     `success` are the same terminal paid outcome; that meaning is applied when
--     reading, never by rewriting what the legacy row said.
-- ─────────────────────────────────────────────────────────────────────────────

create table migration.legacy_withdrawal (
  id                       uuid primary key default app.uuid_generate_v7(),

  -- Provenance
  source_project           text        not null,
  source_table             text        not null default 'withdrawals',
  source_id                uuid        not null,
  import_run_id            uuid        not null,
  imported_at              timestamptz not null default now(),

  -- Reconciled figures. Integer kobo: round(legacy_naira * 100), exact.
  amount_kobo              app.kobo    not null,
  original_status          text        not null,
  original_created_at      timestamptz,
  original_updated_at      timestamptz,

  -- Attribution. The legacy ids are the durable facts; collection_id is a
  -- convenience link that may be null if the collection has not landed yet.
  collection_id            uuid references public.collections (id) on delete restrict,
  legacy_collection_id     uuid        not null,
  legacy_user_id           uuid        not null,
  legacy_wallet_id         uuid,

  -- Provider references, so a legacy transfer stays traceable.
  provider                 text        not null default 'paystack',
  provider_transfer_code   text,
  provider_recipient_code  text,

  -- Everything else, verbatim — except the bank details (see header).
  fields                   jsonb       not null,
  notes                    text,

  constraint legacy_withdrawal_run_fk
    foreign key (import_run_id, source_project)
    references migration.import_runs (id, source_project) on delete restrict,
  constraint legacy_withdrawal_amount_not_negative check (amount_kobo >= 0),
  constraint legacy_withdrawal_status_present      check (length(trim(original_status)) > 0),
  constraint legacy_withdrawal_fields_is_object    check (jsonb_typeof(fields) = 'object'),
  constraint legacy_withdrawal_no_bank_details     check (not (fields ? 'destination_account'))
);

create unique index legacy_withdrawal_source_key
  on migration.legacy_withdrawal (source_project, source_table, source_id);
create index legacy_withdrawal_legacy_collection_idx
  on migration.legacy_withdrawal (legacy_collection_id);
create index legacy_withdrawal_run_idx
  on migration.legacy_withdrawal (import_run_id);

comment on table migration.legacy_withdrawal is
  'F-M2. Historical record of legacy withdrawals — never a live withdrawal, never a balance, never a ledger source. Append-only. Bank details are refused (L-3); only a redacted form may be kept, under fields->destination_account_redacted.';
comment on column migration.legacy_withdrawal.original_status is
  'Verbatim legacy status (approved | success | rejected). Per F-L5, approved and success mean the same terminal paid outcome; the word is never rewritten.';

alter table migration.legacy_withdrawal enable row level security;
alter table migration.legacy_withdrawal force row level security;

create policy legacy_withdrawal_deny_client_access
  on migration.legacy_withdrawal for select to authenticated using (false);

revoke all on migration.legacy_withdrawal from public, anon, authenticated, service_role;

create trigger legacy_withdrawal_no_update
  before update on migration.legacy_withdrawal
  for each row execute function app.block_row_mutation();
create trigger legacy_withdrawal_no_delete
  before delete on migration.legacy_withdrawal
  for each row execute function app.block_row_mutation();
