\pset format unaligned
\pset fieldsep ' | '
begin read only;
\echo --- clock/identity
select now() as server_now, current_database(), inet_server_port(), version(), current_setting('kolekto.itest_db_host_port', true) as host_port, current_setting('kolekto.itest_stack', true) is not null as stack_set;
\echo --- roles
select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname in ('kolekto_itest','postgres','service_role','kolekto_itest_worker') or rolname ~ '(worker|sender|notif)' order by 1;
select r.rolname as member, g.rolname as of_role, m.admin_option, m.inherit_option, m.set_option from pg_auth_members m join pg_roles r on r.oid=m.member join pg_roles g on g.oid=m.roleid where r.rolname='kolekto_itest';
\echo --- queue
select (select count(*) from pgmq.q_notification_events) as q_total, (select count(*) from pgmq.q_notification_events where read_ct>0) as q_read, (select count(*) from pgmq.a_notification_events) as a_total;
select queue_name, is_partitioned, is_unlogged from pgmq.meta;
\echo --- deliveries
select channel::text, status::text, count(*) from public.notification_deliveries group by 1,2 order by 1,2;
select count(*) as events from public.notification_events;
select count(*) as open_email from public.notification_deliveries where channel='email' and status in ('pending','sending');
select count(*) as leases from public.notification_deliveries where send_lease_token is not null;
\echo --- sender state
select email_sending_enabled, last_heartbeat_at, last_claim_at, updated_at, (last_heartbeat_at > now() - interval '60 seconds') as fresh from public.notification_sender_state;
select app.email_sending_enabled() as fn_switch;
\echo --- budget
select (select count(*) from public.notification_send_attempts where send_class='transactional' and attempted_at > now()-interval '24 hours') as l4_used, (select l4_daily from app.notification_send_limits('transactional')) as l4_cap, count(*) as ledger_total, min(attempted_at) as oldest, max(attempted_at) as newest, count(*) filter (where attempted_at < now()-interval '48 hours') as older_than_48h from public.notification_send_attempts;
select * from app.notification_send_limits('transactional');
\echo --- mutex/sessions
select count(*) as advisory_locks from pg_locks where locktype='advisory';
select usename, application_name, state from pg_stat_activity where usename in ('kolekto_itest','kolekto_itest_worker');
\echo --- rls
select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname='public' and c.relname in ('notification_events','notification_deliveries','communities','collections','role_permissions','obligations','members','officer_terms','notification_send_attempts','notification_sender_state','audit_logs','users')) or (n.nspname='pgmq' and c.relname in ('q_notification_events','a_notification_events','meta')) order by 1,2;
\echo --- triggers on worker-written tables
select c.relname, t.tgname, p.proname, p.prosecdef from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where c.relname in ('notification_events','notification_deliveries') and not t.tgisinternal;
\echo --- functions
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, pg_get_userbyid(p.proowner) as owner, coalesce(array_to_string(p.proconfig,','),'') as cfg from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='app' and p.proname in ('claim_next_notification_delivery','reserve_email_attempt','resolve_notification_claim','resolve_lease_ambiguous','recover_expired_notification_lease','expire_stale_notification_deliveries','purge_stale_send_attempts','record_sender_heartbeat','notification_send_health','notification_send_limits','email_sending_enabled','evaluate_email_eligibility','resolve_collection_audience','set_email_sending_enabled','sanitize_notification_event_payload','set_updated_at')) or (n.nspname='pgmq' and p.proname in ('read','delete','archive','send','format_table_name','validate_queue_name','_belongs_to_pgmq')) order by 1,2,3;
\echo --- pgmq grants
select grantee, table_name, privilege_type from information_schema.role_table_grants where table_schema='pgmq' and table_name in ('q_notification_events','a_notification_events','meta') order by 2,1,3;
select nspname, nspacl from pg_namespace where nspname in ('pgmq','app','public');
\echo --- pg_stat_statements
select count(*) from pg_stat_statements;
rollback;
