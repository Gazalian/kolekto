-- ─────────────────────────────────────────────────────────────────────────────
-- 20261111100000 — M8.3: payment records
--
-- The tables a payment is recorded in, and nothing that writes them. The
-- functions that create attempts and capture payments are the next migration
-- (20261111100100), so this file can be reviewed as pure structure.
--
-- Design: docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md §4.2,
-- §4.5, §4.8 and §8; decisions D-11, D-16, D-25, D-28, D-30 in
-- docs/phase-4/financial-decisions.md.
--
--   contribution_intent ─1:1─ payment_attempt ─1:n─ provider_transaction
--          (PII)                (amount lock)          (append-only evidence)
--                                   │
--                                   ├─1:n─ payment_attempt_line
--                                   ├─1:n─ stock_reservation
--                                   └─1:1─ contribution ─1:n─ contribution_line
--
-- What is here:
--
--   1. payment_limits — the per-payment ceiling and the checkout hold times, as
--      a versioned, effective-dated, append-only row (not a constant). Values
--      are the plan's §14.5 recommendations, confirmed for build 2026-11-11:
--      ₦5,000,000 per payment (on the total charged), 30-minute stock hold,
--      attempts checkable for 24 hours.
--   2. fee_schedules gains the D-28 internal provider-cost columns, and the
--      `2026-11-founder` row that mirrors SCHEDULE_2026_11_FOUNDER in
--      packages/domain/src/fees.ts. No existing row is edited (D-13).
--   3. collections.close_when_target_reached (D-30), default off.
--   4. The payment record tables, every one RLS-enabled AND forced, every one
--      without any client write grant, and every financial one append-only or
--      guarded by a transition trigger.
--
-- What is deliberately NOT here (later milestones, recorded so nobody thinks it
-- was forgotten): tickets (M8.5, before ticketing takes money), the date-only
-- opens_on/closes_on columns (D-29 — the window is enforced from the existing
-- starts_at/deadline_at in the next migration), refunds (D-31), the durable
-- initialization rate limiter, reconciliation tables.
--
-- Additive only. No drop, no rename, no existing row rewritten.
-- Rollback (local/staging; nothing depends on these until M8.5):
--   drop table public.contribution_lines, public.contributions,
--     public.provider_transactions, public.stock_reservations,
--     public.payment_attempt_lines, public.payment_attempts,
--     public.contribution_intents, public.payment_limits;
--   drop the four enums and the guard functions created below;
--   alter table public.collections drop column close_when_target_reached;
--   alter table public.fee_schedules drop column provider_cost_rate_bps,
--     drop column max_provider_cost_kobo  (the 2026-11-founder row must be
--     removed first, which its append-only trigger refuses — a rollback of a
--     fee row is a deliberate operator action, not a script).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Payment limits ───────────────────────────────────────────────────────

create table public.payment_limits (
  version             text         primary key,
  effective_from      timestamptz  not null,
  -- The largest single payment Kolekto will start, on the TOTAL CHARGED
  -- (contribution plus any fees the contributor bears). Bounds fraud and
  -- fat-finger exposure; the host's own min/max sit inside it.
  max_payment_kobo    app.kobo     not null,
  -- How long a checkout holds ticket/item stock (O-14).
  hold_minutes        integer      not null,
  -- How long an unresolved attempt stays checkable by the sweep before it may
  -- be expired. Paystack only webhooks successes (N5), so abandonment is
  -- learned only by asking.
  check_window_hours  integer      not null,
  notes               text,
  created_at          timestamptz  not null default now(),
  constraint payment_limits_version_not_blank check (length(btrim(version)) > 0),
  constraint payment_limits_max_positive      check (max_payment_kobo > 0),
  constraint payment_limits_hold_range        check (hold_minutes between 1 and 1440),
  constraint payment_limits_window_range      check (check_window_hours between 1 and 168),
  constraint payment_limits_window_covers_hold check (check_window_hours * 60 >= hold_minutes)
);

comment on table public.payment_limits is
  'Versioned, effective-dated, append-only payment limits. A payment attempt stores the version it was created under, so changing a limit never restates history. Read with app.current_payment_limits().';

create index payment_limits_effective_idx on public.payment_limits (effective_from desc);

insert into public.payment_limits (version, effective_from, max_payment_kobo, hold_minutes, check_window_hours, notes)
values (
  '2026-11-launch',
  '2026-11-11 00:00:00+01',
  500000000,  -- ₦5,000,000
  30,
  24,
  'Plan §14.5 recommendations, confirmed for build 2026-11-11: ₦5m per payment on the total charged; 30-minute stock hold; attempts checkable for 24 hours.'
);

create or replace function app.block_payment_limits_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'PAYMENT_LIMITS_ARE_APPEND_ONLY: %.% cannot be %',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A new limit is a new version with a later effective_from. Payment attempts point at the version they used.';
  return null;
end;
$$;
revoke execute on function app.block_payment_limits_mutation() from public, anon, authenticated;

create trigger payment_limits_no_update before update on public.payment_limits
  for each row execute function app.block_payment_limits_mutation();
create trigger payment_limits_no_delete before delete on public.payment_limits
  for each row execute function app.block_payment_limits_mutation();
create trigger payment_limits_no_truncate before truncate on public.payment_limits
  for each statement execute function app.block_truncate();

alter table public.payment_limits enable row level security;
alter table public.payment_limits force  row level security;

create policy payment_limits_select_all
  on public.payment_limits for select to authenticated
  using (true);

grant select on table public.payment_limits to authenticated;
revoke insert, update, delete, truncate on public.payment_limits from authenticated, anon;


-- ── 2. Fee schedule: D-28 internal provider cost + the 2026-11-founder row ───

alter table public.fee_schedules
  add column provider_cost_rate_bps integer,
  add column max_provider_cost_kobo app.kobo;

alter table public.fee_schedules
  add constraint fee_schedules_provider_cost_rate_is_bps
    check (provider_cost_rate_bps is null or (provider_cost_rate_bps >= 0 and provider_cost_rate_bps <= 10000)),
  add constraint fee_schedules_provider_cost_cap_not_negative
    check (max_provider_cost_kobo is null or max_provider_cost_kobo >= 0);

comment on column public.fee_schedules.provider_cost_rate_bps is
  'D-28: Kolekto''s INTERNAL estimate of the provider''s cost, never shown to contributors. NULL on schedules written before D-28, where gateway_rate_bps was both the shown line and the estimate.';
comment on column public.fee_schedules.max_provider_cost_kobo is
  'D-28: cap on the internal provider-cost estimate. NULL with provider_cost_rate_bps NULL means "same as max_gateway_fee_kobo" (pre-D-28 schedules).';

-- Mirrors SCHEDULE_2026_11_FOUNDER. Shown lines uncapped by owner decision;
-- the provider-cost estimate is 1% capped at ₦2,000 (F8 still OPEN — if
-- Paystack's cap differs, a new version is cut, this row is never edited).
insert into public.fee_schedules
  (version, effective_from, platform_rate_default_bps, gateway_rate_bps, vat_rate_bps,
   max_platform_fee_kobo, max_gateway_fee_kobo, provider_cost_rate_bps, max_provider_cost_kobo, notes)
values
  ('2026-11-founder', '2026-11-11', 50, 150, 0,
   null, null, 100, 200000,
   'D-28: "Processing fee" 1.5% and "Kolekto fee" 0.5% shown, both uncapped; internal provider-cost estimate 1% capped at ₦2,000. Supersedes 2026-09-founder for new attempts.');


-- ── 3. Fundraiser close-on-target (D-30) ────────────────────────────────────

alter table public.collections
  add column close_when_target_reached boolean not null default false;

alter table public.collections
  add constraint collections_close_on_target_needs_target
    check (not close_when_target_reached or target_amount_kobo is not null);

comment on column public.collections.close_when_target_reached is
  'D-30: host opt-in, default off. When on, the capture that takes the sum of completed contribution amounts to or past target_amount_kobo closes the collection inside the same transaction. Payments already in flight are still recorded; nothing is trimmed.';


-- ── 4. Enums ────────────────────────────────────────────────────────────────

create type public.payment_attempt_status as enum (
  'created',       -- row exists; provider not yet acknowledged. Money unknown.
  'initialized',   -- checkout issued. Money unknown.
  'failed',        -- provider said failed/abandoned/refused. NOT terminal: a late success captures.
  'expired',       -- sweep gave up after the check window. NOT terminal either.
  'captured',      -- provider confirmed money; recorded before validation of its effects.
  'needs_review',  -- money known (or state unclear), parked, visible, never lost.
  'completed'      -- contribution and journals exist. Terminal for the attempt.
);

create type public.stock_reservation_status as enum ('reserved', 'converted', 'released');

-- Only `applied` today. Refunds (D-31, deferred) add values with ALTER TYPE …
-- ADD VALUE; a contribution is never edited or deleted.
create type public.contribution_status as enum ('applied');


-- ── 5. Contribution intents — what the contributor chose (PII) ──────────────

create table public.contribution_intents (
  id                       uuid         primary key default app.uuid_generate_v7(),
  community_id             uuid         not null references public.communities (id) on delete restrict,
  collection_id            uuid         not null references public.collections (id) on delete restrict,
  -- One per form submission, generated by the page. Trusted for NOTHING except
  -- making a double-click return the same attempt (plan §4.3).
  checkout_idempotency_key text         not null,
  member_id                uuid         references public.members (id) on delete restrict,
  -- All three required (owner decision 2026-11-11): the receipt goes to the
  -- email, which the provider also needs to start a checkout.
  contributor_name         text         not null,
  contributor_email        text         not null,
  contributor_phone        text         not null,
  answers                  jsonb        not null default '{}'::jsonb,
  attendee_names           text[]       not null default '{}',
  created_at               timestamptz  not null default now(),
  constraint contribution_intents_key_format
    check (checkout_idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  constraint contribution_intents_name_length
    check (char_length(btrim(contributor_name)) between 1 and 120),
  constraint contribution_intents_email_shape
    check (char_length(contributor_email) between 3 and 254 and contributor_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  constraint contribution_intents_phone_length
    check (char_length(btrim(contributor_phone)) between 7 and 32),
  constraint contribution_intents_answers_is_object
    check (jsonb_typeof(answers) = 'object'),
  constraint contribution_intents_attendees_bounded
    check (coalesce(array_length(attendee_names, 1), 0) <= 1000)
);

comment on table public.contribution_intents is
  'What a contributor chose: contact, answers, attendee names, member. Contributor PII — readable only by officers holding transaction.view on the collection. Immutable. Never the source of an amount: amounts live on payment_attempts.';

create unique index contribution_intents_checkout_key
  on public.contribution_intents (collection_id, checkout_idempotency_key);
create index contribution_intents_collection_idx on public.contribution_intents (collection_id, created_at desc);


-- ── 6. Payment attempts — the amount lock ──────────────────────────────────

create table public.payment_attempts (
  id                           uuid         primary key default app.uuid_generate_v7(),
  intent_id                    uuid         not null references public.contribution_intents (id) on delete restrict,
  community_id                 uuid         not null references public.communities (id) on delete restrict,
  collection_id                uuid         not null references public.collections (id) on delete restrict,
  -- KLK- + 26 Crockford base32 characters (128 bits). Ours, unguessable, and
  -- the idempotency key shared with the provider (D-25). Never the human
  -- contributor reference ("BIO26-0042").
  reference                    text         not null,
  provider                     text         not null,
  status                       public.payment_attempt_status not null default 'created',
  currency                     text         not null default 'NGN',

  -- The frozen fee breakdown (D-16). Every later reader reads these; nothing
  -- recalculates. Produced by calculateFees() and arithmetic-checked below.
  amount_kobo                  app.kobo     not null,   -- total charged = what the provider must report
  contribution_kobo            app.kobo     not null,   -- the collection's gross
  platform_fee_kobo            app.kobo     not null,   -- "Kolekto fee"
  gateway_fee_kobo             app.kobo     not null,   -- "Processing fee"
  vat_kobo                     app.kobo     not null,
  total_fees_kobo              app.kobo     not null,
  net_kobo                     app.kobo     not null,   -- what the collection ends with
  provider_cost_estimate_kobo  app.kobo     not null,   -- internal, never shown (D-28)
  fee_bearer                   public.fee_mode not null,
  fee_schedule_version         text         not null references public.fee_schedules (version) on delete restrict,
  payment_limits_version       text         not null references public.payment_limits (version) on delete restrict,

  member_id                    uuid         references public.members (id) on delete restrict,
  obligation_id                uuid         references public.obligations (id) on delete restrict,
  cycle_key                    text,

  provider_access_code         text,
  hold_expires_at              timestamptz  not null,
  check_until                  timestamptz  not null,
  review_reason                text,
  -- Why the provider refused or the checkout ended without money. Evidence for
  -- an operator; nothing branches on it.
  failure_code                 text,
  status_changed_at            timestamptz  not null default now(),
  created_at                   timestamptz  not null default now(),
  updated_at                   timestamptz  not null default now(),

  constraint payment_attempts_reference_format
    check (reference ~ '^KLK-[0-9A-HJKMNP-TV-Z]{26}$'),
  constraint payment_attempts_provider_known
    check (provider in ('paystack', 'fake')),
  constraint payment_attempts_currency_is_ngn
    check (currency = 'NGN'),
  constraint payment_attempts_amounts_sane
    check (contribution_kobo > 0 and amount_kobo > 0
           and platform_fee_kobo >= 0 and gateway_fee_kobo >= 0 and vat_kobo >= 0
           and provider_cost_estimate_kobo >= 0 and net_kobo >= 0),
  constraint payment_attempts_total_fees_add_up
    check (total_fees_kobo = platform_fee_kobo + gateway_fee_kobo + vat_kobo),
  constraint payment_attempts_bearer_arithmetic
    check (
      (fee_bearer = 'contributor_pays'
        and amount_kobo = contribution_kobo + total_fees_kobo
        and net_kobo    = contribution_kobo)
      or
      (fee_bearer = 'community_absorbs'
        and amount_kobo = contribution_kobo
        and net_kobo    = contribution_kobo - total_fees_kobo)
    ),
  constraint payment_attempts_obligation_has_member
    check (obligation_id is null or member_id is not null),
  constraint payment_attempts_review_has_reason
    check (status <> 'needs_review' or review_reason is not null),
  constraint payment_attempts_review_reason_vocabulary
    check (review_reason is null or review_reason in (
      'amount_mismatch', 'currency_mismatch', 'provider_mismatch', 'reference_mismatch',
      'provider_reversed', 'provider_status_unrecognised',
      'stock_exhausted', 'obligation_changed', 'already_paid'
    )),
  constraint payment_attempts_failure_code_length
    check (failure_code is null or char_length(failure_code) between 1 and 120),
  constraint payment_attempts_access_code_length
    check (provider_access_code is null or char_length(provider_access_code) between 1 and 200),
  constraint payment_attempts_check_window_ordered
    check (check_until >= hold_expires_at and hold_expires_at > created_at)
);

comment on table public.payment_attempts is
  'The amount lock: Kolekto''s intent to be paid a specific total, with its fee breakdown frozen (D-16). Created before the provider is called, so a payment can never exist at the provider without a local row. Status moves only along the transition table in app.guard_payment_attempt_update(); never deleted.';
comment on column public.payment_attempts.amount_kobo is
  'The total charged. Capture requires the provider''s reported amount to equal this exactly; any difference is recorded and parked as needs_review, never accepted.';

create unique index payment_attempts_reference_key on public.payment_attempts (reference);
create unique index payment_attempts_intent_key    on public.payment_attempts (intent_id);
-- Two tabs cannot pay one obligation twice at the same time (plan §5.1 E).
create unique index payment_attempts_one_live_per_obligation
  on public.payment_attempts (obligation_id)
  where obligation_id is not null and status in ('created', 'initialized');
create index payment_attempts_collection_idx on public.payment_attempts (collection_id, created_at desc);
create index payment_attempts_sweep_idx
  on public.payment_attempts (check_until)
  where status in ('created', 'initialized');
create index payment_attempts_review_idx
  on public.payment_attempts (collection_id, status_changed_at desc)
  where status in ('captured', 'needs_review');


-- ── 7. Attempt lines — what units were priced, by id ───────────────────────

create table public.payment_attempt_lines (
  attempt_id       uuid      not null references public.payment_attempts (id) on delete restrict,
  line_no          smallint  not null,
  tier_id          uuid      references public.collection_tiers (id) on delete restrict,
  item_id          uuid      references public.collection_items (id) on delete restrict,
  quantity         integer   not null,
  unit_price_kobo  app.kobo  not null,
  amount_kobo      app.kobo  not null,
  primary key (attempt_id, line_no),
  constraint payment_attempt_lines_line_no_range  check (line_no between 1 and 50),
  constraint payment_attempt_lines_one_target     check (num_nonnulls(tier_id, item_id) = 1),
  constraint payment_attempt_lines_quantity_range check (quantity between 1 and 1000),
  constraint payment_attempt_lines_price_positive check (unit_price_kobo > 0),
  constraint payment_attempt_lines_amount_product check (amount_kobo = unit_price_kobo * quantity)
);

comment on table public.payment_attempt_lines is
  'One priced line per tier or item, by ID (ADR 0010 — never by name). Sums to the attempt''s contribution_kobo, asserted by app.create_payment_attempt. Immutable.';


-- ── 8. Stock reservations ───────────────────────────────────────────────────

create table public.stock_reservations (
  id          uuid         primary key default app.uuid_generate_v7(),
  attempt_id  uuid         not null references public.payment_attempts (id) on delete restrict,
  line_no     smallint     not null,
  tier_id     uuid         references public.collection_tiers (id) on delete restrict,
  item_id     uuid         references public.collection_items (id) on delete restrict,
  quantity    integer      not null,
  status      public.stock_reservation_status not null default 'reserved',
  expires_at  timestamptz  not null,
  created_at  timestamptz  not null default now(),
  updated_at  timestamptz  not null default now(),
  constraint stock_reservations_one_target     check (num_nonnulls(tier_id, item_id) = 1),
  constraint stock_reservations_quantity_range check (quantity between 1 and 1000),
  foreign key (attempt_id, line_no) references public.payment_attempt_lines (attempt_id, line_no) on delete restrict
);

comment on table public.stock_reservations is
  'Plan §4.5. Remaining stock = limit − converted − reserved-and-not-expired, computed under a row lock on the tier/item. There is no mutable counter to drift.';

create unique index stock_reservations_attempt_line_key on public.stock_reservations (attempt_id, line_no);
create index stock_reservations_tier_live_idx on public.stock_reservations (tier_id)
  where tier_id is not null and status in ('reserved', 'converted');
create index stock_reservations_item_live_idx on public.stock_reservations (item_id)
  where item_id is not null and status in ('reserved', 'converted');


-- ── 9. Provider transactions — the provider's statements, append-only ──────

create table public.provider_transactions (
  id                       uuid         primary key default app.uuid_generate_v7(),
  attempt_id               uuid         not null references public.payment_attempts (id) on delete restrict,
  provider                 text         not null,
  provider_transaction_id  text         not null,   -- text: Paystack ids are unsigned 64-bit
  provider_reference       text         not null,
  status_mapped            text         not null,
  status_raw               text         not null,
  amount_kobo              app.kobo     not null,
  currency                 text         not null,
  provider_fee_kobo        app.kobo,                -- NULL = not reported, which is not zero (D-11)
  paid_at                  timestamptz,
  channel                  text,
  authorization_hash       text,                    -- sha-256 hex; never the token itself (O-12)
  content_hash             text         not null,   -- sha-256 hex of the normalised statement
  payload                  jsonb        not null,   -- verbatim; may hold PII; no client read
  observed_at              timestamptz  not null default now(),
  constraint provider_transactions_provider_known     check (provider in ('paystack', 'fake')),
  constraint provider_transactions_id_not_blank       check (length(btrim(provider_transaction_id)) > 0),
  constraint provider_transactions_status_vocabulary  check (status_mapped in
    ('pending', 'succeeded', 'failed', 'abandoned', 'reversed', 'unrecognised')),
  constraint provider_transactions_amount_not_negative check (amount_kobo >= 0),
  constraint provider_transactions_fee_not_negative   check (provider_fee_kobo is null or provider_fee_kobo >= 0),
  constraint provider_transactions_auth_hash_format   check (authorization_hash is null or authorization_hash ~ '^[a-f0-9]{64}$'),
  constraint provider_transactions_content_hash_format check (content_hash ~ '^[a-f0-9]{64}$')
);

comment on table public.provider_transactions is
  'What the provider said, each time it said something new. Append-only; the latest row for an attempt is the current statement. A repeated identical verify conflicts on (attempt_id, content_hash) and writes nothing. Payload may carry contributor PII, so no client role can read this table (same model as financial_events).';

create unique index provider_transactions_attempt_content_key
  on public.provider_transactions (attempt_id, content_hash);
create index provider_transactions_attempt_idx
  on public.provider_transactions (attempt_id, observed_at desc);
create index provider_transactions_provider_id_idx
  on public.provider_transactions (provider, provider_transaction_id);


-- ── 10. Contributions — money that arrived and was applied ─────────────────

create table public.contributions (
  id                    uuid         primary key default app.uuid_generate_v7(),
  attempt_id            uuid         not null references public.payment_attempts (id) on delete restrict,
  community_id          uuid         not null references public.communities (id) on delete restrict,
  collection_id         uuid         not null references public.collections (id) on delete restrict,
  status                public.contribution_status not null default 'applied',
  contribution_kobo     app.kobo     not null,
  net_kobo              app.kobo     not null,
  total_charged_kobo    app.kobo     not null,
  total_fees_kobo       app.kobo     not null,
  fee_bearer            public.fee_mode not null,
  fee_schedule_version  text         not null references public.fee_schedules (version) on delete restrict,
  -- What was posted to provider_fee_expense: the provider's reported fee if it
  -- reported one, else the schedule's estimate — and which, so a later
  -- correction is explicable (D-11).
  provider_fee_kobo     app.kobo     not null,
  provider_fee_basis    text         not null,
  member_id             uuid         references public.members (id) on delete restrict,
  obligation_id         uuid         references public.obligations (id) on delete restrict,
  cycle_key             text,
  captured_at           timestamptz  not null,
  created_at            timestamptz  not null default now(),
  constraint contributions_amounts_sane
    check (contribution_kobo > 0 and net_kobo >= 0 and total_charged_kobo > 0
           and total_fees_kobo >= 0 and provider_fee_kobo >= 0),
  constraint contributions_fee_basis_vocabulary
    check (provider_fee_basis in ('reported', 'estimated')),
  constraint contributions_obligation_has_member
    check (obligation_id is null or member_id is not null)
);

comment on table public.contributions is
  'One per completed payment attempt (unique attempt_id — the exactly-once guarantee). Immutable: a refund, when built (D-31), is a new row and a reversing journal, never an edit.';

create unique index contributions_attempt_key on public.contributions (attempt_id);
create index contributions_collection_idx on public.contributions (collection_id, captured_at desc);
create index contributions_obligation_idx on public.contributions (obligation_id) where obligation_id is not null;

create table public.contribution_lines (
  contribution_id  uuid      not null references public.contributions (id) on delete restrict,
  line_no          smallint  not null,
  tier_id          uuid      references public.collection_tiers (id) on delete restrict,
  item_id          uuid      references public.collection_items (id) on delete restrict,
  quantity         integer   not null,
  unit_price_kobo  app.kobo  not null,
  amount_kobo      app.kobo  not null,
  primary key (contribution_id, line_no),
  constraint contribution_lines_one_target     check (num_nonnulls(tier_id, item_id) = 1),
  constraint contribution_lines_quantity_range check (quantity between 1 and 1000),
  constraint contribution_lines_price_positive check (unit_price_kobo > 0),
  constraint contribution_lines_amount_product check (amount_kobo = unit_price_kobo * quantity)
);

comment on table public.contribution_lines is
  'The units a contribution bought, copied from the attempt''s lines at capture. Immutable.';


-- ── 11. Guards ──────────────────────────────────────────────────────────────

-- Append-only: intents, attempt lines, provider transactions, contributions'
-- lines. A correction is a new row, never an edit.
create or replace function app.block_payment_record_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'PAYMENT_RECORD_IS_IMMUTABLE: %.% cannot be %',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'Payment records are evidence. A correction is a new row (and, for money, a reversing journal) — never an edit or a delete.';
  return null;
end;
$$;
revoke execute on function app.block_payment_record_mutation() from public, anon, authenticated;

create trigger contribution_intents_no_update  before update on public.contribution_intents
  for each row execute function app.block_payment_record_mutation();
create trigger contribution_intents_no_delete  before delete on public.contribution_intents
  for each row execute function app.block_payment_record_mutation();
create trigger payment_attempt_lines_no_update before update on public.payment_attempt_lines
  for each row execute function app.block_payment_record_mutation();
create trigger payment_attempt_lines_no_delete before delete on public.payment_attempt_lines
  for each row execute function app.block_payment_record_mutation();
create trigger provider_transactions_no_update before update on public.provider_transactions
  for each row execute function app.block_payment_record_mutation();
create trigger provider_transactions_no_delete before delete on public.provider_transactions
  for each row execute function app.block_payment_record_mutation();
create trigger contribution_lines_no_update    before update on public.contribution_lines
  for each row execute function app.block_payment_record_mutation();
create trigger contribution_lines_no_delete    before delete on public.contribution_lines
  for each row execute function app.block_payment_record_mutation();
create trigger payment_attempts_no_delete      before delete on public.payment_attempts
  for each row execute function app.block_payment_record_mutation();
create trigger stock_reservations_no_delete    before delete on public.stock_reservations
  for each row execute function app.block_payment_record_mutation();
create trigger contributions_no_delete         before delete on public.contributions
  for each row execute function app.block_payment_record_mutation();

create trigger contribution_intents_no_truncate  before truncate on public.contribution_intents
  for each statement execute function app.block_truncate();
create trigger payment_attempts_no_truncate      before truncate on public.payment_attempts
  for each statement execute function app.block_truncate();
create trigger payment_attempt_lines_no_truncate before truncate on public.payment_attempt_lines
  for each statement execute function app.block_truncate();
create trigger stock_reservations_no_truncate    before truncate on public.stock_reservations
  for each statement execute function app.block_truncate();
create trigger provider_transactions_no_truncate before truncate on public.provider_transactions
  for each statement execute function app.block_truncate();
create trigger contributions_no_truncate         before truncate on public.contributions
  for each statement execute function app.block_truncate();
create trigger contribution_lines_no_truncate    before truncate on public.contribution_lines
  for each statement execute function app.block_truncate();

-- Payment attempts: the frozen columns never change, and status moves only
-- along the transition table (plan §4.8). Money-known states never go back to
-- money-unknown ones, and `completed` is terminal (operator resolution of a
-- completed payment is a later, permissioned function — not an update path).
create or replace function app.guard_payment_attempt_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if (new.id, new.intent_id, new.community_id, new.collection_id, new.reference, new.provider,
      new.currency, new.amount_kobo, new.contribution_kobo, new.platform_fee_kobo,
      new.gateway_fee_kobo, new.vat_kobo, new.total_fees_kobo, new.net_kobo,
      new.provider_cost_estimate_kobo, new.fee_bearer, new.fee_schedule_version,
      new.payment_limits_version, new.member_id, new.obligation_id, new.cycle_key,
      new.hold_expires_at, new.check_until, new.created_at)
     is distinct from
     (old.id, old.intent_id, old.community_id, old.collection_id, old.reference, old.provider,
      old.currency, old.amount_kobo, old.contribution_kobo, old.platform_fee_kobo,
      old.gateway_fee_kobo, old.vat_kobo, old.total_fees_kobo, old.net_kobo,
      old.provider_cost_estimate_kobo, old.fee_bearer, old.fee_schedule_version,
      old.payment_limits_version, old.member_id, old.obligation_id, old.cycle_key,
      old.hold_expires_at, old.check_until, old.created_at)
  then
    raise exception 'PAYMENT_ATTEMPT_IS_FROZEN: the amount, fee breakdown, reference and attribution of attempt % never change (D-16)', old.id
      using errcode = 'P0001';
  end if;

  if new.provider_access_code is distinct from old.provider_access_code
     and old.provider_access_code is not null then
    raise exception 'PAYMENT_ATTEMPT_IS_FROZEN: attempt % already has a provider access code', old.id
      using errcode = 'P0001';
  end if;

  if new.review_reason is distinct from old.review_reason and new.status <> 'needs_review' then
    raise exception 'PAYMENT_ATTEMPT_IS_FROZEN: review_reason is set only with a move to needs_review'
      using errcode = 'P0001';
  end if;
  if new.failure_code is distinct from old.failure_code and not (new.status = 'failed' and old.status <> 'failed') then
    raise exception 'PAYMENT_ATTEMPT_IS_FROZEN: failure_code is set only with a move to failed'
      using errcode = 'P0001';
  end if;

  if new.status = old.status then
    new.updated_at := now();
    return new;
  end if;

  v_allowed := case old.status
    when 'created'      then new.status in ('initialized', 'failed', 'expired', 'captured', 'needs_review')
    when 'initialized'  then new.status in ('failed', 'expired', 'captured', 'needs_review')
    when 'failed'       then new.status in ('captured', 'needs_review')
    when 'expired'      then new.status in ('captured', 'needs_review')
    when 'captured'     then new.status in ('completed', 'needs_review')
    when 'needs_review' then false
    when 'completed'    then false
    else false
  end;

  if not v_allowed then
    raise exception 'PAYMENT_ATTEMPT_TRANSITION_REFUSED: % → % is not a permitted transition for attempt %',
      old.status, new.status, old.id
      using errcode = 'P0001',
            hint = 'Money-known states (captured, needs_review, completed) never return to money-unknown ones, and failed never overwrites captured.';
  end if;

  new.status_changed_at := now();
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_payment_attempt_update() from public, anon, authenticated;

create trigger payment_attempts_guard_update before update on public.payment_attempts
  for each row execute function app.guard_payment_attempt_update();

-- Reservations: reserved → converted | released; released → converted (a late
-- capture that still found stock). Nothing else changes.
create or replace function app.guard_stock_reservation_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.attempt_id, new.line_no, new.tier_id, new.item_id, new.quantity, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.attempt_id, old.line_no, old.tier_id, old.item_id, old.quantity, old.expires_at, old.created_at)
  then
    raise exception 'STOCK_RESERVATION_IS_FROZEN: only the status of reservation % may change', old.id
      using errcode = 'P0001';
  end if;

  if new.status <> old.status and not (
       (old.status = 'reserved' and new.status in ('converted', 'released'))
    or (old.status = 'released' and new.status = 'converted')
  ) then
    raise exception 'STOCK_RESERVATION_TRANSITION_REFUSED: % → % for reservation %', old.status, new.status, old.id
      using errcode = 'P0001';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_stock_reservation_update() from public, anon, authenticated;

create trigger stock_reservations_guard_update before update on public.stock_reservations
  for each row execute function app.guard_stock_reservation_update();

-- Contributions: immutable today. When refunds arrive (D-31) the status
-- column is the one thing that will move, through its own migration.
create trigger contributions_no_update before update on public.contributions
  for each row execute function app.block_payment_record_mutation();

-- Tenancy: every child row's collection belongs to the community it names,
-- and lines' tiers/items belong to the attempt's collection. Checked once
-- here so no writer can get it wrong.
create or replace function app.assert_payment_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.collections c
    where c.id = new.collection_id and c.community_id = new.community_id
  ) then
    raise exception 'PAYMENT_TENANCY_MISMATCH: collection % does not belong to community % (%.%)',
      new.collection_id, new.community_id, tg_table_schema, tg_table_name
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.assert_payment_tenancy() from public, anon, authenticated;

create trigger contribution_intents_assert_tenancy before insert on public.contribution_intents
  for each row execute function app.assert_payment_tenancy();
create trigger payment_attempts_assert_tenancy before insert on public.payment_attempts
  for each row execute function app.assert_payment_tenancy();
create trigger contributions_assert_tenancy before insert on public.contributions
  for each row execute function app.assert_payment_tenancy();

create or replace function app.assert_payment_line_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_collection_id uuid;
begin
  if tg_table_name = 'contribution_lines' then
    select c.collection_id into v_collection_id from public.contributions c where c.id = new.contribution_id;
  else
    select a.collection_id into v_collection_id from public.payment_attempts a where a.id = new.attempt_id;
  end if;

  if new.tier_id is not null and not exists (
       select 1 from public.collection_tiers t where t.id = new.tier_id and t.collection_id = v_collection_id) then
    raise exception 'PAYMENT_LINE_FOREIGN_TARGET: tier % is not in collection %', new.tier_id, v_collection_id
      using errcode = 'P0001';
  end if;
  if new.item_id is not null and not exists (
       select 1 from public.collection_items i where i.id = new.item_id and i.collection_id = v_collection_id) then
    raise exception 'PAYMENT_LINE_FOREIGN_TARGET: item % is not in collection %', new.item_id, v_collection_id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function app.assert_payment_line_target() from public, anon, authenticated;

create trigger payment_attempt_lines_assert_target before insert on public.payment_attempt_lines
  for each row execute function app.assert_payment_line_target();
create trigger stock_reservations_assert_target before insert on public.stock_reservations
  for each row execute function app.assert_payment_line_target();
create trigger contribution_lines_assert_target before insert on public.contribution_lines
  for each row execute function app.assert_payment_line_target();


-- ── 12. Row level security and grants ──────────────────────────────────────
--
-- Every table: RLS enabled AND forced. No client role holds INSERT, UPDATE,
-- DELETE or TRUNCATE on any of them; every write is an app.* SECURITY DEFINER
-- function reachable only from the server's owner connection (next migration).
-- Officers holding transaction.view on the collection read attempts,
-- contributions and intents; provider_transactions is readable by nobody
-- through a client role, because its payload carries contributor PII.

alter table public.contribution_intents  enable row level security;
alter table public.contribution_intents  force  row level security;
alter table public.payment_attempts      enable row level security;
alter table public.payment_attempts      force  row level security;
alter table public.payment_attempt_lines enable row level security;
alter table public.payment_attempt_lines force  row level security;
alter table public.stock_reservations    enable row level security;
alter table public.stock_reservations    force  row level security;
alter table public.provider_transactions enable row level security;
alter table public.provider_transactions force  row level security;
alter table public.contributions         enable row level security;
alter table public.contributions         force  row level security;
alter table public.contribution_lines    enable row level security;
alter table public.contribution_lines    force  row level security;

create policy contribution_intents_select_officer
  on public.contribution_intents for select to authenticated
  using (app.has_permission_for_collection(collection_id, 'transaction.view'));

create policy payment_attempts_select_officer
  on public.payment_attempts for select to authenticated
  using (app.has_permission_for_collection(collection_id, 'transaction.view'));

create policy payment_attempt_lines_select_officer
  on public.payment_attempt_lines for select to authenticated
  using (exists (
    select 1 from public.payment_attempts a
    where a.id = payment_attempt_lines.attempt_id
      and app.has_permission_for_collection(a.collection_id, 'transaction.view')
  ));

create policy stock_reservations_select_officer
  on public.stock_reservations for select to authenticated
  using (exists (
    select 1 from public.payment_attempts a
    where a.id = stock_reservations.attempt_id
      and app.has_permission_for_collection(a.collection_id, 'transaction.view')
  ));

create policy provider_transactions_no_client_read
  on public.provider_transactions for select to authenticated
  using (false);

create policy contributions_select_officer
  on public.contributions for select to authenticated
  using (app.has_permission_for_collection(collection_id, 'transaction.view'));

create policy contribution_lines_select_officer
  on public.contribution_lines for select to authenticated
  using (exists (
    select 1 from public.contributions c
    where c.id = contribution_lines.contribution_id
      and app.has_permission_for_collection(c.collection_id, 'transaction.view')
  ));

grant select on table public.contribution_intents  to authenticated;
grant select on table public.payment_attempts      to authenticated;
grant select on table public.payment_attempt_lines to authenticated;
grant select on table public.stock_reservations    to authenticated;
grant select on table public.contributions         to authenticated;
grant select on table public.contribution_lines    to authenticated;

revoke all on public.contribution_intents  from anon;
revoke all on public.payment_attempts      from anon;
revoke all on public.payment_attempt_lines from anon;
revoke all on public.stock_reservations    from anon;
revoke all on public.contributions         from anon;
revoke all on public.contribution_lines    from anon;
revoke all on public.provider_transactions from anon, authenticated;

revoke insert, update, delete, truncate on public.contribution_intents  from authenticated;
revoke insert, update, delete, truncate on public.payment_attempts      from authenticated;
revoke insert, update, delete, truncate on public.payment_attempt_lines from authenticated;
revoke insert, update, delete, truncate on public.stock_reservations    from authenticated;
revoke insert, update, delete, truncate on public.contributions         from authenticated;
revoke insert, update, delete, truncate on public.contribution_lines    from authenticated;
