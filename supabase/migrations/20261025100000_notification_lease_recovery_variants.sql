-- ─────────────────────────────────────────────────────────────────────────────
-- 20261025100000 — Ambiguous lease recovery for non-idempotent providers
--                  (M13.2 P9-4)
--
-- docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §10.6.2
-- (ambiguous outcomes vs provider idempotency), §10.6.4 (added in this PR).
-- docs/product/M13.2-P9-4-SES-SENDING-ADAPTER-DESIGN.md.
--
-- Scope — ADD ONLY. One new function. The sender pause switch stays off, no
-- SES adapter is enabled by this migration, no AWS resource is touched, and
-- no existing function is amended (recover_expired_notification_lease and
-- the resolve_notification_claim path are preserved byte-for-byte).
--
-- What this does, and only this:
--
--   app.resolve_lease_ambiguous(p_delivery_id uuid): the sibling of
--   app.recover_expired_notification_lease. Same lease-expired precondition,
--   same row-locking discipline, but transitions the row to
--   dead / outcome_unknown instead of returning it to pending.
--
--   Used by the sender when the provider is `idempotency: "none"` (SES
--   today): a worker crash while holding a lease could have left SES in
--   either "accepted" or "did not accept" state, and we must not retry a
--   send that may have already gone through (Q-DUP). The row is surfaced for
--   an operator to decide, matching the in-process rule in
--   notification-backoff.ts for `provider_timeout` + idempotency: "none".
--
-- What this deliberately does NOT do:
--
--   · No change to recover_expired_notification_lease (the idempotent-provider
--     recovery path stays as-is: back to pending so a retry can finish the
--     job via the provider's own dedupe window).
--   · No change to resolve_notification_claim, claim_notification_delivery,
--     reserve_email_attempt, is_address_suppressed, notification_send_health,
--     the suppression table, the webhook ingestion or the quota controls.
--   · No change to the sender pause switch default (false).
--
-- Privileges follow the P5 convention: SECURITY DEFINER with
-- SET search_path = '', EXECUTE revoked from public, anon and authenticated.
-- The sole caller is the notification worker over its owner connection.
--
-- Additive. No existing row is rewritten. Rollback: drop the function.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Resolve an expired lease as ambiguous (dead / outcome_unknown) ───────
create or replace function app.resolve_lease_ambiguous(
  p_delivery_id uuid
)
returns table (resolved boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  -- Serialise with a concurrent live worker and with the sibling
  -- recover_expired_notification_lease path, both of which take the same
  -- row lock. First writer wins; a second caller re-checks the state and
  -- reports "not_leased" (the row has already left `sending`).
  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
  for update;

  if v_row.id is null or v_row.status <> 'sending' then
    resolved := false; reason := 'not_leased';
    return next;
    return;
  end if;

  -- A live lease refuses: the worker that holds it may still complete the
  -- resolve path. Only an expired lease is eligible. The lease is cleared
  -- in the same update so the old holder's token can never settle after.
  if v_row.send_lease_expires_at is null or v_row.send_lease_expires_at > now() then
    resolved := false; reason := 'lease_still_valid';
    return next;
    return;
  end if;

  update public.notification_deliveries
  set status = 'dead',
      error_code = 'outcome_unknown',
      send_lease_token = null,
      send_lease_expires_at = null
      -- provider_message_id intentionally untouched: a crash-after-accept
      -- leaves it null (the worker died before it could record the id).
      -- A Delivery webhook that arrives afterwards is already a no-op on
      -- dead rows (app.record_ses_delivery_event only promotes from sent).
  where id = p_delivery_id;

  resolved := true; reason := 'dead';
  return next;
  return;
end;
$$;

comment on function app.resolve_lease_ambiguous(uuid) is
  'M13.2 P9-4: transition a sending row with an expired lease to dead / outcome_unknown. Used for providers with idempotency = "none" (SES today) where a lease-expired state means the provider may have accepted the message and a retry would double-send. The sibling recover_expired_notification_lease is still the right path for idempotent providers. Row-locked and lease-expired-gated; a live lease is refused. Operator/worker only; no client role may execute it.';

revoke all on function app.resolve_lease_ambiguous(uuid) from public;
revoke execute on function app.resolve_lease_ambiguous(uuid) from anon, authenticated;
