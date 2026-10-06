-- ─────────────────────────────────────────────────────────────────────────────
-- 20260924160000 — M8.2: provider event processing, as append-only attempts
--
-- The M8.1 audit named a real tension and this resolves it in the approved
-- direction.
--
-- `financial_events` holds what a provider SAID. It is immutable, and a trigger
-- refuses every UPDATE, because it is the only record of the provider's own
-- words and editing it would destroy the evidence. But processing an event has
-- state that changes: it was attempted, it failed, it was retried, it succeeded.
--
-- Putting that state on `financial_events` would mean opening an UPDATE path on
-- the table holding provider evidence — the exact thing M8.1 spent a migration
-- preventing. So processing state lives here, as one **append-only row per
-- attempt**.
--
-- ── WHY ATTEMPTS AND NOT COUNTERS ───────────────────────────────────────────
--
-- A mutable `attempt_count` integer would answer "how many times?" and nothing
-- else. A row per attempt answers "what happened on the third try, and when, and
-- with what error?" — which is the question somebody actually asks at 3am. The
-- history is the point; the count is a `count(*)` over it.
--
-- The eight questions the M8.2 brief asks are answered by
-- `v_financial_event_processing` at the end of this file:
--
--   received?              → the financial_events row exists
--   how many attempts?     → attempt_count
--   latest outcome?        → latest_outcome
--   successfully processed?→ processed_at is not null
--   failed?                → latest_outcome = 'failed'
--   needs retry?           → needs_retry
--   what error?            → latest_error_code / latest_error_message
--   when processed?        → processed_at
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- No processor. Nothing writes to this table, because the webhook receiver is
-- M8.9 and needs a provider and a public URL. This is the record a processor will
-- write, with its invariants, built first.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── The outcome of one attempt ──────────────────────────────────────────────
--
-- Four values, and the distinction between the middle two is the one that
-- matters (D-27):
--
--   failed   — we know it did not work. Retrying is safe.
--   unknown  — we do NOT know. The provider timed out or was unreachable, and a
--              money-moving side effect may or may not have happened. This is
--              not a failure and must never be treated as one.
--
-- `ignored` is terminal and is not a problem: an event type Kolekto does not
-- handle is stored and passed over, deliberately, rather than retried for ever
-- or reported as broken.
create type public.event_processing_outcome as enum (
  'succeeded',
  'failed',
  'unknown',
  'ignored'
);


create table public.financial_event_processing_attempts (
  id                 uuid    primary key default gen_random_uuid(),

  financial_event_id uuid    not null
                     references public.financial_events (id) on delete restrict,

  -- 1 for the first attempt. Unique per event, so two concurrent processors
  -- cannot both claim to be attempt 3 — one of them conflicts and backs off.
  attempt_no         integer not null,

  outcome            public.event_processing_outcome not null,

  -- Kolekto's own error code, not a provider string: 'AMOUNT_MISMATCH',
  -- 'COLLECTION_NOT_FOUND', 'PROVIDER_TIMEOUT'. A stable vocabulary is what
  -- makes an alert on "how many AMOUNT_MISMATCH today" possible.
  error_code         text,
  error_message      text,

  started_at         timestamptz not null,
  finished_at        timestamptz not null default now(),

  -- When the processor intends to try again. Null for a terminal outcome.
  -- Advisory: it records intent, and nothing schedules from it yet.
  next_retry_at      timestamptz,

  constraint fepa_attempt_no_positive
    check (attempt_no >= 1),

  constraint fepa_finished_after_started
    check (finished_at >= started_at),

  -- A success has nothing to explain. An error on a successful attempt would
  -- make "did this work?" ambiguous.
  constraint fepa_success_has_no_error
    check (outcome <> 'succeeded' or (error_code is null and error_message is null)),

  -- A failure or an unknown outcome must say why. An unexplained failure is a
  -- row somebody has to reproduce to understand.
  constraint fepa_problem_has_a_reason
    check (outcome not in ('failed', 'unknown') or error_message is not null),

  -- Terminal outcomes do not schedule a retry. A 'succeeded' row with a
  -- next_retry_at would mean the processor intended to redo work it had done.
  constraint fepa_terminal_has_no_retry
    check (outcome not in ('succeeded', 'ignored') or next_retry_at is null)
);

comment on table public.financial_event_processing_attempts is
  'M8.2: one append-only row per attempt to process a provider event. Exists so that processing state never mutates financial_events, which holds the provider''s own words and must stay immutable. The history is the point — a count is a count(*) over it.';
comment on column public.financial_event_processing_attempts.attempt_no is
  'Unique per event, so two concurrent processors cannot both be attempt 3 — the second conflicts rather than both proceeding.';
comment on column public.financial_event_processing_attempts.outcome is
  'D-27: `unknown` is not `failed`. A provider timeout may mean a side effect happened, so it blocks blind retry and is resolved by querying the provider.';
comment on column public.financial_event_processing_attempts.error_code is
  'Kolekto''s own stable code, never a provider string, so an alert can count one class of problem over time.';

create unique index financial_event_processing_attempts_event_attempt_key
  on public.financial_event_processing_attempts (financial_event_id, attempt_no);

create index financial_event_processing_attempts_event_idx
  on public.financial_event_processing_attempts (financial_event_id, attempt_no desc);

-- The index a retry sweep would use: everything not yet terminal, due now.
create index financial_event_processing_attempts_retry_idx
  on public.financial_event_processing_attempts (next_retry_at)
  where next_retry_at is not null;

alter table public.financial_event_processing_attempts enable row level security;
alter table public.financial_event_processing_attempts force  row level security;


-- ── Append-only, enforced twice (DAT-02) ────────────────────────────────────
-- An attempt is a historical fact about what happened at a moment. Editing one
-- would rewrite the processing history that exists to be trusted.
--
-- Reuses `app.block_financial_event_mutation()` from 20260924120000: the message
-- it raises names the table from the trigger context, so it is already correct
-- for this table.

create trigger financial_event_processing_attempts_no_update
  before update on public.financial_event_processing_attempts
  for each row execute function app.block_financial_event_mutation();

create trigger financial_event_processing_attempts_no_delete
  before delete on public.financial_event_processing_attempts
  for each row execute function app.block_financial_event_mutation();


-- ── Reads: nobody, for the same reason as the events themselves ─────────────
--
-- An attempt's `error_message` may quote a provider payload, and that payload may
-- carry contributor PII. Under ADR 0009 that is staff-realm data, and the staff
-- realm is not built. So no client role reads this, and the policy says so
-- explicitly rather than leaving the table policy-less and the reason unrecorded.

create policy financial_event_processing_attempts_no_client_read
  on public.financial_event_processing_attempts for select to authenticated
  using (false);

revoke all on public.financial_event_processing_attempts from authenticated, anon;


-- ── The answers, in one place ───────────────────────────────────────────────
--
-- `security_invoker` so the caller's own rights apply — the previous system had
-- seven definer views granted to anon, which bypassed RLS on contributions and
-- deposits by design.
--
-- Not granted to any client role. It exists for staff tooling and for an
-- operator with a service-role session, and it is the query an alert on
-- "events needing retry" would run.

create view public.v_financial_event_processing
with (security_invoker = true) as
select
  e.id                     as financial_event_id,
  e.provider,
  e.provider_event_id,
  e.provider_event_type,
  e.received_at,
  e.signature_verified,

  coalesce(counted.attempt_count, 0)       as attempt_count,
  latest.attempt_no                        as latest_attempt_no,
  latest.outcome                           as latest_outcome,
  latest.error_code                        as latest_error_code,
  latest.error_message                     as latest_error_message,
  latest.finished_at                       as latest_attempt_at,
  latest.next_retry_at                     as next_retry_at,

  -- When it was successfully processed. NULL means it has not been — which
  -- includes "never attempted", and that is the correct reading: an event nobody
  -- has processed and an event whose processing failed are both unprocessed.
  succeeded.finished_at                    as processed_at,

  -- Needs retry when the latest attempt was a failure or an unknown outcome.
  -- An event with no attempt at all also needs picking up, so it counts too.
  (
    latest.outcome is null
    or latest.outcome in ('failed', 'unknown')
  )                                        as needs_retry,

  -- Surfaced separately because it is the one that must not be retried blindly
  -- (D-27). It is resolved by querying the provider, not by trying again.
  (latest.outcome = 'unknown')             as awaiting_provider_resolution
from public.financial_events e
left join lateral (
  select count(*) as attempt_count
  from public.financial_event_processing_attempts a
  where a.financial_event_id = e.id
) counted on true
left join lateral (
  select a.attempt_no, a.outcome, a.error_code, a.error_message, a.finished_at, a.next_retry_at
  from public.financial_event_processing_attempts a
  where a.financial_event_id = e.id
  order by a.attempt_no desc
  limit 1
) latest on true
left join lateral (
  select a.finished_at
  from public.financial_event_processing_attempts a
  where a.financial_event_id = e.id and a.outcome = 'succeeded'
  order by a.attempt_no asc
  limit 1
) succeeded on true;

comment on view public.v_financial_event_processing is
  'M8.2: the current processing state of every provider event, derived from its append-only attempts. Answers: received, attempt count, latest outcome, processed, failed, needs retry, what error, when. Never written to; not readable by any client role.';
