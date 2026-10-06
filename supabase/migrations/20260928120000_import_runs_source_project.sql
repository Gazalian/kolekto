-- ─────────────────────────────────────────────────────────────────────────────
-- 20260928120000 — Every import run names its source project (E-P1)
--
-- Import Foundations milestone. docs/migration/IMPORT-FOUNDATIONS-REPORT.md.
--
-- A run already recorded WHICH SNAPSHOT it read (source_snapshot_label) but not
-- WHICH PROJECT that snapshot came from. Rehearsals will be run against synthetic
-- data, then against legacy production's backup, into databases that may be
-- compared side by side — and without this column a rehearsal row and a real row
-- are indistinguishable.
--
-- The value is constrained, not free text. An unrecognised source is refused
-- rather than recorded, so a run cannot be ambiguous about where its rows came
-- from. A genuinely new source means a migration that extends the list, which is
-- the decision being made on the record.
--
--   legacy-production:busfgcmbndleljklrcbd   the legacy live project (via the
--                                            verified D1 backup — never the
--                                            live database)
--   legacy-test:lpeeckqsltxohppheucz         the legacy test project (F-L6: not
--                                            production customer history)
--   synthetic:<label>                        generated data, e.g. synthetic:volume-1
--
-- import_runs has 0 rows in every environment at this point, so NOT NULL is safe.
--
-- It also stops a run being rewritten after the fact. A run is the anchor every
-- imported row's provenance points at: which project, which snapshot, when. Those
-- must not change once rows reference them, and a finished run must not change at
-- all. The lifecycle itself — running → completed | failed | rolled_back — stays
-- updatable, because that is what the status column is for.
-- ─────────────────────────────────────────────────────────────────────────────

alter table migration.import_runs
  add column source_project text not null;

alter table migration.import_runs
  add constraint import_runs_source_project_known check (
    source_project in (
      'legacy-production:busfgcmbndleljklrcbd',
      'legacy-test:lpeeckqsltxohppheucz'
    )
    or source_project ~ '^synthetic:[a-z0-9][a-z0-9-]{0,39}$'
  );

-- A composite key other tables can reference, so a row's own source_project is
-- guaranteed to equal its run's — by a foreign key, not by a trigger or by trust.
alter table migration.import_runs
  add constraint import_runs_id_source_project_key unique (id, source_project);

comment on column migration.import_runs.source_project is
  'Which project the run''s snapshot came from. Constrained: legacy-production:<ref>, legacy-test:<ref>, or synthetic:<label>. Never ambiguous.';

-- The table comment used to say a run is "reversible (delete by import_run_id)".
-- That predates M9 (20260918130700), which made imported history append-only:
-- a correction is a new run, never an edit or a delete. Rollback is discarding a
-- rehearsal target, or PITR for a real run (migration-runbook.md §5).
comment on table migration.import_runs is
  'One row per migration pipeline execution. import_run_id on every imported row references this, which is what makes a run identifiable. Imported history is append-only: a wrong run is corrected by a new run with corrected provenance, never by editing or deleting the old one. Rollback is discarding a rehearsal target, or PITR for a real run (migration-runbook.md section 5).';


-- ── Guard: a run's identity is fixed; a finished run is frozen ───────────────
create or replace function app.guard_import_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMPORT_RUN_IS_PERMANENT: import run % cannot be deleted', old.id
      using errcode = 'P0001',
            hint = 'Imported rows reference their run for provenance. A wrong run is superseded by a new one, never removed.';
  end if;

  if old.status <> 'running' then
    raise exception 'IMPORT_RUN_IS_FINISHED: import run % is % and cannot change', old.id, old.status
      using errcode = 'P0001';
  end if;

  if new.id                    is distinct from old.id
  or new.source_project        is distinct from old.source_project
  or new.source_system         is distinct from old.source_system
  or new.source_snapshot_label is distinct from old.source_snapshot_label
  or new.started_at            is distinct from old.started_at
  or new.created_by            is distinct from old.created_by then
    raise exception 'IMPORT_RUN_IDENTITY_IS_FIXED: import run % may only change its status, completed_at and notes', old.id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function app.guard_import_run() from public, anon, authenticated;

create trigger import_runs_guard
  before update or delete on migration.import_runs
  for each row execute function app.guard_import_run();
