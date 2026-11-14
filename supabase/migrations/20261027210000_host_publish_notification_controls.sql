-- ─────────────────────────────────────────────────────────────────────────────
-- 20261027210000 — Host-controlled publish-time notification
--
-- Problem: `app.transition_collection_status` is the only publish path and
-- always writes audit action `collection.publish`, which the audit trigger
-- enqueues for every eligible audience member with an account. The host has
-- no say — the only existing suppression is operator-only and transaction-
-- scoped to Kolekto staff sessions, so it cannot be reached from the UI.
--
-- This migration adds the smallest additive host-facing control: a new
-- SECURITY DEFINER function `app.publish_collection(..., p_notify boolean)`
-- that writes a DIFFERENT audit action — `collection.publish_silent` — when
-- the host chooses not to notify. The audit trigger watches a fixed set of
-- actions (c_watched in 20261009110000) and ignores everything else, so
-- `collection.publish_silent` simply does not reach the pgmq queue. The
-- business state (status, published_at, published_by) is identical.
--
-- Scope:
--   - No change to any existing function, trigger, policy or row.
--   - No change to the notification trigger or worker.
--   - No new column or table.
--   - Caller must hold `collection.publish` permission (same as the existing
--     path). Non-publish transitions are refused with an INVALID_TRANSITION;
--     the host-facing control is deliberately narrow.
--
-- Rollback: drop the new function.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.publish_collection(
  p_collection_id uuid,
  p_expected      public.collection_status,
  p_reason        text default null,
  p_notify        boolean default true
)
returns public.collection_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_resolved   public.collection_status;
  v_tier_count integer;
  v_action     text;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.publish');

  if v_collection.status <> p_expected then
    raise exception 'STATUS_CONFLICT: collection % is %, not %', p_collection_id, v_collection.status, p_expected
      using errcode = 'P0001',
            hint = 'Someone else changed this collection. Reload and try again.';
  end if;

  -- Deliberately narrow: this is the publish gate only. Other transitions go
  -- through app.transition_collection_status with its established checks.
  if v_collection.status <> 'draft' then
    raise exception 'INVALID_TRANSITION: a % collection cannot be published, use app.transition_collection_status',
                    v_collection.status
      using errcode = 'P0001';
  end if;

  -- Same preconditions the existing publish branch enforces (STM-01).
  if v_collection.amount_model = 'fixed' and coalesce(v_collection.fixed_amount_kobo, 0) <= 0 then
    raise exception 'NOT_PUBLISHABLE: set the contribution amount before publishing' using errcode = 'P0001';
  end if;
  if v_collection.amount_model = 'tiers' then
    select count(*) into v_tier_count
    from public.collection_tiers
    where collection_id = p_collection_id and not hidden;
    if v_tier_count = 0 then
      raise exception 'NOT_PUBLISHABLE: add at least one visible option before publishing' using errcode = 'P0001';
    end if;
  end if;
  if v_collection.deadline_at is not null and v_collection.deadline_at <= now() then
    raise exception 'NOT_PUBLISHABLE: the deadline has already passed' using errcode = 'P0001';
  end if;

  -- A future start resolves to scheduled, same as the existing path.
  if v_collection.starts_at is not null and v_collection.starts_at > now() then
    v_resolved := 'scheduled';
  else
    v_resolved := 'active';
  end if;

  -- The one difference: a silent publish is audited under a distinct action
  -- the notification trigger does NOT watch, so no enqueue happens. The audit
  -- row still records what the host did and why.
  v_action := case when coalesce(p_notify, true) then 'collection.publish' else 'collection.publish_silent' end;

  update public.collections set
    status       = v_resolved,
    published_at = now(),
    published_by = auth.uid()
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id,
    'officer',
    auth.uid(),
    v_action,
    'collection',
    p_collection_id,
    jsonb_build_object('status', v_collection.status),
    jsonb_build_object('status', v_resolved, 'notified', coalesce(p_notify, true)),
    p_reason
  );

  return v_resolved;
end;
$$;

comment on function app.publish_collection(uuid, public.collection_status, text, boolean) is
  'M13.3: host-facing publish with an explicit notify choice. p_notify=true writes action collection.publish (the audit trigger enqueues); p_notify=false writes collection.publish_silent (not watched, no enqueue). Requires collection.publish permission. Does the same preconditions as the existing publish branch of app.transition_collection_status. Narrow by design: refuses non-draft transitions.';

revoke all on function app.publish_collection(uuid, public.collection_status, text, boolean) from public;
revoke execute on function app.publish_collection(uuid, public.collection_status, text, boolean) from public, anon;
grant  execute on function app.publish_collection(uuid, public.collection_status, text, boolean) to authenticated;
