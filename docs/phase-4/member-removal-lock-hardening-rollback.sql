-- Rollback for supabase/migrations/20261126100000_member_removal_lock_hardening.sql
--
-- Recreates the four function bodies exactly as they were before that
-- migration (archive_member / set_member_groups / remove_member_from_group
-- from 20260918140100 / 20260920130000, restore_member from 20260920120100)
-- and restores their comments. CREATE OR REPLACE keeps the EXECUTE grants.
-- Writes no row. Grants revoked by archives made while the migration was live
-- stay revoked (safe direction).
--
-- Run in one transaction, then:
--   delete from supabase_migrations.schema_migrations where version = '20261126100000';

begin;

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

comment on function app.archive_member(uuid, text) is
  'member.archive (MEM-13). Members are archived, never deleted — the delete-guard trigger enforces this once obligations exist; this function is the intended path even before then.';

create or replace function app.restore_member(
  p_member_id uuid,
  p_reason    text default null
)
returns public.member_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.members%rowtype;
  v_status public.member_status;
begin
  select * into v_member from public.members where id = p_member_id;
  if v_member.id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_member.community_id, 'member.archive');

  if v_member.status <> 'archived' then
    raise exception 'NOT_ARCHIVED: this member is %, so there is nothing to restore', v_member.status
      using errcode = 'P0001';
  end if;

  v_status := case when v_member.phone_e164 is not null then 'active' else 'unclaimed' end;

  update public.members
  set status = v_status, archived_at = null
  where id = p_member_id;

  perform app.write_audit_log(
    v_member.community_id, 'officer', auth.uid(), 'member.restore', 'member', p_member_id,
    jsonb_build_object('status', 'archived'), jsonb_build_object('status', v_status), p_reason
  );

  return v_status;
end;
$$;

comment on function app.restore_member(uuid, text) is
  '§42: archiving is reversible and nothing is deleted, so restoring is a status change plus an audit row. Obligations and history were never touched by the archive and are not touched here.';

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

commit;
