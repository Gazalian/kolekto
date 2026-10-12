-- ─────────────────────────────────────────────────────────────────────────────
-- 35 — A suppression that runs out mid-transaction must not start notifying (M13.2 P3 review)
--
-- Migration 20261009120000. THE SCENARIO that this file reproduces, in REAL time: an operator
-- switches suppression on, a long repair writes audited rows, the window passes, and the next
-- audited write used to be silently enqueued — real people notified halfway through a repair,
-- with no record. The window is shortened to two seconds and the test genuinely waits
-- (pg_sleep), so the clock does the lapsing; the trigger's logic is identical at 10 minutes.
--
-- What must now be true, and is asserted below:
--   · after the lapse the event is HELD (intact, durable, recorded), not notified, not dropped;
--   · the audited write itself still commits;
--   · ordinary callers are unaffected; officer access changes are never held;
--   · a hold that cannot be recorded and queued falls through and notifies, never a silent loss;
--   · the operator can release or discard held events, and nobody else can.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(38);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('a7000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@lapse.example.test');
insert into public.users (id, full_name, email) values
  ('a7000000-0000-4000-8000-000000000001', 'Lapse Owner', 'owner@lapse.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a7200000-0000-4000-8000-00000000000a', 'lapse-tests', 'Lapse Tests', 'social_group', false, 'a7000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a7300000-0000-4000-8000-000000000001', 'a7200000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-000000000001', 'owner', 'Lapse Owner', 'created');

-- ── Helpers ──────────────────────────────────────────────────────────────────
create function pg_temp.audit(p_action text, p_object uuid) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.audit_logs (community_id, actor_type, actor_name_snapshot, action, object_type, object_id)
  values ('a7200000-0000-4000-8000-00000000000a', 'officer', 'Lapse Test', p_action, split_part(p_action, '.', 1), p_object)
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.queued(p_audit uuid) returns integer language sql as $$
  select count(*)::int from pgmq.q_notification_events where message ->> 'audit_log_id' = p_audit::text;
$$;

-- Held events. Returns -1 if the held queue does not exist, so a test fails visibly instead of aborting the file.
create function pg_temp.held(p_audit uuid) returns integer language plpgsql as $$
declare n integer;
begin
  if to_regclass('pgmq.q_notification_events_held') is null then return -1; end if;
  execute 'select count(*)::int from pgmq.q_notification_events_held where message ->> ''audit_log_id'' = $1' into n using p_audit::text;
  return n;
end $$;

create function pg_temp.held_total() returns integer language plpgsql as $$
declare n integer;
begin
  if to_regclass('pgmq.q_notification_events_held') is null then return -1; end if;
  execute 'select count(*)::int from pgmq.q_notification_events_held' into n;
  return n;
end $$;

create function pg_temp.logged(p_audit uuid, p_outcome text) returns integer language sql as $$
  select count(*)::int from public.notification_suppression_log where audit_log_id = p_audit and outcome = p_outcome;
$$;

create function pg_temp.sv(p_offset integer, p_reason text default 'long repair') returns text language sql as $$
  select 'v1|' || (floor(extract(epoch from clock_timestamp()))::bigint + p_offset)::text || '|' || p_reason;
$$;

create function pg_temp.owner_creates_member(p_name text, p_phone text, p_setting text default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"a7000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  if p_setting is not null then perform set_config('kolekto.suppress_notifications', p_setting, true); end if;
  execute 'set local role authenticated';
  select app.create_member('a7200000-0000-4000-8000-00000000000a', p_name, p_phone) into v_id;
  execute 'reset role';
  perform set_config('kolekto.suppress_notifications', '', true);
  return v_id;
exception when others then
  execute 'reset role';
  perform set_config('kolekto.suppress_notifications', '', true);
  raise;
end $$;

create function pg_temp.audit_id_for(p_object uuid, p_action text) returns uuid language sql as $$
  select id from public.audit_logs where object_id = p_object and action = p_action order by created_at desc limit 1;
$$;

-- Try an operator-only function under a real client role; returns the SQLSTATE or 'ok'.
create function pg_temp.try_as(p_role text, p_sql text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    execute 'reset role';
    return 'ok';
  exception when others then
    execute 'reset role';
    return sqlstate;
  end;
end $$;

create temporary table tmp_base as select pg_temp.held_total() as held_before;


-- ═══ A. THE SCENARIO, in real time (1-10) ═══════════════════════════════════
-- The window is two seconds. Write 1 is inside it, then the clock moves on.
select set_config('kolekto.suppress_notifications', pg_temp.sv(2), true);
create temporary table tmp_w1 as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000001') as id;
select pg_sleep(3.2);
create temporary table tmp_w2 as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000002') as id;
create temporary table tmp_w3 as select pg_temp.audit('member.approve_join', 'a7400000-0000-4000-8000-000000000003') as id;
select set_config('kolekto.suppress_notifications', '', true);

select is(pg_temp.queued((select id from tmp_w1)), 0, 'A: write 1, inside the window, is suppressed: nothing in the live queue');
select is(pg_temp.queued((select id from tmp_w2)), 0,
  'A: write 2, AFTER the window lapsed in the same transaction, is NOT sent to the live queue (this is the failure being fixed)');
select is(pg_temp.queued((select id from tmp_w3)), 0, 'A: and neither is write 3: it does not start notifying and carry on');
select is(pg_temp.held((select id from tmp_w2)), 1, 'A: write 2 is HELD in notification_events_held, exactly once');
select is(pg_temp.held((select id from tmp_w3)), 1, 'A: write 3 is held too');
select is(pg_temp.held((select id from tmp_w1)), 0, 'A: write 1 was suppressed within its authority, so it is not held');
select is(pg_temp.logged((select id from tmp_w2), 'lapsed_held'), 1, 'A: the hold is recorded as lapsed_held');
select is((select reason from public.notification_suppression_log where audit_log_id = (select id from tmp_w2) and outcome = 'lapsed_held'), 'long repair',
  'A: with the reason the operator gave');
select is(pg_temp.logged((select id from tmp_w1), 'suppressed'), 1, 'A: write 1 stays recorded as suppressed (not relabelled)');
select ok(
  (select count(*) = 3 from public.audit_logs where id in ((select id from tmp_w1), (select id from tmp_w2), (select id from tmp_w3))),
  'A: all three audited writes committed: the hold never fails or rolls back a business write');

select is(
  (select jsonb_build_object('a', message ->> 'action', 'o', message ->> 'object_id', 'c', message ->> 'community_id')
   from pgmq.q_notification_events_held where message ->> 'audit_log_id' = (select id from tmp_w2)::text),
  jsonb_build_object('a', 'member.create', 'o', 'a7400000-0000-4000-8000-000000000002', 'c', 'a7200000-0000-4000-8000-00000000000a'),
  'A: the held message is the intact event (action, object, community), ready to be released');


-- ═══ B. Officer access changes are never held (12-13) ═══════════════════════
select set_config('kolekto.suppress_notifications', pg_temp.sv(-60), true);
create temporary table tmp_b as select pg_temp.audit('officer_term.end', 'a7300000-0000-4000-8000-000000000001') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_b)), 1, 'B: officer_term.end after a lapse is still sent to the live queue (an officer must always learn of an access change)');
select is(pg_temp.held((select id from tmp_b)), 0, 'B: and is not held');


-- ═══ C. Ordinary callers are unaffected (14-16) ═════════════════════════════
create temporary table tmp_c as
  select pg_temp.owner_creates_member('Public With Expired Setting', '+2348095550701', pg_temp.sv(-600)) as member_id;
select is(pg_temp.queued(pg_temp.audit_id_for((select member_id from tmp_c), 'member.create')), 1,
  'C: a signed-in caller with an expired well-formed setting: ignored, and the event is sent to the live queue as before');
select is(pg_temp.held(pg_temp.audit_id_for((select member_id from tmp_c), 'member.create')), 0, 'C: not held: the hold applies only to operator sessions');
select is(pg_temp.logged(pg_temp.audit_id_for((select member_id from tmp_c), 'member.create'), 'ignored_untrusted_role'), 1, 'C: and the attempt is logged');


-- ═══ D. The 15-minute ceiling is held, not honoured and not ignored (17-18) ═
select set_config('kolekto.suppress_notifications', pg_temp.sv(960), true);
create temporary table tmp_d as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000004') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_d)), 0, 'D: an operator value 16 minutes ahead (past the approved ceiling) is not honoured as a suppression, and does not notify');
select is(pg_temp.held((select id from tmp_d)), 1, 'D: it is held for the operator to decide');


-- ═══ E. A malformed value is still not an activation (19) ═══════════════════
select set_config('kolekto.suppress_notifications', 'v1|not-a-number|!!', true);
create temporary table tmp_e as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000005') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_e)), 1, 'E: a malformed value (not even v1-shaped) is ignored and the event goes out: unchanged, and the helper never produces one');


-- ═══ F. Release and discard (20-33) ═════════════════════════════════════════
select ok(not has_function_privilege('anon', 'app.release_held_notifications()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'app.release_held_notifications()', 'EXECUTE')
      and not has_function_privilege('public', 'app.release_held_notifications()', 'EXECUTE'),
  'F: no client role can execute release_held_notifications');
select ok(not has_function_privilege('anon', 'app.discard_held_notifications(text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'app.discard_held_notifications(text)', 'EXECUTE')
      and not has_function_privilege('public', 'app.discard_held_notifications(text)', 'EXECUTE'),
  'F: nor discard_held_notifications');
select is(pg_temp.try_as('authenticated', 'select app.release_held_notifications()'), '42501', 'F: calling release as authenticated is refused (42501)');
select is(pg_temp.try_as('anon', 'select app.discard_held_notifications(''some reason'')'), '42501', 'F: calling discard as anon is refused (42501)');
select throws_ok($$ select app.discard_held_notifications('Bad Reason!') $$, '22023', null, 'F: discard needs a valid reason');
select throws_ok($$ select app.discard_held_notifications(null) $$, '22023', null, 'F: and a reason at all');

create temporary table tmp_rel as select pg_temp.held_total() as before_n;
create temporary table tmp_rel_n as select app.release_held_notifications() as n;
select is((select n from tmp_rel_n), (select before_n from tmp_rel), 'F: release returns exactly how many events were held');
select is(pg_temp.held_total(), 0, 'F: the held queue is empty afterwards');
select is(pg_temp.queued((select id from tmp_w2)), 1, 'F: the released event is now in the live queue (it will notify), exactly once');
select is((select count(*)::int from public.notification_suppression_log where outcome = 'released_held'), (select n from tmp_rel_n), 'F: one released_held row per event, on the record');

-- discard
select set_config('kolekto.suppress_notifications', pg_temp.sv(-1), true);
create temporary table tmp_f1 as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000006') as id;
create temporary table tmp_f2 as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000007') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.held_total(), 2, 'F: two more events are held');
create temporary table tmp_dis as select app.discard_held_notifications('repair done quietly') as n;
select is((select n from tmp_dis), 2, 'F: discard returns how many it removed');
select ok(pg_temp.held_total() = 0 and pg_temp.queued((select id from tmp_f1)) = 0 and pg_temp.queued((select id from tmp_f2)) = 0,
  'F: the discarded events are gone from the held queue and were never sent');
select is((select count(*)::int from public.notification_suppression_log where outcome = 'discarded_held' and reason = 'repair done quietly'), 2,
  'F: two discarded_held rows with the operator''s reason');


-- ═══ G. Failure directions: a hold that cannot be kept falls through and notifies (34-37) ═══
-- Run LAST: it breaks the log table and the held queue inside this rolled-back transaction.
alter table public.notification_suppression_log rename to notification_suppression_log_moved;
select set_config('kolekto.suppress_notifications', pg_temp.sv(-1), true);
create temporary table tmp_g1 as select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000008') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_g1)), 1, 'G: a lapsed hold that cannot be RECORDED (log table missing) is not a hold: the event is sent, never silently lost');
select is(pg_temp.held((select id from tmp_g1)), 0, 'G: and nothing is half-held');
select ok(exists (select 1 from public.audit_logs where id = (select id from tmp_g1)), 'G: the audited write committed');
alter table public.notification_suppression_log_moved rename to notification_suppression_log;

select pgmq.drop_queue('notification_events_held');
select set_config('kolekto.suppress_notifications', pg_temp.sv(-1), true);
create temporary table tmp_g2 as
  select pg_temp.audit('member.create', 'a7400000-0000-4000-8000-000000000009') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_g2)), 1, 'G: a lapsed hold that cannot be QUEUED (held queue missing) falls through: the event is sent, and the write committed');
select is(pg_temp.logged((select id from tmp_g2), 'lapsed_held'), 0, 'G: and no orphan lapsed_held record is left claiming a hold that did not happen');


select * from finish();
rollback;
