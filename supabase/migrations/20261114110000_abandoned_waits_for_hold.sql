-- ─────────────────────────────────────────────────────────────────────────────
-- 20261114110000 — An abandoned checkout stays pending until its hold ends
--
-- The gap (status report 2026-11-14, sandbox finding 1): Paystack reports an
-- initialized transaction that has not been paid YET as `abandoned` straight
-- away. T1 mapped `abandoned` → attempt `failed` and released the stock, so a
-- verify that ran before the payer finished (the callback page reached by a
-- back navigation, an early webhook) failed a checkout the payer was still
-- completing. The payer saw "failed"; a late success then moved the attempt
-- from failed to captured, and a limited unit released in between could be
-- sold to someone else (T2 then parks the late payment as stock_exhausted).
--
-- The fix (owner decision 2026-11-14): while the attempt's checkout hold is
-- running (now() < hold_expires_at, payment_limits.hold_minutes = 30), an
-- `abandoned` statement is evidence only, exactly like `pending`: the attempt
-- stays created/initialized, its stock stays reserved, and the caller reports
-- `pending`. Once the hold has ended, `abandoned` fails the attempt with
-- failure_code 'provider_abandoned' and releases the stock, as before. The
-- sweep only looks at attempts past their hold, so after 30 minutes it is the
-- sweep that settles an unpaid checkout as abandoned.
--
-- What does NOT change:
--   · `failed` (a declined card) still fails the attempt at once.
--   · `succeeded`, `reversed`, `unrecognised` and `pending` are untouched.
--   · Money-known states (captured, completed, needs_review) are never moved
--     by a failure, inside or outside the hold.
--   · The statement is still stored (deduplicated by content hash) every time.
--
-- Additive. No data changes, no stored amount changes. Rollback: re-create
-- app.record_provider_transaction from 20261111100100_payment_functions.sql.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.record_provider_transaction(
  p_reference               text,
  p_provider                text,
  p_provider_transaction_id text,
  p_provider_reference      text,
  p_status_mapped           text,
  p_status_raw              text,
  p_amount_kobo             bigint,
  p_currency                text,
  p_provider_fee_kobo       bigint,
  p_paid_at                 timestamptz,
  p_channel                 text,
  p_authorization_hash      text,
  p_payload                 jsonb
)
returns table (attempt_id uuid, status public.payment_attempt_status, review_reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_attempt public.payment_attempts%rowtype;
  v_hash    text;
  v_reason  text;
begin
  perform app.assert_payment_operator_session();

  -- By OUR reference, never by metadata (L-unattributed). An unknown reference
  -- creates nothing; the caller records it as an orphan event.
  select * into v_attempt from public.payment_attempts a where a.reference = p_reference for update;
  if not found then
    raise exception 'UNKNOWN_PAYMENT_REFERENCE: %', p_reference using errcode = 'P0001';
  end if;

  v_hash := encode(sha256(convert_to(concat_ws('|',
    p_provider, p_provider_transaction_id, p_provider_reference, p_status_mapped, p_status_raw,
    p_amount_kobo::text, p_currency, coalesce(p_provider_fee_kobo::text, '∅'),
    coalesce(to_char(p_paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '∅'),
    coalesce(p_channel, '∅'), coalesce(p_authorization_hash, '∅')), 'UTF8')), 'hex');

  insert into public.provider_transactions (
    attempt_id, provider, provider_transaction_id, provider_reference, status_mapped, status_raw,
    amount_kobo, currency, provider_fee_kobo, paid_at, channel, authorization_hash, content_hash, payload
  ) values (
    v_attempt.id, p_provider, p_provider_transaction_id, p_provider_reference, p_status_mapped, p_status_raw,
    p_amount_kobo, p_currency, p_provider_fee_kobo, p_paid_at, p_channel, p_authorization_hash, v_hash,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (attempt_id, content_hash) do nothing;

  -- Terminal or parked: the evidence is kept, the state does not move. A
  -- reversal of a completed payment is for the (deferred) refund/dispute
  -- subsystem and an operator, not for this function.
  if v_attempt.status in ('completed', 'needs_review') then
    return query select v_attempt.id, v_attempt.status, v_attempt.review_reason;
    return;
  end if;

  if p_status_mapped = 'succeeded' then
    v_reason := case
      when p_provider is distinct from v_attempt.provider            then 'provider_mismatch'
      when p_provider_reference is distinct from v_attempt.reference then 'reference_mismatch'
      when p_currency is distinct from 'NGN'                         then 'currency_mismatch'
      when p_amount_kobo is distinct from v_attempt.amount_kobo      then 'amount_mismatch'
      else null
    end;
    if v_reason is not null then
      -- Money was taken but does not match the lock. Recorded, parked, visible;
      -- never accepted and never refused (PA-15: never convert currency).
      update public.payment_attempts set status = 'needs_review', review_reason = v_reason where id = v_attempt.id;
    elsif v_attempt.status in ('created', 'initialized', 'failed', 'expired') then
      update public.payment_attempts set status = 'captured' where id = v_attempt.id;
    end if;

  elsif p_status_mapped = 'abandoned' and now() < v_attempt.hold_expires_at then
    -- The payer may still be on the checkout page: Paystack says `abandoned`
    -- for any initialized transaction that is not paid yet. Inside the hold
    -- this is evidence only, like 'pending'; the stock stays reserved.
    null;

  elsif p_status_mapped in ('failed', 'abandoned') then
    if v_attempt.status in ('created', 'initialized') then
      update public.payment_attempts set status = 'failed', failure_code = 'provider_' || p_status_mapped
       where id = v_attempt.id;
      perform app.release_payment_attempt_stock(v_attempt.id);
    end if;

  elsif p_status_mapped = 'reversed' then
    update public.payment_attempts set status = 'needs_review', review_reason = 'provider_reversed' where id = v_attempt.id;

  elsif p_status_mapped = 'unrecognised' then
    update public.payment_attempts set status = 'needs_review', review_reason = 'provider_status_unrecognised'
     where id = v_attempt.id;
  end if;
  -- 'pending', and 'abandoned' inside the hold: evidence only.

  return query select a.id, a.status, a.review_reason from public.payment_attempts a where a.id = v_attempt.id;
end;
$$;
revoke execute on function app.record_provider_transaction(
  text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb
) from public, anon, authenticated;

comment on function app.record_provider_transaction(
  text, text, text, text, text, text, bigint, text, bigint, timestamptz, text, text, jsonb
) is
  'Plan §4.7 T1. Locks the attempt BY REFERENCE, stores the provider''s statement (deduplicated by content hash), and moves the attempt: success that matches → captured; success that does not → needs_review with the reason; failed → failed; abandoned → failed only once the checkout hold has ended (inside the hold it is evidence only, like pending — 20261114110000); failures move only from created/initialized, never over money; reversed/unrecognised → needs_review. Committed on its own so the fact that money was taken is durable before its effects are attempted.';
