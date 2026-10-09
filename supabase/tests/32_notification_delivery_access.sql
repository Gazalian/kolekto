-- ─────────────────────────────────────────────────────────────────────────────
-- 32 — Who may read email delivery records (M13.2 P2)
--
-- Migrations 20261009100000 + 20261009100100. The decision record's Q-RLS:
-- collectors and viewers (and treasurers, and members, and other communities'
-- officers, and anon) must not read email delivery rows, recipient addresses or
-- error detail. member.view_contact is NOT the gate — collector and viewer hold
-- it, and app.has_permission ignores `scoped` — so a dedicated permission,
-- held by owner and admin only, gates a masked read function.
--
-- Every role is exercised for real: a pg_temp helper switches to the
-- `authenticated` role with that user's JWT claims and counts what RLS lets
-- through, so these assertions are about the database refusing, not about a
-- policy existing.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(59);


-- ── Fixtures: two communities, every officer role, a member with an account ──
insert into auth.users (id, instance_id, aud, role, email) values
  ('f1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'treasurer@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'stranger@dlv.example.test');

insert into public.users (id, full_name, email) values
  ('f1000000-0000-4000-8000-000000000001', 'Dlv Owner',     'owner@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000002', 'Dlv Admin',     'admin@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000003', 'Dlv Treasurer', 'treasurer@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000004', 'Dlv Collector', 'collector@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000005', 'Dlv Viewer',    'viewer@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000006', 'Dlv Outsider',  'outsider@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000007', 'Dlv Member',    'member@dlv.example.test'),
  ('f1000000-0000-4000-8000-000000000008', 'Dlv Stranger',  'stranger@dlv.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('f2000000-0000-4000-8000-00000000000a', 'dlv-tests',       'Dlv Tests', 'social_group', false, 'f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-00000000000b', 'dlv-tests-other', 'Dlv Other', 'social_group', false, 'f1000000-0000-4000-8000-000000000006');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'owner',     'Dlv Owner',     'created'),
  ('f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000002', 'admin',     'Dlv Admin',     'invited'),
  ('f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000003', 'treasurer', 'Dlv Treasurer', 'invited'),
  ('f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000004', 'collector', 'Dlv Collector', 'invited'),
  ('f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000005', 'viewer',    'Dlv Viewer',    'invited'),
  ('f2000000-0000-4000-8000-00000000000b', 'f1000000-0000-4000-8000-000000000006', 'owner',     'Dlv Outsider',  'created');

-- A member who HAS an account (user_id + claimed_at move together), and one who does not.
insert into public.members (id, community_id, full_name, phone_e164, email, member_code, status, joined_via, user_id, claimed_at) values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-00000000000a', 'Ada Lovelace', '+2348095550101', 'ada.lovelace@example.com', 'DLV/0001', 'unclaimed', 'manual',
   'f1000000-0000-4000-8000-000000000007', now());
insert into public.members (id, community_id, full_name, phone_e164, email, member_code, status, joined_via) values
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-00000000000a', 'Bob Babbage', '+2348095550102', 'bob.babbage@example.com', 'DLV/0002', 'unclaimed', 'manual');

insert into public.notification_events (id, community_id, event_type, event_key, actor_type, object_type, object_id, payload) values
  ('f4000000-0000-4000-8000-0000000000e1', 'f2000000-0000-4000-8000-00000000000a', 'member.create', 'dlv.evt:1', 'officer', 'member', 'f3000000-0000-4000-8000-000000000001', '{}'),
  ('f4000000-0000-4000-8000-0000000000e2', 'f2000000-0000-4000-8000-00000000000a', 'member.create', 'dlv.evt:2', 'officer', 'member', 'f3000000-0000-4000-8000-000000000002', '{}'),
  ('f4000000-0000-4000-8000-0000000000e3', 'f2000000-0000-4000-8000-00000000000a', 'member.create', 'dlv.evt:3', 'officer', 'member', 'f3000000-0000-4000-8000-000000000002', '{}'),
  ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'collection.publish', 'dlv.evt:4', 'officer', 'collection', 'f4000000-0000-4000-8000-0000000000b1', '{}'),
  ('f4000000-0000-4000-8000-0000000000e5', 'f2000000-0000-4000-8000-00000000000b', 'member.create', 'dlv.evt:5', 'officer', 'member', 'f4000000-0000-4000-8000-0000000000b5', '{}');

-- Community A: a pending email to an account holder, a permanently failed email to a
-- non-account member, a skipped email (no address kept), and an in-app row for the admin.
-- Community B: one pending email, which no community-A officer may ever see.
insert into public.notification_deliveries
  (id, notification_event_id, community_id, recipient_member_id, recipient_user_id, recipient_address,
   recipient_address_assurance, channel, status, error_code, attempt_count) values
  ('f5000000-0000-4000-8000-00000000d001', 'f4000000-0000-4000-8000-0000000000e1', 'f2000000-0000-4000-8000-00000000000a',
   'f3000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000007', 'ada.lovelace@example.com',
   'verified_account', 'email', 'pending', null, 0),
  ('f5000000-0000-4000-8000-00000000d002', 'f4000000-0000-4000-8000-0000000000e2', 'f2000000-0000-4000-8000-00000000000a',
   'f3000000-0000-4000-8000-000000000002', null, 'bob.babbage@example.com',
   'unverified_supplied', 'email', 'dead', 'provider_rejected_permanent', 5),
  ('f5000000-0000-4000-8000-00000000d003', 'f4000000-0000-4000-8000-0000000000e3', 'f2000000-0000-4000-8000-00000000000a',
   'f3000000-0000-4000-8000-000000000002', null, null,
   null, 'email', 'skipped', 'no_recipient_address', 0);

insert into public.notification_deliveries
  (id, notification_event_id, community_id, recipient_member_id, recipient_user_id, channel, status) values
  ('f5000000-0000-4000-8000-00000000d004', 'f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a',
   null, 'f1000000-0000-4000-8000-000000000002', 'in_app', 'sent');

insert into public.notification_deliveries
  (id, notification_event_id, community_id, recipient_address, recipient_address_assurance, channel, status) values
  ('f5000000-0000-4000-8000-00000000d005', 'f4000000-0000-4000-8000-0000000000e5', 'f2000000-0000-4000-8000-00000000000b',
   'carol.other@example.org', 'unverified_supplied', 'email', 'pending');


-- ── Helpers: act as a real user, under the real `authenticated` role ─────────
-- Each returns a count, or -1 if the database refused with 42501 (FORBIDDEN).
create function pg_temp.email_rows_visible_to(p_user uuid) returns integer
language plpgsql as $$
declare n integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.notification_deliveries where channel <> 'in_app';
  execute 'reset role';
  return n;
exception when others then
  execute 'reset role';
  raise;
end $$;

create function pg_temp.in_app_rows_visible_to(p_user uuid) returns integer
language plpgsql as $$
declare n integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.notification_deliveries where channel = 'in_app';
  execute 'reset role';
  return n;
exception when others then
  execute 'reset role';
  raise;
end $$;

create function pg_temp.log_rows_for(p_user uuid, p_community uuid) returns integer
language plpgsql as $$
declare n integer;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from app.list_email_delivery_log(p_community);
  execute 'reset role';
  return n;
exception
  when insufficient_privilege then
    execute 'reset role';
    return -1;
  when others then
    execute 'reset role';
    raise;
end $$;


-- ── 1. The permission and who holds it (1-3) ─────────────────────────────────
select ok(
  exists (select 1 from public.permissions where key = 'notification.view_delivery_log'),
  'the notification.view_delivery_log permission is in the catalogue'
);

select bag_eq(
  $$ select role::text from public.role_permissions where permission = 'notification.view_delivery_log' $$,
  $$ values ('owner'), ('admin') $$,
  'only owner and admin hold it — not treasurer, not collector, not viewer'
);

select is(
  (select count(*)::int from public.role_permissions where permission = 'notification.view_delivery_log' and scoped),
  0,
  'it is never a scoped permission (has_permission ignores scope, so a scoped grant would be unlimited)'
);


-- ── 2. The broad officer policy is gone; only the own-inbox policy remains (4-5) ──
select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public' and tablename = 'notification_deliveries'
       and policyname = 'notification_deliveries_select_officer' $$,
  'the policy that let every officer read every delivery row no longer exists'
);

select bag_eq(
  $$ select policyname::text from pg_policies where schemaname = 'public' and tablename = 'notification_deliveries' $$,
  $$ values ('notification_deliveries_select_own_inbox') $$,
  'the only policy on notification_deliveries is a user''s own in-app inbox'
);


-- ── 3. No officer role reads an email row from the table (6-12) ──────────────
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000001'), 0, 'owner reads no email delivery row from the table');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000002'), 0, 'admin reads no email delivery row from the table');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000003'), 0, 'treasurer reads no email delivery row from the table');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000004'), 0, 'collector reads no email delivery row from the table');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000005'), 0, 'viewer reads no email delivery row from the table');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000006'), 0, 'another community''s owner reads none');
select is(pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000008'), 0, 'an authenticated user with no role anywhere reads none');


-- ── 4. A recipient does not read their own email row either (13) ─────────────
-- Ada has an account and a pending email addressed to her. Email deliveries are
-- not exposed to members in M13.2 (decision record §9.1).
select is(
  pg_temp.email_rows_visible_to('f1000000-0000-4000-8000-000000000007'),
  0,
  'a member with an account cannot read the email delivery addressed to them'
);


-- ── 5. In-app inbox is unchanged (14-18) ─────────────────────────────────────
select is(pg_temp.in_app_rows_visible_to('f1000000-0000-4000-8000-000000000002'), 1,
  'the admin still reads their own in-app notification (M13.1 behaviour preserved)');
select is(pg_temp.in_app_rows_visible_to('f1000000-0000-4000-8000-000000000001'), 0,
  'the owner does NOT read the admin''s in-app notification (the broad officer policy is really gone)');
select is(pg_temp.in_app_rows_visible_to('f1000000-0000-4000-8000-000000000004'), 0,
  'a collector does not read another user''s in-app notification');
select is(pg_temp.in_app_rows_visible_to('f1000000-0000-4000-8000-000000000006'), 0,
  'another community''s owner does not read it either');
select ok(
  not has_table_privilege('anon', 'public.notification_deliveries', 'SELECT'),
  'anon has no SELECT privilege on notification_deliveries'
);


-- ── 6. The controlled read: who may call it (19-27) ──────────────────────────
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-00000000000a'), 3,
  'owner reads the community''s three email deliveries through the log function');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-00000000000a'), 3,
  'admin reads the same three (and not the in-app row)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'treasurer is refused (42501) — they hold member.view_contact and still may not');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'collector is refused (42501)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'viewer is refused (42501)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000007', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'a member with an account is refused (42501)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000008', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'a user with no role is refused (42501)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-00000000000a'), -1,
  'another community''s owner is refused for this community (42501)');
select is(pg_temp.log_rows_for('f1000000-0000-4000-8000-000000000006', 'f2000000-0000-4000-8000-00000000000b'), 1,
  'and sees only their own community''s single delivery, none of community A''s');


-- ── 7. What the function returns (28-37) ─────────────────────────────────────
-- The helpers leave the last user's claims set for the rest of the transaction; this read
-- is inspected as the owner of community A.
select set_config('request.jwt.claims', '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

create temporary table tmp_log as
  select * from app.list_email_delivery_log('f2000000-0000-4000-8000-00000000000a');
-- (queried as the table owner here to inspect content; the permission gate was
-- proven above by the role-switched calls)
select is((select count(*)::int from tmp_log), 3, 'the log returns the community''s three email rows');

select is(
  (select recipient_address_masked from tmp_log where id = 'f5000000-0000-4000-8000-00000000d001'),
  'a***@example.com',
  'the address is masked: first letter, ***, domain'
);

select ok(
  not exists (select 1 from tmp_log where recipient_address_masked like '%lovelace%' or recipient_address_masked like '%babbage%'),
  'no returned value contains the local part of a real address'
);

select is(
  (select recipient_address_masked from tmp_log where id = 'f5000000-0000-4000-8000-00000000d003'),
  null,
  'a skipped row has no address, so nothing to mask'
);

select is(
  (select error_code from tmp_log where id = 'f5000000-0000-4000-8000-00000000d002'),
  'provider_rejected_permanent',
  'the stable reason code is returned'
);

select is(
  (select recipient_address_assurance from tmp_log where id = 'f5000000-0000-4000-8000-00000000d002'),
  'unverified_supplied',
  'the assurance level is returned, so an unverified address is never presented as verified'
);

select ok(
  not exists (select 1 from tmp_log where id = 'f5000000-0000-4000-8000-00000000d004'),
  'in-app rows are not in the email log'
);

select ok(
  not exists (select 1 from tmp_log where id = 'f5000000-0000-4000-8000-00000000d005'),
  'another community''s delivery is not in this community''s log'
);

select ok(
  pg_get_function_result('app.list_email_delivery_log(uuid,integer,timestamptz)'::regprocedure) not like '%error_message%',
  'the function''s result type has no error_message column'
);

select ok(
  pg_get_function_result('app.list_email_delivery_log(uuid,integer,timestamptz)'::regprocedure) not like '%provider_message_id%',
  'nor a provider message id'
);


-- ── 8. Function reachability (38-43) ─────────────────────────────────────────
select ok(not has_function_privilege('anon', 'app.list_email_delivery_log(uuid,integer,timestamptz)', 'EXECUTE'),
  'anon cannot execute the log function');
select ok(not has_function_privilege('public', 'app.list_email_delivery_log(uuid,integer,timestamptz)', 'EXECUTE'),
  'PUBLIC cannot execute the log function');
select ok(has_function_privilege('authenticated', 'app.list_email_delivery_log(uuid,integer,timestamptz)', 'EXECUTE'),
  'authenticated can call it (and the permission check inside decides)');
select ok(not has_function_privilege('authenticated', 'app.mask_email_address(text)', 'EXECUTE'),
  'the masking helper is not callable by authenticated');
select ok(not has_function_privilege('anon', 'app.mask_email_address(text)', 'EXECUTE'),
  'nor by anon');
select is(app.mask_email_address('x'), '***', 'a malformed address masks to *** rather than echoing itself');


-- ── 9. Table constraints (44-57) ─────────────────────────────────────────────
-- Each insert uses a fresh recipient so it can only fail on the constraint named.
select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', 'unverified_supplied') $$,
  '23514', null, 'a pending email row with no address is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', 'not-an-address', 'unverified_supplied') $$,
  '23514', null, 'an email row with a malformed address is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', E'a@example.com\r\nBcc: evil@example.com', 'unverified_supplied') $$,
  '23514', null, 'an address carrying a line break (header injection) is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', 'a@example.com, b@example.com', 'unverified_supplied') $$,
  '23514', null, 'a list of addresses is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', 'ok@example.com') $$,
  '23514', null, 'a sendable email row must state its contact assurance');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'pending', 'ok@example.com', 'verified_phone') $$,
  '23514', null, 'the assurance vocabulary is closed: there is no value that claims more than we know');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, error_code)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'skipped', 'ok@example.com', 'unverified_supplied', 'consent_missing') $$,
  '23514', null, 'a skipped email row must not store the address');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'skipped') $$,
  '23514', null, 'a skipped row without a reason code is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'failed', 'ok@example.com', 'unverified_supplied') $$,
  '23514', null, 'a failed row without a reason code is rejected');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, error_code)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'failed', 'ok@example.com', 'unverified_supplied', 'Mailbox ada@example.com does not exist') $$,
  '23514', null, 'a raw provider sentence cannot be stored as an error code');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, channel, status, recipient_address, recipient_address_assurance, error_code, error_message)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'email', 'failed', 'ok@example.com', 'unverified_supplied', 'provider_rejected_permanent', '550 5.1.1 user unknown') $$,
  '23514', null, 'raw provider error text cannot be stored in error_message at all');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, recipient_user_id, recipient_address, channel, status)
     values ('f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-000000000001', 'ok@example.com', 'in_app', 'sent') $$,
  '23514', null, 'an in-app row cannot carry an address');

select lives_ok(
  $$ insert into public.notification_deliveries (id, notification_event_id, community_id, recipient_address, recipient_address_assurance, channel, status, dedupe_key)
     values ('f5000000-0000-4000-8000-00000000d0f1', 'f4000000-0000-4000-8000-0000000000e4', 'f2000000-0000-4000-8000-00000000000a', 'dee@example.com', 'unverified_supplied', 'email', 'pending',
             'membership_confirmation:f3000000-0000-4000-8000-000000000002') $$,
  'a well-formed email row with a de-duplication key is accepted');

select throws_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, recipient_address, recipient_address_assurance, channel, status, dedupe_key)
     values ('f4000000-0000-4000-8000-0000000000e3', 'f2000000-0000-4000-8000-00000000000a', 'dee@example.com', 'unverified_supplied', 'email', 'pending',
             'membership_confirmation:f3000000-0000-4000-8000-000000000002') $$,
  '23505', null, 'a second email with the same de-duplication key in the same community is refused (one confirmation per membership)');


-- ── 10. The new states exist (58-59) ─────────────────────────────────────────
select ok(
  'sending'::public.notification_delivery_status is not null and 'dead'::public.notification_delivery_status is not null,
  'the delivery status enum has the sender states: sending and dead'
);

select lives_ok(
  $$ insert into public.notification_deliveries (notification_event_id, community_id, recipient_address, recipient_address_assurance, channel, status, error_code, attempt_count)
     values ('f4000000-0000-4000-8000-0000000000e1', 'f2000000-0000-4000-8000-00000000000a', 'gee@example.com', 'unverified_supplied', 'email', 'dead', 'retries_exhausted', 5) $$,
  'a dead row with a stable reason code is accepted'
);


select * from finish();
rollback;
