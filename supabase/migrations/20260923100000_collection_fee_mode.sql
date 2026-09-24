-- ─────────────────────────────────────────────────────────────────────────────
-- 20260923100000 — Who bears the fees, per collection
--
-- M7.7 §5. `collections.fee_mode` has existed since 20260917120700 and
-- `communities.default_fee_mode` since 20260917120300. `app.create_collection`
-- copies the community's default onto the collection and **nothing has ever
-- been able to change it**. An organiser could not answer "who pays the
-- fees?" for one collection, which is the question this milestone exists to
-- put in front of them.
--
-- This is the same pattern as the rest of M7.6's additions: the column was
-- provisioned years ahead of the screen, and the work is completing a design
-- rather than inventing one.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- This is not Phase 4. No fee is charged, no fee is recorded, and no money
-- moves. `fee_mode` is CONFIGURATION: a statement of intent about how a
-- future payment will be split, used today only to show an organiser a
-- preview of the arithmetic before they publish. ADR 0006's gate is
-- untouched — no payment_attempts, no contributions, no ledger.
--
-- ── WHAT IS DELIBERATELY NOT DECIDED HERE ───────────────────────────────────
--
-- Whether a platform fee may lawfully be passed to a contributor at all is
-- DEC-12, a legal question, and this migration does not answer it. Both enum
-- values already exist precisely so the engine can express either answer, and
-- the default stays `community_absorbs` — the conservative one — until
-- counsel rules. See docs/history/2026-09-22-phase4-open-decisions.md.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.set_collection_fee_mode(
  p_collection_id uuid,
  p_fee_mode      public.fee_mode
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  -- Tenancy from the row, never from the caller (SEC-18). Shaping a
  -- collection is `collection.draft`, the same permission that sets its
  -- amount — which is the neighbouring decision and deserves the same door.
  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot be edited', v_collection.status
      using errcode = 'P0001';
  end if;

  if p_fee_mode is null then
    raise exception 'INVALID_FEE_MODE: say who bears the fees' using errcode = 'P0001';
  end if;

  if v_collection.fee_mode = p_fee_mode then
    return;  -- Idempotent, and not worth an audit row.
  end if;

  update public.collections
  set fee_mode = p_fee_mode
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(),
    'collection.fee_mode_set', 'collection', p_collection_id,
    jsonb_build_object('fee_mode', v_collection.fee_mode),
    jsonb_build_object('fee_mode', p_fee_mode)
  );
end;
$$;

comment on function app.set_collection_fee_mode(uuid, public.fee_mode) is
  'M7.7: who bears the fees on one collection — the contributor, or the community out of what it receives. Configuration only; nothing here charges, records or moves money (ADR 0006). Which answer is lawful is DEC-12.';

revoke execute on function app.set_collection_fee_mode(uuid, public.fee_mode) from public;
grant  execute on function app.set_collection_fee_mode(uuid, public.fee_mode) to authenticated;
