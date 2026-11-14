-- Read-only state reading, run as supabase_admin inside the kolekto-itest container (proves state, not role access).
\pset format unaligned
\pset fieldsep ' | '
begin read only;
select now() as server_now, current_database() as db, current_setting('kolekto.itest_db_host_port', true) as declared_host_port, current_setting('kolekto.itest_stack', true) is not null as stack_marker_set;
\echo --- pause switch and heartbeat
select email_sending_enabled, app.email_sending_enabled() as fn, last_heartbeat_at, last_claim_at, updated_at from public.notification_sender_state;
\echo --- queue (waiting, read) and archive
select (select count(*) from pgmq.q_notification_events) as queued, (select count(*) from pgmq.q_notification_events where read_ct>0) as read, (select count(*) from pgmq.a_notification_events) as archived, (select count(*) from pgmq.q_notification_events_held) as held_queued;
select count(*) as unowned_queue_messages from pgmq.q_notification_events q where not exists (select 1 from public.communities c where c.id::text = q.message->>'community_id' and c.slug like 'itest-%');
\echo --- deliveries
select channel::text, status::text, count(*) from public.notification_deliveries group by 1,2 order by 1,2;
select count(*) as open_email, count(*) filter (where send_lease_token is not null) as leases from public.notification_deliveries where channel='email' and status in ('pending','sending');
select count(*) as events from public.notification_events;
select count(*) as communities, count(*) filter (where slug like 'itest-%') as itest_communities from public.communities;
\echo --- budget
select (select count(*) from public.notification_send_attempts where send_class='transactional' and attempted_at > now()-interval '24 hours') as l4_used, (select l4_daily from app.notification_send_limits('transactional')) as l4_cap, count(*) as ledger_total, min(attempted_at) as oldest, max(attempted_at) as newest, count(*) filter (where attempted_at < now()-interval '48 hours') as older_than_48h from public.notification_send_attempts;
\echo --- locks and sessions
select count(*) as advisory_locks from pg_locks where locktype='advisory';
select count(*) filter (where usename='kolekto_itest') as harness_sessions, count(*) filter (where usename='kolekto_itest_worker') as worker_sessions, count(*) filter (where application_name like 'kolekto-itest%') as itest_named from pg_stat_activity;
\echo --- worker role
select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolpassword is not null as password_set from pg_authid where rolname='kolekto_itest_worker';
select count(*) as memberships from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='kolekto_itest_worker';
select tablename, policyname, cmd from pg_policies where 'kolekto_itest_worker' = any(roles) order by 1,3;
\echo --- statements the worker role actually ran (texts of role changes are excluded)
select calls, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 110) as query from extensions.pg_stat_statements s join pg_roles r on r.oid=s.userid where r.rolname='kolekto_itest_worker' and (query ilike '%pgmq.read%' or query ilike '%pgmq.delete%' or query ilike '%pgmq.archive%' or query ilike '%claim_next_notification_delivery%' or query ilike '%record_sender_heartbeat%' or query ilike '%reserve_email_attempt%' or query ilike '%resolve_notification_claim%' or query ilike '%purge_stale_send_attempts%') order by query;
\echo --- switch writes recorded for any role
select r.rolname, calls, left(query, 80) as query from extensions.pg_stat_statements s join pg_roles r on r.oid=s.userid where query ilike '%set_email_sending_enabled%' order by 1,3;
select stats_reset from extensions.pg_stat_statements_info;
rollback;
