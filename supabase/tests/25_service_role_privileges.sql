-- ─────────────────────────────────────────────────────────────────────────────
-- 25 — service_role holds nothing on application tables
--
-- Coverage for 20260928110000_service_role_no_application_table_privileges.sql
-- (finding F-1, docs/migration/SERVICE-ROLE-PRIVILEGE-DECISION.md).
--
-- The service-role key is held by the web server for Storage uploads and by
-- nothing else. It bypasses RLS. Any table privilege it carries is therefore a
-- privilege every holder of that key has over every row. None is used.
--
-- Before this file, no test asserted anything about service_role, which is how
-- the hosted project's default privileges gave it full read/write on every table
-- while the local stack gave it almost none — and every suite still passed.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, pg_catalog;
select plan(7);

-- Every privilege a table can carry, checked on every table and view in the
-- application schemas. has_table_privilege, not information_schema, so a grant
-- arriving by any route — direct, PUBLIC, role membership — is counted.
select is(
  (select count(*)::integer
   from pg_class c
   cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv
   where c.relkind in ('r','p','v','m')
     and c.relnamespace::regnamespace::text in ('public','app','private','migration')
     and has_table_privilege('service_role', c.oid, priv)),
  0,
  'service_role holds no table privilege on any application table or view'
);

-- The ones that matter most, named, so a failure says what is exposed.
select is(
  (select count(*)::integer
   from unnest(array['public.ledger_entries','public.ledger_journals','public.ledger_accounts',
                     'public.financial_events','public.financial_event_processing_attempts',
                     'public.financial_operation_claims','public.fee_schedules','public.audit_logs']) as t
   where has_table_privilege('service_role', t::regclass, 'INSERT')
      or has_table_privilege('service_role', t::regclass, 'SELECT')),
  0,
  'service_role can neither read nor insert into the ledger, financial events, fee schedules or audit log'
);

select is(
  (select count(*)::integer
   from unnest(array['public.ledger_entries','public.ledger_journals','public.financial_events',
                     'public.audit_logs','migration.unattributed_payments']) as t
   where has_table_privilege('service_role', t::regclass, 'TRUNCATE')),
  0,
  'service_role cannot TRUNCATE append-only history'
);

select is(
  -- CASE, not AND: the planner may evaluate WHERE terms in any order, and
  -- has_sequence_privilege raises on a relation that is not a sequence.
  (select count(*)::integer from pg_class c
   where c.relnamespace::regnamespace::text in ('public','app','private','migration')
     and case when c.relkind = 'S'
              then has_sequence_privilege('service_role', c.oid, 'USAGE,SELECT,UPDATE')
              else false end),
  0,
  'service_role holds no privilege on any application sequence'
);

select is(
  (select count(*)::integer from pg_proc p
   where p.pronamespace::regnamespace::text in ('public','app','private','migration')
     and has_function_privilege('service_role', p.oid, 'EXECUTE')),
  0,
  'service_role can execute no application function'
);

-- The drift came from default privileges, so the defaults are pinned too: a
-- table created by a future migration must not arrive already granted.
select is(
  (select count(*)::integer from pg_default_acl d
   where d.defaclrole = 'postgres'::regrole
     and d.defaclobjtype in ('r','S')
     and d.defaclnamespace::regnamespace::text in ('public','app','private','migration')
     and d.defaclacl::text ~ 'service_role='),
  0,
  'postgres''s default privileges grant service_role nothing on future tables or sequences'
);

-- And the proof that the defaults work: a table created now gets nothing.
create table public.zz_service_role_probe (id int);
select is(
  (select count(*)::integer
   from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv
   where has_table_privilege('service_role', 'public.zz_service_role_probe'::regclass, priv)),
  0,
  'a table created after this migration arrives with no service_role privilege'
);

select * from finish();
rollback;
