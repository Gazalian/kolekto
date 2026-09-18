-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918130700 — Phase 1.5 / M9: imported-row immutability
--
-- Migration Architecture section 8 and section 15 (M9): "a new row describing
-- the correction, never an edit to the original." Enforced by the database,
-- reusable for the Phase 3 financial tables the architecture document's M10
-- describes (contributions, transactions, withdrawals — none of which exist
-- yet; ADR 0006).
--
-- Two functions, not one, because the two things being made immutable are not
-- the same kind of thing:
--
--   app.enforce_imported_row_immutability() — CONDITIONAL. Attached to tables
--   that hold both application-created and imported rows in the same table
--   (public.collections, public.members today). Blocks UPDATE/DELETE only
--   where OLD.is_imported = true. An ordinary, non-imported row updates and
--   deletes exactly as Phase 1 already allows.
--
--   app.block_row_mutation() — UNCONDITIONAL. Attached to tables where every
--   row is, by definition, a preserved historical record
--   (migration.unattributed_payments today). No is_imported column to check;
--   the whole table is append-only. Same shape as the existing
--   app.block_audit_mutation() in 20260917120900_audit_log.sql, generalised so
--   a second copy of the same four lines does not appear every time a new
--   append-only table is added.
--
-- ── The trust boundary, stated precisely ────────────────────────────────────
--
-- These are BEFORE UPDATE / BEFORE DELETE triggers. Postgres fires a
-- row-level trigger for every UPDATE or DELETE against the row it is attached
-- to, regardless of which role issued the statement and regardless of
-- SECURITY DEFINER. This is NOT the same mechanism as row-level security:
-- `service_role`'s BYPASSRLS attribute skips RLS POLICY evaluation, but it
-- does not skip trigger execution — a trigger is part of the table's own
-- definition, not a policy. So:
--
--   · A server function, however it is written, cannot silently bypass this.
--     A SECURITY DEFINER function runs with the DEFINER's privileges, but the
--     UPDATE or DELETE statement it issues still fires the table's triggers —
--     definer privilege changes who is allowed to attempt the write, not
--     whether the write's own triggers run.
--   · The `service_role` connection used by server-side application code and
--     by Postgres functions cannot bypass this either, for the same reason.
--   · `insert ... on conflict (source_table, source_id) do nothing` — the
--     idempotent transform pattern from M4 — never triggers this at all,
--     because DO NOTHING never touches the existing row: no UPDATE is issued,
--     so no BEFORE UPDATE trigger fires. This is proven, not assumed — see
--     06_migration_provenance.sql in the test suite.
--   · The only roles that CAN bypass a trigger are the ones with privilege to
--     run `ALTER TABLE ... DISABLE TRIGGER`, or a session that has run `SET
--     session_replication_role = replica`. Both require table-owner or
--     superuser privilege. No application role — authenticated, anon or
--     service_role — holds that privilege in a Supabase project; only a human
--     with direct database administrator access does, through the Supabase
--     dashboard SQL editor or an equivalent superuser connection, which is
--     exactly the reviewed, deliberate, human-approved path the Migration
--     Architecture document already describes for a genuine correction (its
--     section 8: "a new row describing the correction, never an edit to the
--     original" — and if a literal edit is ever truly unavoidable, it is a
--     DBA action outside the application, not something any code path
--     reaches by accident).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.enforce_imported_row_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_imported then
    raise exception
      'IMPORTED_ROW_IS_IMMUTABLE: % row % is imported (source %.%) and cannot be %',
      tg_table_name, old.id, old.source_table, old.source_id, lower(tg_op)
      using errcode = 'P0001',
            hint = 'Historical records from the old Kolekto platform are preserved as imported. A correction is a new row or an annotation, never an edit to the original (Migration Architecture section 8).';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function app.enforce_imported_row_immutability() is
  'M9: blocks UPDATE and DELETE on any row where is_imported = true. Fires for every role including service_role — see this migration''s header for the exact trust boundary. Attached to collections and members here; reusable for the Phase 3 money tables without modification.';

create trigger collections_imported_immutable
  before update or delete on public.collections
  for each row execute function app.enforce_imported_row_immutability();

create trigger members_imported_immutable
  before update or delete on public.members
  for each row execute function app.enforce_imported_row_immutability();


-- ── Unconditional immutability, for tables that are entirely historical ─────
create or replace function app.block_row_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    '% IS APPEND-ONLY: row in % cannot be %',
    upper(tg_table_name), tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A correction is a new row describing the correction, never an edit to the original.';
  return null;
end;
$$;

comment on function app.block_row_mutation() is
  'Generic append-only guard: unconditional UPDATE/DELETE block for tables where every row is a preserved record by definition. Same shape as app.block_audit_mutation (20260917120900_audit_log.sql), generalised so it can be reused instead of copied. Fires for every role, per the same trust boundary as app.enforce_imported_row_immutability() above.';

create trigger unattributed_payments_no_update
  before update on migration.unattributed_payments
  for each row execute function app.block_row_mutation();

create trigger unattributed_payments_no_delete
  before delete on migration.unattributed_payments
  for each row execute function app.block_row_mutation();
