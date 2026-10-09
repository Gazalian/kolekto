-- ─────────────────────────────────────────────────────────────────────────────
-- 33 — Notification event payloads cannot carry addresses (M13.2 P2 review)
--
-- Migration 20261009100200. notification_events is readable by every officer of
-- a community — collector and viewer included — so its payload must never carry
-- a contact address or an officer's free-text note. The BEFORE INSERT trigger
-- redacts; the CHECK constraint proves. These tests cover the redaction (including
-- a person typing an email address as their name, and an escaped '@'), the
-- constraint's backstop, and what a collector and a viewer can actually read
-- under the real `authenticated` role.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(18);


-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email) values
  ('c1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@pl.example.test'),
  ('c1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'collector@pl.example.test'),
  ('c1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@pl.example.test');

insert into public.users (id, full_name, email) values
  ('c1000000-0000-4000-8000-000000000001', 'Pl Owner',     'owner@pl.example.test'),
  ('c1000000-0000-4000-8000-000000000002', 'Pl Collector', 'collector@pl.example.test'),
  ('c1000000-0000-4000-8000-000000000003', 'Pl Viewer',    'viewer@pl.example.test')
on conflict (id) do update set full_name = excluded.full_name;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('c2000000-0000-4000-8000-00000000000a', 'pl-tests', 'Pl Tests', 'social_group', false, 'c1000000-0000-4000-8000-000000000001');

insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'owner',     'Pl Owner',     'created'),
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000002', 'collector', 'Pl Collector', 'invited'),
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000003', 'viewer',    'Pl Viewer',    'invited');

-- The worker's real payload keys, untouched.
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, object_type, object_id, payload) values
  ('c4000000-0000-4000-8000-0000000000e0', 'c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:clean', 'officer', 'member', 'c3000000-0000-4000-8000-000000000001',
   '{"actor_name":"Ada Officer","community_id":"c2000000-0000-4000-8000-00000000000a","member_code":"PL/0001","member_name":"Chidi Okafor"}');

-- A person typed an email address as their name; a nested value; an escaped '@';
-- an email used as a JSON key; and the banned keys.
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, object_type, object_id, payload) values
  ('c4000000-0000-4000-8000-0000000000e1', 'c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:dirty', 'officer', 'member', 'c3000000-0000-4000-8000-000000000002',
   '{"member_name":"Bob <bob@example.com>","nested":{"list":["carol@example.org","fine"]},"erin@example.com":"as a key","email":"frank@example.com","reason":"officer free text","note":"n","phone":"+2348000000000","before_state":{"email":"g@example.com"},"keep":"kept"}'),
  ('c4000000-0000-4000-8000-0000000000e2', 'c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:name-is-email', 'officer', 'member', 'c3000000-0000-4000-8000-000000000003',
   '{"member_name":"whoever@example.com"}'),
  ('c4000000-0000-4000-8000-0000000000e3', 'c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:handle', 'officer', 'member', 'c3000000-0000-4000-8000-000000000004',
   '{"actor_name":"@ada","note_to_self":"see @ the meeting"}');

-- A JSON @ escape for '@', built with chr(92) so the escape reaches the server as an escape.
insert into public.notification_events (id, community_id, event_type, event_key, actor_type, object_type, object_id, payload) values
  ('c4000000-0000-4000-8000-0000000000e4', 'c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:escaped', 'officer', 'member', 'c3000000-0000-4000-8000-000000000005',
   ('{"member_name":"dave' || chr(92) || 'u0040example.net"}')::jsonb);

create function pg_temp.payload_text_seen_by(p_user uuid, p_event uuid) returns text
language plpgsql as $$
declare t text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select payload::text into t from public.notification_events where id = p_event;
  execute 'reset role';
  return t;
exception when others then
  execute 'reset role';
  raise;
end $$;


-- ── 1. Clean payloads are untouched (1-2) ────────────────────────────────────
select is(
  (select payload from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e0'),
  '{"actor_name":"Ada Officer","community_id":"c2000000-0000-4000-8000-00000000000a","member_code":"PL/0001","member_name":"Chidi Okafor"}'::jsonb,
  'a payload with the worker''s real keys and no addresses is stored exactly as given'
);

select is(
  (select payload ->> 'keep' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e1'),
  'kept',
  'unrelated keys in a payload that needed redaction are preserved'
);


-- ── 2. Redaction (3-9) ───────────────────────────────────────────────────────
select ok(
  (select position('@' in payload::text) = 0 from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e1'),
  'no ''@'' survives anywhere in a payload that was submitted full of addresses (values, nested lists, escapes, keys)'
);

select is(
  (select payload ->> 'member_name' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e1'),
  'Bob [email removed]',
  'an address inside a name is replaced; the rest of the name is kept'
);

select is(
  (select payload ->> 'member_name' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e2'),
  '[email removed]',
  'a name that IS an email address is redacted, and the insert still succeeds (it must not become a poison message)'
);

select is(
  (select payload #>> '{nested,list,0}' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e1'),
  '[email removed]',
  'a nested array value is redacted'
);

select ok(
  (select not (payload ? 'email' or payload ? 'reason' or payload ? 'note' or payload ? 'phone' or payload ? 'before_state')
   from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e1'),
  'the banned keys (email, reason, note, phone, before_state) are removed'
);

select is(
  (select payload ->> 'actor_name' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e3'),
  '@ada',
  'an @handle that is not an email address is left alone'
);

select is(
  (select payload ->> 'note_to_self' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e3'),
  'see @ the meeting',
  'ordinary text containing a lone @ is left alone (the pattern needs local@domain.tld)'
);

select is(
  (select payload ->> 'member_name' from public.notification_events where id = 'c4000000-0000-4000-8000-0000000000e4'),
  '[email removed]',
  'an address written with a JSON unicode escape for @ is still redacted'
);

-- ── 3. The constraint is the backstop (10-12) ────────────────────────────────
select throws_ok(
  $$ insert into public.notification_events (community_id, event_type, event_key, actor_type, object_type, object_id, payload)
     values ('c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:array', 'officer', 'member', 'c3000000-0000-4000-8000-000000000009', '["not","an","object"]') $$,
  '23514', null, 'a payload that is not a JSON object is rejected');

select throws_ok(
  format($$ insert into public.notification_events (community_id, event_type, event_key, actor_type, object_type, object_id, payload)
     values ('c2000000-0000-4000-8000-00000000000a', 'member.create', 'pl.evt:big', 'officer', 'member', 'c3000000-0000-4000-8000-00000000000a', %L) $$,
     json_build_object('blob', repeat('x', 9000))::text),
  '23514', null, 'a payload over 8 KiB is rejected');

select ok(
  exists (select 1 from pg_constraint where conname = 'notification_events_payload_safe' and conrelid = 'public.notification_events'::regclass)
  and exists (select 1 from pg_trigger where tgname = 'notification_events_sanitize_payload' and tgrelid = 'public.notification_events'::regclass and not tgisinternal),
  'the constraint and the sanitize trigger both exist'
);


-- ── 4. What officers can actually read, under the real role (13-15) ──────────
select ok(
  position('@' in pg_temp.payload_text_seen_by('c1000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000e1')) = 0,
  'a COLLECTOR reading the event as the authenticated role sees no address in the payload'
);

select ok(
  position('@' in pg_temp.payload_text_seen_by('c1000000-0000-4000-8000-000000000003', 'c4000000-0000-4000-8000-0000000000e1')) = 0,
  'a VIEWER reading the event as the authenticated role sees no address in the payload'
);

select ok(
  pg_temp.payload_text_seen_by('c1000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-0000000000e2') like '%[email removed]%',
  'the collector sees the redaction marker where a name-that-is-an-email was typed'
);


-- ── 5. The trigger function is internal (16-17) ──────────────────────────────
select ok(
  not has_function_privilege('authenticated', 'app.sanitize_notification_event_payload()', 'EXECUTE')
  and not has_function_privilege('anon', 'app.sanitize_notification_event_payload()', 'EXECUTE'),
  'neither authenticated nor anon can execute the sanitize function directly'
);

select ok(
  not has_function_privilege('public', 'app.sanitize_notification_event_payload()', 'EXECUTE'),
  'nor PUBLIC'
);


select * from finish();
rollback;
