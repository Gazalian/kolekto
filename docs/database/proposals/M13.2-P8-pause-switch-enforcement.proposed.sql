-- PROPOSED FOR REVIEW. NOT A MIGRATION. NOT APPLIED ANYWHERE. NOT EXECUTED, EVEN ON THE TEST STACK.
--
-- M13.2 Phase 8: database-level enforcement of the pause switch (finding F-3), which also closes F-12.
-- Kept outside supabase/migrations on purpose.
--
-- Today only runSenderTick reads the switch, once per tick. A bug, an old build, or a direct caller of
-- sendOneClaimed can claim and send while sending is off. After this change the claim itself refuses:
-- no lease, so no reservation, so no provider call. The worker needs no change: claimed = false is
-- already its "nothing to do".
--
-- The only change from the live function (migration 20261013100000) is the block marked below. Being
-- CREATE OR REPLACE with the same signature, it keeps the owner, ACL and comment.
--
-- A send already past its claim still finishes: that is at most one message, and it cannot be stopped
-- from here. Lease recovery and expiry do not claim, so maintenance keeps running while paused, as now.
--
-- Rollback: CREATE OR REPLACE with the body from migration 20261013100000.
--
-- Test impact, which must be planned before this is applied. Every test that sends through sendOneClaimed
-- with the switch off stops sending: the direct-sender tests in notification-sender,
-- notification-sender-mailpit, notification-e2e-mailpit and notification-rate-limit. They would have to
-- move inside the guarded withSendingEnabled window (itest-switch.ts), whose grant the lane gives only to
-- the worker-runtime files today, or run on rolled-back rows with a test-only override. Each is a decision
-- about the guards, and those files spend most of the test budget. Proof would need: RT-1 and EV-1 unchanged;
-- a new test that a direct claim while paused returns reason 'paused' with no state change; and a test that
-- a mid-batch switch-off stops the next claim.

create or replace function app.claim_next_notification_delivery(p_lease_seconds integer default 300)
returns table (
  delivery_id      uuid,
  claimed          boolean,
  lease_token      text,
  lease_expires_at timestamptz,
  attempt_count    integer,
  reason           text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- ── NEW: the pause switch is enforced where the claim happens. ──
  if not app.email_sending_enabled() then
    delivery_id := null; claimed := false; lease_token := null;
    lease_expires_at := null; attempt_count := null; reason := 'paused';
    return next;
    return;
  end if;
  -- ── END NEW ──

  -- SKIP LOCKED: rows a concurrent worker holds are skipped, not waited on.
  -- Oldest created first across all communities, so no community starves.
  select d.id into v_id
  from public.notification_deliveries d
  where d.channel = 'email'
    and d.status = 'pending'
    and d.attempt_count < 3
    and (d.next_retry_at is null or d.next_retry_at <= now())
  order by d.created_at, d.id
  limit 1
  for update skip locked;

  if v_id is null then
    delivery_id := null; claimed := false; lease_token := null;
    lease_expires_at := null; attempt_count := null; reason := 'empty';
    return next;
    return;
  end if;

  -- The by-id claim returns named columns, so no column-alias list is
  -- needed (one is only allowed for functions returning record).
  select d.claimed, d.lease_token, d.lease_expires_at, d.attempt_count, d.reason
    into claimed, lease_token, lease_expires_at, attempt_count, reason
  from app.claim_notification_delivery(v_id, p_lease_seconds) d;

  -- The row was locked by this transaction a moment ago; the by-id claim
  -- cannot refuse it. If it ever does, that is a bug worth raising.
  if not claimed then
    raise exception 'CLAIM_NEXT_REFUSED: claim_next picked % but the by-id claim refused it (%)', v_id, reason
      using errcode = 'P0001';
  end if;

  delivery_id := v_id;
  return next;
  return;
end;
$$;
