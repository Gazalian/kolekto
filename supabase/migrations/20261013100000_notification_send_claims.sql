-- ─────────────────────────────────────────────────────────────────────────────
-- 20261013100000 — Atomic send claims and leases (M13.2 P5-1)
--
-- Decision record §10.2, §10.3, §10.6.2 (claim with lease, 5-minute lease,
-- at most 3 attempts per delivery, no exactly-once claim).
--
-- What this does, and only this:
--
--   1. Two lease columns on public.notification_deliveries:
--      send_lease_token (64 hex chars from gen_random_bytes) and
--      send_lease_expires_at. Only a row in `sending` holds a lease; every
--      other status holds none. Both directions are CHECK-enforced, so a
--      lease can neither leak onto a terminal row nor go missing on a
--      `sending` one. The three-attempt cap lives in the claim function,
--      the only path that increments attempt_count.
--   2. app.claim_notification_delivery(delivery, lease_seconds): atomically
--      claims ONE eligible `pending` email delivery — row lock, eligibility
--      re-check, lease creation, status → `sending`, attempt reservation —
--      in a single transaction. Returns claimed = false with a reason for
--      anything ineligible (terminal, exhausted, not due, already claimed,
--      not found). Never raises for a race outcome.
--   3. app.claim_next_notification_delivery(lease_seconds): the queue-scanning
--      half. Picks the oldest due `pending` email row with
--      FOR UPDATE SKIP LOCKED and claims it through (2), so concurrent
--      workers skip rows each other holds instead of serialising on them.
--      A by-id claim instead takes the row lock and re-validates: two
--      workers racing one id serialise on the lock and only the first can
--      succeed, because the status check happens after the lock is held.
--      That is the documented equivalent the brief allows.
--   4. app.resolve_notification_claim(delivery, token, outcome, ...): the
--      ONLY way to leave `sending`. (Named "resolve", not "settle": the fee
--      invariant test forbids any app.* function whose name contains
--      "settle".) The token must match the stored lease AND the lease must
--      be unexpired, otherwise nothing is written. Outcomes: 'sent'
--      (terminal, stores the provider id), 'retry' (back to `pending` with
--      a caller-supplied next_retry_at; the reserved attempt is NOT
--      refunded) and 'dead' (terminal, stable error_code required). Misuse
--      (unknown outcome, code where none belongs) raises: that is a worker
--      bug, not a race.
--   5. app.recover_expired_notification_lease(delivery): returns an
--      expired-lease `sending` row to `pending` and clears the lease. The
--      reserved attempt stays consumed. A row whose lease is still valid is
--      refused, so recovery and a live worker can never both act.
--
-- What this deliberately does NOT do (later P5 phases):
--
--   · No provider call, no sender loop, no tick. The worker MUST commit the
--     claim transaction before any future provider call executes; holding a
--     transaction open across a provider call would hold the row lock for
--     the duration of the call and defeat SKIP LOCKED.
--   · No rate-limit ledger (P5-2): deferrals never reach these functions,
--     and a deferral consumes no attempt because only a successful claim
--     reserves one.
--   · No backoff computation: 'retry' takes next_retry_at from the caller.
--   · No 72-hour expiry housekeeping: a `pending` row older than 72 hours
--     becoming terminal with `event_too_old` (including while sending is
--     paused) belongs to the sender milestone with the pause switch (P5-5);
--     see docs/product/M13.2-P5-1-SEND-CLAIMS-IMPLEMENTATION.md.
--   · No held-queue interaction: notification_events_held is untouched;
--     nothing here releases or drains held events.
--
-- Privileges follow the P4 convention: SECURITY DEFINER with
-- SET search_path = '', EXECUTE revoked from public, anon and authenticated.
-- The sole caller is the notification worker over its owner connection.
-- Client roles cannot read lease tokens: app.list_email_delivery_log()
-- selects an explicit column list with no token column, and the base table
-- grants no officer any email row (P2).
--
-- Additive. No existing row is rewritten: no delivery row today holds a
-- lease, asserted below before the constraints are added. Rollback: drop
-- the three functions, the two indexes and the two columns, and drop the
-- three new check constraints.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Lease columns ─────────────────────────────────────────────────────────
alter table public.notification_deliveries
  add column send_lease_token text,
  add column send_lease_expires_at timestamptz;

comment on column public.notification_deliveries.send_lease_token is
  'M13.2 P5-1: unguessable 64-hex-char claim token, present only while status is sending. Validated on every state-changing operation; never exposed to client roles.';
comment on column public.notification_deliveries.send_lease_expires_at is
  'M13.2 P5-1: when the claim lease lapses (claim time + 5 minutes by default). A sending row past this timestamp is recoverable to pending; a live lease refuses recovery.';


-- ── Safety check: existing rows must satisfy the new constraints ─────────────
-- Runs after the columns exist (unlike the P2 check, which only read old
-- columns): no delivery row today holds a lease. The three-attempt cap needs
-- no precondition: it is enforced by the claim function, the only path that
-- increments attempt_count, so stored history (including a dead row with an
-- older count) is never rewritten by this migration.
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
  from public.notification_deliveries
  where send_lease_token is not null
     or send_lease_expires_at is not null;

  if v_bad > 0 then
    raise exception
      'M13.2 P5-1 PRECONDITION: % notification_deliveries row(s) already hold a lease; review them before applying this migration', v_bad
      using errcode = 'P0001';
  end if;
end;
$$;


-- ── 2. Constraints ───────────────────────────────────────────────────────────
alter table public.notification_deliveries
  add constraint notification_deliveries_lease_token_format
    check (send_lease_token is null or send_lease_token ~ '^[0-9a-f]{64}$'),

  -- A sending row always holds a complete lease ...
  add constraint notification_deliveries_sending_holds_lease
    check (status <> 'sending'
           or (send_lease_token is not null and send_lease_expires_at is not null)),

  -- ... and only a sending row holds one. Clearing the lease is part of
  -- every transition out of sending, so a stale worker can never match a
  -- newer claim: the token is gone with the old state.
  add constraint notification_deliveries_lease_only_when_sending
    check (status = 'sending'
           or (send_lease_token is null and send_lease_expires_at is null));

  -- No CHECK on attempt_count: at most three attempts per delivery
  -- (decision record §10.6.2) is enforced by the claim function, the only
  -- path that increments it. A CHECK would rewrite history — an existing
  -- test fixture holds a dead row with an older count — while adding no
  -- concurrency safety the row lock does not already give.


-- ── 3. Claim and recovery indexes ────────────────────────────────────────────
-- Oldest due pending email row first, so deferred communities are not starved.
create index notification_deliveries_claim_idx
  on public.notification_deliveries (created_at, id)
  where channel = 'email' and status = 'pending';

-- Stale-lease recovery scan.
create index notification_deliveries_expired_lease_idx
  on public.notification_deliveries (send_lease_expires_at)
  where status = 'sending';


-- ── 4. Claim one delivery by id ──────────────────────────────────────────────
create or replace function app.claim_notification_delivery(
  p_delivery_id  uuid,
  p_lease_seconds integer default 300
)
returns table (
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
  v_lease   integer;
  v_row     public.notification_deliveries%rowtype;
  v_token   text;
  v_expires timestamptz;
begin
  -- Five minutes, by contract. The parameter exists so tests can use short
  -- leases without waiting; it is clamped so a caller cannot mint an
  -- indefinite or a uselessly short lease.
  v_lease := greatest(60, least(coalesce(p_lease_seconds, 300), 600));

  -- Serialise concurrent claimers of this row: the second waits on the lock,
  -- then re-validates below and reports already_claimed. Claiming, lease
  -- creation, the state transition and the attempt reservation all commit
  -- together when the caller's transaction commits — which must happen
  -- BEFORE any provider call, never across one.
  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
  for update;

  if v_row.id is null then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := null; reason := 'not_found';
    return next;
    return;
  end if;

  if v_row.channel <> 'email' then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := v_row.attempt_count; reason := 'not_email';
    return next;
    return;
  end if;

  if v_row.status in ('sent', 'dead', 'skipped') then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := v_row.attempt_count; reason := 'terminal';
    return next;
    return;
  end if;

  if v_row.status <> 'pending' then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := v_row.attempt_count; reason := 'already_claimed';
    return next;
    return;
  end if;

  if v_row.attempt_count >= 3 then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := v_row.attempt_count; reason := 'exhausted';
    return next;
    return;
  end if;

  if v_row.next_retry_at is not null and v_row.next_retry_at > now() then
    claimed := false; lease_token := null; lease_expires_at := null;
    attempt_count := v_row.attempt_count; reason := 'not_due';
    return next;
    return;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(secs => v_lease);

  update public.notification_deliveries
  set status = 'sending',
      send_lease_token = v_token,
      send_lease_expires_at = v_expires,
      attempt_count = v_row.attempt_count + 1,
      last_attempted_at = now()
  where id = p_delivery_id;

  claimed := true; lease_token := v_token; lease_expires_at := v_expires;
  attempt_count := v_row.attempt_count + 1; reason := 'claimed';
  return next;
  return;
end;
$$;

comment on function app.claim_notification_delivery(uuid, integer) is
  'M13.2 P5-1: atomically claim one pending email delivery. Row lock, eligibility re-check, 64-hex lease, status to sending, attempt reserved — one transaction. Returns claimed = false with a reason for terminal/exhausted/not-due/already-claimed rows. Commit before any provider call; never hold the transaction across one. Operator/worker only; no client role may execute it.';

revoke all on function app.claim_notification_delivery(uuid, integer) from public;
revoke execute on function app.claim_notification_delivery(uuid, integer) from anon, authenticated;


-- ── 5. Claim the next due delivery ───────────────────────────────────────────
create or replace function app.claim_next_notification_delivery(
  p_lease_seconds integer default 300
)
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

comment on function app.claim_next_notification_delivery(integer) is
  'M13.2 P5-1: claim the oldest due pending email delivery with FOR UPDATE SKIP LOCKED (three-attempt cap, not-due rows skipped). Empty queue returns claimed = false, never raises. Operator/worker only; no client role may execute it.';

revoke all on function app.claim_next_notification_delivery(integer) from public;
revoke execute on function app.claim_next_notification_delivery(integer) from anon, authenticated;


-- ── 6. Resolve a claim (token-gated) ─────────────────────────────────────────
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

  -- The lease alone never proves delivery (decision record §10.3); it only
  -- proves THIS worker holds the current claim. Expired, replaced (the
  -- stored token differs) or missing leases change nothing. The NULL check
  -- on the *supplied* token comes first and is explicit: `stored <> NULL`
  -- yields NULL, which an IF chain would treat as pass, so without it a
  -- NULL token would fail open and resolve any live claim.
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
    -- The reserved attempt stays consumed: a timed-out call may still have
    -- delivered, so refunding would let a flaky network exceed the cap.
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
  'M13.2 P5-1: leave sending only with the current unexpired lease token. sent stores the provider id and is terminal; retry returns to pending with a caller-supplied next_retry_at and the attempt kept consumed; dead is terminal with a stable error_code. An expired, replaced or wrong token changes nothing. Operator/worker only; no client role may execute it.';

revoke all on function app.resolve_notification_claim(uuid, text, text, text, text, timestamptz) from public;
revoke execute on function app.resolve_notification_claim(uuid, text, text, text, text, timestamptz) from anon, authenticated;


-- ── 7. Recover an expired lease ──────────────────────────────────────────────
create or replace function app.recover_expired_notification_lease(
  p_delivery_id uuid
)
returns table (recovered boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notification_deliveries%rowtype;
begin
  select * into v_row
  from public.notification_deliveries
  where id = p_delivery_id
  for update;

  if v_row.id is null or v_row.status <> 'sending' then
    recovered := false; reason := 'not_leased';
    return next;
    return;
  end if;

  -- A live lease refuses recovery: the holder may still complete it. Only
  -- an expired lease returns to pending — and the lease is cleared in the
  -- same update, so the old holder's token can never settle afterwards.
  if v_row.send_lease_expires_at is null or v_row.send_lease_expires_at > now() then
    recovered := false; reason := 'lease_still_valid';
    return next;
    return;
  end if;

  update public.notification_deliveries
  set status = 'pending',
      send_lease_token = null,
      send_lease_expires_at = null
  where id = p_delivery_id;

  recovered := true; reason := 'pending';
  return next;
  return;
end;
$$;

comment on function app.recover_expired_notification_lease(uuid) is
  'M13.2 P5-1: return a sending row with an expired lease to pending and clear the lease, so the old token can never settle afterwards. A live lease is refused. Attempts stay consumed. Operator/worker only; no client role may execute it.';

revoke all on function app.recover_expired_notification_lease(uuid) from public;
revoke execute on function app.recover_expired_notification_lease(uuid) from anon, authenticated;
