-- ─────────────────────────────────────────────────────────────────────────────
-- 20261013200100 — Fix resolve_notification_claim: clear stale error fields
-- on the sent outcome (M13.2 P5-1 corrective)
--
-- Defect: when a delivery fails transiently (retry with error_code) and then
-- succeeds, the sent outcome did not null out error_code or error_message.
-- The notification_deliveries_sent_has_no_error CHECK constraint rejects the
-- UPDATE, making retry-then-sent impossible.
--
-- Fix: add error_code = null, error_message = null to the sent UPDATE.
-- No other outcome or behavior is changed.
--
-- Additive. Does not rewrite the P5-1 migration. Safe to apply after P5-2.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.resolve_notification_claim(
  p_delivery_id          uuid,
  p_lease_token          text,
  p_outcome              text,
  p_error_code           text          default null,
  p_provider_message_id  text          default null,
  p_next_retry_at        timestamptz   default null
)
returns table (settled boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  if p_outcome not in ('sent', 'retry', 'dead') then
    raise exception 'INVALID_OUTCOME: settle outcome must be sent, retry or dead, not %', p_outcome
      using errcode = '22023';
  end if;

  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
  for update;

  if v_row.id is null
     or v_row.status <> 'sending'
     or p_lease_token is null
     or v_row.send_lease_token is null
     or v_row.send_lease_token <> p_lease_token
     or v_row.send_lease_expires_at is null
     or v_row.send_lease_expires_at <= now() then
    settled := false; reason := 'invalid_or_expired_lease';
    return next;
    return;
  end if;

  if p_outcome = 'sent' then
    if p_error_code is not null then
      raise exception 'INVALID_SETTLE: a sent delivery carries no error_code'
        using errcode = '22023';
    end if;
    update public.notification_deliveries
    set status = 'sent',
        provider_message_id = p_provider_message_id,
        error_code = null,
        error_message = null,
        send_lease_token = null,
        send_lease_expires_at = null
    where id = p_delivery_id;
    settled := true; reason := 'sent';
    return next;
    return;
  end if;

  if p_outcome = 'retry' then
    if p_error_code is null then
      raise exception 'INVALID_SETTLE: a retry carries the transient error_code'
        using errcode = '22023';
    end if;
    update public.notification_deliveries
    set status = 'pending',
        error_code = p_error_code,
        next_retry_at = p_next_retry_at,
        send_lease_token = null,
        send_lease_expires_at = null
    where id = p_delivery_id;
    settled := true; reason := 'pending';
    return next;
    return;
  end if;

  -- p_outcome = 'dead'
  if p_error_code is null then
    raise exception 'INVALID_SETTLE: a dead delivery carries a stable error_code'
      using errcode = '22023';
  end if;
  update public.notification_deliveries
  set status = 'dead',
      error_code = p_error_code,
      provider_message_id = coalesce(p_provider_message_id, provider_message_id),
      send_lease_token = null,
      send_lease_expires_at = null
  where id = p_delivery_id;
  settled := true; reason := 'dead';
  return next;
  return;
end;
$$;

comment on function app.resolve_notification_claim(uuid, text, text, text, text, timestamptz) is
  'M13.2 P5-1: leave sending only with the current unexpired lease token. sent stores the provider id, clears stale error fields, and is terminal; retry returns to pending with a caller-supplied next_retry_at and the attempt kept consumed; dead is terminal with a stable error_code. An expired, replaced or wrong token changes nothing. Operator/worker only; no client role may execute it.';
