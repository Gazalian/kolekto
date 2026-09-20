-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920130000 — Member groups: archiving, and the write path
--
-- Phase 1 created `member_groups` and `member_group_memberships` (MEM-03) and
-- left them as data nobody could change: Phase 2 skipped group CRUD explicitly
-- ("groups already exist as data (seeded) and are readable; creating/editing
-- them is a small, separable follow-up"). This is that follow-up.
--
-- Groups are how a collection will later say who it is for — "300 Level",
-- "Block B", "Youth" — so they carry weight beyond labelling: an audience
-- resolves through them. Two consequences shape this migration.
--
--   1. A group is never deleted once anyone has been in it. The membership rows
--      are how a collection's audience was interpreted at the time, and an
--      audience that silently loses a group is an audience nobody can explain.
--      Archiving keeps the group and its history; deletion is allowed only
--      while a group has never been used.
--
--   2. Membership is many-to-many and stays that way. A person is Youth AND
--      Choir; a flat cannot be forced to choose between Block B and Tenants.
--      Nothing here makes groups exclusive.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.member_groups
  add column archived_at timestamptz;

comment on column public.member_groups.archived_at is
  'MEM-03: an archived group stops being offered for new assignments and keeps every membership it already has. Groups are archived rather than deleted because a collection audience is interpreted through them.';

-- The pickers and the member list read active groups; the group admin screen
-- reads all of them. One partial index serves the common case.
create index member_groups_active_idx
  on public.member_groups (community_id, sort_order)
  where archived_at is null;


-- ── Creating and editing ─────────────────────────────────────────────────────

create or replace function app.create_member_group(
  p_community_id     uuid,
  p_name             text,
  p_description      text default null,
  p_pickable_at_join boolean default false,
  p_sort_order       smallint default 0
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id uuid;
  v_name     text := nullif(trim(coalesce(p_name, '')), '');
begin
  perform app.require_permission(p_community_id, 'group.manage');

  if v_name is null or char_length(v_name) > 60 then
    raise exception 'INVALID_GROUP_NAME: a group name is 1 to 60 characters' using errcode = 'P0001';
  end if;

  -- member_groups_community_name_key would catch this with an index violation.
  -- An organiser adding "300 Level" twice should be told that, in those words.
  if exists (
    select 1 from public.member_groups
    where community_id = p_community_id and lower(name) = lower(v_name)
  ) then
    raise exception 'GROUP_EXISTS: this community already has a group called "%"', v_name
      using errcode = 'P0001';
  end if;

  v_group_id := app.uuid_generate_v7();

  insert into public.member_groups (id, community_id, name, description, pickable_at_join, sort_order, created_by)
  values (v_group_id, p_community_id, v_name, nullif(trim(coalesce(p_description, '')), ''),
          coalesce(p_pickable_at_join, false), coalesce(p_sort_order, 0), auth.uid());

  perform app.write_audit_log(
    p_community_id, 'officer', auth.uid(), 'group.create', 'member_group', v_group_id,
    null, jsonb_build_object('name', v_name)
  );

  return v_group_id;
end;
$$;

comment on function app.create_member_group is
  'group.manage. Groups are community-scoped and their names are unique within one — two "300 Level" groups in the same community would make an audience ambiguous.';

create or replace function app.update_member_group(
  p_group_id         uuid,
  p_name             text,
  p_description      text default null,
  p_pickable_at_join boolean default false,
  p_sort_order       smallint default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.member_groups%rowtype;
  v_name  text := nullif(trim(coalesce(p_name, '')), '');
begin
  select * into v_group from public.member_groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'NOT_FOUND: group % does not exist', p_group_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_group.community_id, 'group.manage');

  if v_name is null or char_length(v_name) > 60 then
    raise exception 'INVALID_GROUP_NAME: a group name is 1 to 60 characters' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.member_groups
    where community_id = v_group.community_id and lower(name) = lower(v_name) and id <> p_group_id
  ) then
    raise exception 'GROUP_EXISTS: this community already has a group called "%"', v_name
      using errcode = 'P0001';
  end if;

  update public.member_groups set
    name             = v_name,
    description      = nullif(trim(coalesce(p_description, '')), ''),
    pickable_at_join = coalesce(p_pickable_at_join, false),
    sort_order       = coalesce(p_sort_order, 0)
  where id = p_group_id;

  perform app.write_audit_log(
    v_group.community_id, 'officer', auth.uid(), 'group.update', 'member_group', p_group_id,
    to_jsonb(v_group), (select to_jsonb(g) from public.member_groups g where g.id = p_group_id)
  );
end;
$$;


-- ── Archiving, restoring, and the one case where deleting is allowed ─────────

create or replace function app.set_member_group_archived(
  p_group_id uuid,
  p_archived boolean,
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.member_groups%rowtype;
begin
  select * into v_group from public.member_groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'NOT_FOUND: group % does not exist', p_group_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_group.community_id, 'group.manage');

  update public.member_groups
  set archived_at = case when p_archived then now() else null end
  where id = p_group_id;

  perform app.write_audit_log(
    v_group.community_id, 'officer', auth.uid(),
    case when p_archived then 'group.archive' else 'group.restore' end,
    'member_group', p_group_id,
    jsonb_build_object('archived', v_group.archived_at is not null),
    jsonb_build_object('archived', p_archived),
    p_reason
  );
end;
$$;

comment on function app.set_member_group_archived(uuid, boolean, text) is
  'group.manage. Archiving hides a group from new assignments and keeps every membership it holds — the record of who was in it is how a past audience is read.';

-- A group nobody has ever been in is a typo, and a typo should be removable.
-- Anything else is history.
create or replace function app.delete_member_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group  public.member_groups%rowtype;
  v_members integer;
begin
  select * into v_group from public.member_groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'NOT_FOUND: group % does not exist', p_group_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_group.community_id, 'group.manage');

  select count(*) into v_members from public.member_group_memberships where group_id = p_group_id;

  if v_members > 0 then
    raise exception 'GROUP_HAS_MEMBERS: "%" holds % member(s) and cannot be deleted', v_group.name, v_members
      using errcode = 'P0001',
            hint = 'Archive it instead. Who was in a group is how a collection audience is read later.';
  end if;

  perform app.write_audit_log(
    v_group.community_id, 'officer', auth.uid(), 'group.delete', 'member_group', p_group_id,
    to_jsonb(v_group), null
  );

  delete from public.member_groups where id = p_group_id;
end;
$$;


-- ── Membership ───────────────────────────────────────────────────────────────

-- Assigning several members to one group, from the group's own screen. Members
-- outside the group's community match nothing (SEC-18) rather than being
-- reported as errors, which would confirm that an id exists.
create or replace function app.add_members_to_group(
  p_group_id   uuid,
  p_member_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group   public.member_groups%rowtype;
  v_added   integer := 0;
  v_member_id uuid;
begin
  select * into v_group from public.member_groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'NOT_FOUND: group % does not exist', p_group_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_group.community_id, 'group.manage');

  if v_group.archived_at is not null then
    raise exception 'GROUP_ARCHIVED: "%" is archived and takes no new members', v_group.name
      using errcode = 'P0001';
  end if;
  if array_length(p_member_ids, 1) is null then
    raise exception 'NO_MEMBERS: select at least one member' using errcode = 'P0001';
  end if;
  if array_length(p_member_ids, 1) > 500 then
    raise exception 'TOO_MANY_MEMBERS: assign at most 500 members per call' using errcode = 'P0001';
  end if;

  for v_member_id in
    select m.id from public.members m
    where m.id = any (p_member_ids)
      and m.community_id = v_group.community_id
      and m.status <> 'merged'
  loop
    insert into public.member_group_memberships (member_id, group_id, added_by)
    values (v_member_id, p_group_id, auth.uid())
    on conflict do nothing;

    if found then
      v_added := v_added + 1;
    end if;
  end loop;

  if v_added > 0 then
    perform app.write_audit_log(
      v_group.community_id, 'officer', auth.uid(), 'group.add_members', 'member_group', p_group_id,
      null, jsonb_build_object('added', v_added)
    );
  end if;

  return v_added;
end;
$$;

create or replace function app.remove_member_from_group(
  p_group_id  uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group public.member_groups%rowtype;
begin
  select * into v_group from public.member_groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'NOT_FOUND: group % does not exist', p_group_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_group.community_id, 'group.manage');

  delete from public.member_group_memberships
  where group_id = p_group_id and member_id = p_member_id;

  perform app.write_audit_log(
    v_group.community_id, 'officer', auth.uid(), 'group.remove_member', 'member_group', p_group_id,
    jsonb_build_object('member_id', p_member_id), null
  );
end;
$$;

comment on function app.remove_member_from_group(uuid, uuid) is
  'group.manage. Removing someone from a group does not remove any obligation already assigned to them — an obligation is a record of what was asked, not a view over current group membership.';

-- The member's own screen: replace the whole set of groups they belong to.
-- Full replace rather than add/remove pairs, because the form shows every group
-- with a checkbox and submits what it shows.
create or replace function app.set_member_groups(
  p_member_id uuid,
  p_group_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_count  integer := 0;
begin
  select * into v_member from public.members where id = p_member_id;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_member.community_id, 'group.manage');

  -- Archived groups the member is already in are left alone: the form does not
  -- offer them, so their absence from the payload is not a decision to leave.
  delete from public.member_group_memberships mgm
  using public.member_groups g
  where mgm.group_id = g.id
    and mgm.member_id = p_member_id
    and g.archived_at is null
    and not (mgm.group_id = any (coalesce(p_group_ids, '{}')));

  insert into public.member_group_memberships (member_id, group_id, added_by)
  select p_member_id, g.id, auth.uid()
  from public.member_groups g
  where g.id = any (coalesce(p_group_ids, '{}'))
    and g.community_id = v_member.community_id
    and g.archived_at is null
  on conflict do nothing;

  select count(*) into v_count
  from public.member_group_memberships where member_id = p_member_id;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'group.set_member_groups', 'member', p_member_id,
    null, jsonb_build_object('group_count', v_count)
  );

  return v_count;
end;
$$;

comment on function app.set_member_groups(uuid, uuid[]) is
  'group.manage. Replaces a member''s group memberships with the set given. Archived groups are untouched — the form does not offer them, so their absence is not an instruction.';
