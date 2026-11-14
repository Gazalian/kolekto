-- ─────────────────────────────────────────────────────────────────────────────
-- 40 — Security regression: member.reject_join audit before_state is minimized
--
-- Migration 20261019120000. app.reject_pending_member must store only
-- full_name, email and joined_via in audit_logs.before_state — never the whole
-- member row (phone_e164, identifier, freeform attributes), which audit.view
-- holders (including the read-only viewer) could otherwise read for someone
-- who was rejected and never became a member.
--
-- Also proves the audit record and its identifying fields survive (the
-- rejection is still auditable) and the member row is deleted.
-- ─────────────────────────────────────────────────────────────────────────────

begin;
set local search_path to extensions, public, app, pg_catalog;
select plan(8);


-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'owner@t40.example.test', now());
insert into public.users (id, full_name, email) values
  ('e0000000-0000-4000-8000-000000000001', 'T40 Owner', 'owner@t40.example.test')
on conflict (id) do update set full_name = excluded.full_name, email = excluded.email;

insert into public.communities (id, slug, name, type, is_personal, created_by) values
  ('e1000000-0000-4000-8000-00000000000a', 't40-reject-audit', 'T40 Reject Audit',
   'fellowship', false, 'e0000000-0000-4000-8000-000000000001');

insert into public.officer_terms (id, community_id, user_id, role, actor_name_snapshot, start_reason) values
  ('e2000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a',
   'e0000000-0000-4000-8000-000000000001', 'owner', 'T40 Owner', 'created');

-- A pending-approval applicant carrying the personal data the audit must NOT
-- retain: phone number and the community-assigned member code.
insert into public.members
  (id, community_id, full_name, phone_e164, email, member_code, status, joined_via)
values
  ('e3000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a',
   'Rejected Applicant', '+2348012345678', 'applicant@t40.example.test', 'MBR-001',
   'pending_approval', 'invite_link');


-- ── Reject as the owner (holds invite.approve) ──────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub":"e0000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok($$
  select app.reject_pending_member('e3000000-0000-4000-8000-000000000001', 'duplicate request')
$$, 'owner can reject a pending-approval member');

reset role;


-- ── The member row is gone, the rejection is still audited ──────────────────
select is(
  (select count(*)::int from public.members
   where id = 'e3000000-0000-4000-8000-000000000001'),
  0, 'the rejected member row is deleted');

select is(
  (select count(*)::int from public.audit_logs
   where action = 'member.reject_join'
     and object_id = 'e3000000-0000-4000-8000-000000000001'),
  1, 'exactly one member.reject_join audit row is written');


-- ── before_state holds ONLY the minimized key set ───────────────────────────
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys(
     (select before_state from public.audit_logs
      where action = 'member.reject_join'
        and object_id = 'e3000000-0000-4000-8000-000000000001')) k),
  array['email', 'full_name', 'joined_via'],
  'before_state has exactly full_name, email and joined_via');


-- ── Identifying fields are preserved (auditability) ─────────────────────────
select is(
  (select before_state ->> 'full_name' from public.audit_logs
   where action = 'member.reject_join'
     and object_id = 'e3000000-0000-4000-8000-000000000001'),
  'Rejected Applicant', 'before_state keeps full_name');

select is(
  (select before_state ->> 'email' from public.audit_logs
   where action = 'member.reject_join'
     and object_id = 'e3000000-0000-4000-8000-000000000001'),
  'applicant@t40.example.test', 'before_state keeps email');


-- ── The surplus PII is NOT retained ─────────────────────────────────────────
select ok(
  (select not (before_state ? 'phone_e164') from public.audit_logs
   where action = 'member.reject_join'
     and object_id = 'e3000000-0000-4000-8000-000000000001'),
  'before_state does not retain phone_e164');

select ok(
  (select not (before_state ? 'member_code') from public.audit_logs
   where action = 'member.reject_join'
     and object_id = 'e3000000-0000-4000-8000-000000000001'),
  'before_state does not retain member_code');


select * from finish();
rollback;
