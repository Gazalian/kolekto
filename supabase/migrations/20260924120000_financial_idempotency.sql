-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924120000 — M8.1 step 10: the financial idempotency foundation
--
-- Providers deliver the same event more than once. Paystack retries every 3
-- minutes for the first 4 attempts and then hourly for up to 72 hours whenever
-- it does not receive an HTTP 200 (PA-02, ESTABLISHED), and an operator can
-- resend any event from the dashboard deliberately. Delivery is therefore
-- AT-LEAST-ONCE and must never be assumed to be exactly-once (D-26).
--
-- ── THE RULE THIS MIGRATION EXISTS TO ENFORCE ───────────────────────────────
--
-- D-25: an idempotency key is a UNIQUE INDEX, never a lookup-then-insert.
--
-- Every "check whether it exists, then insert it" in the old code was a race
-- between two concurrent deliveries. Here the insert is attempted and the
-- CONFLICT is the answer. No handler decides whether something is a duplicate;
-- the database already knows.
--
-- Three mechanisms, at three different points:
--
--   1. `financial_events`            — the provider said something, once
--   2. `financial_operation_claims`  — Kolekto is about to do something, once
--   3. `ledger_journals.idempotency_key` (already created in 20260924110000)
--                                    — the money moved, once
--
-- ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
--
-- No webhook endpoint. No signature verification. No Paystack call. No
-- processing. These are the tables a webhook receiver will insert into; the
-- receiver itself belongs to a later milestone and to a provider integration
-- that does not exist yet.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Provider events ──────────────────────────────────────────────────────
--
-- The raw, signed payload, stored BEFORE the 200 is returned.
--
-- The ordering is the whole point and it is not belt-and-braces. A provider
-- that has been acknowledged will not resend. Acknowledging something you have
-- not stored is how the old system lost events permanently: it stored none, so
-- a webhook that failed past Paystack's retry window was simply gone, with no
-- record that it had ever arrived.
--
-- IMMUTABLE. A provider correction is a NEW event, never an edit to the one
-- that was wrong.

create table public.financial_events (
  id                  uuid        primary key default gen_random_uuid(),

  provider            text        not null,
  -- The provider's own event id. THIS is the webhook idempotency key, and its
  -- uniqueness IS the deduplication (PA-03).
  provider_event_id   text        not null,
  -- The provider's own word for what happened, kept raw. Mapping it to a
  -- Kolekto vocabulary is a reader's job; storing somebody else's mapping of
  -- somebody else's event is how the original meaning gets lost.
  provider_event_type text        not null,

  -- The whole payload. A reconciliation two years from now needs the bytes,
  -- not a mapping of them.
  payload             jsonb       not null,

  -- Whether the signature checked out. An unsigned or wrongly-signed body
  -- should never reach this table at all — the column exists so that "we
  -- verified it" is recorded rather than assumed, and so a stored event with
  -- false here is visible as the anomaly it would be.
  signature_verified  boolean     not null,

  received_at         timestamptz not null default now(),

  constraint financial_events_provider_not_blank
    check (length(btrim(provider)) > 0),
  constraint financial_events_event_id_not_blank
    check (length(btrim(provider_event_id)) > 0)
);

comment on table public.financial_events is
  'D-26/PA-02: raw provider events, stored before the acknowledgement is sent, unique on (provider, provider_event_id). Immutable. Replayable for ever: re-processing a stored event re-runs verification and hits the same conflicts, so it writes nothing.';
comment on column public.financial_events.provider_event_id is
  'D-25: the provider''s own event id. Its unique index IS the webhook deduplication — there is no read-then-write anywhere in the ingest path.';
comment on column public.financial_events.payload is
  'The whole payload as received. May carry contributor PII (name, email, phone), which is why no client role can read this table and why exports redact it. Retention is O-10, open with counsel.';

-- The dedupe. A second delivery of the same event conflicts here and the
-- handler returns 200 having written nothing.
create unique index financial_events_provider_event_key
  on public.financial_events (provider, provider_event_id);

create index financial_events_received_idx on public.financial_events (received_at desc);
create index financial_events_type_idx     on public.financial_events (provider, provider_event_type, received_at desc);

alter table public.financial_events enable row level security;
alter table public.financial_events force  row level security;


-- ── 2. Operation claims ─────────────────────────────────────────────────────
--
-- The same defence for operations Kolekto INITIATES, where the effect is not
-- (or not yet) a journal — the clearest case being an outbound provider
-- transfer.
--
-- Paystack's documentation available to us does not establish that transfers
-- are idempotent on a reference we supply (PA-08, UNKNOWN). So Kolekto does not
-- rely on the provider's idempotency at all: it claims its own key first, and
-- the claim is what makes a retry safe.
--
-- This is deliberately generic — a scope and a key — because the operations it
-- will protect do not exist yet and inventing their key shapes now would be
-- guessing. What is NOT generic is the guarantee: one row per (scope, key),
-- ever.

create table public.financial_operation_claims (
  id         uuid        primary key default gen_random_uuid(),

  -- What kind of operation, e.g. 'provider_transfer', 'withdrawal_request'.
  scope      text        not null,
  -- The operation's own identity within that scope. Kolekto-generated.
  key        text        not null,

  claimed_at timestamptz not null default now(),

  constraint financial_operation_claims_scope_not_blank
    check (length(btrim(scope)) > 0),
  constraint financial_operation_claims_key_not_blank
    check (length(btrim(key)) > 0)
);

comment on table public.financial_operation_claims is
  'D-25/PA-08: one row per (scope, key), for ever. An operation claims its key before acting, so a retry after a timeout conflicts instead of acting twice. Kolekto never relies on a provider being idempotent — PA-08 is UNKNOWN and a wrong optimistic assumption there pays a bank twice.';
comment on column public.financial_operation_claims.key is
  'Kolekto-generated, never the provider''s. D-27: a timed-out operation is `unknown`, not failed — it is resolved by QUERYING the provider using this key, never by retrying.';

create unique index financial_operation_claims_scope_key
  on public.financial_operation_claims (scope, key);

alter table public.financial_operation_claims enable row level security;
alter table public.financial_operation_claims force  row level security;


-- ── Append-only, enforced twice (DAT-02) ────────────────────────────────────

create or replace function app.block_financial_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'FINANCIAL_EVENT_IS_APPEND_ONLY: %.% cannot be % (D-26, DAT-02)',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A provider correction is a new event, not an edit to the one that was wrong. A claim is never released — that is what makes it a claim.';
  return null;
end;
$$;

comment on function app.block_financial_event_mutation() is
  'Refuses UPDATE and DELETE on provider events and operation claims. An event is what arrived; editing it would destroy the only record of what the provider actually said.';

create trigger financial_events_no_update
  before update on public.financial_events
  for each row execute function app.block_financial_event_mutation();

create trigger financial_events_no_delete
  before delete on public.financial_events
  for each row execute function app.block_financial_event_mutation();

create trigger financial_operation_claims_no_update
  before update on public.financial_operation_claims
  for each row execute function app.block_financial_event_mutation();

create trigger financial_operation_claims_no_delete
  before delete on public.financial_operation_claims
  for each row execute function app.block_financial_event_mutation();


-- ── Reads: nobody ───────────────────────────────────────────────────────────
--
-- Neither table is granted to any client role, and both policies deny.
--
-- `financial_events.payload` carries whatever the provider sent, which includes
-- a contributor's name, email and phone number. Under ADR 0009 that is
-- staff-realm data, readable only through a staff-gated `app.*` function — and
-- the staff realm is not built yet. So the honest state is: no client reads
-- this, and the policy says so explicitly rather than leaving the table
-- policy-less and the reason unrecorded.
--
-- A `using (false)` policy and an absent grant are not redundant. The grant is
-- what actually stops a read; the policy is what stops a future `grant select`
-- in a hurry from being sufficient.

create policy financial_events_no_client_read
  on public.financial_events for select to authenticated
  using (false);

create policy financial_operation_claims_no_client_read
  on public.financial_operation_claims for select to authenticated
  using (false);

revoke all on public.financial_events           from authenticated, anon;
revoke all on public.financial_operation_claims from authenticated, anon;
