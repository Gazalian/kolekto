-- F-13 read-only catalog reading. Run as supabase_admin inside the kolekto-itest container. Sends no HTTP request.
\pset format unaligned
\pset fieldsep ' | '
begin read only;
select now() as read_at, current_setting('kolekto.itest_db_host_port', true) as declared_host_port;
\echo --- extension
select e.extname, e.extversion, n.nspname as ext_schema, r.rolname as owner, e.extrelocatable from pg_extension e join pg_namespace n on n.oid = e.extnamespace join pg_roles r on r.oid = e.extowner where e.extname = 'pg_net';
\echo --- schema net owner and acl
select n.nspname, r.rolname as owner, n.nspacl from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = 'net';
\echo --- objects in net
select c.relkind, c.relname, r.rolname as owner, c.relacl, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner where n.nspname = 'net' and c.relkind in ('r','v','S','m','p') order by 2;
select p.proname, pg_get_function_identity_arguments(p.oid) as args, r.rolname as owner, p.prosecdef, p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner where n.nspname = 'net' order by 1, 2;
\echo --- privilege matrix (role, schema usage, get, post, delete, request queue select/insert, response select)
select r.rolname,
  has_schema_privilege(r.oid, 'net', 'USAGE') as schema_usage,
  bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) filter (where p.proname = 'http_get') as http_get,
  bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) filter (where p.proname = 'http_post') as http_post,
  bool_or(has_function_privilege(r.oid, p.oid, 'EXECUTE')) filter (where p.proname = 'http_delete') as http_delete,
  has_table_privilege(r.oid, 'net.http_request_queue', 'SELECT') as queue_select,
  has_table_privilege(r.oid, 'net.http_request_queue', 'INSERT') as queue_insert,
  has_table_privilege(r.oid, 'net._http_response', 'SELECT') as response_select
from pg_roles r cross join pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'net' and p.proname in ('http_get','http_post','http_delete')
group by r.oid, r.rolname order by r.rolname;
\echo --- default privileges that could re-grant on net
select d.defaclnamespace::regnamespace as ns, pg_get_userbyid(d.defaclrole) as for_role, d.defaclobjtype, d.defaclacl from pg_default_acl d where d.defaclnamespace = 'net'::regnamespace;
\echo --- event triggers that manage pg_net grants
select evtname, evtevent, evtenabled, evtfoid::regprocedure as fn, evttags from pg_event_trigger order by 1;
\echo --- any function outside net whose source mentions net.http or net._ (who would need it)
select n.nspname, p.proname, r.rolname as owner, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner where n.nspname <> 'net' and p.prosrc ~* '\mnet\.(http_|_http|http_request)' order by 1, 2;
\echo --- triggers using supabase_functions.http_request (webhooks)
select count(*) as webhook_triggers from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'supabase_functions' and not t.tgisinternal;
\echo --- pg_cron jobs that mention net
select count(*) filter (where to_regclass('cron.job') is not null) as cron_available from (select 1) s;
\echo --- pending or stored http traffic (counts only)
select (select count(*) from net.http_request_queue) as queued_requests, (select count(*) from net._http_response) as stored_responses;
\echo --- pg_stat_statements mentioning net.http, by role (counts only)
select r.rolname, count(*) as statements, sum(s.calls) as calls from extensions.pg_stat_statements s join pg_roles r on r.oid = s.userid where s.query ~* '\mnet\.http_' group by 1 order by 1;
rollback;
