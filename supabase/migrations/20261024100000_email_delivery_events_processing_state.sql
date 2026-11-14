-- ─────────────────────────────────────────────────────────────────────────────
-- 20261024100000 — SES event-ingestion processing state (M13.2 P9-2.1)
--
-- Follow-up hardening after PR #15 (M13.2 P9-2). The receiving route in P9-2
-- stored the authenticated event ledger row BEFORE applying the suppression
-- or delivery-status side effect, but SWALLOWED side-effect failures and
-- returned 200. On a transient DB blip the SNS Notification would be
-- acknowledged while the suppression or delivery transition never actually
-- fired, and a subsequent SNS redelivery would hit the unique index on
-- (provider, provider_event_id) and skip the retry: the event would be lost
-- from the operator's point of view, visible only in the ledger with no
-- marker telling anyone the side effect never happened.
--
-- What this migration changes, and only this:
--
--   1. public.email_delivery_events gains four processing-state columns and
--      an updated_at: processing_status ('pending'|'succeeded'|'failed'),
--      processing_attempts, last_processed_at, last_error_code. All existing
--      rows take the default 'pending' with 0 attempts — this is additive
--      and does not rewrite historical content. (In production there are no
--      rows yet; the P9-2 route is behind unconfigured ingestion.)
--      updated_at is a plain timestamptz; existing rows pick up now() at
--      ADD COLUMN time and the row-level trigger below keeps it current.
--
--   2. The append-only trigger is replaced with a stricter mutation guard:
--      UPDATE is permitted only when the session has set
--      app.email_delivery_events_processing_marker to 'true', AND the
--      content columns (provider, provider_event_id, provider_event_type,
--      normalized_event_type, payload, signature_verified,
--      recipient_address_key, ses_feedback_id, provider_message_id,
--      sns_topic_arn, received_at) are byte-identical between OLD and NEW.
--      Only the five processing-state columns may change. DELETE and
--      TRUNCATE remain unconditionally blocked. This preserves the P9-2
--      "a correction is a NEW event" rule while giving the route an
--      operator-only path to mark the row processed.
--
--   3. app.record_ses_notification: the route's new single entry point for
--      a Notification envelope. INSERT ... ON CONFLICT DO NOTHING on the
--      unique (provider, provider_event_id) and returns the row's id,
--      whether this call inserted it, whether a prior call already marked
--      it succeeded, and the current attempt counter. Operator-only.
--
--   4. app.mark_ses_notification_succeeded(uuid): operator-only. Transitions
--      the row from pending/failed to succeeded, increments the attempt
--      counter, stamps last_processed_at, clears last_error_code. A row
--      already in 'succeeded' is a no-op (returns 0). Idempotent.
--
--   5. app.mark_ses_notification_failed(uuid, text): operator-only.
--      Transitions a non-succeeded row to 'failed' with a stable snake_case
--      error_code, increments attempts, stamps last_processed_at. A row
--      already 'succeeded' is left strictly alone (returns 0): a late
--      failure after an earlier success never downgrades the row.
--
-- What this deliberately does NOT do:
--
--   · Not reintroduce a sending adapter. P9-4 is still gated on D-PROVIDER.
--   · Not change app.record_ses_suppression or app.record_ses_delivery_event
--     (the actual side-effect writers). The route composes them with the
--     new orchestration above.
--   · Not change public.email_suppressions, the sender runtime, or the
--     notification_deliveries schema.
--   · Not flip the sender pause switch (default false; verified).
--
-- Privileges: SECURITY DEFINER with SET search_path = '', EXECUTE revoked
-- from public, anon and authenticated. The sole caller is the webhook route
-- over the owner connection.
--
-- Additive. Rollback: drop the three new app.* functions, drop the five
-- new columns on email_delivery_events, drop the processing index, restore
-- the previous (strictly-no-UPDATE) trigger body from migration
-- 20261023120000_email_delivery_events.sql.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. New processing-state columns ──────────────────────────────────────────
alter table public.email_delivery_events
  add column processing_status text not null default 'pending',
  add column processing_attempts int not null default 0,
  add column last_processed_at timestamptz,
  add column last_error_code text,
  add column updated_at timestamptz not null default now();

alter table public.email_delivery_events
  add constraint email_delivery_events_processing_status_values
    check (processing_status in ('pending', 'succeeded', 'failed')),
  add constraint email_delivery_events_processing_attempts_nonneg
    check (processing_attempts >= 0),
  add constraint email_delivery_events_last_error_code_format
    -- Same stable snake_case vocabulary notification_deliveries.error_code uses.
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  add constraint email_delivery_events_succeeded_has_no_error
    -- A succeeded row must not carry an error_code — the two together would
    -- confuse operators reading the ledger.
    check (processing_status <> 'succeeded' or last_error_code is null),
  add constraint email_delivery_events_failed_has_error
    -- A failed row must say what failed. Pending rows have never been
    -- processed, so they may have null error_code. Succeeded rows have no
    -- error_code (previous check).
    check (processing_status <> 'failed' or last_error_code is not null);

comment on column public.email_delivery_events.processing_status is
  'M13.2 P9-2.1: pending (new, no side effect attempted yet) | succeeded (side effect applied) | failed (side effect attempted, failed). A ''failed'' row is retried on the next SNS redelivery.';

comment on column public.email_delivery_events.processing_attempts is
  'How many times the route has attempted the side effect for this event. Incremented by both the succeeded and failed mark functions; starts at 0 at insert.';

comment on column public.email_delivery_events.last_error_code is
  'Stable snake_case error_code from the last failed attempt. Null when the row has never failed or has since succeeded.';


-- Partial index for operator inspection of events that have not yet reached
-- 'succeeded'. Keeps the index small (most rows settle to succeeded quickly).
create index email_delivery_events_unprocessed_idx
  on public.email_delivery_events (received_at)
  where processing_status in ('pending', 'failed');


-- ── 2. updated_at keeper ─────────────────────────────────────────────────────
-- The existing app.set_updated_at() trigger function (used by many other
-- tables, defined in 20260918140000-ish) handles exactly this pattern. We
-- attach it here so updated_at advances on every allowed row mutation.
create trigger email_delivery_events_set_updated_at
  before update on public.email_delivery_events
  for each row execute function app.set_updated_at();


-- ── 3. Replace the mutation-blocking trigger ─────────────────────────────────
-- UPDATE is now allowed ONLY when the processing-marker session variable is
-- set to 'true', AND only the processing-state columns differ. DELETE and
-- TRUNCATE remain unconditionally blocked.
--
-- The previous body (migration 20261023120000) refused UPDATE outright. The
-- rewrite below is the minimum change: a single short-circuit for the
-- marker-gated UPDATE path, and byte-identity checks on every content
-- column so even an operator with the marker set cannot rewrite history.
create or replace function app.block_email_delivery_events_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('app.email_delivery_events_processing_marker', true) = 'true' then
    -- Content is strictly immutable. Only processing_status, processing_attempts,
    -- last_processed_at, last_error_code and updated_at may change. The order
    -- in the ROW() constructor matches the table's column order to make the
    -- comparison tuple obvious to a reader; it does not need to.
    if row(old.id, old.provider, old.provider_event_id, old.provider_event_type,
           old.normalized_event_type, old.payload, old.signature_verified,
           old.recipient_address_key, old.ses_feedback_id, old.provider_message_id,
           old.sns_topic_arn, old.received_at)
       is distinct from
       row(new.id, new.provider, new.provider_event_id, new.provider_event_type,
           new.normalized_event_type, new.payload, new.signature_verified,
           new.recipient_address_key, new.ses_feedback_id, new.provider_message_id,
           new.sns_topic_arn, new.received_at)
    then
      raise exception
        'EMAIL_DELIVERY_EVENTS_CORE_IS_IMMUTABLE: a correction to the event payload must land as a NEW event, never as an edit (M13.2 P9-2.1)'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  raise exception
    'EMAIL_DELIVERY_EVENTS_IS_APPEND_ONLY: email_delivery_events rows cannot be % — a correction is a NEW event, never an edit (M13.2 P9-2.1)',
    lower(tg_op)
    using errcode = 'P0001';
  return null;
end;
$$;

-- Permissions re-asserted (create or replace preserves prior grants, but we
-- state them explicitly for review).
revoke execute on function app.block_email_delivery_events_mutation() from public, anon, authenticated;


-- ── 4. Insert-or-reuse the ledger row for a Notification ─────────────────────
create or replace function app.record_ses_notification(
  p_provider_event_id      text,
  p_provider_event_type    text,
  p_normalized_event_type  text,
  p_payload                jsonb,
  p_signature_verified     boolean,
  p_recipient_address_key  text,
  p_ses_feedback_id        text,
  p_provider_message_id    text,
  p_sns_topic_arn          text
)
returns table (
  event_id             uuid,
  inserted             boolean,
  previously_succeeded boolean,
  processing_attempts  integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role     text;
  v_existing public.email_delivery_events%rowtype;
  v_new_id   uuid;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: record_ses_notification is operator-only (role = none)'
      using errcode = '42501';
  end if;

  -- Try to insert. ON CONFLICT DO NOTHING swallows a duplicate (replayed
  -- Notification carrying the same SNS MessageId) and the row-fetch below
  -- picks up the existing row.
  insert into public.email_delivery_events (
    provider, provider_event_id, provider_event_type, normalized_event_type,
    payload, signature_verified, recipient_address_key,
    ses_feedback_id, provider_message_id, sns_topic_arn
  ) values (
    'ses', p_provider_event_id, p_provider_event_type, p_normalized_event_type,
    p_payload, p_signature_verified, p_recipient_address_key,
    p_ses_feedback_id, p_provider_message_id, p_sns_topic_arn
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_new_id;

  if v_new_id is not null then
    event_id := v_new_id;
    inserted := true;
    previously_succeeded := false;
    processing_attempts := 0;
    return next;
    return;
  end if;

  -- Already exists: pull the current state so the route can decide whether
  -- to retry the side effect (previously_succeeded = false) or short-circuit
  -- as a duplicate ack (previously_succeeded = true).
  select * into v_existing
  from public.email_delivery_events
  where provider = 'ses' and provider_event_id = p_provider_event_id;

  event_id := v_existing.id;
  inserted := false;
  previously_succeeded := (v_existing.processing_status = 'succeeded');
  processing_attempts := v_existing.processing_attempts;
  return next;
  return;
end;
$$;

comment on function app.record_ses_notification(text, text, text, jsonb, boolean, text, text, text, text) is
  'M13.2 P9-2.1: single entry point the webhook route calls on an authenticated SNS Notification. Inserts the ledger row (ON CONFLICT DO NOTHING on the unique provider+provider_event_id); if the row already exists, returns its id, previously_succeeded flag and current attempt count. Operator-only (role = none); the route calls it via withOwnerConnection.';

revoke all on function app.record_ses_notification(text, text, text, jsonb, boolean, text, text, text, text) from public;
revoke execute on function app.record_ses_notification(text, text, text, jsonb, boolean, text, text, text, text) from anon, authenticated;


-- ── 5. Mark a notification succeeded ─────────────────────────────────────────
create or replace function app.mark_ses_notification_succeeded(
  p_event_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_updated bigint;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: mark_ses_notification_succeeded is operator-only (role = none)'
      using errcode = '42501';
  end if;

  perform set_config('app.email_delivery_events_processing_marker', 'true', true);

  update public.email_delivery_events
  set processing_status   = 'succeeded',
      processing_attempts = processing_attempts + 1,
      last_processed_at   = now(),
      last_error_code     = null
  where id = p_event_id
    and processing_status <> 'succeeded';

  get diagnostics v_updated = row_count;

  perform set_config('app.email_delivery_events_processing_marker', 'false', true);

  return v_updated;
end;
$$;

comment on function app.mark_ses_notification_succeeded(uuid) is
  'M13.2 P9-2.1: transition a notification''s ledger row to processing_status = succeeded. Idempotent (a second call for a succeeded row returns 0). Increments processing_attempts, stamps last_processed_at, clears last_error_code. Operator-only (role = none).';

revoke all on function app.mark_ses_notification_succeeded(uuid) from public;
revoke execute on function app.mark_ses_notification_succeeded(uuid) from anon, authenticated;


-- ── 6. Mark a notification failed ────────────────────────────────────────────
create or replace function app.mark_ses_notification_failed(
  p_event_id    uuid,
  p_error_code  text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_updated bigint;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: mark_ses_notification_failed is operator-only (role = none)'
      using errcode = '42501';
  end if;

  -- Stable snake_case error codes only. The route maps its own fault vocabulary
  -- onto a small, reviewed set so the operator-visible column stays legible.
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'INVALID_ERROR_CODE: p_error_code must be stable snake_case'
      using errcode = '22023';
  end if;

  perform set_config('app.email_delivery_events_processing_marker', 'true', true);

  -- Never downgrade a succeeded row. A late failure signal after a successful
  -- processing attempt (unexpected but conceivable in a replay scenario) must
  -- not overwrite the operator-visible success state.
  update public.email_delivery_events
  set processing_status   = 'failed',
      processing_attempts = processing_attempts + 1,
      last_processed_at   = now(),
      last_error_code     = p_error_code
  where id = p_event_id
    and processing_status <> 'succeeded';

  get diagnostics v_updated = row_count;

  perform set_config('app.email_delivery_events_processing_marker', 'false', true);

  return v_updated;
end;
$$;

comment on function app.mark_ses_notification_failed(uuid, text) is
  'M13.2 P9-2.1: transition a notification''s ledger row to processing_status = failed with a stable snake_case error_code. Never downgrades a succeeded row (returns 0 in that case). Operator-only (role = none).';

revoke all on function app.mark_ses_notification_failed(uuid, text) from public;
revoke execute on function app.mark_ses_notification_failed(uuid, text) from anon, authenticated;
