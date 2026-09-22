-- ─────────────────────────────────────────────────────────────────────────────
-- 17 — Who may run a collection (M7.6 hardening, items 8 and 9)
--
-- The three M7.6 operations that disclose or change something an outsider
-- should not reach: taking member data out of the system, setting the
-- reference format, and working a door. Each is checked twice — once as the
-- role matrix, which is what the UI mirrors, and once as the function
-- refusing a caller who does not hold it, which is what actually decides.
--
-- Plus the isolation the whole milestone rests on: a reference belongs to one
-- collection inside one community, and neither another community's officer
-- nor another collection's query can reach it.
--
-- Written as pgTAP rather than as a second browser session because the
-- question is "does the database refuse this?", and a browser can only
-- observe that a screen did not offer it — which is a different and much
-- weaker statement.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(28);

-- ── The role matrix, as data ────────────────────────────────────────────────
--
-- RPT-06: taking member personal data out of the system is not a read. A
-- viewer can see members on screen and cannot export them.

select bag_eq(
  $$ select role::text from public.role_permissions where permission = 'member.export' $$,
  $$ values ('owner'), ('admin'), ('treasurer') $$,
  'member.export is held by owner, admin and treasurer — not collector, not viewer (RPT-06)'
);

select bag_eq(
  $$ select role::text from public.role_permissions where permission = 'collection.configure_codes' $$,
  $$ values ('owner'), ('admin') $$,
  'setting the reference format is an owner or admin decision (M7.6 part X)'
);

select bag_eq(
  $$ select role::text from public.role_permissions where permission = 'attendance.check_in' $$,
  $$ values ('owner'), ('admin'), ('treasurer'), ('collector') $$,
  'working a door is open to the field-agent role as well as the officers — a viewer cannot'
);

select is(
  (select scoped from public.role_permissions
   where role = 'collector' and permission = 'attendance.check_in'),
  true,
  'ROLE-06: a collector holds check-in only inside their assigned scope'
);

select is(
  (select scoped from public.role_permissions
   where role = 'owner' and permission = 'collection.configure_codes'),
  false,
  'an owner holds it across the community, unscoped'
);


-- ── Fixtures: two communities, five roles ───────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('d1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@ops.example.test');

insert into public.users (id, full_name, email) values
  ('d1000000-0000-4000-8000-000000000001', 'Ops Owner',     'owner@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000002', 'Ops Admin',     'admin@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000003', 'Ops Collector', 'collector@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000004', 'Ops Viewer',    'viewer@ops.example.test'),
  ('d1000000-0000-4000-8000-000000000005', 'Ops Outsider',  'outsider@ops.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('d2000000-0000-4000-8000-00000000000a', 'ops-tests',       'Ops Tests',  'social_group', false, 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-00000000000b', 'ops-tests-other', 'Other Ops',  'social_group', false, 'd1000000-0000-4000-8000-000000000005');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('d2000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000001', 'owner',     'Ops Owner',     'created'),
  ('d2000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000002', 'admin',     'Ops Admin',     'invited'),
  ('d2000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000003', 'collector', 'Ops Collector', 'invited'),
  ('d2000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000004', 'viewer',    'Ops Viewer',    'invited'),
  ('d2000000-0000-4000-8000-00000000000b', 'd1000000-0000-4000-8000-000000000005', 'owner',     'Ops Outsider',  'created');

insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-00000000000a', 'Ẹniọlá Adéṣínà', '+2348095550001', 'OP/0001', 'active', 'manual'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-00000000000a', 'Ngọzị Okoro',    '+2348095550002', 'OP/0002', 'active', 'manual');

set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table tmp_gala as
  select app.create_collection(
    'd2000000-0000-4000-8000-00000000000a', 'Ops Gala', 'event', 'managed', 'fixed',
    null, 'full_only', 'one_time', 750000
  ) as id;

-- A second collection in the SAME community, to prove a reference belongs to
-- one collection rather than to the community that owns it.
create temporary table tmp_levy as
  select app.create_collection(
    'd2000000-0000-4000-8000-00000000000a', 'Ops Levy', 'dues', 'managed', 'fixed',
    null, 'full_only', 'one_time', 250000
  ) as id;

select lives_ok(
  $f$ select app.set_collection_code_settings((select id from tmp_gala), true, 'OPS', '-', 4::smallint, 1::bigint, 'sequential') $f$,
  'the owner sets the gala''s reference format'
);

select lives_ok(
  $f$ select app.set_collection_code_settings((select id from tmp_levy), true, 'LEV', '-', 4::smallint, 1::bigint, 'sequential') $f$,
  'and the levy''s, which is a different series in the same community'
);

select is(
  app.assign_obligations(
    (select id from tmp_gala),
    array['d3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000002']::uuid[],
    null, null
  ),
  2,
  'two members go on the gala'
);

select is(
  app.assign_obligations(
    (select id from tmp_levy), array['d3000000-0000-4000-8000-000000000001']::uuid[], null, null
  ),
  1,
  'one of them is also on the levy'
);

reset role;
grant select on tmp_gala, tmp_levy to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Isolation: a reference belongs to ONE collection
-- ─────────────────────────────────────────────────────────────────────────────

select bag_eq(
  $$ select reference from public.contributor_references where collection_id = (select id from tmp_gala) $$,
  $$ values ('OPS-0001'), ('OPS-0002') $$,
  'the gala''s references are the gala''s'
);

select bag_eq(
  $$ select reference from public.contributor_references where collection_id = (select id from tmp_levy) $$,
  $$ values ('LEV-0001') $$,
  'and the levy''s are its own — the same member holds a different reference in each (part M)'
);

select is(
  (select count(distinct reference)::integer from public.contributor_references
   where community_id = 'd2000000-0000-4000-8000-00000000000a'),
  3,
  'three distinct references across the two collections, none shared'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Exporting: member.export, checked by the function
-- ─────────────────────────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}';

select lives_ok(
  $f$ select app.record_collection_export((select id from tmp_gala), 'roll', 'csv', 2, array['full_name','reference']) $f$,
  'an admin may export, and the disclosure is recorded'
);

select is(
  (select (after_state ->> 'fields')::jsonb from public.audit_logs
   where action = 'collection.export_created' and object_id = (select id from tmp_gala)
   order by created_at desc limit 1),
  '["full_name", "reference"]'::jsonb,
  'the audit row names the COLUMNS that left'
);

select is(
  (select after_state ? 'value' or after_state ? 'rows' from public.audit_logs
   where action = 'collection.export_created' and object_id = (select id from tmp_gala)
   order by created_at desc limit 1),
  false,
  'and carries no value out of any row — an audit of an export is not a second copy of it (SEC-26)'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}';

select throws_ok(
  $f$ select app.record_collection_export((select id from tmp_gala), 'roll', 'csv', 2, array['full_name']) $f$,
  '42501',
  null,
  'a viewer cannot export member data, whatever the screen offers'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $f$ select app.record_collection_export((select id from tmp_gala), 'roll', 'csv', 2, array['full_name']) $f$,
  '42501',
  null,
  'and neither can a collector'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- The door: attendance.check_in
-- ─────────────────────────────────────────────────────────────────────────────

create temporary table tmp_guest as
  select id from public.obligations
  where collection_id = (select id from tmp_gala)
    and member_id = 'd3000000-0000-4000-8000-000000000001';
grant select on tmp_guest to authenticated;

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}';

select lives_ok(
  $f$ select app.check_in_obligation((select id from tmp_guest)) $f$,
  'a collector may work the door — that is what the role is for'
);

select lives_ok(
  $f$ select * from app.collection_door_totals((select id from tmp_gala)) $f$,
  'and may read the door''s counters'
);

select is(
  (select inside from app.collection_door_totals((select id from tmp_gala))),
  1,
  'one person inside'
);

select is(
  (select not_arrived from app.collection_door_totals((select id from tmp_gala))),
  1,
  'and one who has not arrived — counted over a visit history, not over a flag'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}';

select throws_ok(
  $f$ select app.check_in_obligation((select id from tmp_guest)) $f$,
  '42501',
  null,
  'a viewer cannot admit anybody'
);

select throws_ok(
  $f$ select * from app.collection_door_totals((select id from tmp_gala)) $f$,
  '42501',
  null,
  'nor read the door''s counters, which are about who turned up'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Another community's owner reaches none of it (SEC-18)
-- ─────────────────────────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';

select throws_ok(
  $f$ select app.record_collection_export((select id from tmp_gala), 'roll', 'csv', 2, array['full_name']) $f$,
  '42501',
  null,
  'an outsider cannot export this community''s collection'
);

select throws_ok(
  $f$ select app.set_collection_code_settings((select id from tmp_gala), true, 'HACK', '-', 4::smallint, 1::bigint, 'sequential') $f$,
  '42501',
  null,
  'nor change its reference format'
);

select throws_ok(
  $f$ select app.check_in_obligation((select id from tmp_guest)) $f$,
  '42501',
  null,
  'nor admit one of its guests'
);

select is_empty(
  $$ select reference from public.contributor_references
     where community_id = 'd2000000-0000-4000-8000-00000000000a' $$,
  'and cannot read a single one of its references'
);

select is_empty(
  $$ select id from public.obligations where collection_id = (select id from tmp_gala) $$,
  'nor a single row of its roll — which is what the paged roll query is filtered by'
);

reset role;

select * from finish();
rollback;
