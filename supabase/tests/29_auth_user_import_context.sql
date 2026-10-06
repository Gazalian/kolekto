-- ─────────────────────────────────────────────────────────────────────────────
-- 29 — The sign-up trigger, and how an import switches it off for its own rows
--
-- Coverage for 20260928120700_auth_user_import_context.sql. Decision:
-- docs/migration/IMPORT-FOUNDATIONS-REPORT.md §7.
--
-- app.handle_new_auth_user fires AFTER INSERT on every auth.users row and makes a
-- public.users row, a personal community and an owner term (COM-01). For a real
-- sign-up that is exactly right. For 623 imported users it is wrong three ways:
-- the name and phone come from auth metadata rather than the legacy profile
-- (F-M1), the owner term says 'created' rather than 'migration', and nothing
-- records that the import made them — while correcting any of it afterwards
-- would need UPDATE, which the importer does not have.
--
-- So an import declares itself, per transaction: set_config('kolekto.import_run_id',
-- <id of a RUNNING run>, true). Then, and only then, the trigger stands aside and
-- the importer creates those three rows itself.
--
-- Part 1 characterises today's behaviour and must hold before and after.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(14);

-- ── Part 1 — ordinary sign-up, unchanged ─────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('6a000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'signup.one@example.test', '{"full_name":"Signup One"}');

select is(
  (select full_name from public.users where id = '6a000000-0000-4000-8000-000000000001'),
  'Signup One',
  'sign-up: a public.users row is created, named from auth metadata'
);
select is(
  (select count(*)::integer from public.communities
   where created_by = '6a000000-0000-4000-8000-000000000001' and is_personal),
  1,
  'sign-up: exactly one personal community is created (COM-01)'
);
select is(
  (select start_reason::text from public.officer_terms ot
   join public.communities c on c.id = ot.community_id
   where ot.user_id = '6a000000-0000-4000-8000-000000000001' and c.is_personal and ot.role = 'owner'),
  'created',
  'sign-up: the owner term records start_reason ''created'''
);

-- No name in metadata: the email's local part is the placeholder.
insert into auth.users (id, instance_id, aud, role, email) values
  ('6a000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'noname.two@example.test');
select is(
  (select full_name from public.users where id = '6a000000-0000-4000-8000-000000000002'),
  'noname.two',
  'sign-up with no name: the placeholder is the email''s local part'
);


-- ── Part 2 — an import run declares its context ──────────────────────────────
insert into migration.import_runs (id, source_project, source_snapshot_label) values
  ('6b000000-0000-4000-8000-000000000001', 'synthetic:auth-context', 'test-snapshot');

select set_config('kolekto.import_run_id', '6b000000-0000-4000-8000-000000000001', true);

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('6a000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'imported.three@example.test', '{"full_name":"From Metadata"}');

select is(
  (select count(*)::integer from public.users where id = '6a000000-0000-4000-8000-000000000003'),
  0,
  'import context: the trigger creates no public.users row'
);
select is(
  (select count(*)::integer from public.communities where created_by = '6a000000-0000-4000-8000-000000000003'),
  0,
  'import context: the trigger creates no personal community'
);
select is(
  (select count(*)::integer from public.officer_terms where user_id = '6a000000-0000-4000-8000-000000000003'),
  0,
  'import context: the trigger creates no owner term'
);
select ok(
  exists (select 1 from auth.users where id = '6a000000-0000-4000-8000-000000000003'),
  'import context: the auth.users row itself is inserted, UUID as given'
);

-- The context is transaction-scoped: clearing it restores ordinary behaviour at once.
select set_config('kolekto.import_run_id', '', true);
insert into auth.users (id, instance_id, aud, role, email) values
  ('6a000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'after.context@example.test');
select is(
  (select count(*)::integer from public.communities where created_by = '6a000000-0000-4000-8000-000000000004' and is_personal),
  1,
  'context cleared: the next sign-up gets its personal community as usual'
);


-- ── Part 3 — a context that is not a running run is refused, never ignored ───
-- Silently falling back to ordinary behaviour here would create exactly the
-- uncontrolled objects the context exists to prevent.
select set_config('kolekto.import_run_id', '6b000000-0000-4000-8000-0000000000ff', true);
select throws_like(
  $$ insert into auth.users (id, instance_id, aud, role, email) values
       ('6a000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'no.such.run@example.test') $$,
  '%IMPORT_CONTEXT_INVALID%',
  'a context naming no import run is refused'
);

select set_config('kolekto.import_run_id', 'not-a-uuid', true);
select throws_like(
  $$ insert into auth.users (id, instance_id, aud, role, email) values
       ('6a000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'malformed@example.test') $$,
  '%IMPORT_CONTEXT_INVALID%',
  'a malformed context is refused'
);

-- A finished run cannot be used to switch the trigger off.
select set_config('kolekto.import_run_id', '', true);
update migration.import_runs set status = 'completed', completed_at = now()
where id = '6b000000-0000-4000-8000-000000000001';
select set_config('kolekto.import_run_id', '6b000000-0000-4000-8000-000000000001', true);
select throws_like(
  $$ insert into auth.users (id, instance_id, aud, role, email) values
       ('6a000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'finished.run@example.test') $$,
  '%IMPORT_CONTEXT_INVALID%',
  'a completed run cannot be used as an import context'
);
select set_config('kolekto.import_run_id', '', true);


-- ── Part 4 — the context is not reachable from a client role ─────────────────
-- An authenticated caller cannot insert into auth.users at all, so it cannot
-- use the context — and cannot open an import run to point one at.
set local role authenticated;
set local request.jwt.claims = '{"sub":"6a000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$ insert into migration.import_runs (source_project, source_snapshot_label)
     values ('synthetic:spoof', 'x') $$,
  '42501', null,
  'a signed-in user cannot open an import run'
);
select throws_ok(
  $$ insert into auth.users (id, instance_id, aud, role, email) values
       ('6a000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'client.insert@example.test') $$,
  '42501', null,
  'a signed-in user cannot insert into auth.users'
);
reset role;

select * from finish();
rollback;
