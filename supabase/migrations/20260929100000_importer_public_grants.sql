-- ─────────────────────────────────────────────────────────────────────────────
-- 20260929100000 — Importer grants and RLS on the public destinations
--
-- Import Foundations §5 named this migration as the last thing before the
-- importer. Every insert lands only into a RUNNING import run, checked from
-- kolekto.import_run_id — the same GUC the auth import context reads in
-- 20260928120700. The importer role stays NOLOGIN, NOBYPASSRLS.
--
-- The nine destinations, and what each policy asks for:
--
--   users, communities, officer_terms
--     A running run must be set. Nothing else — these are live-domain tables
--     without provenance columns; the audit trail is imported_objects.
--
--   collections, members
--     A running run must be set AND is_imported must be true. Provenance is
--     stored in the row itself, and imports never create non-imported rows.
--
--   collection_tiers, collection_fields, collection_code_sequences, legacy_links
--     A running run must be set. Idempotency is enforced by the unique
--     indexes each table already carries; the importer uses ON CONFLICT DO
--     NOTHING to make re-import a no-op.
--
-- No UPDATE, no DELETE, no TRUNCATE, no TRIGGER, no REFERENCES. The four
-- validation and derivation triggers (assert_tier_is_consistent,
-- derive_collection_audience_mode, set_updated_at, enforce_imported_row_immutability)
-- fire on every role and do not read the invoking role, so they behave the
-- same under kolekto_importer.
--
-- app functions granted to the importer:
--   app.uuid_generate_v7()             — id defaults (already granted, kept)
--   app.generate_unique_collection_slug — resolving collision on re-import
--   app.generate_unique_community_slug  — same
--
-- Anything requiring the caller to be authenticated (permission checks,
-- has_permission, current_user_id) stays unreachable — the importer never
-- calls a SECURITY DEFINER write function; it inserts into the tables directly
-- under this policy.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.is_running_import_context()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ctx text := nullif(current_setting('kolekto.import_run_id', true), '');
begin
  if v_ctx is null then return false; end if;
  if v_ctx !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return exists (
    select 1 from migration.import_runs r
    where r.id = v_ctx::uuid and r.status = 'running'
  );
end;
$$;

comment on function app.is_running_import_context() is
  'True iff kolekto.import_run_id names a RUNNING migration.import_runs row. Used by every importer INSERT policy to gate writes on an open import context. Malformed or finished contexts return false — never raise.';

revoke execute on function app.is_running_import_context() from public, anon, authenticated;
grant execute on function app.is_running_import_context() to kolekto_importer;
grant execute on function app.generate_unique_collection_slug(uuid, text) to kolekto_importer;
grant execute on function app.generate_unique_community_slug(text) to kolekto_importer;


-- ── Live-domain, no provenance columns ──────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['users', 'communities', 'officer_terms',
                            'collection_tiers', 'collection_fields', 'collection_code_sequences',
                            'legacy_links']
  loop
    execute format('grant select, insert on public.%I to kolekto_importer', t);
    execute format('create policy %I on public.%I for select to kolekto_importer using (true)', t || '_importer_select', t);
    execute format('create policy %I on public.%I for insert to kolekto_importer with check (app.is_running_import_context())',
                   t || '_importer_insert', t);
  end loop;
end;
$$;


-- ── Provenance-bearing: collections and members ─────────────────────────────
grant select, insert on public.collections to kolekto_importer;
create policy collections_importer_select on public.collections
  for select to kolekto_importer using (true);
create policy collections_importer_insert on public.collections
  for insert to kolekto_importer
  with check (app.is_running_import_context() and is_imported = true);

grant select, insert on public.members to kolekto_importer;
create policy members_importer_select on public.members
  for select to kolekto_importer using (true);
create policy members_importer_insert on public.members
  for insert to kolekto_importer
  with check (app.is_running_import_context() and is_imported = true);


-- ── auth.users, auth.identities: NOT granted here ───────────────────────────
-- The `auth` schema is platform-owned. Local rehearsal inserts into auth.users
-- run as the orchestrating connection (the container owner), which is what
-- the sign-up trigger's import context (20260928120700) also expects.
-- Granting a client role INSERT on auth.users is a Supabase platform decision
-- outside this codebase, and it is not needed for a local rehearsal.
