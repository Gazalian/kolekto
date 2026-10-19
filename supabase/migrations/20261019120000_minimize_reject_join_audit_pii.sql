-- ─────────────────────────────────────────────────────────────────────────────
-- 20261019120000 — Minimize member.reject_join audit before_state (security)
--
-- Finding: app.reject_pending_member captured the ENTIRE member row
-- (to_jsonb(m)) into audit_logs.before_state before deleting the member. The
-- whole row carries personal data the audit purpose does not need —
-- phone_e164, identifier and the freeform `attributes` object — and
-- audit_logs.before_state is readable by every officer holding audit.view
-- (owner, admin, treasurer AND the read-only viewer). A rejected applicant,
-- who never became a member, thus had their full contact record retained in
-- the audit log indefinitely and exposed to audit viewers.
--
-- This contradicts the documented design: the audit_logs table comment states
-- "PII is scrubbed by the writer, not here" (20260917120900_audit_log.sql).
-- reject_pending_member is the writer, so it must do the scrubbing.
--
-- Fix: store only the fields the audit and its one downstream consumer need —
-- full_name, email and joined_via. The notification trigger
-- (20261009110000) and its suppression-lapse variant (20261009120000) read
-- exactly these three keys from before_state for member.reject_join (the
-- member row is already deleted by then, so before_state is their only
-- source). Keeping that set preserves both the audit record (who was rejected)
-- and the existing notification behaviour, while dropping phone_e164,
-- identifier, attributes and every internal column.
--
-- Scope: this is the smallest safe change. Only the before_state captured by
-- this one function changes; no outcome, permission, policy or notification
-- semantics changes. Forward-only by design: historical audit rows written
-- before this migration are NOT touched (no destructive data cleanup). Whether
-- to scrub those existing rows is a separate, explicit decision.
--
-- Additive (create or replace). Rollback: re-create the prior function body
-- with to_jsonb(m) as before_state.
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- Capture only the fields the audit record and the notification trigger
  -- need. NOT to_jsonb(m): the whole row retains phone, identifier and
  -- freeform attributes the audit purpose does not require (see migration
  -- header). full_name / email / joined_via are the exact keys the
  -- member.reject_join notification trigger reads from before_state.
  select m.community_id, m.status,
         jsonb_build_object(
           'full_name',  m.full_name,
           'email',      m.email,
           'joined_via', m.joined_via
         )
    into v_community_id, v_status, v_before
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
  'invite.approve. Deletes a rejected join request — safe because a pending-approval member has no financial history yet (MEM-13). Audit before_state is minimized to full_name, email and joined_via (the keys the member.reject_join notification trigger reads); the full member row is never stored in the audit log.';
