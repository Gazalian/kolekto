-- ─────────────────────────────────────────────────────────────────────────────
-- 20260918140100 — Phase 2: application write functions
--
-- ADR 0008 / SEC-14: `authenticated` holds SELECT only (20260917121100_grants).
-- There are no INSERT, UPDATE or DELETE policies anywhere in this schema, on
-- purpose. Every write a Phase 2 application feature needs — creating a named
-- community, managing members, inviting people — goes through a named
-- SECURITY DEFINER function here: it re-checks `app.has_permission`, re-derives
-- tenancy from the row rather than trusting a client-supplied community_id
-- (SEC-18), and writes an audit row (AUD-01) before returning.
--
-- These are called from `apps/web` server actions via `supabase.rpc(...)`,
-- never directly from a browser holding only a publishable key — but the
-- database does not rely on that discipline. The function IS the authorization
-- boundary; the server action is where the call happens to be made from.
--
-- Functions in this file, grouped:
--   Communities        create_community, update_community_profile
--   Members            create_member, update_member, archive_member
--   Member invites     create_invite_link, revoke_invite_link,
--                       redeem_invite_link, approve_pending_member,
--                       reject_pending_member
--   Officer invites     create_officer_invitation, accept_officer_invitation,
--                       decline_officer_invitation, revoke_officer_invitation
--   Officer terms       end_officer_term
--
-- Explicitly NOT built here (documented, not silently skipped):
--   · community.archive — PRD marks it "requires_second_approver" and no
--     approval-queue table exists yet. Building a single-approver version
--     would misrepresent the permission; building the queue is a schema
--     decision bigger than Phase 2's brief. Left for the phase that owns it.
--   · member_groups CRUD (group.manage) — groups already exist as data
--     (seeded) and are readable; creating/editing them is a small, separable
--     follow-up, not a blocker for members or invitations.
--   · leadership handover (HND-*) — its own phase per the PRD; officer
--     invite/accept/end below covers ordinary team management without it.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Shared helpers ───────────────────────────────────────────────────────────

-- Raises FORBIDDEN rather than making every function below repeat the same
-- three lines. Not SECURITY DEFINER itself — it only calls app.has_permission,
-- which already is, and every caller of this helper is itself a SECURITY
-- DEFINER function running as the (superuser-equivalent) function owner, so no
-- additional EXECUTE grant is needed for the nested call to succeed.
create or replace function app.require_permission(p_community_id uuid, p_permission text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not app.has_permission(p_community_id, p_permission) then
    raise exception 'FORBIDDEN: missing permission % in community %', p_permission, p_community_id
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function app.require_permission(uuid, text) from public;

-- Shared by every invite path (MEM-05, OFF-01). SEC-20b: the raw token is
-- returned to the caller exactly once, here, and never stored — only its hash
-- and a short prefix are persisted.
create or replace function app.generate_secret_token()
returns table (token text, token_prefix text, token_hash text)
language sql
volatile
set search_path = ''
as $$
  select t, left(t, 12), encode(extensions.digest(t, 'sha256'), 'hex')
  from (select encode(extensions.gen_random_bytes(24), 'hex') as t) as generated;
$$;

revoke all on function app.generate_secret_token() from public;


-- ─────────────────────────────────────────────────────────────────────────────
-- Communities
-- ─────────────────────────────────────────────────────────────────────────────

-- Section 16: a signed-in person starts a named community. No permission check
-- beyond being signed in — there is no existing community to hold a role in
-- yet, and being the founder is what makes the caller its owner (ADR 0004,
-- mirroring the sign-up bootstrap in 20260918140000).
create or replace function app.create_community(
  p_name        text,
  p_type        public.community_type,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id      uuid := auth.uid();
  v_community_id uuid;
  v_actor_name   text;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED: sign in to create a community' using errcode = '28000';
  end if;
  if p_type = 'personal' then
    raise exception 'INVALID_COMMUNITY_TYPE: personal communities are created at sign-up only' using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_name, '')) < 3 or char_length(p_name) > 80 then
    raise exception 'INVALID_NAME: community name must be 3 to 80 characters' using errcode = 'P0001';
  end if;

  select full_name into v_actor_name from public.users where id = v_user_id;

  v_community_id := app.uuid_generate_v7();

  insert into public.communities (id, slug, name, type, description, is_personal, created_by)
  values (v_community_id, app.generate_unique_community_slug(p_name), p_name, p_type, p_description, false, v_user_id);

  insert into public.officer_terms (community_id, user_id, role, actor_name_snapshot, start_reason)
  values (v_community_id, v_user_id, 'owner', v_actor_name, 'created');

  perform app.write_audit_log(
    v_community_id, 'officer', v_user_id, 'community.create', 'community', v_community_id,
    null, to_jsonb(p_name)
  );

  return v_community_id;
end;
$$;

comment on function app.create_community(text, public.community_type, text) is
  'Section 16: creates a named community with the caller as its owner. The one write path that needs no pre-existing permission, because there is no community yet to hold one in.';

-- Full-replace semantics (PRD section 20 / community.edit_profile): pass every
-- editable field, not a sparse patch. Simpler than distinguishing "omitted"
-- from "cleared" for a handful of optional text fields, and the UI form
-- already holds the current values when it calls this.
create or replace function app.update_community_profile(
  p_community_id            uuid,
  p_name                    text,
  p_description             text default null,
  p_logo_url                text default null,
  p_location_state          text default null,
  p_location_city           text default null,
  p_institution              text default null,
  p_contact_email           extensions.citext default null,
  p_contact_phone_e164      text default null,
  p_show_officers_publicly  boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_phone  text := app.normalise_phone(p_contact_phone_e164);
begin
  perform app.require_permission(p_community_id, 'community.edit_profile');

  if p_contact_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_contact_phone_e164
      using errcode = 'P0001';
  end if;

  select to_jsonb(c) into v_before from public.communities c where c.id = p_community_id;
  if v_before is null then
    raise exception 'NOT_FOUND: community % does not exist' , p_community_id using errcode = 'P0002';
  end if;

  update public.communities set
    name                    = p_name,
    description             = p_description,
    logo_url                = p_logo_url,
    location_state          = p_location_state,
    location_city           = p_location_city,
    institution             = p_institution,
    contact_email           = p_contact_email,
    contact_phone_e164      = v_phone,
    show_officers_publicly  = p_show_officers_publicly
  where id = p_community_id;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'community.update_profile', 'community', p_community_id,
    v_before, (select to_jsonb(c) from public.communities c where c.id = p_community_id)
  );
end;
$$;

comment on function app.update_community_profile is
  'community.edit_profile. Full-replace update of the community''s editable profile fields, audited before/after.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Members
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.create_member(
  p_community_id uuid,
  p_full_name    text,
  p_phone_e164   text default null,
  p_email        extensions.citext default null,
  p_identifier   text default null,
  p_attributes   jsonb default '{}'::jsonb,
  p_group_ids    uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_phone     text := app.normalise_phone(p_phone_e164);
  v_group_id  uuid;
begin
  perform app.require_permission(p_community_id, 'member.create');

  if p_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: member name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  v_member_id := app.uuid_generate_v7();

  insert into public.members (
    id, community_id, full_name, phone_e164, email, identifier, attributes,
    status, joined_via, created_by
  ) values (
    v_member_id, p_community_id, p_full_name, v_phone, p_email, p_identifier, coalesce(p_attributes, '{}'::jsonb),
    'unclaimed', 'manual', auth.uid()
  );

  foreach v_group_id in array coalesce(p_group_ids, '{}')
  loop
    insert into public.member_group_memberships (member_id, group_id, added_by)
    select v_member_id, id, auth.uid()
    from public.member_groups
    where id = v_group_id and community_id = p_community_id;
  end loop;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'member.create', 'member', v_member_id,
    null, to_jsonb(p_full_name)
  );

  return v_member_id;
end;
$$;

comment on function app.create_member is
  'member.create (MEM-*). Adds a member record — not a user account (ADR 0004). Group ids outside the community are silently ignored rather than trusted (SEC-18).';

create or replace function app.update_member(
  p_member_id  uuid,
  p_full_name  text,
  p_phone_e164 text default null,
  p_email      extensions.citext default null,
  p_identifier text default null,
  p_attributes jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_before       jsonb;
  v_phone        text := app.normalise_phone(p_phone_e164);
begin
  select community_id, to_jsonb(m) into v_community_id, v_before
  from public.members m where m.id = p_member_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'member.edit');

  if p_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: member name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  update public.members set
    full_name  = p_full_name,
    phone_e164 = v_phone,
    email      = p_email,
    identifier = p_identifier,
    attributes = coalesce(p_attributes, '{}'::jsonb)
  where id = p_member_id;

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'member.update', 'member', p_member_id,
    v_before, (select to_jsonb(m) from public.members m where m.id = p_member_id)
  );
end;
$$;

comment on function app.update_member is
  'member.edit. Tenancy is re-derived from the member row, never taken from a client-supplied community_id (SEC-18).';

-- MEM-13: archiving, never deleting, is how a member with (eventual) financial
-- history leaves the roll. Applied uniformly here even before obligations
-- exist, so the UI and the API contract do not change when they do.
create or replace function app.archive_member(p_member_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_before       jsonb;
begin
  select community_id, to_jsonb(m) into v_community_id, v_before
  from public.members m where m.id = p_member_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'member.archive');

  update public.members set status = 'archived', archived_at = now() where id = p_member_id;

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'member.archive', 'member', p_member_id,
    v_before, (select to_jsonb(m) from public.members m where m.id = p_member_id), p_reason
  );
end;
$$;

comment on function app.archive_member is
  'member.archive (MEM-13). Members are archived, never deleted — the delete-guard trigger enforces this once obligations exist; this function is the intended path even before then.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Member invite links (MEM-05)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.create_invite_link(
  p_community_id       uuid,
  p_group_ids          uuid[]  default '{}',
  p_allow_group_choice boolean default false,
  p_allow_multi_group  boolean default false,
  p_approve_joiners    boolean default false,
  p_expires_at         timestamptz default null,
  p_max_uses           integer default null,
  p_label              text default null
)
returns table (id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := app.uuid_generate_v7();
  v_generated record;
begin
  perform app.require_permission(p_community_id, 'invite.create');

  select * into v_generated from app.generate_secret_token();

  insert into public.invite_links (
    id, community_id, token_prefix, token_hash, group_ids, allow_group_choice,
    allow_multi_group, approve_joiners, expires_at, max_uses, label, created_by
  ) values (
    v_id, p_community_id, v_generated.token_prefix, v_generated.token_hash, coalesce(p_group_ids, '{}'),
    p_allow_group_choice, p_allow_multi_group, p_approve_joiners, p_expires_at, p_max_uses, p_label, auth.uid()
  );

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'invite_link.create', 'invite_link', v_id
  );

  return query select v_id, v_generated.token;
end;
$$;

comment on function app.create_invite_link is
  'invite.create (MEM-05). Returns the raw token exactly once (SEC-20b) — only its hash is ever stored.';

create or replace function app.revoke_invite_link(p_invite_link_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select community_id into v_community_id from public.invite_links where id = p_invite_link_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: invite link % does not exist', p_invite_link_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'invite.create');

  update public.invite_links set status = 'revoked', revoked_at = now()
  where id = p_invite_link_id and status = 'active';

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'invite_link.revoke', 'invite_link', p_invite_link_id
  );
end;
$$;

-- SEC-20b / MEM-05: the one write path a person with no Kolekto account can
-- reach at all (granted to anon — see the grants migration). Everything it can
-- do is bounded tightly: create exactly one members row, in exactly the
-- community the link belongs to, with a status that never claims a
-- verification (phone OTP, officer approval) that did not happen.
create or replace function app.redeem_invite_link(
  p_token      text,
  p_full_name  text,
  p_phone_e164 text,
  p_email      extensions.citext default null,
  p_group_ids  uuid[] default '{}'
)
returns table (member_id uuid, status public.member_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link      public.invite_links%rowtype;
  v_phone     text := app.normalise_phone(p_phone_e164);
  v_status    public.member_status;
  v_member_id uuid;
  v_group_id  uuid;
begin
  if v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_phone_e164 using errcode = 'P0001';
  end if;
  if char_length(coalesce(p_full_name, '')) < 1 or char_length(p_full_name) > 120 then
    raise exception 'INVALID_NAME: name must be 1 to 120 characters' using errcode = 'P0001';
  end if;

  select * into v_link
  from public.invite_links
  where token_prefix = left(p_token, 12)
  limit 1;

  if v_link.id is null or v_link.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex') then
    raise exception 'INVITE_NOT_FOUND: this invite link is not valid' using errcode = 'P0002';
  end if;
  if v_link.status = 'revoked' then
    raise exception 'INVITE_REVOKED: this invite link has been revoked' using errcode = 'P0001';
  end if;
  if v_link.expires_at is not null and v_link.expires_at <= now() then
    raise exception 'INVITE_EXPIRED: this invite link has expired' using errcode = 'P0001';
  end if;
  if v_link.max_uses is not null and v_link.uses >= v_link.max_uses then
    raise exception 'INVITE_EXHAUSTED: this invite link has reached its usage limit' using errcode = 'P0001';
  end if;
  if v_link.status <> 'active' then
    raise exception 'INVITE_UNAVAILABLE: this invite link is no longer active' using errcode = 'P0001';
  end if;

  -- 'active' requires phone verification this endpoint does not perform
  -- (CON-22 is a separate OTP challenge); 'unclaimed' is the closest honest
  -- status for "on the roll, not yet confirmed" (comment on public.members).
  v_status := case when v_link.approve_joiners then 'pending_approval' else 'unclaimed' end;
  v_member_id := app.uuid_generate_v7();

  insert into public.members (
    id, community_id, full_name, phone_e164, email, status, joined_via,
    invite_link_id, created_by
  ) values (
    v_member_id, v_link.community_id, p_full_name, v_phone, p_email, v_status, 'invite_link',
    v_link.id, null
  );

  foreach v_group_id in array coalesce(v_link.group_ids, '{}')
  loop
    insert into public.member_group_memberships (member_id, group_id)
    values (v_member_id, v_group_id);
  end loop;

  if v_link.allow_group_choice then
    foreach v_group_id in array coalesce(p_group_ids, '{}')
    loop
      insert into public.member_group_memberships (member_id, group_id)
      select v_member_id, id
      from public.member_groups
      where id = v_group_id and community_id = v_link.community_id and pickable_at_join
      on conflict do nothing;

      exit when not v_link.allow_multi_group;
    end loop;
  end if;

  -- Table-qualified: `status` is also the name of this function's second OUT
  -- parameter (returns table (member_id uuid, status ...)), which PL/pgSQL
  -- exposes as a variable, so the bare column name is ambiguous by default.
  update public.invite_links
  set uses = invite_links.uses + 1,
      status = case when invite_links.max_uses is not null and invite_links.uses + 1 >= invite_links.max_uses
                     then 'exhausted'::public.invite_status
                     else invite_links.status end
  where id = v_link.id;

  perform app.write_audit_log(
    v_link.community_id, 'member', null, 'member.join_via_invite', 'member', v_member_id
  );

  return query select v_member_id, v_status;
end;
$$;

comment on function app.redeem_invite_link is
  'MEM-05, anonymous. Joins the community as an unconfirmed member. Never marks a member ''active'' — that status means phone-verified (CON-22), which this endpoint does not perform.';

create or replace function app.approve_pending_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_status       public.member_status;
begin
  select community_id, status into v_community_id, v_status from public.members where id = p_member_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'invite.approve');

  if v_status <> 'pending_approval' then
    raise exception 'INVALID_STATE: member % is not pending approval', p_member_id using errcode = 'P0001';
  end if;

  update public.members set status = 'unclaimed' where id = p_member_id;

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'member.approve_join', 'member', p_member_id
  );
end;
$$;

comment on function app.approve_pending_member is
  'invite.approve (MEM-09). Moves a link joiner off the approval queue. Not ''active'' — approval attests intent to join, not phone ownership.';

-- A rejected pending-approval row has no financial history by construction
-- (MEM-13's guard only protects members with obligations), so deleting it
-- outright is correct rather than an archive that would clutter the roll with
-- people who were never accepted.
create or replace function app.reject_pending_member(p_member_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_status       public.member_status;
  v_before       jsonb;
begin
  select community_id, status, to_jsonb(m) into v_community_id, v_status, v_before
  from public.members m where m.id = p_member_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'invite.approve');

  if v_status <> 'pending_approval' then
    raise exception 'INVALID_STATE: member % is not pending approval', p_member_id using errcode = 'P0001';
  end if;

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'member.reject_join', 'member', p_member_id,
    v_before, null, p_reason
  );

  delete from public.members where id = p_member_id;
end;
$$;

comment on function app.reject_pending_member is
  'invite.approve. Deletes a rejected join request — safe because a pending-approval member has no financial history yet (MEM-13).';


-- ─────────────────────────────────────────────────────────────────────────────
-- Officer invitations (OFF-01)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.create_officer_invitation(
  p_community_id       uuid,
  p_role               public.officer_role,
  p_title              text default null,
  p_scope              jsonb default null,
  p_invitee_name       text default null,
  p_invitee_phone_e164 text default null,
  p_invitee_email      extensions.citext default null
)
returns table (id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id        uuid := app.uuid_generate_v7();
  v_generated record;
  v_phone     text := app.normalise_phone(p_invitee_phone_e164);
begin
  perform app.require_permission(p_community_id, 'officer.invite');

  -- Only an existing owner may grant the owner role. officer.invite alone is
  -- held by admin and treasurer too (PRD 2.2), and neither should be able to
  -- mint a co-owner — the schema has no finer-grained permission for this, so
  -- the check is here rather than left unenforced.
  if p_role = 'owner' and not app.has_permission(p_community_id, 'officer.remove_owner') then
    raise exception 'FORBIDDEN: only an owner may invite another owner' using errcode = '42501';
  end if;

  if p_invitee_phone_e164 is not null and v_phone is null then
    raise exception 'INVALID_PHONE: % is not a recognisable phone number', p_invitee_phone_e164 using errcode = 'P0001';
  end if;
  if v_phone is null and p_invitee_email is null then
    raise exception 'UNREACHABLE: an officer invitation needs a phone number or an email address' using errcode = 'P0001';
  end if;
  if p_scope is not null and p_role <> 'collector' then
    raise exception 'INVALID_SCOPE: only a collector invitation may carry a scope' using errcode = 'P0001';
  end if;

  select * into v_generated from app.generate_secret_token();

  insert into public.officer_invitations (
    id, community_id, role, title, scope, invitee_name, invitee_phone_e164, invitee_email,
    token_prefix, token_hash, invited_by
  ) values (
    v_id, p_community_id, p_role, p_title, p_scope, p_invitee_name, v_phone, p_invitee_email,
    v_generated.token_prefix, v_generated.token_hash, auth.uid()
  );

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'officer_invitation.create', 'officer_invitation', v_id,
    null, jsonb_build_object('role', p_role)
  );

  return query select v_id, v_generated.token;
end;
$$;

comment on function app.create_officer_invitation is
  'officer.invite (OFF-01). Returns the raw token once (SEC-20b). Granting the owner role requires officer.remove_owner, not just officer.invite.';

create or replace function app.revoke_officer_invitation(p_officer_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select community_id into v_community_id from public.officer_invitations where id = p_officer_invitation_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: officer invitation % does not exist', p_officer_invitation_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'officer.invite');

  update public.officer_invitations set status = 'revoked', revoked_at = now()
  where id = p_officer_invitation_id and status = 'sent';

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'officer_invitation.revoke', 'officer_invitation', p_officer_invitation_id
  );
end;
$$;

-- Shared identity check for accept/decline: the signed-in caller must be the
-- person the invitation names (matches the officer_invitations_select_invitee
-- RLS policy's own logic), so a leaked token cannot be used by anyone other
-- than its addressee even though they could still read the row.
create or replace function app.assert_is_invitee(p_invitation public.officer_invitations)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_matches boolean;
begin
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (
        (p_invitation.invitee_email is not null and u.email = p_invitation.invitee_email)
        or (p_invitation.invitee_phone_e164 is not null and u.phone_e164 = p_invitation.invitee_phone_e164)
      )
  ) into v_matches;

  if not v_matches then
    raise exception 'FORBIDDEN: this invitation was not addressed to the signed-in account' using errcode = '42501';
  end if;
end;
$$;

revoke all on function app.assert_is_invitee(public.officer_invitations) from public;

create or replace function app.accept_officer_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation   public.officer_invitations%rowtype;
  v_user_id      uuid := auth.uid();
  v_actor_name   text;
  v_officer_term uuid;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED: sign in to accept an officer invitation' using errcode = '28000';
  end if;

  select * into v_invitation
  from public.officer_invitations
  where token_prefix = left(p_token, 12)
  limit 1;

  if v_invitation.id is null or v_invitation.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex') then
    raise exception 'INVITE_NOT_FOUND: this invitation is not valid' using errcode = 'P0002';
  end if;
  if v_invitation.status = 'revoked' then
    raise exception 'INVITE_REVOKED: this invitation has been revoked' using errcode = 'P0001';
  end if;
  if v_invitation.status = 'declined' then
    raise exception 'INVITE_DECLINED: this invitation was already declined' using errcode = 'P0001';
  end if;
  if v_invitation.status = 'accepted' then
    raise exception 'INVITE_ALREADY_ACCEPTED: this invitation was already accepted' using errcode = 'P0001';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception 'INVITE_EXPIRED: this invitation has expired' using errcode = 'P0001';
  end if;

  perform app.assert_is_invitee(v_invitation);

  if exists (
    select 1 from public.officer_terms
    where community_id = v_invitation.community_id and user_id = v_user_id and ended_at is null
  ) then
    raise exception 'ALREADY_AN_OFFICER: you already hold an active role in this community' using errcode = 'P0001';
  end if;

  select full_name into v_actor_name from public.users where id = v_user_id;
  v_officer_term := app.uuid_generate_v7();

  insert into public.officer_terms (
    id, community_id, user_id, role, title, scope, actor_name_snapshot, start_reason
  ) values (
    v_officer_term, v_invitation.community_id, v_user_id, v_invitation.role, v_invitation.title,
    v_invitation.scope, v_actor_name, 'invited'
  );

  update public.officer_invitations
  set status = 'accepted', accepted_at = now(), accepted_by = v_user_id
  where id = v_invitation.id;

  perform app.write_audit_log(
    v_invitation.community_id, 'officer', v_user_id, 'officer_invitation.accept', 'officer_term', v_officer_term,
    null, jsonb_build_object('role', v_invitation.role)
  );

  return v_officer_term;
end;
$$;

comment on function app.accept_officer_invitation is
  'OFF-01. The invitee must already be signed in (ADR ''sign in with OTP and accept''); identity is re-checked against the invitation, never trusted from the token alone.';

create or replace function app.decline_officer_invitation(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.officer_invitations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: sign in to decline an officer invitation' using errcode = '28000';
  end if;

  select * into v_invitation
  from public.officer_invitations
  where token_prefix = left(p_token, 12)
  limit 1;

  if v_invitation.id is null or v_invitation.token_hash <> encode(extensions.digest(p_token, 'sha256'), 'hex') then
    raise exception 'INVITE_NOT_FOUND: this invitation is not valid' using errcode = 'P0002';
  end if;
  if v_invitation.status <> 'sent' then
    raise exception 'INVALID_STATE: this invitation is no longer open' using errcode = 'P0001';
  end if;

  perform app.assert_is_invitee(v_invitation);

  update public.officer_invitations set status = 'declined', declined_at = now() where id = v_invitation.id;

  perform app.write_audit_log(
    v_invitation.community_id, 'officer', auth.uid(), 'officer_invitation.decline', 'officer_invitation', v_invitation.id
  );
end;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- Officer terms
-- ─────────────────────────────────────────────────────────────────────────────

-- Ends an officer's term — a resignation (self) or a removal (someone else
-- with the matching permission). ROLE-02 (a community keeps at least one
-- active owner) is enforced by the existing deferred constraint trigger on
-- officer_terms, not repeated here: this function does not need to guess
-- whether ending a given term is safe, because the database already will not
-- let the transaction commit if it is not.
create or replace function app.end_officer_term(
  p_officer_term_id uuid,
  p_reason          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_term        public.officer_terms%rowtype;
  v_caller      uuid := auth.uid();
  v_is_self     boolean;
  v_end_reason  public.officer_term_end_reason;
begin
  select * into v_term from public.officer_terms where id = p_officer_term_id and ended_at is null;
  if v_term.id is null then
    raise exception 'NOT_FOUND: no active officer term % found', p_officer_term_id using errcode = 'P0002';
  end if;

  v_is_self := v_term.user_id = v_caller;

  if v_is_self then
    v_end_reason := 'resigned';
  else
    v_end_reason := 'removed';
    if v_term.role = 'owner' then
      perform app.require_permission(v_term.community_id, 'officer.remove_owner');
    else
      perform app.require_permission(v_term.community_id, 'officer.invite');
    end if;
  end if;

  update public.officer_terms
  set ended_at = now(), end_reason = v_end_reason
  where id = p_officer_term_id;

  perform app.write_audit_log(
    v_term.community_id, 'officer', v_caller, 'officer_term.end', 'officer_term', p_officer_term_id,
    jsonb_build_object('role', v_term.role), jsonb_build_object('end_reason', v_end_reason), p_reason
  );
end;
$$;

comment on function app.end_officer_term is
  'A person may always end their own term (resignation). Ending someone else''s requires officer.remove_owner for an owner or officer.invite for any other role. ROLE-02 (never zero owners) is enforced by the existing officer_terms_assert_owner trigger.';
