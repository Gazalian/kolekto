-- M13.2 Option A: one-off gated purge of 131 verified test-only ledger rows on the kolekto-itest stack.
-- PROPOSED. NOT EXECUTED. NOT APPROVED. NOT A MIGRATION. Do not reuse: it is valid for one set of rows and one time window.
-- See docs/database/M13.2-OPTION-A-PURGE-PROCEDURE-REVIEW.md.
--
-- Modes, passed with -v mode=...:
--   rehearse-projected  Read-only. Runs every gate as if at the window's start. No lock, no purge.
--   rehearse-now        Read-only. Runs every gate at the real time. No lock, no purge.
--   execute             Takes the locks, gates, purges, verifies, commits. Any failure rolls everything back.
-- With no mode the script stops before doing anything.
\set ON_ERROR_STOP on
\if :{?mode}
\else
  \echo 'REFUSED: no mode given. Nothing was done.'
  \quit
\endif
select (:'mode' = 'execute') as is_execute \gset

-- The lock comes first in the transaction, because REPEATABLE READ takes its snapshot at the first query after it.
-- So the snapshot sees every writer that finished before the lock, and no writer can start until commit or rollback.
\if :is_execute
begin transaction isolation level repeatable read read write;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local idle_in_transaction_session_timeout = '120s';
lock table public.notification_send_attempts in share row exclusive mode;
\else
begin transaction isolation level repeatable read read only;
\endif
set local kolekto.purge_mode = :'mode';

do $gate$
declare
  c_expected_count constant bigint := 131;
  c_expected_fingerprint constant text := '69d44053a77410236d7ad2cc253e79a382fa4e04f0a40563211563d3526aed31';
  c_expected_ids constant uuid[] := array[
    '01a1a740-c0ba-78dd-8e9f-bf64ecf9a80e',
    '01a1a740-c4b9-7fd5-ac9b-a59dcc7073ba',
    '01a1a740-c96d-78ed-8a51-febdfc52f731',
    '01a1a740-dcb5-7038-8e07-7019bff03a2e',
    '01a1a740-e0fa-7675-a582-5fe07e9e4b51',
    '01a1a740-e514-7c58-899f-bc7c7330340d',
    '01a1a740-e8ff-76c7-bfb3-b842b1704554',
    '01a1a740-ed31-7b04-9641-4f0e3421a986',
    '01a1a740-f18e-7901-8a3a-0dd74ff8bd13',
    '01a1a740-f5a1-7b3b-9498-3c3c5eacaf45',
    '01a1a740-f998-7af2-a150-621833572207',
    '01a1a740-fdc1-73df-9429-e02c97a6dfa1',
    '01a1a741-01c4-778b-a23a-68198b3328d4',
    '01a1a741-05c6-7c2f-9532-88e425c66197',
    '01a1a741-0ab0-792a-b693-4dab4e5355a7',
    '01a1a741-1213-70e9-a199-11cf42ce1071',
    '01a1a741-1638-75ba-9c01-6fe9e4ac8e18',
    '01a1a742-743f-73b6-b1d1-d6a4a49f82a1',
    '01a1a742-785a-7f2c-93e4-cc81a53d32cb',
    '01a1a742-7cfd-799a-bfc0-6fe7adfcabc0',
    '01a1a742-a0e8-7b97-8368-dc9fea41ed9a',
    '01a1a742-a4d4-78d3-8870-955fa7682625',
    '01a1a742-a96b-7cdc-9e18-e837e0492e58',
    '01a1a742-b309-713a-94f3-7adfc1196480',
    '01a1a742-b74e-7550-8fe1-72026cb2e939',
    '01a1a742-bb44-71bf-9504-b3bb0e214f05',
    '01a1a742-c345-7b34-9bd9-86f699bca02b',
    '01a1a742-c73b-7cdb-8cb2-00dfdd3a17d4',
    '01a1a742-cb9d-7823-a3dc-54b991bd42ca',
    '01a1a742-cf5b-7e1a-b191-0399f81a251a',
    '01a1a742-d3b1-7b3c-82a5-bbb94c0b631f',
    '01a1a742-d9a0-76c6-a4c8-4b484233465c',
    '01a1a742-e139-79a8-b081-4eb677519977',
    '01a1a742-e526-7c5e-bda0-805947c964ca',
    '01a1a743-1f29-7399-816f-e1d3a4b4c87f',
    '01a1a743-2337-7504-90b9-99d05a939898',
    '01a1a743-2823-72a1-a544-124d715beef4',
    '01a1a743-3bdd-7a9f-b5d6-bc296636f410',
    '01a1a743-3fef-7062-a6a8-6d4fc12126e2',
    '01a1a743-441e-745b-aae0-810d826df6f1',
    '01a1a743-4810-7bb3-8168-ee3423aeefa3',
    '01a1a743-4c66-77d7-8d1e-4fbb3aa6ef49',
    '01a1a743-501f-7ce5-b582-4413bdfd027d',
    '01a1a743-5445-7049-868c-8c645aedbb6f',
    '01a1a743-58fa-7036-86c2-f1dd9dc78404',
    '01a1a743-5cbc-7711-8998-ea91534833e3',
    '01a1a743-60b1-7da5-914a-5ee45d75cdb7',
    '01a1a743-64d1-7731-b31b-2c71c6fa99af',
    '01a1a743-69ba-7cbe-91d8-9e93bdb16631',
    '01a1a743-6f59-7f52-8645-e5daff2bc683',
    '01a1a743-733f-7d14-8445-d17399361be2',
    '01a1a743-c128-70d9-80f9-73c573d7016f',
    '01a1a743-c4e6-77f5-b543-16c8822a5697',
    '01a1a743-c99c-71b9-a53a-14d5e13a3232',
    '01a1a743-e39f-7042-882b-e7e6562664c1',
    '01a1a743-e7e9-7da2-a7f9-f59b71b37677',
    '01a1a743-ec4c-7764-bf12-558dc80616d7',
    '01a1a743-f023-7912-a9cf-02005a4b9a59',
    '01a1a743-f3f6-7005-abda-7645fd977b6d',
    '01a1a743-f889-778a-ade8-0bb45e71100f',
    '01a1a743-fc77-7d85-a93b-60c0ab3d140d',
    '01a1a744-0070-7245-8e14-99cc406ffb67',
    '01a1a744-0471-7444-8b25-57f1527e6d3d',
    '01a1a744-0889-7ff9-9275-0ad5eca4be4e',
    '01a1a744-0d0f-78fc-ac37-7d2e7a865ce2',
    '01a1a744-1370-7d01-a8dc-67ffc4c62018',
    '01a1a744-1a6a-713d-9879-5055b14e1c9a',
    '01a1a744-1e3d-706f-9dcf-80b879157a1c',
    '01a1a75c-ee57-7fca-acb8-271f519ad1d1',
    '01a1a75c-f26c-7790-838e-ab053dce264e',
    '01a1a75c-f755-75c0-987d-8751152c7919',
    '01a1a75d-16d2-7c36-8385-c9aa5f701760',
    '01a1a75d-1ba3-75b0-bd07-b6e74952e744',
    '01a1a75d-1f7f-7a5a-9638-1e1a8a1c43b5',
    '01a1a75d-23e4-78b9-b0df-1c92bc181564',
    '01a1a75d-2b46-78cb-8dd9-e78dfb3928ec',
    '01a1a75d-2f7b-7d64-9a97-55c65ead2ac4',
    '01a1a75d-33f7-7b1e-b59a-7ea0093f8a12',
    '01a1a75d-37da-778a-9bfc-e6831e9068bd',
    '01a1a75d-3c0a-7fb3-a0a0-abb209e4f021',
    '01a1a75d-4014-7fc9-adf9-270752bf0a64',
    '01a1a75d-4430-7060-90c2-20debd899f91',
    '01a1a75d-4837-7dd3-9d4f-584550389dd9',
    '01a1a75d-4c3d-701f-9fb0-8e019c372703',
    '01a1a75d-504b-7aba-8f31-6ca32dc0697c',
    '01a1a75d-547e-7567-8b67-075b5fee8db4',
    '01a1a75d-5c36-7511-8c2c-7d9f4ac4edd3',
    '01a1a75d-6156-78d0-b827-5803a3225dfa',
    '01a1a75d-658c-76fa-9696-2b791e260dc2',
    '01a1a75e-bd66-7017-bfa7-8f2256409b7e',
    '01a1a75e-c17e-7a51-959a-44fb37c8dc2b',
    '01a1a75e-c62b-786e-af4d-0759c2faeb50',
    '01a1a75e-dae5-7762-a01c-1eafb51a1b99',
    '01a1a75e-df4d-7bf8-9e5f-3fea0b17f9d0',
    '01a1a75e-e3a4-7317-8e33-ba87e2b2e020',
    '01a1a75e-e79b-7a6d-8f22-7b958c3e5303',
    '01a1a75e-f098-72f9-a89d-53bf94e1fcd3',
    '01a1a75e-f499-7130-acb2-d64ba3e515a1',
    '01a1a75e-f8d0-7206-9546-6df71512787d',
    '01a1a75e-fce7-796c-be9e-f99ea1f229eb',
    '01a1a75f-00d7-75ad-941d-0de803e07def',
    '01a1a75f-0518-71e9-b345-7c44c15a1565',
    '01a1a75f-0921-79af-9815-1d3e59e6bef2',
    '01a1a75f-0d62-7593-b658-d4dc69ad875f',
    '01a1a75f-11e7-7ce6-a637-3066506a7d20',
    '01a1a75f-1614-7437-bea1-a2ead80b6003',
    '01a1a75f-1a75-78d1-a424-a0f1c8c806b4',
    '01a1a75f-1e5e-7946-90a2-65b267ab7b50',
    '01a1a75f-22a5-7b79-998a-46bdd1b4cb1a',
    '01a1a75f-26c0-72b0-992d-27236e0445d9',
    '01a1a75f-55ed-7d93-aa61-52d57d8c6458',
    '01a1a75f-5a35-7ff9-b3ed-960a2b0aa0e9',
    '01a1a75f-5ea6-7f90-ae5a-4bd730d4ea2a',
    '01a1a75f-70d7-7431-bc54-f2b5ecca8ee9',
    '01a1a75f-74cd-75f5-92ef-5b74ba288bd6',
    '01a1a75f-78d6-7670-a370-fdb0e17e26ea',
    '01a1a75f-7cc7-7437-b7a5-95f397d84b03',
    '01a1a75f-854f-73c4-a67c-ff0c6b777f2a',
    '01a1a75f-8985-7b23-ab3e-565fd5f6cf82',
    '01a1a75f-8dac-7b0a-8e7a-6269977dfccb',
    '01a1a75f-91a6-7e15-a32d-4f57016f1167',
    '01a1a75f-95ed-719a-bc75-b0338e77804e',
    '01a1a75f-9a00-708e-b18d-ef25cd88728c',
    '01a1a75f-9e11-78a0-9e75-0730256bf511',
    '01a1a75f-a22b-7763-84ec-7d14cd85ca68',
    '01a1a75f-a62e-7a47-952a-654c2c1d9594',
    '01a1a75f-aa40-758b-900e-20dfde33dc09',
    '01a1a75f-ae75-75c9-8562-43dfcdccfd7a',
    '01a1a75f-b290-77a5-9f19-aee00e5e067e',
    '01a1a75f-b718-7770-870f-6595bfc3bc6e',
    '01a1a75f-bb1d-76b8-bb3c-fce302af253d'
  ]::uuid[];
  c_window_start constant timestamptz := timestamptz '2026-11-06 16:23:52+00';
  c_window_end constant timestamptz := timestamptz '2026-11-07 16:11:13+00';
  c_strict_address constant text := '^itest\+[0-9a-f]{8}-[0-9]+@[a-z0-9-]+\.example\.test$';

  v_mode text := current_setting('kolekto.purge_mode', true);
  v_exec boolean;
  v_at timestamptz;
  v_cutoff timestamptz;
  v_now constant timestamptz := now();
  v_n bigint; v_distinct bigint; v_bad bigint; v_ids uuid[]; v_fp text;
  v_total_before bigint; v_total_after bigint; v_rest_before text; v_rest_after text;
  v_deleted bigint; v_expected_left bigint;
begin
  -- Every condition is tested with IS NOT TRUE, so a NULL refuses. Comparisons that may meet NULL use IS DISTINCT FROM.
  if (v_mode in ('execute', 'rehearse-projected', 'rehearse-now')) is not true then
    raise exception 'GATE REFUSED: unknown mode';
  end if;
  v_exec := (v_mode = 'execute'); -- M:EXEC
  if (v_exec = (current_setting('transaction_read_only') = 'off')) is not true then -- M:ROCHECK
    raise exception 'GATE REFUSED: a rehearsal must be read-only, and execute must not be'; -- M:ROCHECK
  end if; -- M:ROCHECK
  v_at := case when v_mode = 'rehearse-projected' then c_window_start else now() end; -- only a read-only rehearsal may shift this
  v_cutoff := v_at - interval '48 hours';

  -- Target and session
  if (current_database() = 'postgres'
      and current_setting('kolekto.itest_db_host_port', true) = '55422'
      and coalesce(current_setting('kolekto.itest_stack', true), '') <> '') is not true then
    raise exception 'GATE REFUSED: not the kolekto-itest stack';
  end if;
  -- A role subject to RLS could see fewer rows than the DELETE, which runs as the bypassing owner.
  if (current_user = 'supabase_admin' and session_user = 'supabase_admin'
      and (select rolbypassrls from pg_catalog.pg_roles where rolname = current_user)) is not true then
    raise exception 'GATE REFUSED: wrong session role';
  end if;
  if (current_setting('session_replication_role') = 'origin') is not true then
    raise exception 'GATE REFUSED: session_replication_role would disable triggers';
  end if;
  if (current_setting('app.send_attempts_purging', true) is distinct from 'true') is not true then
    raise exception 'GATE REFUSED: purge flag already set';
  end if;
  if (v_at >= c_window_start and v_at < c_window_end) is not true then
    raise exception 'GATE REFUSED: outside the valid time window';
  end if;

  -- The stack holds only test data
  if exists (select 1 from public.communities c where (c.slug ~ '^itest-[0-9a-f]{8}-[0-9]+$') is not true) then
    raise exception 'GATE REFUSED: a community on this stack is not test-only';
  end if;
  if exists (select 1 from auth.users u where (u.email ~ '^[^@]+@[a-z0-9.-]+\.example\.test$' and u.phone is null) is not true) then
    raise exception 'GATE REFUSED: a user on this stack is not test-only';
  end if;

  -- Sending is off and nothing is running
  if ((select s.email_sending_enabled from public.notification_sender_state s) = false
      and app.email_sending_enabled() = false
      and (select count(*) from public.notification_sender_state) = 1) is not true then
    raise exception 'GATE REFUSED: email_sending_enabled is not false';
  end if;
  if ((select count(*) from pgmq.q_notification_events) = 0
      and (select count(*) from pgmq.q_notification_events_held) = 0
      and (select count(*) from public.notification_deliveries d
            where d.status::text in ('pending', 'sending') or d.send_lease_token is not null) = 0) is not true then
    raise exception 'GATE REFUSED: queue, open deliveries or leases are not empty';
  end if;
  if exists (select 1 from pg_catalog.pg_stat_activity a
              where a.pid <> pg_backend_pid()
                and (a.usename in ('kolekto_itest', 'kolekto_itest_worker') or a.application_name like 'kolekto-itest%')) then
    raise exception 'GATE REFUSED: a harness or worker session is connected';
  end if;
  if (select count(*) from cron.job) is distinct from 0::bigint then
    raise exception 'GATE REFUSED: a scheduled job exists';
  end if;

  -- The purge machinery is what was reviewed
  if (md5(pg_get_functiondef('app.purge_stale_send_attempts()'::regprocedure)) = 'edf555fa3ffd5ceb4b2476ecb2bd44d0'
      and md5(pg_get_functiondef('app.block_send_attempts_mutation()'::regprocedure)) = '7be129db4c011a8fe280cf8e0400e6e5') is not true then -- M:DEFS
    raise exception 'GATE REFUSED: a function definition changed since review';
  end if;
  if ((select count(*) from pg_catalog.pg_trigger t where t.tgrelid = 'public.notification_send_attempts'::regclass and not t.tgisinternal) = 3
      and (select count(*) from pg_catalog.pg_trigger t where t.tgrelid = 'public.notification_send_attempts'::regclass and not t.tgisinternal and t.tgenabled = 'O'
            and t.tgname in ('notification_send_attempts_no_delete', 'notification_send_attempts_no_truncate', 'notification_send_attempts_no_update')) = 3
      and (select count(*) from pg_catalog.pg_rewrite r where r.ev_class = 'public.notification_send_attempts'::regclass) = 0
      and (select count(*) from pg_catalog.pg_constraint k where k.confrelid = 'public.notification_send_attempts'::regclass) = 0
      and (select c.relhassubclass = false from pg_catalog.pg_class c where c.oid = 'public.notification_send_attempts'::regclass)
      and (select r.rolbypassrls from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner where p.oid = 'app.purge_stale_send_attempts()'::regprocedure)) is not true then
    raise exception 'GATE REFUSED: triggers, rules, references or owner differ from review';
  end if;

  -- Every eligible row, verified. LEFT JOIN keeps a row whose relation is missing, so it fails below.
  with x as (
    select a.id, a.community_id, a.delivery_id, a.attempted_at, a.send_class, a.address_key,
      d.id as d_id, d.community_id as d_community, d.recipient_address, d.channel::text as d_channel, d.status::text as d_status,
      d.send_lease_token, d.send_class as d_class, d.recipient_user_id, d.recipient_member_id, d.notification_event_id,
      e.id as e_id, e.community_id as e_community, e.event_key,
      c.id as c_id, c.slug, c.contact_email, c.contact_phone_e164, c.is_personal,
      au.id as au_id, au.email as au_email, au.phone as au_phone,
      cu.id as cu_id, cu.email as cu_email, cu.phone as cu_phone,
      substring(c.slug from '^itest-([0-9a-f]{8})-[0-9]+$') as slug_tag,
      substring(a.address_key from '^itest\+([0-9a-f]{8})-[0-9]+@[a-z0-9-]+\.example\.test$') as addr_tag,
      substring(a.address_key from '^itest\+[0-9a-f]{8}-[0-9]+@([a-z0-9-]+)\.example\.test$') as addr_label,
      substring(e.event_key from '^itest-([0-9a-f]{8})-[a-z0-9-]+-[0-9]+$') as event_tag,
      substring(e.event_key from '^itest-[0-9a-f]{8}-([a-z0-9-]+)-[0-9]+$') as event_label
    from public.notification_send_attempts a
    left join public.communities c on c.id = a.community_id -- M:JOINC
    left join public.notification_deliveries d on d.id = a.delivery_id -- M:JOIND
    left join public.notification_events e on e.id = d.notification_event_id -- M:JOINE
    left join auth.users au on au.id = e.actor_user_id -- M:JOINAU
    left join auth.users cu on cu.id = c.created_by -- M:JOINCU
    where a.attempted_at < v_cutoff
  )
  select count(*), count(distinct x.id), array_agg(x.id order by x.id),
    encode(sha256(convert_to(string_agg(
      x.id::text || '|' || x.community_id || '|' || x.delivery_id || '|' || x.notification_event_id || '|'
      || to_char(x.attempted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' || x.send_class || '|'
      || encode(sha256(convert_to(x.address_key, 'UTF8')), 'hex'), E'\n' order by x.id), 'UTF8')), 'hex'),
    count(*) filter (where (
          x.c_id is not null and x.d_id is not null and x.e_id is not null and x.au_id is not null and x.cu_id is not null
      -- slug, address and event key all carry the same run tag, and address and event key the same test file
      and x.slug_tag is not null and x.addr_tag = x.slug_tag and x.event_tag = x.slug_tag and x.addr_label = x.event_label -- M:TAGS
      -- matching test-only delivery
      and x.d_community = x.community_id and lower(x.recipient_address) = x.address_key
      and x.d_channel = 'email' and x.d_status in ('sent', 'dead') and x.send_lease_token is null and x.d_class = x.send_class
      -- matching test-only event
      and x.e_community = x.community_id
      -- no recipient, contact or member outside the test address itself
      and x.recipient_user_id is null and x.recipient_member_id is null
      and x.contact_email is null and x.contact_phone_e164 is null and x.is_personal = false
      and not exists (select 1 from public.members m where m.community_id = x.community_id)
      -- the people behind the row are test users
      and x.au_email ~ c_strict_address and x.au_phone is null and x.cu_email ~ c_strict_address and x.cu_phone is null
    ) is not true)
  into v_n, v_distinct, v_ids, v_fp, v_bad
  from x;

  if (v_bad = 0) is not true then
    raise exception 'GATE REFUSED: % eligible row(s) are not demonstrably test-only', v_bad;
  end if;
  if (v_n = c_expected_count and v_distinct = v_n) is not true then
    raise exception 'GATE REFUSED: eligible count is %, expected %', v_n, c_expected_count;
  end if;
  if (v_ids = c_expected_ids) is not true then
    raise exception 'GATE REFUSED: eligible ids differ from the inventory';
  end if;
  if (v_fp = c_expected_fingerprint) is not true then
    raise exception 'GATE REFUSED: eligible fingerprint differs from the inventory';
  end if;

  if not v_exec then
    raise notice 'GATE PASSED, rehearsal only: % rows, nothing locked or deleted', v_n;
    return;
  end if;

  -- Execute only. The purge is reached only if every check above passed.
  if pg_try_advisory_xact_lock(918273, 1) is not true then -- M:MUTEX
    raise exception 'GATE REFUSED: the integration-suite mutex is held';
  end if;
  select count(*) filter (where a.attempted_at >= v_cutoff),
         encode(sha256(convert_to(coalesce(string_agg(a.id::text || '|' || a.attempted_at::text || '|' || a.address_key, E'\n' order by a.id)
                  filter (where a.attempted_at >= v_cutoff), ''), 'UTF8')), 'hex')
    into v_expected_left, v_rest_before
    from public.notification_send_attempts a;
  select count(*) into v_total_before from public.notification_send_attempts;

  v_deleted := app.purge_stale_send_attempts(); -- M:PURGE

  if (v_deleted = c_expected_count) is not true then
    raise exception 'VERIFY FAILED: purge deleted %, expected %', v_deleted, c_expected_count;
  end if;
  if exists (select 1 from public.notification_send_attempts a where a.attempted_at < v_cutoff) then -- M:OLDER
    raise exception 'VERIFY FAILED: rows older than 48 hours remain'; -- M:OLDER
  end if; -- M:OLDER
  if exists (select 1 from public.notification_send_attempts a where a.id = any (c_expected_ids)) then -- M:GONE
    raise exception 'VERIFY FAILED: a verified row was not deleted'; -- M:GONE
  end if; -- M:GONE
  select count(*), encode(sha256(convert_to(coalesce(string_agg(a.id::text || '|' || a.attempted_at::text || '|' || a.address_key, E'\n' order by a.id), ''), 'UTF8')), 'hex')
    into v_total_after, v_rest_after
    from public.notification_send_attempts a;
  if (v_total_after = v_total_before - c_expected_count and v_total_after = v_expected_left) is not true then -- M:TOTAL
    raise exception 'VERIFY FAILED: ledger total is %, expected %', v_total_after, v_expected_left; -- M:TOTAL
  end if; -- M:TOTAL
  if (v_rest_after = v_rest_before) is not true then -- M:REST
    raise exception 'VERIFY FAILED: rows outside the verified set changed'; -- M:REST
  end if; -- M:REST
  if (now() = v_now and current_setting('app.send_attempts_purging', true) is distinct from 'true') is not true then
    raise exception 'VERIFY FAILED: transaction timestamp or purge flag not as expected';
  end if;
  if ((select s.email_sending_enabled from public.notification_sender_state s) = false) is not true then
    raise exception 'VERIFY FAILED: email_sending_enabled is not false';
  end if;
  raise notice 'PURGE VERIFIED: % rows deleted, % remain. Committing.', v_deleted, v_total_after;
end
$gate$;

\if :is_execute
commit;
\else
rollback;
\endif
