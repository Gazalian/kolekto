-- PROPOSED FOR REVIEW. NOT A MIGRATION. NOT APPLIED ANYWHERE. NOT EXECUTED, EVEN ON THE TEST STACK.
--
-- M13.2 Phase 8: the production form of the least-privilege worker role (finding F-1).
-- Kept outside supabase/migrations on purpose: the test stack refuses to start if that directory
-- differs from its copy, and nothing here is approved.
--
-- Provenance: the grant and policy set is workerRoleSql() in scripts/itest/itest.mjs, which the real
-- worker ran against on kolekto-itest in Phases 7 and 8. What is new here, and so unproven, is the role
-- name, the connection limit, the ALTER ROLE timeouts, and running under the migration role on a hosted
-- project. Phase 8's parking needs no extra grant: it uses UPDATE on the queue table, which is already here.
--
-- Target: staging first, under its own approval, then production under a separate one. Run by the
-- migration role (`postgres`). This file sets no password: LOGIN with a null password cannot log in
-- until a credential is issued, per environment, out of band.
--
-- Rollback (no data is touched, and the role owns nothing):
--   1. Stop the worker, or repoint SUPABASE_DB_URL at the previous credential and restart it.
--   2. Run the block at the end of this file.

begin;

create role kolekto_worker with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit connection limit 5 password null;

-- The worker sets these itself and refuses to start without them. Here they are a second line of defence
-- for any other session opened with this credential. Keep in step with DB_SESSION_TIMEOUTS in worker-safety.ts.
alter role kolekto_worker set lock_timeout = '5s';
alter role kolekto_worker set statement_timeout = '15s';
alter role kolekto_worker set idle_in_transaction_session_timeout = '30s';

grant usage on schema public, app, pgmq, extensions to kolekto_worker;

-- Queue. No INSERT, so pgmq.send is refused. SELECT on the archive is msg_id only, needed by RETURNING inside pgmq.archive.
grant select, update, delete on pgmq.q_notification_events to kolekto_worker;
grant insert, select (msg_id) on pgmq.a_notification_events to kolekto_worker;

-- Events and deliveries: insert and read. Every state change goes through a SECURITY DEFINER function.
grant select, insert on public.notification_events, public.notification_deliveries to kolekto_worker;
create policy kolekto_worker_notification_events_select on public.notification_events for select to kolekto_worker using (true);
create policy kolekto_worker_notification_events_insert on public.notification_events for insert to kolekto_worker with check (true);
create policy kolekto_worker_notification_deliveries_select on public.notification_deliveries for select to kolekto_worker using (true);
create policy kolekto_worker_notification_deliveries_insert on public.notification_deliveries for insert to kolekto_worker with check (true);

-- Reads, by column. Deliberately absent: members.email, members.phone_e164, and every financial table
-- except the three obligation columns the audience filter reads. USING (true) is cross-tenant by design;
-- the worker serves every community, and the limit comes from these column grants.
grant select (id, slug, name) on public.communities to kolekto_worker;
grant select (id, community_id, name, slug) on public.collections to kolekto_worker;
grant select (id, community_id, full_name, member_code, user_id, is_imported, joined_via, status, archived_at, merged_into_id) on public.members to kolekto_worker;
grant select (id, community_id, user_id, role, end_reason, started_at, ended_at) on public.officer_terms to kolekto_worker;
grant select (role, permission) on public.role_permissions to kolekto_worker;
grant select (collection_id, member_id, status) on public.obligations to kolekto_worker;
create policy kolekto_worker_communities_select on public.communities for select to kolekto_worker using (true);
create policy kolekto_worker_collections_select on public.collections for select to kolekto_worker using (true);
create policy kolekto_worker_members_select on public.members for select to kolekto_worker using (true);
create policy kolekto_worker_officer_terms_select on public.officer_terms for select to kolekto_worker using (true);
create policy kolekto_worker_role_permissions_select on public.role_permissions for select to kolekto_worker using (true);
create policy kolekto_worker_obligations_select on public.obligations for select to kolekto_worker using (true);

-- Deliberately absent: app.set_email_sending_enabled. The worker must never be able to turn sending on.
grant execute on function
  app.claim_next_notification_delivery(integer),
  app.reserve_email_attempt(uuid),
  app.resolve_notification_claim(uuid, text, text, text, text, timestamptz),
  app.resolve_lease_ambiguous(uuid),
  app.recover_expired_notification_lease(uuid),
  app.expire_stale_notification_deliveries(integer),
  app.purge_stale_send_attempts(),
  app.record_sender_heartbeat(boolean),
  app.notification_send_health(),
  app.notification_send_limits(text),
  app.email_sending_enabled(),
  app.evaluate_email_eligibility(text, uuid, uuid),
  app.resolve_collection_audience(uuid),
  -- Run by the insert path: the id default, the payload sanitiser trigger and the table's CHECK constraint.
  app.uuid_generate_v7(),
  extensions.gen_random_bytes(integer),
  app.strip_banned_payload_keys(jsonb),
  app.payload_has_banned_key(jsonb)
to kolekto_worker;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Checks to run after applying, read-only. Each must return exactly what is stated.
--
--   select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit, rolconnlimit
--     from pg_roles where rolname = 'kolekto_worker';
--     → true, false, false, false, false, false, false, 5
--   select count(*) from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'kolekto_worker';
--     → 0
--   select count(*) from pg_policies where 'kolekto_worker' = any(roles);
--     → 10
--   select has_schema_privilege('kolekto_worker', 'net', 'USAGE');
--     → false. THIS WILL BE TRUE UNTIL F-13 IS CLOSED IN THAT ENVIRONMENT. Do not issue a credential while it is true.
--   select has_function_privilege('kolekto_worker', 'app.set_email_sending_enabled(boolean)', 'EXECUTE');
--     → false
--
-- ─────────────────────────────────────────────────────────────────────────────
-- F-13, separately, because a role grant cannot fix it. A PUBLIC grant cannot be denied per role.
--
-- Read first, in each environment, under its own approval (read-only, sends nothing):
--   select n.nspacl from pg_namespace n where n.nspname = 'net';
--   select relname, relacl from pg_class where relnamespace = 'net'::regnamespace;
--   select proname, proacl from pg_proc where pronamespace = 'net'::regnamespace;
--
-- Then one of these, which is a security decision (see the Phase 8 report §11):
--   A. Revoke, as the object owner. What ran on the test stack, as supabase_admin:
--        revoke all on schema net from public, anon, authenticated, service_role;
--        revoke all on all tables in schema net from public, anon, authenticated, service_role;
--        revoke all on all sequences in schema net from public, anon, authenticated, service_role;
--        revoke all on all functions in schema net from public, anon, authenticated, service_role;
--      On a hosted project the migration role may not own these objects, so this may fail or do nothing
--      without an error. NOT TESTED. Read the ACLs back afterwards. Re-check after any platform upgrade,
--      because Supabase's grant_pg_net_access() event trigger grants again when the extension is created.
--   B. Remove the extension, if nothing is going to use it. Nothing does today, but ADR 0005 plans
--      pg_cron → pg_net → route handler, so this reverses a recorded decision.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback block. Run only after the worker no longer uses this role.
--
-- begin;
-- alter role kolekto_worker nologin;
-- select pg_terminate_backend(pid) from pg_stat_activity where usename = 'kolekto_worker';
-- drop policy kolekto_worker_notification_events_select on public.notification_events;
-- drop policy kolekto_worker_notification_events_insert on public.notification_events;
-- drop policy kolekto_worker_notification_deliveries_select on public.notification_deliveries;
-- drop policy kolekto_worker_notification_deliveries_insert on public.notification_deliveries;
-- drop policy kolekto_worker_communities_select on public.communities;
-- drop policy kolekto_worker_collections_select on public.collections;
-- drop policy kolekto_worker_members_select on public.members;
-- drop policy kolekto_worker_officer_terms_select on public.officer_terms;
-- drop policy kolekto_worker_role_permissions_select on public.role_permissions;
-- drop policy kolekto_worker_obligations_select on public.obligations;
-- drop owned by kolekto_worker;
-- drop role kolekto_worker;
-- commit;
