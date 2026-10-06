-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120500 — TRUNCATE cannot empty append-only or immutable tables (F-4)
--
-- Finding F-4, docs/migration/SERVICE-ROLE-PRIVILEGE-DECISION.md §4.
--
-- Every append-only table protects itself with BEFORE UPDATE / BEFORE DELETE
-- *row* triggers. TRUNCATE fires no row triggers — it does not visit rows — so
-- a single `truncate public.ledger_entries` would empty the ledger that no UPDATE
-- or DELETE can touch. The table owner (`postgres`, the role SUPABASE_DB_URL
-- connects as) holds TRUNCATE by ownership, so revoking a grant cannot close this.
-- A statement-level BEFORE TRUNCATE trigger can: it is part of the table, fires
-- for every role, owner included, and fires on every table a
-- `truncate … cascade` reaches.
--
-- Only removing the trigger (ALTER TABLE … DISABLE TRIGGER, or
-- session_replication_role = replica) gets past it, and both need owner or
-- superuser rights — the same reviewed, deliberate DBA path the architecture
-- already names for any genuine correction (20260918130700's header).
--
-- WHICH TABLES — taken from the existing classification, not invented:
--
--   unconditionally append-only (UPDATE and DELETE already refused on every row)
--     ledger_accounts, ledger_journals, ledger_entries,
--     financial_events, financial_event_processing_attempts,
--     financial_operation_claims, audit_logs,
--     fee_schedules, fee_schedule_category_rates,
--     withdrawal_fee_schedules, withdrawal_fee_brackets
--
--   conditionally immutable (some rows refuse UPDATE/DELETE, so emptying the
--   table would destroy exactly those rows)
--     collections, members           — imported rows (M9)
--     contributor_references         — issued references
--
--   every migration.* table — imported history and its anchors
--     import_runs, legacy_profile, legacy_collection, legacy_contribution,
--     legacy_deposit, unattributed_payments, legacy_withdrawal,
--     legacy_overflow, imported_objects
--
-- Not included: obligations — its trigger validates paid status; it is not an
-- immutability rule. No application path issues TRUNCATE on any table, so this
-- removes no behaviour.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.block_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'TRUNCATE_REFUSED: %.% is append-only or holds immutable history and cannot be truncated',
    tg_table_schema, tg_table_name
    using errcode = 'P0001',
          hint = 'Nothing in Kolekto empties these tables. A correction is a new row describing the correction, never removal of the original.';
end;
$$;

comment on function app.block_truncate() is
  'F-4: statement-level BEFORE TRUNCATE guard for append-only and immutable tables. Fires for every role, including the table owner.';

revoke execute on function app.block_truncate() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'public.ledger_accounts', 'public.ledger_journals', 'public.ledger_entries',
    'public.financial_events', 'public.financial_event_processing_attempts',
    'public.financial_operation_claims', 'public.audit_logs',
    'public.fee_schedules', 'public.fee_schedule_category_rates',
    'public.withdrawal_fee_schedules', 'public.withdrawal_fee_brackets',
    'public.collections', 'public.members', 'public.contributor_references',
    'migration.import_runs', 'migration.legacy_profile', 'migration.legacy_collection',
    'migration.legacy_contribution', 'migration.legacy_deposit',
    'migration.unattributed_payments', 'migration.legacy_withdrawal',
    'migration.legacy_overflow', 'migration.imported_objects'
  ]
  loop
    execute format(
      'create trigger %I before truncate on %s for each statement execute function app.block_truncate()',
      split_part(t, '.', 2) || '_no_truncate', t
    );
  end loop;
end;
$$;
