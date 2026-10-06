-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120600 — kolekto_importer: the one role that may write imported history
--
-- Import Foundations, Phase 6. Decision: docs/migration/SERVICE-ROLE-PRIVILEGE-DECISION.md §5,
-- privilege matrix: docs/migration/IMPORT-FOUNDATIONS-REPORT.md §5.
--
-- WHY A DEDICATED ROLE. service_role holds nothing on application tables (F-1,
-- final), cannot log in, and is the credential the web server carries for
-- Storage. The importer needs a narrow, named identity whose every privilege is
-- on the record.
--
-- THE SHAPE
--   · NOLOGIN. There is no credential for it and this migration creates none.
--     The migration connection (the database owner, locally `postgres`) enters it
--     with `SET ROLE kolekto_importer` for the writes and leaves it with
--     `RESET ROLE`. The same pattern packages/db uses for `authenticated`.
--   · NOBYPASSRLS. Every destination table forces RLS; the importer passes it
--     through explicit policies written for it — visible, testable and
--     conditional — rather than by being exempt from all of them.
--   · INSERT and SELECT only. No UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER,
--     anywhere. History is append-only for every role anyway; this role cannot
--     even attempt the rest.
--   · Function EXECUTE on exactly one application function: app.uuid_generate_v7,
--     because it is every table's id default and runs with the caller's rights.
--     Trigger functions fire without an EXECUTE check, so none is needed for them.
--
-- WHAT THIS MIGRATION GRANTS — the migration schema only:
--     import_runs (a run starts as `running`), the six history tables, the
--     overflow store and the provenance registry.
--
-- WHAT IT DELIBERATELY DOES NOT GRANT YET — the public-schema destinations
-- (users, communities, officer_terms, collections, members, collection_tiers,
-- collection_fields, collection_code_sequences, legacy_links) and auth.users /
-- auth.identities. Their exact privileges depend on which triggers fire on an
-- imported insert and what those triggers read as the invoking role — which can
-- only be tested against real transform output. They are specified in the
-- report's matrix and land with the importer, each with its own test. Granting
-- them now, untested, would be granting on a guess.
--
-- THE RUN LIFECYCLE is not the importer's. It may open a run (insert, status
-- 'running') and write rows into an open run. Moving a run to completed / failed
-- / rolled_back is an UPDATE, done by the orchestrating connection as itself.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kolekto_importer') then
    create role kolekto_importer nologin noinherit nobypassrls nocreatedb nocreaterole;
  end if;
end;
$$;

comment on role kolekto_importer is
  'Migration importer. NOLOGIN — entered only by SET ROLE from the migration connection. INSERT/SELECT on migration.* only; no UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES. Passes RLS through explicit policies, never BYPASSRLS. See docs/migration/IMPORT-FOUNDATIONS-REPORT.md §5.';

-- The SET ROLE path. INHERIT FALSE: the owner does not silently gain the role's
-- privileges — it must switch to it, visibly.
grant kolekto_importer to postgres with inherit false, set true;

grant usage on schema migration  to kolekto_importer;
grant usage on schema app        to kolekto_importer;
grant usage on schema extensions to kolekto_importer;
grant execute on function app.uuid_generate_v7() to kolekto_importer;


-- ── import_runs: may open a run; may read runs ───────────────────────────────
grant select, insert on migration.import_runs to kolekto_importer;

create policy import_runs_importer_select
  on migration.import_runs for select to kolekto_importer using (true);
create policy import_runs_importer_open
  on migration.import_runs for insert to kolekto_importer
  with check (status = 'running' and completed_at is null);


-- ── History, overflow and registry: rows only into an OPEN run ───────────────
-- The check is the RLS strategy: a row lands only if its run exists and is still
-- running. A finished, failed or rolled-back run accepts nothing more.
do $$
declare
  t text;
begin
  foreach t in array array[
    'legacy_profile', 'legacy_collection', 'legacy_contribution', 'legacy_deposit',
    'unattributed_payments', 'legacy_withdrawal', 'legacy_overflow', 'imported_objects'
  ]
  loop
    execute format('grant select, insert on migration.%I to kolekto_importer', t);

    execute format(
      'create policy %I on migration.%I for select to kolekto_importer using (true)',
      t || '_importer_select', t
    );
    execute format(
      'create policy %I on migration.%I for insert to kolekto_importer
         with check (exists (
           select 1 from migration.import_runs r
           where r.id = import_run_id and r.status = ''running''
         ))',
      t || '_importer_insert', t
    );
  end loop;
end;
$$;
