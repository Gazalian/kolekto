-- PROPOSED FOR REVIEW. NOT A MIGRATION. NOT APPLIED ANYWHERE. NOT EXECUTED, EVEN ON THE TEST STACK.
--
-- M13.2 final corrections: database-level enforcement of the pause switch (finding F-3), which also closes
-- F-12. Supersedes M13.2-P8-pause-switch-enforcement.proposed.sql, which is kept byte for byte because the
-- sealed Phase 8 reports pin its hash. The function body below is unchanged from that file. Only this header
-- changed: its test-impact list was wrong in both directions. Do not apply either file without the plan below.
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
-- ─────────────────────────────────────────────────────────────────────────────
-- Test impact. From reading which test bodies reach the unscoped claim. NOT EXECUTED.
--
-- Affected: 18 integration tests, plus pgTAP 37. All paths are under apps/worker/test/integration/.
--
-- notification-sender.integration.test.ts: 12 of 19
--   Would FAIL, because their first send gets "empty" (9):
--     1. sends a pending delivery and records it as sent
--     2. does not re-send a sent row on replay (no duplicate send)
--     3. permanent failure → dead with that code, one call only
--     4. transient failure retries with a ~5-minute next_retry_at, then succeeds
--     5. retry exhaustion → dead/retries_exhausted after exactly 3 calls, never a 4th
--     6. ambiguous outcome with provider idempotency retries with the same key (one message)
--     7. ambiguous outcome WITHOUT idempotency → dead/outcome_unknown, never retried
--     8. recovers a crashed worker's expired lease back to pending
--     9. health output reflects outcomes and leaks no recipient address
--   Would have PASSED WHILE PROVING NOTHING under the Phase 8 form of these tests (3). They assert
--   outcome "empty", which a paused claim also returns. They now carry assertClaimableNow and
--   assertNothingDue, so they FAIL loudly instead, until they are moved:
--    10. P9-4: non-idempotent provider sends an expired lease to dead/outcome_unknown instead of pending
--        (its final step only; the Phase 8 review counted this one as failing, not vacuous)
--    11. E6: a skipped row is never claimed and the provider is never called
--    12. E7: a dead row is never claimed
--
-- notification-sender-mailpit.integration.test.ts: 4 of 4
--    13. D1: sends a member.create email and settles the row as sent, once
--    14. D2: renders and sends an officer_invitation.accept email
--    15. E4: a sent row is terminal — a second sender call claims nothing and does not call the provider
--    16. E9: an SMTP-unreachable adapter schedules a transient retry (provider_unreachable) and nothing is settled as sent
--
-- notification-e2e-mailpit.integration.test.ts: 1 of 1
--    17. member.create: audit → trigger → queue → processor → delivery → sender → Mailpit, once, and replay-safe
--
-- notification-send-claim.integration.test.ts: 1 of 3
--    18. gates settle and recover on the live token, caps attempts, refuses terminal rows
--        (claimNextDelivery expects the RACE row, then "empty")
--
-- supabase/tests/37_notification_send_claims.sql: 7 of 59 assertions
--   Direct (2): both D assertions, lines 178 and 181.
--   Cascading from D2 never being claimed (5): E "the valid lease settles to sent", E "the settled row is
--   sent", E "the provider id is stored…", E "a sent delivery cannot be reclaimed" (whose by-id claim would
--   now succeed and lease D2), and F "a sent row is not recoverable" (D2 would hold a live lease).
--   This file can set the switch itself, inside its own rolled-back transaction, as pgTAP 40 does. Add
--   `select app.set_email_sending_enabled(true);` immediately before section D and
--   `select app.set_email_sending_enabled(false);` immediately after it. No plan() change is needed.
--
-- NOT affected, read from the code:
--   notification-rate-limit: 0 of 3. It claims by id only. The Phase 8 header listed it, wrongly.
--   notification-processor, notification-suppression: never claim.
--   notification-worker-reliability, notification-worker-runtime: send inside withSendingEnabled.
--   In notification-sender, the other 7 of 19: L2, L5 and L4 deferral and D3 claim by id; paused, 72-hour
--   expiry and maintenance never reach a claim.
--   pgTAP 38, 39, 40, 41, 44: by-id claim. Only 37 calls app.claim_next_notification_delivery.
--
-- Moving the 18 is a decision about the guards, not a mechanical edit. withSendingEnabled is granted only to
-- worker-runtime files, and the acceptance guard refuses a switch write anywhere else. So either the lane's
-- grant widens, or a test-only override appears. These files also hold 19 of the 36 grants a full lane uses.
--
-- Proof needed before this is applied:
--   a. RT-1, EV-1 and PS-RESTORE unchanged (they already run through the worker with the real switch).
--   b. New: a direct claim while paused returns reason 'paused', claimed false, with no state change.
--   c. New: a switch-off mid-batch stops the next claim, and leaves the rest pending.
--   d. E6, E7 and P9-4 pass with sending enabled, with their controls intact. Their control is what proves
--      a state filter rather than the switch ruled the row out.
--   e. pgTAP 37 passes with the edit above, and the 18 are green on a real run.

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
