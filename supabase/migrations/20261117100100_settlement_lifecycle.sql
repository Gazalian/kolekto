-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100100 — T+1 settlement lifecycle (D-09, D-09c, D-09e)
--
-- Design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §3
--
-- WHAT THIS ADDS
--   1. Two platform account codes:
--        provider_settled_funds  money the provider has CONFIRMED it settled
--                                to Kolekto (asset)
--        organiser_payouts       contra to collection_withdrawn: money paid out
--                                to organisers' banks (asset). Lets a payout
--                                move cash at platform level while
--                                collection_withdrawn stays the cumulative
--                                "withdrawn" figure the chart defines.
--   2. settlement_schedules — the D-09 boundary as a versioned, effective-dated,
--      append-only row (D-09e), not a constant. Seeded with the closed
--      decision: 05:00 Africa/Lagos on the following calendar day, every day,
--      and (owner decision 2026-11-17) release only after the provider has
--      confirmed it settled that payment.
--   3. contribution_settlements — one row per contribution: when it is
--      scheduled to become available, when (and for how much) the provider
--      confirmed settlement, when it was released and by which journal.
--      Created by a trigger on contributions, so the capture function is not
--      re-created. Existing contributions are back-filled (new table only;
--      no contribution, attempt or journal is touched).
--   4. app.record_provider_settlement(...) — operator: the provider settled
--      one payment. Matching amount → a provider_settlement journal
--      (Dr provider_settled_funds, Cr provider_receivable). Mismatch →
--      the row is marked `discrepancy`, nothing is posted, the payment stays
--      pending, and the discrepancy is audited.
--   5. app.release_due_settlements(limit) — operator/worker: posts one
--      balance_release journal (Dr collection_pending, Cr
--      collection_available, net amount) per payment that is due AND
--      confirmed. Idempotent: row lock + status + unique journal key.
--
-- WHAT 05:00 MEANS. It is when a release becomes DUE, never proof that the
-- provider settled. A payment due at 05:00 whose provider settlement has not
-- been confirmed stays in collection_pending ("awaiting provider") and is
-- released by the first run after the confirmation lands. Weekends and public
-- holidays need no calendar here: D-09 is calendar days, and a provider that
-- does not settle on a holiday simply has not confirmed yet.
--
-- Scheduled and actual times are separate columns: scheduled_release_at,
-- provider_confirmed_at (provider's settlement time), released_at (journal
-- posting time).
--
-- Additive. Rollback (nothing else depends on these yet):
--   drop trigger contributions_schedule_settlement on public.contributions;
--   drop function app.release_due_settlements(integer);
--   drop function app.record_provider_settlement(text, text, bigint, timestamptz);
--   drop function app.schedule_contribution_settlement();
--   drop table public.contribution_settlements;  drop type public.settlement_status;
--   drop function app.settlement_due_at(timestamptz, text);
--   drop function app.settlement_schedule_version_at(timestamptz);
--   drop table public.settlement_schedules;
--   delete the two ledger_account_codes rows (only while no account uses them).
-- Journals already posted stay (the ledger is append-only); after a rollback
-- they are explained by their source_type and reason.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Chart of accounts ────────────────────────────────────────────────────

insert into public.ledger_account_codes (code, scope, type, description) values
  ('provider_settled_funds', 'platform', 'asset',
   'Money the payment provider has confirmed it settled to Kolekto for captured payments. Debited by provider_settlement journals; credited when a payout leaves.'),
  ('organiser_payouts',      'platform', 'asset',
   'Contra to collection_withdrawn: cumulative money paid out to organisers. Debited by payout journals so platform cash falls while collection_withdrawn keeps the cumulative withdrawn figure.');


-- ── 2. Settlement schedules (D-09e) ─────────────────────────────────────────

create table public.settlement_schedules (
  version                        text        primary key,
  effective_from                 timestamptz not null,
  timezone                       text        not null,
  -- Calendar days after the capture day (in `timezone`) that the release
  -- becomes due. D-09: 1.
  release_day_offset             smallint    not null,
  -- Local wall-clock time on that day. D-09: 05:00.
  release_time                   time        not null,
  -- Owner decision 2026-11-17: no release before the provider confirms it
  -- settled the payment.
  requires_provider_confirmation boolean     not null,
  notes                          text,
  created_at                     timestamptz not null default now(),

  constraint settlement_schedules_version_not_blank check (length(btrim(version)) > 0),
  -- A-1 / D-09b: Lagos is the only zone a Nigerian collection settles in.
  -- A different zone is a new decision and a new migration, not a data edit.
  constraint settlement_schedules_timezone_lagos   check (timezone = 'Africa/Lagos'),
  constraint settlement_schedules_offset_range     check (release_day_offset between 0 and 7),
  constraint settlement_schedules_offset_or_later  check (release_day_offset > 0 or release_time > time '00:00')
);

comment on table public.settlement_schedules is
  'D-09e: the T+1 boundary as versioned, effective-dated data. Append-only: a change is a new version, so every settlement row can say which boundary it was scheduled under.';

alter table public.settlement_schedules enable row level security;
alter table public.settlement_schedules force  row level security;

-- Clients read the rule only through app.collection_settlement_summary, so the
-- table stays off the authenticated SELECT allowlist (02_grant_matrix.sql).
create policy settlement_schedules_no_client_read
  on public.settlement_schedules for select to authenticated using (false);
revoke all on public.settlement_schedules from anon, authenticated;

create or replace function app.block_settlement_schedule_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'SETTLEMENT_SCHEDULE_IS_APPEND_ONLY: %.% cannot be % (D-09e)',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001',
          hint = 'A boundary change is a new schedule version. Editing one would re-time payments already scheduled under it.';
  return null;
end;
$$;
revoke execute on function app.block_settlement_schedule_mutation() from public, anon, authenticated;

create trigger settlement_schedules_no_update
  before update on public.settlement_schedules
  for each row execute function app.block_settlement_schedule_mutation();
create trigger settlement_schedules_no_delete
  before delete on public.settlement_schedules
  for each row execute function app.block_settlement_schedule_mutation();

-- Effective from before the first payment table existed, so every existing
-- contribution has a schedule to be back-filled under.
insert into public.settlement_schedules (
  version, effective_from, timezone, release_day_offset, release_time, requires_provider_confirmation, notes
) values (
  '2026-11-t1-0500-lagos', '2026-09-01 00:00:00+01', 'Africa/Lagos', 1, time '05:00', true,
  'D-09: 05:00 Africa/Lagos on the following calendar day, every day. Owner decision 2026-11-17: released only once the provider has confirmed it settled the payment.'
);


create or replace function app.settlement_schedule_version_at(p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.version from public.settlement_schedules s
  where s.effective_from <= p_at
  order by s.effective_from desc
  limit 1;
$$;
revoke execute on function app.settlement_schedule_version_at(timestamptz) from public, anon, authenticated;

-- D-09 in SQL. Pinned to the same vectors as availableAt() in
-- packages/domain/src/settlement.ts by supabase/tests/57_settlement_lifecycle.sql.
-- Computed against the IANA zone, never a literal +01:00 (A-1).
create or replace function app.settlement_due_at(p_captured_at timestamptz, p_version text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (((p_captured_at at time zone s.timezone)::date + s.release_day_offset) + s.release_time)
           at time zone s.timezone
  from public.settlement_schedules s
  where s.version = p_version;
$$;
revoke execute on function app.settlement_due_at(timestamptz, text) from public, anon, authenticated;

comment on function app.settlement_due_at(timestamptz, text) is
  'D-09: the moment a payment captured at p_captured_at becomes DUE for release under schedule p_version (05:00 Africa/Lagos the next calendar day for 2026-11-t1-0500-lagos). Due is not released: see app.release_due_settlements.';


-- ── 3. Contribution settlements ─────────────────────────────────────────────

create type public.settlement_status as enum (
  'pending',      -- in collection_pending: not yet due, or due and awaiting the provider
  'released',     -- a balance_release journal moved it to collection_available
  'discrepancy'   -- the provider reported a different settled amount; held in pending
);

create table public.contribution_settlements (
  contribution_id        uuid        primary key,
  collection_id          uuid        not null references public.collections (id)  on delete restrict,
  community_id           uuid        not null references public.communities (id) on delete restrict,
  schedule_version       text        not null references public.settlement_schedules (version) on delete restrict,

  -- What the release moves: the contribution's net (what collection_pending
  -- received for it, after the fees journal).
  net_kobo               app.kobo    not null,
  -- What the provider should settle to Kolekto for it: total charged less the
  -- provider fee posted at capture (what provider_receivable holds for it).
  expected_provider_kobo app.kobo    not null,

  captured_at            timestamptz not null,
  scheduled_release_at   timestamptz not null,

  status                 public.settlement_status not null default 'pending',

  provider_settlement_ref text,
  provider_settled_kobo   app.kobo,
  provider_confirmed_at   timestamptz,   -- the provider's settlement time (confirmed and matching)
  provider_recorded_at    timestamptz,   -- when Kolekto recorded the provider's statement
  provider_journal_id     uuid references public.ledger_journals (id) on delete restrict,

  released_at            timestamptz,
  release_journal_id     uuid references public.ledger_journals (id) on delete restrict,

  discrepancy_reason     text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint contribution_settlements_contribution_fk
    foreign key (contribution_id, collection_id)
    references public.contributions (id, collection_id) on delete restrict,
  constraint contribution_settlements_amounts check (net_kobo >= 0 and expected_provider_kobo >= 0),
  constraint contribution_settlements_due_after_capture check (scheduled_release_at > captured_at),
  constraint contribution_settlements_released_shape
    check ((status = 'released') = (released_at is not null)),
  constraint contribution_settlements_confirmed_shape
    check (provider_confirmed_at is null
           or (provider_settled_kobo is not null and provider_settlement_ref is not null and provider_recorded_at is not null)),
  constraint contribution_settlements_discrepancy_shape
    check ((status = 'discrepancy') = (discrepancy_reason is not null)),
  constraint contribution_settlements_ref_not_blank
    check (provider_settlement_ref is null or length(btrim(provider_settlement_ref)) between 1 and 200)
);

comment on table public.contribution_settlements is
  'D-09: per-contribution settlement state. scheduled_release_at = when a release becomes due (05:00 Lagos next day); provider_confirmed_at = when the provider says it settled; released_at = when the balance_release journal was posted. The ledger, not this row, is the balance; this row says why and when.';

create index contribution_settlements_due_idx
  on public.contribution_settlements (scheduled_release_at)
  where status = 'pending';
create index contribution_settlements_collection_idx
  on public.contribution_settlements (collection_id, status);

alter table public.contribution_settlements enable row level security;
alter table public.contribution_settlements force  row level security;
create policy contribution_settlements_no_client_read
  on public.contribution_settlements for select to authenticated using (false);
revoke all on public.contribution_settlements from anon, authenticated;

-- Forward-only. What a payment is, when it was due and under which schedule
-- never change; a confirmation and a release are each written once.
create or replace function app.guard_contribution_settlement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'SETTLEMENT_IS_PERMANENT: contribution_settlements rows are never deleted'
      using errcode = 'P0001';
  end if;

  if new.contribution_id        is distinct from old.contribution_id
     or new.collection_id       is distinct from old.collection_id
     or new.community_id        is distinct from old.community_id
     or new.schedule_version    is distinct from old.schedule_version
     or new.net_kobo            is distinct from old.net_kobo
     or new.expected_provider_kobo is distinct from old.expected_provider_kobo
     or new.captured_at         is distinct from old.captured_at
     or new.scheduled_release_at is distinct from old.scheduled_release_at
     or new.created_at          is distinct from old.created_at then
    raise exception 'SETTLEMENT_FACTS_IMMUTABLE: a payment''s amount and schedule cannot change'
      using errcode = 'P0001';
  end if;

  if old.status = 'released' then
    raise exception 'SETTLEMENT_ALREADY_RELEASED: contribution % was released at %', old.contribution_id, old.released_at
      using errcode = 'P0001';
  end if;
  if old.status = 'discrepancy' and new.status <> 'discrepancy' then
    raise exception 'SETTLEMENT_DISCREPANCY_OPEN: resolving a discrepancy needs its own reviewed function'
      using errcode = 'P0001';
  end if;

  if old.provider_confirmed_at is not null and (
       new.provider_confirmed_at   is distinct from old.provider_confirmed_at
    or new.provider_settled_kobo   is distinct from old.provider_settled_kobo
    or new.provider_settlement_ref is distinct from old.provider_settlement_ref
    or new.provider_journal_id     is distinct from old.provider_journal_id) then
    raise exception 'SETTLEMENT_CONFIRMATION_IMMUTABLE: provider confirmation for % is already recorded', old.contribution_id
      using errcode = 'P0001';
  end if;

  if new.status = 'released' and new.release_journal_id is null and new.net_kobo > 0 then
    raise exception 'SETTLEMENT_RELEASE_NEEDS_JOURNAL: a release of a non-zero amount must name its journal'
      using errcode = 'P0001';
  end if;

  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function app.guard_contribution_settlement() from public, anon, authenticated;

create trigger contribution_settlements_guard
  before update or delete on public.contribution_settlements
  for each row execute function app.guard_contribution_settlement();


-- Every contribution gets its settlement row in the transaction that captures
-- it. A missing schedule refuses the capture rather than leaving money with no
-- release time (the seeded schedule is effective from before any payment).
create or replace function app.schedule_contribution_settlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version text;
begin
  v_version := app.settlement_schedule_version_at(new.captured_at);
  if v_version is null then
    raise exception 'NO_SETTLEMENT_SCHEDULE: no settlement schedule is effective at %', new.captured_at
      using errcode = 'P0001';
  end if;

  insert into public.contribution_settlements (
    contribution_id, collection_id, community_id, schedule_version,
    net_kobo, expected_provider_kobo, captured_at, scheduled_release_at
  ) values (
    new.id, new.collection_id, new.community_id, v_version,
    new.net_kobo, new.total_charged_kobo - new.provider_fee_kobo, new.captured_at,
    app.settlement_due_at(new.captured_at, v_version)
  )
  on conflict (contribution_id) do nothing;
  return null;
end;
$$;
revoke execute on function app.schedule_contribution_settlement() from public, anon, authenticated;

create trigger contributions_schedule_settlement
  after insert on public.contributions
  for each row execute function app.schedule_contribution_settlement();

-- Back-fill: contributions captured before this migration. New rows only.
insert into public.contribution_settlements (
  contribution_id, collection_id, community_id, schedule_version,
  net_kobo, expected_provider_kobo, captured_at, scheduled_release_at
)
select c.id, c.collection_id, c.community_id, v.version,
       c.net_kobo, c.total_charged_kobo - c.provider_fee_kobo, c.captured_at,
       app.settlement_due_at(c.captured_at, v.version)
from public.contributions c
cross join lateral (select app.settlement_schedule_version_at(c.captured_at) as version) v
where v.version is not null
  and not exists (select 1 from public.contribution_settlements s where s.contribution_id = c.id);


-- ── 4. The provider confirms it settled a payment ───────────────────────────
--
-- Operator session only (worker / operations script on the server's own
-- connection). The statement comes from the provider's settlement report:
-- its settlement id, the amount it settled for this payment, and when.
--
-- outcome:
--   confirmed          recorded and journalled
--   already_confirmed  same statement again — no effect
--   discrepancy        amount differs from what Kolekto expects: held, audited
--   already_flagged    same mismatching statement again — no effect
--   conflict           a different statement for an already-decided payment:
--                      nothing changes, audited for a human

create or replace function app.record_provider_settlement(
  p_reference              text,
  p_provider_settlement_id text,
  p_settled_kobo           bigint,
  p_settled_at             timestamptz
)
returns table (outcome text, contribution_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now        timestamptz := now();
  v_attempt    public.payment_attempts%rowtype;
  v_contrib    uuid;
  v_row        public.contribution_settlements%rowtype;
  v_settled    public.ledger_accounts.id%type;
  v_receivable public.ledger_accounts.id%type;
  v_journal    uuid;
begin
  perform app.assert_payment_operator_session();

  if p_provider_settlement_id is null or length(btrim(p_provider_settlement_id)) not between 1 and 200 then
    raise exception 'INVALID_SETTLEMENT_ID: a provider settlement id is required' using errcode = '22023';
  end if;
  if p_settled_kobo is null or p_settled_kobo < 0 then
    raise exception 'INVALID_AMOUNT: settled amount must be zero or more kobo' using errcode = '22023';
  end if;
  if p_settled_at is null or p_settled_at > v_now + interval '5 minutes' then
    raise exception 'INVALID_SETTLEMENT_TIME: a settlement cannot be in the future' using errcode = '22023';
  end if;

  select * into v_attempt from public.payment_attempts a where a.reference = p_reference;
  select c.id into v_contrib from public.contributions c where c.attempt_id = v_attempt.id;
  if v_attempt.id is null or v_contrib is null then
    raise exception 'UNKNOWN_PAYMENT_REFERENCE: no completed payment has reference %', p_reference
      using errcode = 'P0001';
  end if;

  select * into v_row from public.contribution_settlements s where s.contribution_id = v_contrib for update;
  if v_row.contribution_id is null then
    raise exception 'SETTLEMENT_ROW_MISSING: contribution % has no settlement row', v_contrib using errcode = 'P0001';
  end if;
  if p_settled_at < v_row.captured_at then
    raise exception 'INVALID_SETTLEMENT_TIME: settled before the payment was captured' using errcode = '22023';
  end if;

  -- Already decided.
  if v_row.provider_confirmed_at is not null or v_row.status = 'discrepancy' then
    if v_row.provider_settlement_ref = btrim(p_provider_settlement_id) and v_row.provider_settled_kobo = p_settled_kobo then
      return query select case when v_row.status = 'discrepancy' then 'already_flagged' else 'already_confirmed' end,
                          v_contrib;
      return;
    end if;
    perform app.write_audit_log(
      v_row.community_id, 'system', null, 'settlement.provider_conflict', 'contribution', v_contrib, null,
      jsonb_build_object('reference', p_reference, 'recorded_ref', v_row.provider_settlement_ref,
                         'recorded_kobo', v_row.provider_settled_kobo,
                         'new_ref', btrim(p_provider_settlement_id), 'new_kobo', p_settled_kobo),
      'A second, different provider settlement statement arrived for a payment already decided');
    return query select 'conflict'::text, v_contrib;
    return;
  end if;

  if p_settled_kobo <> v_row.expected_provider_kobo then
    update public.contribution_settlements s
    set status = 'discrepancy',
        discrepancy_reason = 'amount_mismatch',
        provider_settlement_ref = btrim(p_provider_settlement_id),
        provider_settled_kobo = p_settled_kobo,
        provider_recorded_at = v_now
    where s.contribution_id = v_contrib;
    perform app.write_audit_log(
      v_row.community_id, 'system', null, 'settlement.discrepancy', 'contribution', v_contrib, null,
      jsonb_build_object('reference', p_reference, 'expected_kobo', v_row.expected_provider_kobo,
                         'settled_kobo', p_settled_kobo, 'provider_settlement_id', btrim(p_provider_settlement_id)),
      'Provider settled a different amount than Kolekto recorded; funds held in pending');
    return query select 'discrepancy'::text, v_contrib;
    return;
  end if;

  if v_row.expected_provider_kobo > 0 then
    v_settled    := app.ensure_ledger_account(null, null, 'provider_settled_funds');
    v_receivable := app.ensure_ledger_account(null, null, 'provider_receivable');
    v_journal := app.post_payment_journal(
      v_row.community_id, v_row.collection_id, p_settled_at, 'provider_settlement', v_contrib,
      'Provider settled payment ' || p_reference || ' (settlement ' || btrim(p_provider_settlement_id) || ')',
      null, 'provider_settlement:' || v_contrib,
      jsonb_build_array(
        jsonb_build_object('account_id', v_settled,    'direction', 'debit',  'amount_kobo', v_row.expected_provider_kobo),
        jsonb_build_object('account_id', v_receivable, 'direction', 'credit', 'amount_kobo', v_row.expected_provider_kobo)));
  end if;

  update public.contribution_settlements s
  set provider_settlement_ref = btrim(p_provider_settlement_id),
      provider_settled_kobo   = p_settled_kobo,
      provider_confirmed_at   = p_settled_at,
      provider_recorded_at    = v_now,
      provider_journal_id     = v_journal
  where s.contribution_id = v_contrib;

  return query select 'confirmed'::text, v_contrib;
end;
$$;
revoke execute on function app.record_provider_settlement(text, text, bigint, timestamptz) from public, anon, authenticated;

comment on function app.record_provider_settlement(text, text, bigint, timestamptz) is
  'Operator: the provider says it settled payment p_reference for p_settled_kobo at p_settled_at under its settlement p_provider_settlement_id. Matching amount: provider_settlement journal + confirmation (release may follow once due). Mismatch: discrepancy, held in pending, audited. Idempotent for the same statement; a different statement for a decided payment changes nothing and is audited as a conflict.';


-- ── 5. Release what is due and confirmed ────────────────────────────────────
--
-- Run by the worker every few minutes (and safe to run by hand). A payment is
-- released once, by the first run at or after its scheduled time that finds it
-- confirmed. SKIP LOCKED lets two runs overlap without waiting on each other;
-- the status check and the unique journal key make a double release
-- impossible.

create or replace function app.release_due_settlements(p_limit integer default 500)
returns table (released integer, released_kobo bigint, awaiting_provider integer, awaiting_provider_kobo bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now      timestamptz := now();
  v_row      record;
  v_pending  uuid;
  v_avail    uuid;
  v_journal  uuid;
  v_count    integer := 0;
  v_kobo     bigint  := 0;
begin
  perform app.assert_payment_operator_session();
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'INVALID_LIMIT: between 1 and 5000' using errcode = '22023';
  end if;

  for v_row in
    select s.contribution_id, s.collection_id, s.community_id, s.net_kobo, s.scheduled_release_at, a.reference
    from public.contribution_settlements s
    join public.settlement_schedules sch on sch.version = s.schedule_version
    join public.contributions c on c.id = s.contribution_id
    join public.payment_attempts a on a.id = c.attempt_id
    where s.status = 'pending'
      and s.scheduled_release_at <= v_now
      and (s.provider_confirmed_at is not null or not sch.requires_provider_confirmation)
    order by s.scheduled_release_at, s.contribution_id
    limit p_limit
    for update of s skip locked
  loop
    v_journal := null;
    if v_row.net_kobo > 0 then
      v_pending := app.ensure_ledger_account(v_row.community_id, v_row.collection_id, 'collection_pending');
      v_avail   := app.ensure_ledger_account(v_row.community_id, v_row.collection_id, 'collection_available');
      v_journal := app.post_payment_journal(
        v_row.community_id, v_row.collection_id, v_now, 'balance_release', v_row.contribution_id,
        'T+1 release of payment ' || v_row.reference || ' (due '
          || to_char(v_row.scheduled_release_at at time zone 'Africa/Lagos', 'YYYY-MM-DD HH24:MI') || ' WAT)',
        null, 'balance_release:' || v_row.contribution_id,
        jsonb_build_array(
          jsonb_build_object('account_id', v_pending, 'direction', 'debit',  'amount_kobo', v_row.net_kobo),
          jsonb_build_object('account_id', v_avail,   'direction', 'credit', 'amount_kobo', v_row.net_kobo)));
    end if;

    update public.contribution_settlements s
    set status = 'released', released_at = v_now, release_journal_id = v_journal
    where s.contribution_id = v_row.contribution_id;

    v_count := v_count + 1;
    v_kobo  := v_kobo + v_row.net_kobo;
  end loop;

  return query
  select v_count, v_kobo,
         count(*)::integer, coalesce(sum(s.net_kobo), 0)::bigint
  from public.contribution_settlements s
  join public.settlement_schedules sch on sch.version = s.schedule_version
  where s.status = 'pending'
    and s.scheduled_release_at <= v_now
    and s.provider_confirmed_at is null
    and sch.requires_provider_confirmation;
end;
$$;
revoke execute on function app.release_due_settlements(integer) from public, anon, authenticated;

comment on function app.release_due_settlements(integer) is
  'D-09/D-09c: posts one balance_release journal (Dr collection_pending, Cr collection_available, net) per payment whose scheduled_release_at has passed AND whose provider settlement is confirmed (when the schedule requires it). Idempotent. Returns what it released and what is due but still awaiting the provider.';
