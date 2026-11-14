-- ─────────────────────────────────────────────────────────────────────────────
-- 20261023120000 — SES/SNS event ingestion (M13.2 P9-2)
--
-- docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md §9.3 (webhook
-- idempotency, out-of-scope → in scope here), §10.4 (the delivered status,
-- previously reserved for webhooks), §10.6.2 (ambiguity visible but not
-- hidden), §13 (D-SUPPRESS: this migration closes the ses_event half of it;
-- recipient suppression itself landed in P9-1).
--
-- Scope — RECEIVING ONLY. This migration adds the ingest-side tables and
-- functions. No AWS SDK is pulled in; no outbound SES or SNS call is made; no
-- real email is enabled; the P9-1 recipient-suppression migration is not
-- touched; the sender pause switch is not flipped.
--
-- What this does, and only this:
--
--   1. public.email_delivery_events: the authenticated-event ledger. One row
--      per unique (provider, provider_event_id). Stores the verified payload,
--      the normalised event type, correlation keys (recipient_address_key,
--      ses_feedback_id, provider_message_id), the SNS topic ARN as received
--      and whether the signature verified. UNIQUE (provider, provider_event_id)
--      IS the dedupe (D-25) — a replayed SNS Notification conflicts there and
--      the handler returns success having changed nothing else. Deny-all RLS
--      and no client grant, same model as public.financial_events (which
--      stores provider PII in payload and is readable by no client role).
--      Append-only via trigger: a provider correction is a NEW event, never
--      an edit (DAT-02).
--   2. app.record_ses_suppression(address, reason, feedback_id, message_id):
--      operator-session entry point used by the webhook route. Writes
--      permanent suppressions with source = 'ses_event' via the P9-1 setter
--      app.set_email_suppression (so the single setter's lock order, address
--      normalisation and append-only guarantees stay the single source of
--      truth). Only hard_bounce and complaint are permitted; any other reason
--      is refused at the entry point so a malformed event cannot write an
--      unexpected row. source_event_id is populated with the SES feedback id
--      when the event carries one, else the SNS MessageId we also store on
--      email_delivery_events.
--   3. app.record_ses_delivery_event(provider_message_id, delivered_at):
--      operator-session entry point for SES Delivery notifications.
--      Transitions a notification_deliveries row FROM 'sent' TO 'delivered'
--      and ONLY from 'sent' — a 'dead', 'skipped', 'pending', 'sending' or
--      already 'delivered' row is left strictly alone (unknown delivery
--      cannot promote a dead one, and a late Delivery event after an
--      operator-force-dead must not resurrect it). Idempotent: a second call
--      for a row already in 'delivered' is a no-op (returns 0). provider_
--      message_id is the correlation key; it is the id SES returned at send
--      and that app.resolve_notification_claim stored on the row.
--
-- What this deliberately does NOT do:
--
--   · No SES sending adapter, no SES SDK dependency, no registration of 'ses'
--     in REAL_EMAIL_PROVIDERS. That is P9-4.
--   · No change to app.reserve_email_attempt, app.claim_notification_delivery
--     or app.resolve_notification_claim (the sender path is untouched; this
--     only receives feedback).
--   · No change to the sender pause switch (still default false; verified).
--   · No change to app.set_email_suppression or the suppression table beyond
--     writing new rows through the existing setter.
--   · No modification to the P9-1 recipient-suppression migration.
--   · No retention policy — events are stored indefinitely until retention is
--     reviewed and documented alongside the financial_events retention
--     question (O-10 in the decision record). Append-only enforcement makes
--     retention a later operator-controlled migration, not an inline TTL.
--     The implementation record lists this explicitly.
--
-- Privileges: SECURITY DEFINER on every app.* function, SET search_path = '',
-- EXECUTE revoked from public, anon, authenticated. Both new functions are
-- operator-only (role = 'none') because they are reachable only from the
-- webhook route's owner-connection; a client role must never be able to
-- call them (a browser webhook post would be forged input).
--
-- Additive. No existing row is rewritten by this migration. Rollback: drop
-- the two app.* functions added here, the trigger and function that enforce
-- append-only, the three indexes, the deny policy, and the table.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. The authenticated-event ledger ────────────────────────────────────────
create table public.email_delivery_events (
  id                      uuid         primary key default app.uuid_generate_v7(),

  -- Which provider the event came from. 'ses' is the only value today; a
  -- second provider would land its own migration with its own ingest route.
  provider                text         not null,

  -- The provider-stable event id. For SNS Notification messages this is the
  -- SNS MessageId; the per-notification unique index on (provider,
  -- provider_event_id) IS the deduplication (D-25). For a SubscriptionConfirmation
  -- the handler verifies the signature and visits the SubscribeURL but writes
  -- no row (nothing to dedupe or process beyond the subscription itself).
  provider_event_id       text         not null,

  -- The provider's own event type verbatim, exactly as the authenticated
  -- SES/SNS payload named it (e.g. 'Delivery', 'Bounce', 'Complaint',
  -- 'Reject', 'Rendering Failure'). Stored, never branched on by business
  -- logic — a reader maps it to normalized_event_type.
  provider_event_type     text         not null,

  -- Kolekto's own vocabulary. Append-only: once shipped, a value is never
  -- renamed or reused. Everything downstream branches on this.
  normalized_event_type   text         not null,

  -- The authenticated payload, verbatim (SNS envelope + SES message). May
  -- contain contributor PII (recipient addresses), which is why no client
  -- role can read this table and why operator reads must redact. Retention
  -- is open (see migration header).
  payload                 jsonb        not null,

  -- Whether the signature verified. An unverified body never reaches this
  -- table (the route refuses first), so this is always TRUE in practice; it
  -- exists so an unexpected FALSE is visible as the anomaly it would be.
  signature_verified      boolean      not null,

  -- Case-folded recipient address (lower(address)) where the event carries
  -- one — same normalisation as notification_send_attempts.address_key and
  -- email_suppressions.address_key, so correlation across tables is one
  -- lower() call upstream. NULL for events that have no recipient
  -- (SubscriptionConfirmation never writes here; Delivery/Bounce/Complaint
  -- all do). The validity shape is enforced in the setter functions, not
  -- here — this check is the storage-layer sanity gate only.
  recipient_address_key   text,

  -- The SES feedback id, when the event carries one. Kept so an operator
  -- (via a later masked-read function) can trace a suppression back to its
  -- originating SES feedback record.
  ses_feedback_id         text,

  -- The provider message id the SES send returned at the time of acceptance,
  -- echoed back on the Delivery/Bounce/Complaint notification. This is the
  -- correlation key for app.record_ses_delivery_event — the SAME id that
  -- notification_deliveries.provider_message_id holds for a sent row.
  provider_message_id     text,

  -- The SNS topic ARN as named inside the authenticated SNS envelope. Stored
  -- for audit; the route still refuses any topic ARN that does not match the
  -- configured expected ARN, so this column exists to prove in the ledger
  -- which topic the row came from, not to decide at read time.
  sns_topic_arn           text,

  -- When the event reached our handler. Not when SES generated it (which
  -- lives inside payload and is not an identity key).
  received_at             timestamptz  not null default now(),

  constraint email_delivery_events_provider_not_blank
    check (length(btrim(provider)) > 0),
  constraint email_delivery_events_event_id_not_blank
    check (length(btrim(provider_event_id)) > 0),
  constraint email_delivery_events_event_type_not_blank
    check (length(btrim(provider_event_type)) > 0),
  constraint email_delivery_events_normalized_type_values
    -- Append-only vocabulary. New values land only in a reviewed migration.
    check (normalized_event_type in (
      'delivery',
      'bounce_permanent',
      'bounce_transient',
      'complaint',
      'rejection',
      'rendering_failure',
      'other'
    )),
  constraint email_delivery_events_recipient_address_key_shape
    -- When present, must be the lower-cased ASCII form that the suppression
    -- table uses — same character class, same length bounds.
    check (
      recipient_address_key is null
      or (
        length(recipient_address_key) between 3 and 254
        and recipient_address_key = lower(recipient_address_key)
        and position('@' in recipient_address_key) > 1
        and recipient_address_key !~ '[[:cntrl:] ]'
      )
    )
);

comment on table public.email_delivery_events is
  'M13.2 P9-2: authenticated SES/SNS event ledger. One row per unique (provider, provider_event_id). A replayed SNS Notification conflicts on the unique index and no side effect fires twice (D-25). Stores the verified payload; may carry contributor PII, so deny-all RLS and no client grant (same model as public.financial_events). Append-only via trigger; a provider correction is a new event, never an edit. The route stores the row BEFORE applying any suppression or delivery-status side effect, so an acknowledged event is always observable.';

comment on column public.email_delivery_events.provider_event_id is
  'D-25: the SNS MessageId (or equivalent provider-stable event id). The unique index on (provider, provider_event_id) IS the webhook deduplication — there is no read-then-write anywhere in the ingest path.';

comment on column public.email_delivery_events.payload is
  'The authenticated payload as received (SNS envelope + SES message). May carry recipient addresses and other provider-reported PII. No client role can read this table. Operator reads go through a redacted path, never a direct select.';

comment on column public.email_delivery_events.recipient_address_key is
  'lower(address). Same normalisation as notification_send_attempts.address_key and email_suppressions.address_key.';

comment on column public.email_delivery_events.provider_message_id is
  'The provider-returned message id (SES Message-Id). Correlation key with notification_deliveries.provider_message_id for the sent → delivered transition.';


-- The dedupe. A second delivery of the same event conflicts here and the
-- route returns 200 having written nothing beyond the no-op insert attempt.
create unique index email_delivery_events_provider_event_key
  on public.email_delivery_events (provider, provider_event_id);

create index email_delivery_events_received_idx
  on public.email_delivery_events (received_at desc);

-- Lookup by provider_message_id for the Delivery-event correlation. Partial
-- on NOT NULL keeps the index small (SubscriptionConfirmation events have no
-- message id).
create index email_delivery_events_provider_message_id_idx
  on public.email_delivery_events (provider_message_id)
  where provider_message_id is not null;


-- ── 2. RLS and client denial ────────────────────────────────────────────────
alter table public.email_delivery_events enable row level security;
alter table public.email_delivery_events force row level security;

-- The repository rule (01_rls_coverage.sql): every public table carries a
-- policy. Same explicit deny used for notification_send_attempts,
-- email_suppressions and financial_events.
create policy email_delivery_events_deny_client_access
  on public.email_delivery_events for select to authenticated
  using (false);

revoke all on table public.email_delivery_events from public, anon, authenticated;


-- ── 3. Append-only enforcement ──────────────────────────────────────────────
create or replace function app.block_email_delivery_events_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'EMAIL_DELIVERY_EVENTS_IS_APPEND_ONLY: email_delivery_events rows cannot be % — a provider correction is a NEW event, never an edit (M13.2 P9-2, DAT-02)',
    lower(tg_op)
    using errcode = 'P0001';
  return null;
end;
$$;

revoke execute on function app.block_email_delivery_events_mutation() from public, anon, authenticated;

create trigger email_delivery_events_no_update
  before update on public.email_delivery_events
  for each row execute function app.block_email_delivery_events_mutation();

create trigger email_delivery_events_no_delete
  before delete on public.email_delivery_events
  for each row execute function app.block_email_delivery_events_mutation();

create trigger email_delivery_events_no_truncate
  before truncate on public.email_delivery_events
  for each statement execute function app.block_email_delivery_events_mutation();


-- ── 4. Operator-only suppression entry point ─────────────────────────────────
-- Called by the webhook route (over the owner connection, so role = 'none')
-- AFTER the SNS signature has verified AND after the event ledger row has
-- been written. Writes a PERMANENT suppression via the P9-1 setter, which
-- holds the single lock order and the single source of normalisation and
-- validation. This function exists so the route never calls set_email_
-- suppression directly with an SES source — the role gate below forbids any
-- reason other than hard_bounce or complaint, so a malformed event cannot
-- create a 'manual_block' or 'list_unsubscribe' suppression through this path.
create or replace function app.record_ses_suppression(
  p_address      text,
  p_reason       text,
  p_feedback_id  text default null,
  p_message_id   text default null
)
returns table (
  address_key text,
  reason      text,
  inserted    boolean,
  updated     boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role     text;
  v_source_event_id text;
  v_result   record;
begin
  v_role := coalesce(nullif(current_setting('role', true), ''), 'none');
  if v_role <> 'none' then
    raise exception 'FORBIDDEN: record_ses_suppression is operator-only (role = none)'
      using errcode = '42501';
  end if;

  -- Only the two reasons an SES event can authoritatively establish are
  -- accepted here. transient_bounce_capped, manual_block and list_unsubscribe
  -- are reachable only through the operator-only P9-1 setter directly; any
  -- stray SES event type that mapped to one of those at the adapter would
  -- be refused here, not quietly stored.
  if p_reason not in ('hard_bounce', 'complaint') then
    raise exception 'INVALID_REASON: record_ses_suppression accepts hard_bounce or complaint only, not %', p_reason
      using errcode = '22023';
  end if;

  -- Prefer the SES feedback id for the source event id (it is per-recipient-
  -- per-bounce and lets an operator trace back to a specific SES feedback
  -- record); fall back to the SNS MessageId when the event does not carry a
  -- feedback id.
  v_source_event_id := coalesce(nullif(btrim(p_feedback_id), ''), nullif(btrim(p_message_id), ''));

  -- Delegate to the P9-1 setter so the lock order, address normalisation,
  -- validation and append-only guarantees stay in one place.
  select * into v_result
  from app.set_email_suppression(
    p_address,
    p_reason,
    null,            -- permanent suppression
    'ses_event',     -- source
    v_source_event_id
  );

  address_key := v_result.address_key;
  reason      := v_result.reason;
  inserted    := v_result.inserted;
  updated     := v_result.updated;
  return next;
  return;
end;
$$;

comment on function app.record_ses_suppression(text, text, text, text) is
  'M13.2 P9-2: write a permanent recipient suppression originating from an authenticated SES Bounce/Complaint event. Operator-only (role = none) — reachable only from the webhook route over its owner connection. Accepts only hard_bounce or complaint; any other reason is refused so a malformed event cannot create an unexpected row. Delegates the actual write to app.set_email_suppression so the P9-1 lock order, normalisation and append-only guarantees remain the single source of truth. Returns the lower-cased key, the stored reason and whether the operation inserted or updated.';

revoke all on function app.record_ses_suppression(text, text, text, text) from public;
revoke execute on function app.record_ses_suppression(text, text, text, text) from anon, authenticated;


-- ── 5. Operator-only delivery-status entry point ─────────────────────────────
-- Transitions a notification_deliveries row FROM 'sent' TO 'delivered'. Does
-- nothing when the row is in any other status, when it has no provider
-- message id, or when p_provider_message_id is null/blank. Returns the count
-- updated so the route can log the outcome without reading recipient PII
-- back out.
--
-- Idempotency: a second call for a row already in 'delivered' hits zero rows
-- (the status predicate excludes it), so a repeat is a safe no-op.
--
-- Why the status whitelist is explicit:
--   · 'dead' never promotes: a worker already decided it was permanently
--     failed and a late Delivery event does not override that call.
--   · 'skipped' never promotes: the row was never sent in the first place.
--   · 'pending' / 'sending' never promote: ordering between the SES Delivery
--     notification and the sender's own resolve-claim call is not guaranteed,
--     and promoting a 'sending' row would skip the resolve path entirely.
--     In practice SES's Delivery notification arrives seconds after the API
--     accepted the send, by which point the worker has already written
--     'sent'; if it has not, the Delivery event is dropped on the floor
--     intentionally. The row's own event ledger entry still records that
--     SES said it was delivered.
--   · 'delivered' never promotes: idempotent no-op.
create or replace function app.record_ses_delivery_event(
  p_provider_message_id text,
  p_delivered_at        timestamptz default null
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
    raise exception 'FORBIDDEN: record_ses_delivery_event is operator-only (role = none)'
      using errcode = '42501';
  end if;

  if p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    return 0;
  end if;

  -- Transition sent → delivered. The WHERE clause is the gate: a non-sent
  -- row matches nothing and is left alone. No error_code, error_message or
  -- provider_message_id is touched (the row already has them). updated_at
  -- advances via the existing BEFORE UPDATE trigger on the table.
  update public.notification_deliveries
  set status = 'delivered'
  where provider_message_id = btrim(p_provider_message_id)
    and status = 'sent';

  get diagnostics v_updated = row_count;

  -- p_delivered_at is accepted for future auditability (a column may be
  -- added later) but is not stored on notification_deliveries today: the
  -- authoritative evidence of when SES observed delivery lives in the
  -- email_delivery_events.payload the webhook route stores alongside the
  -- status update. Silencing the "unused parameter" line keeps the
  -- interface stable without a comment-only no-op elsewhere.
  perform p_delivered_at;

  return v_updated;
end;
$$;

comment on function app.record_ses_delivery_event(text, timestamptz) is
  'M13.2 P9-2: transition a notification_deliveries row FROM sent TO delivered on an authenticated SES Delivery event. Operator-only (role = none). Correlation key is provider_message_id (the id SES returned at send, and that app.resolve_notification_claim stored on the row). Idempotent: a second call changes nothing. Dead, skipped, pending, sending and already-delivered rows are strictly left alone. Returns the number of rows updated (0 or 1).';

revoke all on function app.record_ses_delivery_event(text, timestamptz) from public;
revoke execute on function app.record_ses_delivery_event(text, timestamptz) from anon, authenticated;
