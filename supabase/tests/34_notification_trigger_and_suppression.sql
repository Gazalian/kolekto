-- ─────────────────────────────────────────────────────────────────────────────
-- 34 — The approved event mapping, trigger safety and suppression (M13.2 P3)
--
-- Migration 20261009110000. Four things are proved here:
--
--   A. Every approved watched action produces exactly one queue message; unwatched
--      actions and `system`/`contributor`/`staff` actors on member.* produce none.
--   B. member.reject_join forwards a narrow object, never the whole member row.
--   C. The ten suppression tests of decision record 10.7: honoured only in an
--      operator session, for at most 15 minutes, never for officer access changes,
--      never from `anon` or `authenticated`, logged, and touching no business record.
--   D. The trigger can never make an audited write fail: malformed settings, odd
--      payload shapes, a missing queue and a missing log table are all absorbed.
--
-- The roles are real. Untrusted-role tests call real audited domain functions
-- (app.create_member, app.redeem_invite_link) under `set local role authenticated`
-- / `anon`, with the setting switched on, because that is the attack: a public
-- caller trying to silence a notification.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(74);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('a1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@p3.example.test');
insert into public.users (id, full_name, email) values
  ('a1000000-0000-4000-8000-000000000001', 'P3 Owner', 'owner@p3.example.test')
on conflict (id) do update set full_name = excluded.full_name;
insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('a2000000-0000-4000-8000-00000000000a', 'p3-tests', 'P3 Tests', 'social_group', false, 'a1000000-0000-4000-8000-000000000001');
insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'owner', 'P3 Owner', 'created');

-- ── Helpers (pg_temp) ────────────────────────────────────────────────────────
-- Write an audit row as the operator session this file runs in, return its id.
create function pg_temp.audit(
  p_actor  public.audit_actor_type, p_action text, p_object uuid,
  p_before jsonb default null, p_after jsonb default null, p_reason text default null,
  p_community uuid default 'a2000000-0000-4000-8000-00000000000a'
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  -- A staff row must name an accountable user and give a reason (audit_logs_staff_action_is_accountable).
  insert into public.audit_logs (community_id, actor_type, actor_user_id, actor_name_snapshot, action, object_type, object_id, before_state, after_state, reason)
  values (p_community, p_actor, case when p_actor = 'staff' then 'a1000000-0000-4000-8000-000000000001'::uuid end, 'P3 Test', p_action,
          split_part(p_action, '.', 1), p_object, p_before, p_after,
          coalesce(p_reason, case when p_actor = 'staff' then 'pgTAP fixture' end))
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.queued(p_audit uuid) returns integer language sql as $$
  select count(*)::int from pgmq.q_notification_events where message ->> 'audit_log_id' = p_audit::text;
$$;

create function pg_temp.queued_msg(p_audit uuid) returns jsonb language sql as $$
  select message from pgmq.q_notification_events where message ->> 'audit_log_id' = p_audit::text limit 1;
$$;

create function pg_temp.logged(p_audit uuid, p_outcome text) returns integer language sql as $$
  select count(*)::int from public.notification_suppression_log where audit_log_id = p_audit and outcome = p_outcome;
$$;

-- A suppression value expiring `p_offset` seconds from now.
create function pg_temp.sv(p_offset integer, p_reason text default 'test repair') returns text language sql as $$
  select 'v1|' || (floor(extract(epoch from clock_timestamp()))::bigint + p_offset)::text || '|' || p_reason;
$$;

-- Do something as a real user: owner of the test community, under the real role.
create function pg_temp.owner_creates_member(p_name text, p_phone text, p_setting text default null) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  if p_setting is not null then perform set_config('kolekto.suppress_notifications', p_setting, true); end if;
  execute 'set local role authenticated';
  select app.create_member('a2000000-0000-4000-8000-00000000000a', p_name, p_phone) into v_id;
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

-- A fingerprint of business data. If suppression changed any of it, this changes.
create function pg_temp.business_fingerprint() returns text language sql as $$
  select md5(concat_ws('|',
    (select coalesce(md5(string_agg(m::text, ',' order by m.id)), '') from public.members m),
    (select coalesce(md5(string_agg(o::text, ',' order by o.id)), '') from public.obligations o),
    (select coalesce(md5(string_agg(c::text, ',' order by c.id)), '') from public.collections c),
    (select coalesce(md5(string_agg(j::text, ',' order by j.id)), '') from public.ledger_journals j),
    (select coalesce(md5(string_agg(u::text, ',' order by u.id)), '') from public.users u),
    (select coalesce(md5(string_agg(t::text, ',' order by t.id)), '') from public.officer_terms t)
  ));
$$;


-- ═══ A. The approved watched actions (1-13) ═════════════════════════════════
select is(pg_temp.queued(pg_temp.audit('officer', 'collection.publish',        'a4000000-0000-4000-8000-000000000001')), 1, 'collection.publish (M13.1) still enqueues');
select is(pg_temp.queued(pg_temp.audit('officer', 'member.create',             'a4000000-0000-4000-8000-000000000002')), 1, 'member.create enqueues');
select is(pg_temp.queued(pg_temp.audit('officer', 'member.approve_join',       'a4000000-0000-4000-8000-000000000003')), 1, 'member.approve_join (M13.1) still enqueues');
select is(pg_temp.queued(pg_temp.audit('officer', 'member.reject_join',        'a4000000-0000-4000-8000-000000000004')), 1, 'member.reject_join enqueues');
select is(pg_temp.queued(pg_temp.audit('member',  'member.join_via_invite',    'a4000000-0000-4000-8000-000000000005')), 1, 'member.join_via_invite (M13.1) still enqueues, actor type member');
select is(pg_temp.queued(pg_temp.audit('officer', 'officer_invitation.accept', 'a4000000-0000-4000-8000-000000000006')), 1, 'officer_invitation.accept enqueues');
select is(pg_temp.queued(pg_temp.audit('officer', 'officer_term.end',          'a4000000-0000-4000-8000-000000000007')), 1, 'officer_term.end enqueues');

select is(pg_temp.queued(pg_temp.audit('officer', 'member.edit',    'a4000000-0000-4000-8000-000000000008')), 0, 'an unwatched action (member.edit) does not enqueue');
select is(pg_temp.queued(pg_temp.audit('officer', 'member.restore', 'a4000000-0000-4000-8000-000000000009')), 0, 'member.restore never enqueues (the inventory forbids it)');
select is(pg_temp.queued(pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-00000000000a', p_community => null)), 0, 'an audit row with no community enqueues nothing and raises nothing');

select is(
  (select sum(pg_temp.queued(pg_temp.audit(a, act, ('a4000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid)))::int
   from (values ('system'::public.audit_actor_type, 'member.create', 1), ('system', 'member.approve_join', 2),
                ('system', 'member.reject_join', 3), ('system', 'member.join_via_invite', 4),
                ('contributor', 'member.create', 5), ('staff', 'member.create', 6)) as v(a, act, n)),
  0,
  'a system, contributor or staff actor on any member.* action enqueues nothing (a marker or repair is not a person acting on a membership)'
);

select is(pg_temp.queued(pg_temp.audit('system', 'collection.publish', 'a4000000-0000-4000-8000-000000000201')), 1,
  'but a system actor on collection.publish still enqueues: the M13.1 behaviour is preserved');
select is(pg_temp.queued(pg_temp.audit('system', 'officer_term.end', 'a4000000-0000-4000-8000-000000000202')), 1,
  'and a system actor ending an officer term still enqueues: an officer must always learn of an access change');


-- ═══ B. member.reject_join forwards a narrow object (14-20) ═════════════════
create temporary table tmp_reject as
  select pg_temp.audit('officer', 'member.reject_join', 'a4000000-0000-4000-8000-000000000301',
    p_before => jsonb_build_object(
      'id', 'a4000000-0000-4000-8000-000000000301', 'full_name', 'Requester Name', 'phone_e164', '+2348099990001',
      'email', 'requester@example.com', 'joined_via', 'invite_link', 'attributes', jsonb_build_object('matric', 'KW/123', 'faculty', 'Law'),
      'member_code', 'P3/0001', 'status', 'pending_approval'),
    p_reason => 'officer free text: does not look genuine') as id;

select is(
  (select array_agg(k order by k) from jsonb_object_keys((select pg_temp.queued_msg(id) -> 'before_state' from tmp_reject)) k),
  array['email', 'full_name', 'joined_via'],
  'the forwarded before_state has exactly three keys: full_name, joined_via, email'
);
select is((select pg_temp.queued_msg(id) -> 'before_state' ->> 'email' from tmp_reject), 'requester@example.com',
  'the email is forwarded because the requester typed it themselves (joined_via = invite_link)');
select ok(
  (select position('+2348099990001' in pg_temp.queued_msg(id)::text) = 0 and position('KW/123' in pg_temp.queued_msg(id)::text) = 0
          and position('Law' in pg_temp.queued_msg(id)::text) = 0 and position('P3/0001' in pg_temp.queued_msg(id)::text) = 0
   from tmp_reject),
  'no phone number, attribute value or member code from the member row reaches the queue'
);
select ok(
  (select position('free text' in pg_temp.queued_msg(id)::text) = 0 and not (pg_temp.queued_msg(id) ? 'reason') from tmp_reject),
  'the officer''s free-text reason is never forwarded'
);
select is(
  (select pg_temp.queued_msg(pg_temp.audit('officer', 'member.reject_join', 'a4000000-0000-4000-8000-000000000302',
     p_before => jsonb_build_object('full_name', 'Added By Officer', 'email', 'typed.by.officer@example.com', 'joined_via', 'manual'))) -> 'before_state' ->> 'email'),
  null,
  'an address an OFFICER typed (joined_via = manual) is not forwarded: only a requester''s own address is'
);
select is(
  pg_temp.queued(pg_temp.audit('officer', 'member.reject_join', 'a4000000-0000-4000-8000-000000000303', p_before => null)),
  1,
  'a rejection with no before_state still enqueues, and raises nothing'
);
select is(
  pg_temp.queued(pg_temp.audit('officer', 'member.reject_join', 'a4000000-0000-4000-8000-000000000304', p_before => '["not","an","object"]'::jsonb)),
  1,
  'a before_state that is not an object (an array) enqueues and raises nothing'
);


-- ═══ C. Suppression (21-45) ═════════════════════════════════════════════════

-- C1. Honoured (21-23)
select app.begin_notification_suppression('maintenance repair');
create temporary table tmp_c1 as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000401') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_c1)), 0, 'C1: an operator session with a valid setting suppresses member.create: nothing is enqueued');
select is(pg_temp.logged((select id from tmp_c1), 'suppressed'), 1, 'C1: and exactly one ''suppressed'' row is logged');
select is((select reason from public.notification_suppression_log where audit_log_id = (select id from tmp_c1)), 'maintenance repair',
  'C1: carrying the operator''s reason');

-- C2. Default (24-25)
create temporary table tmp_c2 as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000402') as id;
select is(pg_temp.queued((select id from tmp_c2)), 1, 'C2: with no setting the event is enqueued (the M13.1 default is unchanged)');
select is((select count(*)::int from public.notification_suppression_log where audit_log_id = (select id from tmp_c2)), 0, 'C2: and nothing is logged');

-- C3. Untrusted roles, through REAL domain functions (26-31)
select set_config('kolekto.suppress_notifications', '', true);
create temporary table tmp_c3a as select pg_temp.owner_creates_member('Public Tried To Suppress', '+2348095550301', pg_temp.sv(300)) as member_id;
select is(pg_temp.queued(pg_temp.audit_id_for((select member_id from tmp_c3a), 'member.create')), 1,
  'C3: a signed-in OWNER who sets a valid setting under the authenticated role does NOT suppress: the event is enqueued');
select is(pg_temp.logged(pg_temp.audit_id_for((select member_id from tmp_c3a), 'member.create'), 'ignored_untrusted_role'), 1,
  'C3: and the attempt is logged as ignored_untrusted_role');

create function pg_temp.owner_creates_invite() returns text language plpgsql as $$
declare v_token text;
begin
  perform set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  execute 'set local role authenticated';
  select token into v_token from app.create_invite_link('a2000000-0000-4000-8000-00000000000a');
  execute 'reset role';
  return v_token;
exception when others then
  execute 'reset role';
  raise;
end $$;

create function pg_temp.anon_redeems(p_token text, p_setting text) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  perform set_config('kolekto.suppress_notifications', p_setting, true);
  execute 'set local role anon';
  select member_id into v_id from app.redeem_invite_link(p_token, 'Anonymous Joiner', '+2348095550302', 'joiner@example.com');
  execute 'reset role';
  perform set_config('kolekto.suppress_notifications', '', true);
  return v_id;
exception when others then
  execute 'reset role';
  perform set_config('kolekto.suppress_notifications', '', true);
  raise;
end $$;

create temporary table tmp_c3b as
  select pg_temp.anon_redeems(pg_temp.owner_creates_invite(), pg_temp.sv(300)) as member_id;
select is(pg_temp.queued(pg_temp.audit_id_for((select member_id from tmp_c3b), 'member.join_via_invite')), 1,
  'C3: an ANONYMOUS joiner who sets a valid setting under the anon role does NOT suppress: the event is enqueued');
select is(pg_temp.logged(pg_temp.audit_id_for((select member_id from tmp_c3b), 'member.join_via_invite'), 'ignored_untrusted_role'), 1,
  'C3: and the attempt is logged');
select is((select current_setting('role')), 'none', 'C3: the role was restored to the operator session after the anon call');
select ok(not has_function_privilege('anon', 'app.notification_suppression_state()', 'EXECUTE')
          and not has_function_privilege('authenticated', 'app.notification_suppression_state()', 'EXECUTE'),
  'C3: the state parser is not callable by a client role either');

-- C4. Time bounds (32-35)
select set_config('kolekto.suppress_notifications', pg_temp.sv(-5), true);
create temporary table tmp_c4a as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000411') as id;
select set_config('kolekto.suppress_notifications', pg_temp.sv(960), true);
create temporary table tmp_c4b as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000412') as id;
select set_config('kolekto.suppress_notifications', pg_temp.sv(840), true);
create temporary table tmp_c4c as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000413') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_c4a)), 1, 'C4: an expired setting is ignored: the event is enqueued');
select is(pg_temp.queued((select id from tmp_c4b)), 1, 'C4: a setting that expires 16 minutes from now is ignored (the maximum is 15): enqueued');
select is(pg_temp.queued((select id from tmp_c4c)), 0, 'C4: a setting that expires 14 minutes from now is honoured: suppressed');
select is((select count(*)::int from public.notification_suppression_log where audit_log_id in ((select id from tmp_c4a), (select id from tmp_c4b))), 0,
  'C4: ignored-for-time settings are not logged as suppressions');

-- C5. Malformed values: no error, the event proceeds (36-37)
create function pg_temp.audit_with_setting(p_setting text, p_n integer) returns uuid language plpgsql as $$
begin
  perform set_config('kolekto.suppress_notifications', p_setting, true);
  return pg_temp.audit('officer', 'member.create', ('a4000000-0000-4000-8000-0000000005' || lpad(p_n::text, 2, '0'))::uuid);
end $$;
create temporary table tmp_c5 as
  select n, pg_temp.audit_with_setting(s, n) as id
  from (values
    (1, 'garbage'), (2, 'v1|abc|test repair'), (3, 'v2|' || (floor(extract(epoch from clock_timestamp()))::bigint + 300)::text || '|test repair'),
    (4, pg_temp.sv(300, 'ab')), (5, pg_temp.sv(300, 'Bad Reason!')), (6, 'v1|' || (floor(extract(epoch from clock_timestamp()))::bigint + 300)::text),
    (7, 'v1||test repair'), (8, repeat('x', 10000)), (9, 'v1|99999999999999999999|test repair'), (10, 'v1|-5|test repair'),
    (11, '|||'), (12, 'v1|1e3|test repair'), (13, pg_temp.sv(300, 'has|pipe'))
  ) as v(n, s);
select set_config('kolekto.suppress_notifications', '', true);
select is((select count(*)::int from tmp_c5 where pg_temp.queued(id) = 1), 13,
  'C5: thirteen malformed settings (garbage, wrong version, non-numeric / oversized / negative expiry, bad reasons, extra pipes, 10 000 characters) raise nothing and every event is still enqueued');
select is((select count(*)::int from public.notification_suppression_log where audit_log_id in (select id from tmp_c5)), 0,
  'C5: and none of them is mistaken for a suppression');

-- C6. Officer access changes are never suppressible (38-39)
select set_config('kolekto.suppress_notifications', pg_temp.sv(300), true);
create temporary table tmp_c6 as
  select pg_temp.audit('officer', 'officer_term.end', 'a4000000-0000-4000-8000-000000000601') as a,
         pg_temp.audit('officer', 'officer_invitation.accept', 'a4000000-0000-4000-8000-000000000602') as b;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select a from tmp_c6)) + pg_temp.queued((select b from tmp_c6)), 2,
  'C6: officer_term.end and officer_invitation.accept are enqueued even under a valid operator setting');
select is((select count(*)::int from public.notification_suppression_log where audit_log_id in ((select a from tmp_c6), (select b from tmp_c6))), 0,
  'C6: and are not logged as suppressed');

-- C7. Suppression changes no business record (40-41)
create temporary table tmp_fp as select pg_temp.business_fingerprint() as before_fp;
select set_config('kolekto.suppress_notifications', pg_temp.sv(300, 'fingerprint check'), true);
create temporary table tmp_c7 as select pg_temp.audit('officer', 'member.approve_join', 'a4000000-0000-4000-8000-000000000701') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_c7)), 0, 'C7: the event was suppressed');
select is(pg_temp.business_fingerprint(), (select before_fp from tmp_fp),
  'C7: members, obligations, collections, ledger journals, users and officer terms are byte-identical before and after');

-- C8. The helper (42-47)
select ok(
  not has_function_privilege('anon', 'app.begin_notification_suppression(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.begin_notification_suppression(text)', 'EXECUTE')
  and not has_function_privilege('public', 'app.begin_notification_suppression(text)', 'EXECUTE'),
  'C8: no client role and not PUBLIC can execute the helper');
select throws_ok($$ select app.begin_notification_suppression('ab') $$, '22023', null, 'C8: a 2-character reason is refused');
select throws_ok($$ select app.begin_notification_suppression('Bad Reason!') $$, '22023', null, 'C8: a reason with capitals or punctuation is refused');
select throws_ok($$ select app.begin_notification_suppression(null) $$, '22023', null, 'C8: a NULL reason is refused');
select lives_ok($$ select app.begin_notification_suppression('data repair 1') $$, 'C8: a valid reason is accepted in an operator session');
select ok(
  current_setting('kolekto.suppress_notifications') ~ '^v1\|[0-9]{10}\|data repair 1$'
  and split_part(current_setting('kolekto.suppress_notifications'), '|', 2)::bigint
      between floor(extract(epoch from clock_timestamp()))::bigint + 590 and floor(extract(epoch from clock_timestamp()))::bigint + 601,
  'C8: the helper sets v1|<expiry>|<reason> with an expiry about 10 minutes out (inside the 15-minute maximum)');
select set_config('kolekto.suppress_notifications', '', true);

-- C9. Lifetime (48)
select ok(
  (select pg_get_functiondef('app.begin_notification_suppression(text)'::regprocedure) ~ 'set_config\(\s*''kolekto\.suppress_notifications''[^;]*,\s*true\s*\)'),
  'C9: the helper calls set_config with is_local = true, so the setting ends with the transaction (a two-session proof is scripts/verify/notification-suppression-lifetime.mjs)');

-- C10. Log integrity (49-55)
select throws_ok($$ update public.notification_suppression_log set outcome = 'suppressed' $$, 'P0001', null, 'C10: the log rejects UPDATE');
select throws_ok($$ delete from public.notification_suppression_log $$, 'P0001', null, 'C10: the log rejects DELETE');
select throws_ok($$ truncate public.notification_suppression_log $$, 'P0001', null, 'C10: the log rejects TRUNCATE');
select ok(
  not has_table_privilege('anon', 'public.notification_suppression_log', 'SELECT')
  and not has_table_privilege('authenticated', 'public.notification_suppression_log', 'SELECT')
  and not has_table_privilege('authenticated', 'public.notification_suppression_log', 'INSERT')
  and not has_table_privilege('authenticated', 'public.notification_suppression_log', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.notification_suppression_log', 'DELETE'),
  'C10: no client role holds any privilege on the log');
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.notification_suppression_log'::regclass),
  'C10: row-level security is enabled and forced');
select bag_eq(
  $$ select policyname::text from pg_policies where schemaname = 'public' and tablename = 'notification_suppression_log' $$,
  $$ values ('notification_suppression_log_deny_client_access') $$,
  'C10: the only policy is the explicit deny-all (the repository requires a stated decision, not a policy-less table)');
select throws_ok($$ insert into public.notification_suppression_log (action, outcome) values ('member.create', 'made_up') $$, '23514', null, 'C10: the outcome vocabulary is closed');
select throws_ok($$ insert into public.notification_suppression_log (action, outcome, reason) values ('member.create', 'suppressed', 'Has Capitals!') $$, '23514', null, 'C10: the reason must be a slug');


-- ═══ D. Importer and restore paths never notify (56-60) ═════════════════════
select ok(
  not has_table_privilege('kolekto_importer', 'public.audit_logs', 'INSERT')
  and not has_function_privilege('kolekto_importer', 'app.write_audit_log(uuid,public.audit_actor_type,uuid,text,text,uuid,jsonb,jsonb,text,inet,text)', 'EXECUTE')
  and not has_function_privilege('kolekto_importer', 'app.enqueue_notification_on_audit()', 'EXECUTE'),
  'D: the importer role can neither write an audit row, call the audit writer, nor call the enqueue function: an import cannot produce an event');

create temporary table tmp_q as select count(*)::int as n from pgmq.q_notification_events;
insert into public.members (id, community_id, full_name, phone_e164, member_code, status, joined_via)
values ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-00000000000a', 'Direct Insert', '+2348095550999', 'P3/9999', 'unclaimed', 'manual');
select is((select count(*)::int from pgmq.q_notification_events), (select n from tmp_q),
  'D: a direct insert into members (a seed, a script) writes no audit row and enqueues nothing');

set local session_replication_role = replica;
create temporary table tmp_restore as
  select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000801') as id;
set local session_replication_role = origin;
select is(pg_temp.queued((select id from tmp_restore)), 0,
  'D: rows loaded with triggers off (the restore path, session_replication_role = replica) enqueue nothing');
select is((select count(*)::int from public.audit_logs where id = (select id from tmp_restore)), 1,
  'D: although the restored audit row itself is present');

select is(pg_temp.queued(pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000802')), 1,
  'D: and with triggers back on, a new audit row enqueues again (the restore setting did not leak)');


-- ═══ E. Earlier protections are intact (61-64) ═════════════════════════════
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.notification_events'::regclass and tgname = 'notification_events_sanitize_payload' and not tgisinternal)
  and exists (select 1 from pg_constraint where conname = 'notification_events_payload_safe'),
  'E: the payload sanitize trigger and constraint from the previous migrations are still in place');
create temporary table tmp_e as
  with ins as (
    insert into public.notification_events (community_id, event_type, event_key, actor_type, object_type, object_id, payload)
    values ('a2000000-0000-4000-8000-00000000000a', 'member.create', 'p3.nested:1', 'officer', 'member', 'a4000000-0000-4000-8000-000000000902',
            '{"keep":"yes","outer":{"Reason":"officer text","list":[{"phone":"+2348000000000"}]}}')
    returning payload)
  select payload from ins;
select is(
  (select payload from tmp_e),
  '{"keep":"yes","outer":{"list":[{}]}}'::jsonb,
  'E: the recursive, case-insensitive payload protection still strips nested banned keys'
);
select is((select count(*)::int from public.notification_deliveries where channel = 'email'), 0,
  'E: no email delivery row exists. P3 writes none, and the trigger cannot create deliveries at all');
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'app.enqueue_notification_on_audit()'::regprocedure)
  and not has_function_privilege('authenticated', 'app.enqueue_notification_on_audit()', 'EXECUTE')
  and not has_function_privilege('anon', 'app.enqueue_notification_on_audit()', 'EXECUTE'),
  'E: the trigger function is SECURITY DEFINER with a pinned search_path and is not callable by a client role');


-- ═══ F. The trigger can never break a valid business write (65-72) ══════════
-- Run LAST: it destroys the queue and the log table, inside this rolled-back transaction.
select set_config('kolekto.suppress_notifications', '', true);

-- F0. The log table is broken but the queue is fine. A broken RECORD must never lose or hide a notification.
alter table public.notification_suppression_log rename to notification_suppression_log_moved;
create temporary table tmp_f0 as
  select pg_temp.owner_creates_member('Untrusted Setting And No Log', '+2348095550404', pg_temp.sv(300)) as member_id;
select is(pg_temp.queued(pg_temp.audit_id_for((select member_id from tmp_f0), 'member.create')), 1,
  'F0: a public caller''s setting is ignored AND the log table is broken: the event is still enqueued (the failed record must not abandon the notification)');
select set_config('kolekto.suppress_notifications', pg_temp.sv(300), true);
create temporary table tmp_f0b as select pg_temp.audit('officer', 'member.create', 'a4000000-0000-4000-8000-000000000a01') as id;
select set_config('kolekto.suppress_notifications', '', true);
select is(pg_temp.queued((select id from tmp_f0b)), 1,
  'F0: a valid operator suppression that CANNOT be recorded is not honoured: the event is enqueued, never silently lost');
alter table public.notification_suppression_log_moved rename to notification_suppression_log;
-- F1. A malformed setting, through a real domain function.
create temporary table tmp_f1 as
  select pg_temp.owner_creates_member('Write With Malformed Setting', '+2348095550401', 'v1|not-a-number|!!') as member_id;
select ok(exists (select 1 from public.members where id = (select member_id from tmp_f1)),
  'F1: app.create_member succeeds when the suppression setting is malformed');
select is(pg_temp.queued(pg_temp.audit_id_for((select member_id from tmp_f1), 'member.create')), 1,
  'F1: and its notification event is still enqueued');

-- F2. The queue is gone entirely.
select pgmq.drop_queue('notification_events');
create temporary table tmp_f2 as
  select pg_temp.owner_creates_member('Write With No Queue', '+2348095550402') as member_id;
select ok(exists (select 1 from public.members where id = (select member_id from tmp_f2)),
  'F2: app.create_member still succeeds when the queue does not exist (the business write is not rolled back)');
select ok(exists (select 1 from public.audit_logs where object_id = (select member_id from tmp_f2) and action = 'member.create'),
  'F2: and its audit row is committed');
select is(pg_temp.logged(pg_temp.audit_id_for((select member_id from tmp_f2), 'member.create'), 'enqueue_failed'), 1,
  'F2: the absorbed failure is recorded as enqueue_failed, so it is visible rather than silent');
select ok(not exists (select 1 from information_schema.tables where table_schema = 'pgmq' and table_name = 'q_notification_events'),
  'F2: and no event was created (nothing was half-written to a queue that no longer exists)');

-- F3. The log table is ALSO gone: recording the failure must not become a failure.
alter table public.notification_suppression_log rename to notification_suppression_log_moved;
create temporary table tmp_f3 as
  select pg_temp.owner_creates_member('Write With No Queue And No Log', '+2348095550403') as member_id;
select ok(exists (select 1 from public.members where id = (select member_id from tmp_f3))
          and exists (select 1 from public.audit_logs where object_id = (select member_id from tmp_f3) and action = 'member.create'),
  'F3: with both the queue and the log table missing, the business write and its audit row still commit');


select * from finish();
rollback;
