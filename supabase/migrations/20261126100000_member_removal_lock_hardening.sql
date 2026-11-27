-- ─────────────────────────────────────────────────────────────────────────────
-- 20261126100000 — Phase 3: membership removal serialises with checkout
--
-- Owner decision of 2026-11-26 (Phase 3, Policy B): eligibility is enforced
-- when a checkout attempt is created. An attempt that already exists may
-- finish — capture, contribution, ledger and attribution are NOT gated on
-- current membership. Nothing in the payment lifecycle changes here.
--
-- M10 (20261125100000) share-locks the member row inside
-- app.create_payment_attempt before it checks eligibility and resolves the
-- pass. suspend / revoke / rotate / issue already lock that row first. This
-- migration makes the remaining removal paths take the same row lock before
-- they change what eligibility reads, so removal and checkout authorisation
-- serialise on one record:
--
--   · app.archive_member — locks the member row, then archives (unchanged),
--     then revokes the member's open membership-pass grants (new; the same
--     statement app.suspend_member runs). Before this, archive left grants
--     live; the resolver refused them only while the member stayed archived,
--     so a restore within 30 minutes made a pre-archive pass valid again.
--   · app.restore_member — locks the member row before the status check and
--     the update. It does not touch grants: a grant revoked by archive stays
--     revoked; the member gets a new pass through app.validate_membership_id.
--   · app.remove_member_from_group — locks the member row (only when it is in
--     the group's community) before deleting the group membership, which is
--     what a 'groups' audience reads.
--   · app.set_member_groups — locks the member row before replacing groups.
--     One member per call, so no multi-row lock ordering arises.
--
-- Lock mode: FOR NO KEY UPDATE, not FOR UPDATE. Both conflict with checkout's
-- FOR SHARE, so serialisation is the same. FOR NO KEY UPDATE is the mode the
-- archive/restore UPDATE of members.status already takes (status is in no
-- unique index), so it adds no new conflict with the FOR KEY SHARE that
-- foreign-key checks take — contributions / obligations / payment_attempts
-- inserts during capture, and member_group_memberships inserts by
-- app.add_members_to_group. FOR UPDATE would block those FK checks and could
-- deadlock set_member_groups against add_members_to_group on one member.
--
-- Lock order: permission is checked from an unlocked read first (so a caller
-- without permission takes no lock), then members, then grants or group
-- memberships, then audit. Checkout takes collections → members; capture
-- takes payment_attempts → collections → obligations and never locks members.
-- No cycle.
--
-- Unchanged: signatures, SECURITY DEFINER, search_path = '', EXECUTE grants
-- (CREATE OR REPLACE keeps the ACL), error codes and messages, audit rows,
-- return values. No table, column, index, trigger or constraint changes. No
-- row is written by this migration. Payment attempts, contributions,
-- obligations, ledger, settlement and withdrawals are not touched.
--
-- Ordering: sorts after 20261125100000 (M10). Independent of
-- supabase/pending-migrations/20261123120100_membership_id_plaintext_finalize.sql.
--
-- Rollback (no data loss; this migration writes no row): run
-- docs/phase-4/member-removal-lock-hardening-rollback.sql, which recreates the
-- four previous bodies verbatim and restores their comments, then
--   delete from supabase_migrations.schema_migrations where version = '20261126100000';
-- Grants revoked by archives made while this was live stay revoked; that is
-- the safe direction (the member re-validates their ID for a new pass).
-- ─────────────────────────────────────────────────────────────────────────────

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
  select community_id into v_community_id
  from public.members m where m.id = p_member_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: member % does not exist', p_member_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'member.archive');

  -- Phase 3: serialise with checkout (M10 share-locks this row). Re-read under
  -- the lock so the audit "before" is the row actually changed.
  select to_jsonb(m) into v_before
  from public.members m where m.id = p_member_id
  for no key update;

  update public.members set status = 'archived', archived_at = now() where id = p_member_id;

  -- Phase 3: open membership passes stop at once and stay stopped if the
  -- member is later restored. Same statement as app.suspend_member.
  update public.membership_access_grants set revoked_at = now()
  where member_id = p_member_id and revoked_at is null;

  perform app.write_audit_log(
    v_community_id, 'officer', auth.uid(), 'member.archive', 'member', p_member_id,
    v_before, (select to_jsonb(m) from public.members m where m.id = p_member_id), p_reason
  );
end;
$$;

comment on function app.archive_member(uuid, text) is
  'member.archive (MEM-13). Members are archived, never deleted — the delete-guard trigger enforces this once obligations exist; this function is the intended path even before then. Phase 3 (20261126100000): locks the member row (FOR NO KEY UPDATE, serialising with checkout''s FOR SHARE) and revokes the member''s open membership-pass grants. Existing payment attempts, contributions and obligations are not touched (Policy B).';


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

  -- Phase 3: lock, then judge the state that is actually there.
  select * into v_member from public.members where id = p_member_id for no key update;

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
  '§42: archiving is reversible and nothing is deleted, so restoring is a status change plus an audit row. Obligations and history were never touched by the archive and are not touched here. Phase 3 (20261126100000): locks the member row first; membership-pass grants revoked by the archive stay revoked — the member validates their ID again for a new pass.';


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

  -- Phase 3: serialise with checkout, which share-locks this row before it
  -- reads the audience. Only a member of the group's own community is locked
  -- (SEC-18); any other id matches no membership row below, as before.
  perform 1 from public.members
  where id = p_member_id and community_id = v_group.community_id
  for no key update;

  delete from public.member_group_memberships
  where group_id = p_group_id and member_id = p_member_id;

  perform app.write_audit_log(
    v_group.community_id, 'officer', auth.uid(), 'group.remove_member', 'member_group', p_group_id,
    jsonb_build_object('member_id', p_member_id), null
  );
end;
$$;

comment on function app.remove_member_from_group(uuid, uuid) is
  'group.manage. Removing someone from a group does not remove any obligation already assigned to them — an obligation is a record of what was asked, not a view over current group membership. Phase 3 (20261126100000): locks the member row first, serialising with checkout.';


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

  -- Phase 3: serialise with checkout before changing what a 'groups'
  -- audience reads. One member per call: no multi-row lock order to keep.
  perform 1 from public.members where id = p_member_id for no key update;

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
  'group.manage. Replaces a member''s group memberships with the set given. Archived groups are untouched — the form does not offer them, so their absence is not an instruction. Phase 3 (20261126100000): locks the member row first, serialising with checkout.';
