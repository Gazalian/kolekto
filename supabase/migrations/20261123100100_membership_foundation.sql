-- ─────────────────────────────────────────────────────────────────────────────
-- 20261123100100 — M9b: membership foundation (product doc Part F §F4, §F6,
-- §F9; owner decisions Q2, Q8, Q10, Q12, Q14 of 2026-11-22, and the owner's
-- 2026-11-22 change that the full ID is stored so it can always be shown)
--
-- What this adds:
--
--   1. Granular, delegable community permissions (Q2). Four new permissions,
--      held by the OWNER role only by default. An owner may grant a delegable
--      permission to one specific officer term; the grant ends with the term.
--      app.has_permission learns to read those grants — every other answer it
--      gives is unchanged (a grant table that is empty changes nothing).
--
--   2. Community membership ID format: prefix + separator + random suffix
--      (default 5), configurable by holders of membership.configure_ids.
--      A change applies to IDs issued afterwards only.
--
--   3. Membership IDs. The ID is generated on the web server. The database
--      stores:
--        · id_hash        HMAC-SHA256 under a server-held key — used for every
--                         lookup and for uniqueness;
--        · id_ciphertext  the full ID, AES-256-GCM under a different server-held
--                         key (owner decision: members must always be able to
--                         see it). The database never holds either key, so a
--                         dump or backup alone does not reveal an ID;
--        · last2          for masked display.
--      No plaintext ID is ever written to a table, audit row or log here.
--
--   4. Suspension: members.suspended_at + status_before_suspension;
--      app.suspend_member / app.reinstate_member (member.suspend).
--
--   5. Validation of an ID for one collection (anonymous, through the web
--      server only — the app schema is not served by PostgREST), with
--      database-backed rate limits per IP hash, per collection and per
--      community, one generic answer for every failure, a lockout audit row for
--      monitoring, and a 30-minute access grant bound to member + collection.
--      NOTHING consumes the grant yet: the payment path is unchanged
--      (owner: no payment-path change in this phase).
--
-- Not touched: payment attempts, capture, contributions, ledger, settlement,
-- withdrawals, reminders, notifications, collection visibility, member_code.
-- Existing member rows: two nullable columns added, no row changed.
--
-- ROLLBACK (itest only; nothing here holds money):
--   drop the functions created below; drop tables membership_access_grants,
--   membership_validation_attempts, membership_ids,
--   community_membership_id_settings, officer_permission_grants; restore
--   app.has_permission to its 20260917120400 body; drop trigger
--   members_clear_suspension_on_archive and its function; alter table
--   public.members drop constraint members_suspension_consistent, drop column
--   suspended_at, drop column status_before_suspension; alter table
--   public.permissions drop column delegable; delete the four new permission
--   keys from role_permissions and permissions.
-- ─────────────────────────────────────────────────────────────────────────────


-- ══ 1. Permissions ═══════════════════════════════════════════════════════════

alter table public.permissions
  add column if not exists delegable boolean not null default false;

comment on column public.permissions.delegable is
  'Q2 (2026-11-22): an owner may grant this permission to one officer term with app.grant_officer_permission. Money, officer and ownership permissions are never delegable.';

insert into public.permissions (key, description) values
  ('membership.configure_ids', 'Configure the community membership ID format'),
  ('membership.issue_ids',     'Issue, replace and revoke membership IDs'),
  ('member.suspend',           'Suspend and reinstate members'),
  ('officer.delegate',         'Grant or remove individual permissions for officers')
on conflict (key) do nothing;

-- Owner only. No other role receives these by default (owner decision Q2:
-- "an officer must not gain permissions simply because they hold a generic
-- officer role").
insert into public.role_permissions (role, permission) values
  ('owner', 'membership.configure_ids'),
  ('owner', 'membership.issue_ids'),
  ('owner', 'member.suspend'),
  ('owner', 'officer.delegate')
on conflict (role, permission) do nothing;

-- The membership-management capabilities an owner may hand to one officer.
-- officer.delegate itself is not delegable: the owner keeps final authority.
update public.permissions
set delegable = true
where key in ('membership.configure_ids', 'membership.issue_ids', 'member.suspend',
              'member.create', 'member.edit', 'invite.approve');


create table public.officer_permission_grants (
  id               uuid primary key default app.uuid_generate_v7(),
  community_id     uuid not null references public.communities (id) on delete cascade,
  officer_term_id  uuid not null references public.officer_terms (id) on delete cascade,
  permission       text not null references public.permissions (key) on delete restrict,
  granted_by       uuid not null references public.users (id) on delete restrict,
  granted_at       timestamptz not null default now(),
  revoked_by       uuid references public.users (id) on delete restrict,
  revoked_at       timestamptz,
  constraint officer_permission_grants_revocation_consistent
    check ((revoked_at is null) = (revoked_by is null))
);

create unique index officer_permission_grants_active_key
  on public.officer_permission_grants (officer_term_id, permission)
  where revoked_at is null;
create index officer_permission_grants_lookup_idx
  on public.officer_permission_grants (community_id, permission)
  where revoked_at is null;

comment on table public.officer_permission_grants is
  'Q2: one delegable permission granted by an owner to one officer term. Read by app.has_permission. Ends with the term (the term join), or when revoked. Written only by app.grant_officer_permission / app.revoke_officer_permission.';

alter table public.officer_permission_grants enable row level security;
alter table public.officer_permission_grants force row level security;
-- No policies: no client role reads or writes this table directly.

-- Defence in depth: whatever writes a row, it must be delegable, and the term
-- must belong to the same community.
create or replace function app.guard_officer_permission_grant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.community_id <> old.community_id or new.officer_term_id <> old.officer_term_id
       or new.permission <> old.permission or new.granted_by <> old.granted_by
       or new.granted_at <> old.granted_at or old.revoked_at is not null then
      raise exception 'GRANT_IS_IMMUTABLE: a permission grant can only be revoked, once' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if not exists (select 1 from public.permissions p where p.key = new.permission and p.delegable) then
    raise exception 'NOT_DELEGABLE: % cannot be granted to an individual officer', new.permission using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.officer_terms ot
                 where ot.id = new.officer_term_id and ot.community_id = new.community_id) then
    raise exception 'TERM_COMMUNITY_MISMATCH' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_officer_permission_grant() from public, anon, authenticated;

create trigger officer_permission_grants_guard
  before insert or update on public.officer_permission_grants
  for each row execute function app.guard_officer_permission_grant();
create trigger officer_permission_grants_no_delete
  before delete on public.officer_permission_grants
  for each row execute function app.block_payment_record_mutation();


-- has_permission: the role matrix, OR an unrevoked grant on the caller's own
-- active term. The first branch is the 20260917120400 body, unchanged.
create or replace function app.has_permission(
  p_community_id uuid,
  p_permission   text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.officer_terms ot
    join public.role_permissions rp
      on rp.role = ot.role
     and rp.permission = p_permission
    where ot.community_id = p_community_id
      and ot.user_id      = auth.uid()
      and ot.ended_at is null
      and ot.started_at <= now()
  )
  or exists (
    select 1
    from public.officer_permission_grants g
    join public.officer_terms ot on ot.id = g.officer_term_id
    where g.community_id = p_community_id
      and g.permission   = p_permission
      and g.revoked_at is null
      and ot.community_id = p_community_id
      and ot.user_id      = auth.uid()
      and ot.ended_at is null
      and ot.started_at <= now()
  );
$$;

comment on function app.has_permission(uuid, text) is
  'SEC-09: does the caller hold this permission in this community, right now? Active officer term via the role matrix, or (Q2, 20261123100100) an unrevoked grant on that active term. Used by every RLS policy and re-checked in every server function (SEC-13, SEC-17).';


create or replace function app.grant_officer_permission(p_officer_term_id uuid, p_permission text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_term public.officer_terms%rowtype;
begin
  select * into v_term from public.officer_terms where id = p_officer_term_id;
  if v_term.id is null then
    raise exception 'NOT_FOUND: officer term' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_term.community_id, 'officer.delegate');

  if v_term.ended_at is not null then
    raise exception 'TERM_ENDED: this person is no longer an officer' using errcode = 'P0001';
  end if;
  if v_term.role = 'owner' then
    raise exception 'NOT_NEEDED: an owner already holds every permission' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission and p.delegable) then
    raise exception 'NOT_DELEGABLE: % cannot be granted to an individual officer', p_permission using errcode = 'P0001';
  end if;

  if exists (select 1 from public.officer_permission_grants g
             where g.officer_term_id = p_officer_term_id and g.permission = p_permission and g.revoked_at is null) then
    return;  -- already granted; nothing to record twice
  end if;

  insert into public.officer_permission_grants (community_id, officer_term_id, permission, granted_by)
  values (v_term.community_id, p_officer_term_id, p_permission, auth.uid());

  perform app.write_audit_log(
    v_term.community_id, 'officer', auth.uid(), 'officer.grant_permission', 'officer_term', p_officer_term_id,
    null, jsonb_build_object('permission', p_permission, 'officer_user_id', v_term.user_id, 'role', v_term.role)
  );
end;
$$;

comment on function app.grant_officer_permission(uuid, text) is
  'Q2. officer.delegate (owner) only: grants one delegable permission to one active, non-owner officer term in the same community. Idempotent. Audited.';

create or replace function app.revoke_officer_permission(p_officer_term_id uuid, p_permission text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_term public.officer_terms%rowtype;
  v_id   uuid;
begin
  select * into v_term from public.officer_terms where id = p_officer_term_id;
  if v_term.id is null then
    raise exception 'NOT_FOUND: officer term' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_term.community_id, 'officer.delegate');

  update public.officer_permission_grants g
  set revoked_at = now(), revoked_by = auth.uid()
  where g.officer_term_id = p_officer_term_id and g.permission = p_permission and g.revoked_at is null
  returning g.id into v_id;

  if v_id is null then
    return;  -- nothing granted; nothing to record
  end if;

  perform app.write_audit_log(
    v_term.community_id, 'officer', auth.uid(), 'officer.revoke_permission', 'officer_term', p_officer_term_id,
    jsonb_build_object('permission', p_permission, 'officer_user_id', v_term.user_id), null
  );
end;
$$;

comment on function app.revoke_officer_permission(uuid, text) is
  'Q2. officer.delegate (owner) only: removes one granted permission from an officer term. Idempotent. Audited.';

-- Owner's view of who holds which granted permission, plus the list of what
-- can be granted. Officers' names come from the term snapshot, never contact.
create or replace function app.list_officer_permission_grants(p_community_id uuid)
returns table (
  officer_term_id uuid,
  officer_name    text,
  role            public.officer_role,
  permission      text,
  granted_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_community_id, 'officer.delegate');
  return query
  select ot.id, coalesce(u.full_name, ot.actor_name_snapshot), ot.role, g.permission, g.granted_at
  from public.officer_permission_grants g
  join public.officer_terms ot on ot.id = g.officer_term_id
  left join public.users u on u.id = ot.user_id
  where g.community_id = p_community_id
    and g.revoked_at is null
    and ot.ended_at is null
  order by 2, g.permission;
end;
$$;

create or replace function app.list_delegable_permissions()
returns table (permission text, description text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.key, p.description from public.permissions p where p.delegable order by p.key;
$$;

-- The caller's own granted permissions in one community, for the UI mirror
-- (apps/web/lib/permissions.ts). Enforcement never relies on it.
create or replace function app.my_granted_permissions(p_community_id uuid)
returns table (permission text)
language sql
stable
security definer
set search_path = ''
as $$
  select g.permission
  from public.officer_permission_grants g
  join public.officer_terms ot on ot.id = g.officer_term_id
  where g.community_id = p_community_id
    and g.revoked_at is null
    and ot.user_id = auth.uid()
    and ot.ended_at is null
    and ot.started_at <= now();
$$;


-- ══ 2. Membership ID format ══════════════════════════════════════════════════

create table public.community_membership_id_settings (
  community_id   uuid primary key references public.communities (id) on delete cascade,
  prefix         text not null,
  separator      text not null default '/',
  suffix_length  smallint not null default 5,
  enabled        boolean not null default false,
  updated_by     uuid references public.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint community_membership_id_settings_prefix_format
    check (prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint community_membership_id_settings_prefix_not_reserved
    check (prefix not in ('KM', 'KLK', 'KOLEKTO', 'KTR', 'KPAY', 'ADMIN', 'ROOT', 'SYS', 'SYSTEM', 'TEST', 'NULL')),
  constraint community_membership_id_settings_separator
    check (separator in ('/', '-')),
  constraint community_membership_id_settings_suffix_length
    check (suffix_length between 5 and 8)
);

comment on table public.community_membership_id_settings is
  'F4.2: how this community''s NEW membership IDs look — PREFIX + separator + random suffix (Crockford base32, at least one letter). Changing it never rewrites an issued ID.';

create trigger community_membership_id_settings_set_updated_at
  before update on public.community_membership_id_settings
  for each row execute function app.set_updated_at();

alter table public.community_membership_id_settings enable row level security;
alter table public.community_membership_id_settings force row level security;


create or replace function app.set_membership_id_settings(
  p_community_id  uuid,
  p_prefix        text,
  p_separator     text,
  p_suffix_length smallint,
  p_enabled       boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := upper(regexp_replace(coalesce(p_prefix, ''), '\s', '', 'g'));
  v_before jsonb;
  v_personal boolean;
begin
  perform app.require_permission(p_community_id, 'membership.configure_ids');

  select is_personal into v_personal from public.communities where id = p_community_id;
  if v_personal then
    raise exception 'NOT_ALLOWED: a personal workspace has no members' using errcode = 'P0001';
  end if;
  if v_prefix !~ '^[A-Z][A-Z0-9]{1,9}$' then
    raise exception 'INVALID_PREFIX: use 2 to 10 letters or numbers, starting with a letter' using errcode = '22023';
  end if;
  if v_prefix in ('KM', 'KLK', 'KOLEKTO', 'KTR', 'KPAY', 'ADMIN', 'ROOT', 'SYS', 'SYSTEM', 'TEST', 'NULL') then
    raise exception 'RESERVED_PREFIX: % is reserved by Kolekto; choose another', v_prefix using errcode = '22023';
  end if;
  if p_separator is null or p_separator not in ('/', '-') then
    raise exception 'INVALID_SEPARATOR: use / or -' using errcode = '22023';
  end if;
  if p_suffix_length is null or p_suffix_length not between 5 and 8 then
    raise exception 'INVALID_SUFFIX_LENGTH: use 5 to 8 random characters' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'INVALID_INPUT: say whether membership IDs are on' using errcode = '22023';
  end if;

  select jsonb_build_object('prefix', s.prefix, 'separator', s.separator,
                            'suffix_length', s.suffix_length, 'enabled', s.enabled)
    into v_before
  from public.community_membership_id_settings s where s.community_id = p_community_id;

  insert into public.community_membership_id_settings
    (community_id, prefix, separator, suffix_length, enabled, updated_by)
  values (p_community_id, v_prefix, p_separator, p_suffix_length, p_enabled, auth.uid())
  on conflict (community_id) do update
    set prefix = excluded.prefix, separator = excluded.separator,
        suffix_length = excluded.suffix_length, enabled = excluded.enabled,
        updated_by = excluded.updated_by;

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'membership.update_id_settings', 'community', p_community_id,
    v_before,
    jsonb_build_object('prefix', v_prefix, 'separator', p_separator,
                       'suffix_length', p_suffix_length, 'enabled', p_enabled)
  );
end;
$$;

comment on function app.set_membership_id_settings(uuid, text, text, smallint, boolean) is
  'F4.2. membership.configure_ids: sets prefix (normalised to upper case), separator, suffix length and the on switch. Affects IDs issued afterwards only. Audited with before/after.';

create or replace function app.get_membership_id_settings(p_community_id uuid)
returns table (prefix text, separator text, suffix_length smallint, enabled boolean, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_community_id, 'community.view_dashboard');
  return query
  select s.prefix, s.separator, s.suffix_length, s.enabled, s.updated_at
  from public.community_membership_id_settings s
  where s.community_id = p_community_id;
end;
$$;


-- ══ 3. Membership IDs ════════════════════════════════════════════════════════

create table public.membership_ids (
  id               uuid primary key default app.uuid_generate_v7(),
  community_id     uuid not null references public.communities (id) on delete restrict,
  member_id        uuid not null references public.members (id) on delete restrict,
  id_hash          bytea not null,
  id_ciphertext    text,
  key_version      smallint not null default 1,
  prefix           text not null,
  separator        text not null,
  last2            text not null,
  issued_at        timestamptz not null default now(),
  issued_by        uuid references public.users (id) on delete set null,
  revoked_at       timestamptz,
  revoked_by       uuid references public.users (id) on delete set null,
  revoke_reason    text,
  constraint membership_ids_hash_length       check (octet_length(id_hash) = 32),
  constraint membership_ids_last2_format      check (last2 ~ '^[0-9A-Z]{2}$'),
  constraint membership_ids_ciphertext_format check (id_ciphertext is null or id_ciphertext ~ '^v[0-9]+\.[A-Za-z0-9_-]+$'),
  constraint membership_ids_live_has_ciphertext check (revoked_at is not null or id_ciphertext is not null),
  constraint membership_ids_reason_length     check (revoke_reason is null or char_length(revoke_reason) <= 500)
);

-- Unique within the community across ALL rows, revoked included: a revoked ID
-- is never issued again to anyone.
create unique index membership_ids_community_hash_key on public.membership_ids (community_id, id_hash);
create unique index membership_ids_one_live_per_member on public.membership_ids (member_id) where revoked_at is null;

comment on table public.membership_ids is
  'F4.4. A member''s membership ID: HMAC hash (lookup, uniqueness) + AES-GCM ciphertext (display; owner decision 2026-11-22) + last two characters. Both keys live on the web server only. A replaced or revoked row keeps its hash (so the ID is never reissued) and loses its ciphertext.';
comment on column public.membership_ids.id_hash is
  'HMAC-SHA256(server key, community_id || '':'' || canonical ID). Never the ID itself.';
comment on column public.membership_ids.id_ciphertext is
  'AES-256-GCM of the full ID under a server-held key, bound to community + member. Null once revoked.';

alter table public.membership_ids enable row level security;
alter table public.membership_ids force row level security;

create or replace function app.guard_membership_id_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.members m where m.id = new.member_id and m.community_id = new.community_id) then
      raise exception 'MEMBER_COMMUNITY_MISMATCH' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- UPDATE: only revocation, once; the hash and identity of the row never move.
  if old.revoked_at is not null
     or new.revoked_at is null
     or new.id_hash <> old.id_hash or new.member_id <> old.member_id or new.community_id <> old.community_id
     or new.issued_at <> old.issued_at or new.last2 <> old.last2 or new.prefix <> old.prefix
     or new.separator <> old.separator or new.key_version <> old.key_version
     or new.id_ciphertext is not null then
    raise exception 'MEMBERSHIP_ID_IS_IMMUTABLE: a membership ID can only be revoked, once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.guard_membership_id_row() from public, anon, authenticated;

create trigger membership_ids_guard
  before insert or update on public.membership_ids
  for each row execute function app.guard_membership_id_row();
create trigger membership_ids_no_delete
  before delete on public.membership_ids
  for each row execute function app.block_payment_record_mutation();
create trigger membership_ids_no_truncate
  before truncate on public.membership_ids
  for each statement execute function app.block_truncate();


-- Statuses in which a member is in good standing (owner decision Q8: an
-- unclaimed member — no Kolekto account linked — is still a member). The same
-- set the collection audience uses. Excluded: pending_approval, suspended,
-- archived, merged.
create or replace function app.member_in_good_standing(p_status public.member_status)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('active', 'unclaimed', 'invited');
$$;

-- Shared by issue and rotate: checks, then inserts one live row. Not granted.
create or replace function app.insert_membership_id(
  p_member      public.members,
  p_id_hash     bytea,
  p_ciphertext  text,
  p_last2       text,
  p_key_version smallint,
  p_prefix      text,
  p_separator   text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.community_membership_id_settings%rowtype;
  v_id       uuid;
  v_constraint text;
begin
  select * into v_settings from public.community_membership_id_settings where community_id = p_member.community_id;
  if v_settings.community_id is null or not v_settings.enabled then
    raise exception 'MEMBERSHIP_IDS_OFF: turn on membership IDs in community settings first' using errcode = 'P0001';
  end if;
  -- The server generated the ID from the settings it read; if they changed in
  -- between, refuse rather than issue an ID in a superseded format.
  if p_prefix is distinct from v_settings.prefix or p_separator is distinct from v_settings.separator then
    raise exception 'SETTINGS_CHANGED: the membership ID format changed; try again' using errcode = 'P0001';
  end if;
  if not app.member_in_good_standing(p_member.status) then
    raise exception 'MEMBER_NOT_ELIGIBLE: a % member cannot hold a membership ID', p_member.status using errcode = 'P0001';
  end if;
  if p_id_hash is null or octet_length(p_id_hash) <> 32 or p_ciphertext is null or p_last2 is null then
    raise exception 'INVALID_INPUT: membership ID material is incomplete' using errcode = '22023';
  end if;

  begin
    insert into public.membership_ids
      (community_id, member_id, id_hash, id_ciphertext, key_version, prefix, separator, last2, issued_by)
    values
      (p_member.community_id, p_member.id, p_id_hash, p_ciphertext, coalesce(p_key_version, 1),
       p_prefix, p_separator, p_last2, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'membership_ids_community_hash_key' then
      -- The server regenerates the random suffix and calls again.
      raise exception 'MEMBERSHIP_ID_COLLISION' using errcode = 'P0001';
    end if;
    raise exception 'ALREADY_ISSUED: this member already has a membership ID' using errcode = 'P0001';
  end;
  return v_id;
end;
$$;
revoke execute on function app.insert_membership_id(public.members, bytea, text, text, smallint, text, text) from public, anon, authenticated;

create or replace function app.issue_membership_id(
  p_member_id   uuid,
  p_id_hash     bytea,
  p_ciphertext  text,
  p_last2       text,
  p_key_version smallint,
  p_prefix      text,
  p_separator   text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_id     uuid;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_member.community_id, 'membership.issue_ids');

  v_id := app.insert_membership_id(v_member, p_id_hash, p_ciphertext, p_last2, p_key_version, p_prefix, p_separator);

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.issue_membership_id', 'member', p_member_id,
    null, jsonb_build_object('membership_id_id', v_id, 'masked', p_prefix || p_separator || '…' || p_last2)
  );
  return v_id;
end;
$$;

comment on function app.issue_membership_id(uuid, bytea, text, text, smallint, text, text) is
  'F4.5. membership.issue_ids: records a server-generated membership ID (hash + ciphertext + last two characters) for a member in good standing who has none. MEMBERSHIP_ID_COLLISION = regenerate and call again. Audited with the masked form only.';

create or replace function app.rotate_membership_id(
  p_member_id   uuid,
  p_id_hash     bytea,
  p_ciphertext  text,
  p_last2       text,
  p_key_version smallint,
  p_prefix      text,
  p_separator   text,
  p_reason      text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_old    public.membership_ids%rowtype;
  v_id     uuid;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_member.community_id, 'membership.issue_ids');

  select * into v_old from public.membership_ids where member_id = p_member_id and revoked_at is null for update;
  if v_old.id is null then
    raise exception 'NOTHING_TO_REPLACE: this member has no membership ID yet' using errcode = 'P0001';
  end if;

  update public.membership_ids
  set revoked_at = now(), revoked_by = auth.uid(), id_ciphertext = null,
      revoke_reason = coalesce(nullif(trim(p_reason), ''), 'replaced')
  where id = v_old.id;

  v_id := app.insert_membership_id(v_member, p_id_hash, p_ciphertext, p_last2, p_key_version, p_prefix, p_separator);

  -- Grants issued under the old ID stop working at once.
  update public.membership_access_grants set revoked_at = now()
  where membership_id_id = v_old.id and revoked_at is null;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.rotate_membership_id', 'member', p_member_id,
    jsonb_build_object('membership_id_id', v_old.id, 'masked', v_old.prefix || v_old.separator || '…' || v_old.last2),
    jsonb_build_object('membership_id_id', v_id, 'masked', p_prefix || p_separator || '…' || p_last2),
    nullif(trim(p_reason), '')
  );
  return v_id;
end;
$$;

comment on function app.rotate_membership_id(uuid, bytea, text, text, smallint, text, text, text) is
  'F4.7. membership.issue_ids: in one transaction revokes the member''s current ID (its ciphertext is erased, its hash kept so it is never reissued), records the new one, and revokes access grants made with the old one. Audited.';

create or replace function app.revoke_membership_id(p_member_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_old    public.membership_ids%rowtype;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_member.community_id, 'membership.issue_ids');
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: say why the membership ID is being revoked' using errcode = '22023';
  end if;

  select * into v_old from public.membership_ids where member_id = p_member_id and revoked_at is null for update;
  if v_old.id is null then
    raise exception 'NOTHING_TO_REVOKE: this member has no membership ID' using errcode = 'P0001';
  end if;

  update public.membership_ids
  set revoked_at = now(), revoked_by = auth.uid(), id_ciphertext = null, revoke_reason = trim(p_reason)
  where id = v_old.id;
  update public.membership_access_grants set revoked_at = now()
  where membership_id_id = v_old.id and revoked_at is null;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.revoke_membership_id', 'member', p_member_id,
    jsonb_build_object('membership_id_id', v_old.id, 'masked', v_old.prefix || v_old.separator || '…' || v_old.last2),
    null, trim(p_reason)
  );
end;
$$;

-- The member's current ID for display. The server decrypts it. Officers who
-- can see a member's contact details can see their ID (owner decision
-- 2026-11-22: "always show it").
create or replace function app.get_member_membership_id(p_member_id uuid)
returns table (
  membership_id_id uuid,
  id_ciphertext    text,
  key_version      smallint,
  prefix           text,
  separator        text,
  last2            text,
  issued_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community uuid;
begin
  select community_id into v_community from public.members where id = p_member_id;
  if v_community is null then
    return;
  end if;
  perform app.require_permission(v_community, 'member.view_contact');
  return query
  select mi.id, mi.id_ciphertext, mi.key_version, mi.prefix, mi.separator, mi.last2, mi.issued_at
  from public.membership_ids mi
  where mi.member_id = p_member_id and mi.revoked_at is null;
end;
$$;

-- Members in good standing without a live ID, for batched issuing.
create or replace function app.members_without_membership_id(p_community_id uuid, p_limit integer default 200)
returns table (member_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_community_id, 'membership.issue_ids');
  return query
  select m.id
  from public.members m
  where m.community_id = p_community_id
    and app.member_in_good_standing(m.status)
    and not exists (select 1 from public.membership_ids mi where mi.member_id = m.id and mi.revoked_at is null)
  order by m.created_at, m.id
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$$;

-- Which members of a community hold a live ID (masked), for the members list.
create or replace function app.community_membership_id_summary(p_community_id uuid)
returns table (member_id uuid, masked text, issued_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_permission(p_community_id, 'member.view_contact');
  return query
  select mi.member_id, mi.prefix || mi.separator || '•••' || mi.last2, mi.issued_at
  from public.membership_ids mi
  where mi.community_id = p_community_id and mi.revoked_at is null;
end;
$$;


-- ══ 4. Suspension ════════════════════════════════════════════════════════════

alter table public.members
  add column if not exists suspended_at timestamptz,
  add column if not exists status_before_suspension public.member_status;

alter table public.members
  add constraint members_suspension_consistent
  check ((status = 'suspended') = (suspended_at is not null)
         and (suspended_at is null) = (status_before_suspension is null));

comment on column public.members.suspended_at is
  'F9: set while the member is suspended (not in good standing: their membership ID does not validate and they are outside every collection audience).';
comment on column public.members.status_before_suspension is
  'F9: the status reinstatement returns to.';

-- Archiving a suspended member ends the suspension record (archive is the
-- stronger state). Restoring them later is a separate, audited act by a holder
-- of member.archive.
create or replace function app.clear_suspension_on_archive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'archived' and old.status = 'suspended' then
    new.suspended_at := null;
    new.status_before_suspension := null;
  end if;
  return new;
end;
$$;
revoke execute on function app.clear_suspension_on_archive() from public, anon, authenticated;

create trigger members_clear_suspension_on_archive
  before update of status on public.members
  for each row execute function app.clear_suspension_on_archive();

create or replace function app.suspend_member(p_member_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_member.community_id, 'member.suspend');
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'REASON_REQUIRED: say why the member is being suspended' using errcode = '22023';
  end if;
  if not app.member_in_good_standing(v_member.status) then
    raise exception 'INVALID_STATE: a % member cannot be suspended', v_member.status using errcode = 'P0001';
  end if;

  update public.members
  set status = 'suspended', suspended_at = now(), status_before_suspension = v_member.status
  where id = p_member_id;

  -- Open access grants stop at once (validation re-checks status anyway).
  update public.membership_access_grants set revoked_at = now()
  where member_id = p_member_id and revoked_at is null;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.suspend', 'member', p_member_id,
    jsonb_build_object('status', v_member.status), jsonb_build_object('status', 'suspended'), trim(p_reason)
  );
end;
$$;

create or replace function app.reinstate_member(p_member_id uuid, p_reason text default null)
returns public.member_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_status public.member_status;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member' using errcode = 'P0002';
  end if;
  perform app.require_permission(v_member.community_id, 'member.suspend');
  if v_member.status <> 'suspended' then
    raise exception 'NOT_SUSPENDED: this member is %', v_member.status using errcode = 'P0001';
  end if;

  v_status := v_member.status_before_suspension;
  -- members_active_requires_phone: an active member must have a phone.
  if v_status = 'active' and v_member.phone_e164 is null then
    v_status := 'unclaimed';
  end if;

  update public.members
  set status = v_status, suspended_at = null, status_before_suspension = null
  where id = p_member_id;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.reinstate', 'member', p_member_id,
    jsonb_build_object('status', 'suspended'), jsonb_build_object('status', v_status), nullif(trim(p_reason), '')
  );
  return v_status;
end;
$$;


-- ══ 5. Validation, rate limits, access grants ════════════════════════════════

create table public.membership_validation_attempts (
  id            uuid primary key default app.uuid_generate_v7(),
  ip_hash       bytea not null,
  community_id  uuid references public.communities (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  outcome       text not null,
  attempted_at  timestamptz not null default now(),
  constraint membership_validation_attempts_ip_hash_length check (octet_length(ip_hash) = 32),
  constraint membership_validation_attempts_outcome check (outcome in
    ('success', 'unknown_id', 'member_ineligible', 'not_in_audience', 'collection_unavailable', 'rate_limited'))
);

create index membership_validation_attempts_ip_idx on public.membership_validation_attempts (ip_hash, attempted_at desc);
create index membership_validation_attempts_collection_idx on public.membership_validation_attempts (collection_id, attempted_at desc);
create index membership_validation_attempts_community_idx on public.membership_validation_attempts (community_id, attempted_at desc);

comment on table public.membership_validation_attempts is
  'F6.3: one row per membership ID check, for rate limiting and abuse monitoring. Holds a keyed hash of the IP (never the IP) and no member reference. Purged after 30 days by app.purge_membership_validation_records().';

alter table public.membership_validation_attempts enable row level security;
alter table public.membership_validation_attempts force row level security;

create table public.membership_access_grants (
  id                uuid primary key default app.uuid_generate_v7(),
  token_hash        bytea not null unique,
  membership_id_id  uuid not null references public.membership_ids (id) on delete restrict,
  member_id         uuid not null references public.members (id) on delete restrict,
  collection_id     uuid not null references public.collections (id) on delete cascade,
  community_id      uuid not null references public.communities (id) on delete cascade,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  constraint membership_access_grants_token_hash_length check (octet_length(token_hash) = 32),
  constraint membership_access_grants_window check (expires_at > created_at and expires_at <= created_at + interval '30 minutes')
);

create index membership_access_grants_member_idx on public.membership_access_grants (member_id) where revoked_at is null;

comment on table public.membership_access_grants is
  'F6.2: a 30-minute pass for one member on one collection, made by a successful membership ID check. The raw token is returned once and never stored (SHA-256 only). Not consumed by any payment code yet (Phase 3/4).';

alter table public.membership_access_grants enable row level security;
alter table public.membership_access_grants force row level security;


create or replace function app.validate_membership_id(
  p_collection_id uuid,
  p_id_hash       bytea,
  p_ip_hash       bytea
)
returns table (valid boolean, access_token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now        timestamptz := now();
  v_collection record;
  v_mi         public.membership_ids%rowtype;
  v_member     public.members%rowtype;
  v_outcome    text;
  v_token      text;
  v_expires    timestamptz;
  v_limited_scope text;
begin
  if p_ip_hash is null or octet_length(p_ip_hash) <> 32 then
    raise exception 'INVALID_INPUT: ip hash' using errcode = '22023';
  end if;
  if p_id_hash is null or octet_length(p_id_hash) <> 32 then
    raise exception 'INVALID_INPUT: id hash' using errcode = '22023';
  end if;

  select c.id, c.community_id, c.status, c.audience_mode, com.status as community_status
    into v_collection
  from public.collections c
  join public.communities com on com.id = c.community_id
  where c.id = p_collection_id;

  -- Rate limits first, before any lookup, so a limited caller learns nothing.
  if (select count(*) from public.membership_validation_attempts a
        where a.ip_hash = p_ip_hash and a.attempted_at > v_now - interval '15 minutes'
          and a.outcome <> 'success') >= 10
     or (select count(*) from public.membership_validation_attempts a
        where a.ip_hash = p_ip_hash and a.attempted_at > v_now - interval '15 minutes') >= 30 then
    v_outcome := 'rate_limited';
    v_limited_scope := 'ip';
  elsif v_collection.id is not null and (select count(*) from public.membership_validation_attempts a
        where a.collection_id = v_collection.id and a.attempted_at > v_now - interval '1 hour'
          and a.outcome not in ('success', 'rate_limited')) >= 200 then
    v_outcome := 'rate_limited';
    v_limited_scope := 'collection';
  elsif v_collection.id is not null and (select count(*) from public.membership_validation_attempts a
        where a.community_id = v_collection.community_id and a.attempted_at > v_now - interval '24 hours'
          and a.outcome not in ('success', 'rate_limited')) >= 1000 then
    v_outcome := 'rate_limited';
    v_limited_scope := 'community';
  elsif v_collection.id is null or v_collection.community_status <> 'active'
        or v_collection.status <> 'active' or v_collection.audience_mode = 'public' then
    v_outcome := 'collection_unavailable';
  else
    select * into v_mi from public.membership_ids mi
    where mi.community_id = v_collection.community_id and mi.id_hash = p_id_hash and mi.revoked_at is null;
    if v_mi.id is null then
      v_outcome := 'unknown_id';
    else
      select * into v_member from public.members where id = v_mi.member_id;
      if not app.member_in_good_standing(v_member.status) then
        v_outcome := 'member_ineligible';
      elsif not exists (select 1 from app.resolve_collection_audience(v_collection.id) a where a.member_id = v_member.id) then
        v_outcome := 'not_in_audience';
      else
        v_outcome := 'success';
      end if;
    end if;
  end if;

  insert into public.membership_validation_attempts (ip_hash, community_id, collection_id, outcome)
  values (p_ip_hash, v_collection.community_id, v_collection.id, v_outcome);

  -- Monitoring: a collection- or community-wide lockout is written to the
  -- community's audit log, at most once an hour per collection.
  if v_limited_scope in ('collection', 'community') and not exists (
    select 1 from public.audit_logs l
    where l.action = 'membership.validation_lockout' and l.object_id = v_collection.id
      and l.created_at > v_now - interval '1 hour'
  ) then
    perform app.write_audit_log(
      v_collection.community_id, 'system', null, 'membership.validation_lockout', 'collection', v_collection.id,
      null, jsonb_build_object('scope', v_limited_scope)
    );
  end if;

  if v_outcome = 'success' then
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_expires := v_now + interval '30 minutes';
    insert into public.membership_access_grants
      (token_hash, membership_id_id, member_id, collection_id, community_id, created_at, expires_at)
    values
      (extensions.digest(v_token, 'sha256'), v_mi.id, v_member.id, v_collection.id, v_collection.community_id,
       v_now, v_expires);
    return query select true, v_token, v_expires;
  else
    return query select false, null::text, null::timestamptz;
  end if;
end;
$$;

comment on function app.validate_membership_id(uuid, bytea, bytea) is
  'F6. Checks a membership ID (as its server-computed hash) for one collection. Rate-limited per IP hash (10 failures or 30 attempts / 15 min), per collection (200 failures / hour) and per community (1,000 failures / day). Every failure answers the same (valid = false). On success returns a 30-minute access token once (only its SHA-256 is stored). Never returns a name, code or contact.';

create or replace function app.resolve_membership_access_grant(p_collection_id uuid, p_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select g.member_id into v_member_id
  from public.membership_access_grants g
  join public.membership_ids mi on mi.id = g.membership_id_id
  join public.members m on m.id = g.member_id
  join public.collections c on c.id = g.collection_id
  join public.communities com on com.id = c.community_id
  where g.token_hash = extensions.digest(p_token, 'sha256')
    and g.collection_id = p_collection_id
    and g.revoked_at is null
    and g.expires_at > now()
    and mi.revoked_at is null
    and app.member_in_good_standing(m.status)
    and c.status = 'active'
    and com.status = 'active'
    and exists (select 1 from app.resolve_collection_audience(c.id) a where a.member_id = m.id);
  return v_member_id;
end;
$$;

comment on function app.resolve_membership_access_grant(uuid, text) is
  'F6.2. The member a grant token stands for on this collection, or null. Re-checks everything live: expiry, revocation, the ID still live, the member in good standing and in the audience, the collection and community active.';

-- Retention (F6.3): not scheduled yet; to be run by the worker.
create or replace function app.purge_membership_validation_records()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.membership_validation_attempts where attempted_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;


-- ══ 6. Grants ════════════════════════════════════════════════════════════════

revoke all on function app.grant_officer_permission(uuid, text)                    from public, anon;
revoke all on function app.revoke_officer_permission(uuid, text)                   from public, anon;
revoke all on function app.list_officer_permission_grants(uuid)                    from public, anon;
revoke all on function app.list_delegable_permissions()                            from public, anon;
revoke all on function app.my_granted_permissions(uuid)                            from public, anon;
revoke all on function app.set_membership_id_settings(uuid, text, text, smallint, boolean) from public, anon;
revoke all on function app.get_membership_id_settings(uuid)                        from public, anon;
revoke all on function app.member_in_good_standing(public.member_status)          from public, anon, authenticated;
revoke all on function app.issue_membership_id(uuid, bytea, text, text, smallint, text, text) from public, anon;
revoke all on function app.rotate_membership_id(uuid, bytea, text, text, smallint, text, text, text) from public, anon;
revoke all on function app.revoke_membership_id(uuid, text)                        from public, anon;
revoke all on function app.get_member_membership_id(uuid)                          from public, anon;
revoke all on function app.members_without_membership_id(uuid, integer)            from public, anon;
revoke all on function app.community_membership_id_summary(uuid)                   from public, anon;
revoke all on function app.suspend_member(uuid, text)                              from public, anon;
revoke all on function app.reinstate_member(uuid, text)                            from public, anon;
revoke all on function app.validate_membership_id(uuid, bytea, bytea)              from public;
revoke all on function app.resolve_membership_access_grant(uuid, text)             from public;
revoke all on function app.purge_membership_validation_records()                   from public, anon, authenticated;

grant execute on function app.grant_officer_permission(uuid, text)                 to authenticated;
grant execute on function app.revoke_officer_permission(uuid, text)                to authenticated;
grant execute on function app.list_officer_permission_grants(uuid)                 to authenticated;
grant execute on function app.list_delegable_permissions()                         to authenticated;
grant execute on function app.my_granted_permissions(uuid)                         to authenticated;
grant execute on function app.set_membership_id_settings(uuid, text, text, smallint, boolean) to authenticated;
grant execute on function app.get_membership_id_settings(uuid)                     to authenticated;
grant execute on function app.issue_membership_id(uuid, bytea, text, text, smallint, text, text) to authenticated;
grant execute on function app.rotate_membership_id(uuid, bytea, text, text, smallint, text, text, text) to authenticated;
grant execute on function app.revoke_membership_id(uuid, text)                     to authenticated;
grant execute on function app.get_member_membership_id(uuid)                       to authenticated;
grant execute on function app.members_without_membership_id(uuid, integer)         to authenticated;
grant execute on function app.community_membership_id_summary(uuid)                to authenticated;
grant execute on function app.suspend_member(uuid, text)                           to authenticated;
grant execute on function app.reinstate_member(uuid, text)                         to authenticated;
-- Anonymous: a contributor has no account. Reached only through the web
-- server's direct connection (PostgREST serves `public` only).
grant execute on function app.validate_membership_id(uuid, bytea, bytea)           to anon, authenticated;
grant execute on function app.resolve_membership_access_grant(uuid, text)          to anon, authenticated;
