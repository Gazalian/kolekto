-- ─────────────────────────────────────────────────────────────────────────────
-- 20261114100000 — An all-members / groups payment is remembered as paid
--
-- The gap (status report 2026-11-13, "contributor onboarding scenario"):
-- on an `all_members` or `groups` collection every eligible member may pay,
-- obligation or not. create_payment_attempt accepts a member with no
-- obligation (fixed amount falls back to collections.fixed_amount_kobo), and
-- complete_payment_capture writes the contribution with obligation_id = null.
-- When the organiser later runs "Add members" (sync_collection_obligations), a
-- fresh obligation is inserted as 'unpaid'. The member has paid; the roll says
-- they have not.
--
-- The fix (option 1, owner choice 2026-11-14 — lazy materialisation at
-- capture): when T2 captures a payment from a named member who has no
-- obligation on a one-time fixed-amount collection whose audience is
-- all_members or groups, it creates that member's obligation for exactly the
-- amount paid, writes the contribution against it, and moves it to 'paid'
-- through the ordinary update — so app.block_manual_paid_status checks the
-- evidence exactly as it does for an assigned obligation (CASH-02 / SEC-20a).
-- sync_collection_obligations already skips members who have an obligation,
-- so a later "Add members" leaves the paid row alone and stops counting the
-- member as awaiting.
--
-- What does NOT change:
--   · selected_members — the audience whose membership IS its obligations.
--     A member not on the list cannot pay at all (find_collection_member
--     cannot find them), and if a collection is switched to selected_members
--     while a payment is in flight, the capture records the contribution
--     without an obligation, as before. Naming someone stays a human act.
--   · public collections, open-amount / tiers / items / per_member models and
--     recurring collections: no obligation is created. per_member and
--     recurring already require one before a payment can start; the others
--     have no single "amount owed" for the row to state.
--   · contributions stay append-only. The contribution is inserted already
--     pointing at the obligation; nothing is updated after the fact.
--
-- If an obligation for (collection, member, no cycle) appeared after the
-- attempt was created — the organiser ran "Add members" while the member was
-- at checkout — capture links to it and pays it when it is still unpaid for
-- the same amount, and parks the payment as needs_review otherwise
-- (already_paid / obligation_changed), the same rules as an assigned
-- obligation.
--
-- Also: app.block_manual_paid_status now fires on INSERT as well as UPDATE.
-- An obligation could previously be INSERTED as 'paid' — no function did, and
-- RLS gives client roles no insert, but the CASH-02 guard did not cover it.
-- A row cannot be born paid: the contribution that would justify it must
-- reference the row, so the row must exist first. The capture path above
-- inserts 'unpaid' and then updates.
--
-- Additive. No data changes. Rollback: re-create app.complete_payment_capture
-- and app.block_manual_paid_status from 20261111100100 and drop the trigger
-- obligations_block_paid_insert. Obligations created by this path stay valid
-- rows (paid, with the contribution that paid them) after a rollback.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. An obligation is never born paid ─────────────────────────────────────

create or replace function app.block_manual_paid_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    if not exists (
      select 1 from public.contributions c
      where c.obligation_id = new.id
        and c.status = 'applied'
        and c.contribution_kobo = new.expected_amount_kobo - new.waived_amount_kobo
    ) then
      raise exception
        'NO_MANUAL_PAID: an obligation becomes paid only through a Paystack-verified contribution (CASH-02, SEC-20a)'
        using errcode = 'P0001',
              hint = 'Kolekto is cashless. To clear a balance without payment, exempt the member or waive the amount, with a reason.';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function app.block_manual_paid_status() from public, anon, authenticated;

create trigger obligations_block_paid_insert
  before insert on public.obligations
  for each row execute function app.block_manual_paid_status();


-- ── 2. T2, with the obligation created when there was none ──────────────────

create or replace function app.complete_payment_capture(p_attempt_id uuid)
returns table (contribution_id uuid, status public.payment_attempt_status, review_reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now            timestamptz := now();
  v_attempt        public.payment_attempts%rowtype;
  v_collection     public.collections%rowtype;
  v_tx             public.provider_transactions%rowtype;
  v_obligation     public.obligations%rowtype;
  v_line           public.payment_attempt_lines%rowtype;
  v_remaining      integer;
  v_reason         text;
  v_contribution   uuid;
  v_provider_fee   bigint;
  v_fee_basis      text;
  v_journal        uuid;
  v_receivable     uuid;
  v_pending        uuid;
  v_fee_income     uuid;
  v_vat_payable    uuid;
  v_fee_expense    uuid;
  v_raised         bigint;
  v_on_capture     boolean := false;  -- the member had no obligation when checkout started
  v_created        boolean := false;  -- this capture inserted the obligation
begin
  perform app.assert_payment_operator_session();

  select * into v_attempt from public.payment_attempts a where a.id = p_attempt_id for update;
  if not found then
    raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: %', p_attempt_id using errcode = 'P0001';
  end if;

  -- Exactly once: a second call returns what the first produced.
  if v_attempt.status = 'completed' then
    return query select c.id, v_attempt.status, v_attempt.review_reason
                 from public.contributions c where c.attempt_id = p_attempt_id;
    return;
  end if;
  if v_attempt.status <> 'captured' then
    return query select null::uuid, v_attempt.status, v_attempt.review_reason;
    return;
  end if;

  select * into v_tx from public.provider_transactions t
  where t.attempt_id = p_attempt_id and t.status_mapped = 'succeeded'
  order by t.observed_at desc, t.id desc
  limit 1;
  if not found then
    raise exception 'CAPTURE_WITHOUT_EVIDENCE: attempt % is captured but has no successful provider statement', p_attempt_id
      using errcode = 'P0001';
  end if;

  -- D-30 needs captures on one collection serialised; everything else only
  -- needs the collection to exist (a payment started inside the window is
  -- recorded even if the collection closed since — D-29). The same lock
  -- serialises two captures that would both create one member's obligation.
  select * into v_collection from public.collections where id = v_attempt.collection_id for update;

  -- ── Effects that might not be possible. Decided before anything is written.
  if v_attempt.obligation_id is not null then
    select * into v_obligation from public.obligations where id = v_attempt.obligation_id for update;
  elsif v_attempt.member_id is not null
        and v_attempt.cycle_key is null
        and v_collection.audience_mode in ('all_members', 'groups')
        and v_collection.amount_model = 'fixed'
        and v_collection.schedule = 'one_time' then
    -- A named member paying with no obligation. One may have been assigned
    -- since checkout started; if so it is judged like any other.
    v_on_capture := true;
    select * into v_obligation from public.obligations o
    where o.collection_id = v_attempt.collection_id
      and o.member_id = v_attempt.member_id
      and o.cycle_key is null
    for update;
  end if;

  if v_obligation.id is not null then
    if v_obligation.status = 'paid' then
      v_reason := 'already_paid';
    elsif v_obligation.status not in ('unpaid', 'overdue')
       or v_obligation.expected_amount_kobo - v_obligation.waived_amount_kobo <> v_attempt.contribution_kobo then
      v_reason := 'obligation_changed';
    end if;
  end if;

  if v_reason is null then
    perform 1 from public.collection_tiers
     where id in (select l.tier_id from public.payment_attempt_lines l where l.attempt_id = p_attempt_id)
     order by id for update;
    perform 1 from public.collection_items
     where id in (select l.item_id from public.payment_attempt_lines l where l.attempt_id = p_attempt_id)
     order by id for update;

    for v_line in select * from public.payment_attempt_lines l where l.attempt_id = p_attempt_id order by l.line_no loop
      v_remaining := app.stock_remaining(v_line.tier_id, v_line.item_id, p_attempt_id, v_now);
      if v_remaining is not null and v_line.quantity > v_remaining then
        v_reason := 'stock_exhausted';
        exit;
      end if;
    end loop;
  end if;

  if v_reason is not null then
    -- Money is recorded (T1) and stays visible; the host decides. Nothing
    -- else is written, and the stock this attempt held goes back on sale.
    update public.payment_attempts set status = 'needs_review', review_reason = v_reason where id = p_attempt_id;
    perform app.release_payment_attempt_stock(p_attempt_id);
    perform app.write_audit_log(
      v_attempt.community_id, 'system', null, 'payment.needs_review', 'payment_attempt', p_attempt_id,
      null, jsonb_build_object('reference', v_attempt.reference, 'reason', v_reason), null);
    return query select null::uuid, 'needs_review'::public.payment_attempt_status, v_reason;
    return;
  end if;

  -- ── The effects, all in this transaction.

  -- The member's obligation, for exactly what they paid, created 'unpaid' and
  -- moved to 'paid' below once the contribution exists (block_manual_paid_status
  -- refuses a row born paid). Due date as sync_collection_obligations would set.
  if v_on_capture and v_obligation.id is null then
    insert into public.obligations (
      community_id, collection_id, member_id, cycle_key, expected_amount_kobo, due_at, assigned_by
    ) values (
      v_attempt.community_id, v_attempt.collection_id, v_attempt.member_id, null,
      v_attempt.contribution_kobo, v_collection.deadline_at, null
    )
    on conflict (collection_id, member_id, cycle_key) do nothing
    returning * into v_obligation;

    if v_obligation.id is null then
      -- Assigned by someone else between the check above and this insert.
      -- Roll everything back; the sweep re-runs T2, which then judges that
      -- obligation in the decision step like any other.
      raise exception 'CAPTURE_RACED_ASSIGNMENT: an obligation for this member was assigned during capture of %; retry',
        p_attempt_id using errcode = 'P0001';
    end if;
    v_created := true;
  end if;

  if v_tx.provider_fee_kobo is not null then
    v_provider_fee := v_tx.provider_fee_kobo;
    v_fee_basis := 'reported';
  else
    v_provider_fee := v_attempt.provider_cost_estimate_kobo;
    v_fee_basis := 'estimated';
  end if;

  insert into public.contributions (
    attempt_id, community_id, collection_id, contribution_kobo, net_kobo, total_charged_kobo,
    total_fees_kobo, fee_bearer, fee_schedule_version, provider_fee_kobo, provider_fee_basis,
    member_id, obligation_id, cycle_key, captured_at
  ) values (
    p_attempt_id, v_attempt.community_id, v_attempt.collection_id, v_attempt.contribution_kobo,
    v_attempt.net_kobo, v_attempt.amount_kobo, v_attempt.total_fees_kobo, v_attempt.fee_bearer,
    v_attempt.fee_schedule_version, v_provider_fee, v_fee_basis,
    v_attempt.member_id, v_obligation.id, v_attempt.cycle_key, coalesce(v_tx.paid_at, v_now)
  )
  returning id into v_contribution;

  insert into public.contribution_lines (contribution_id, line_no, tier_id, item_id, quantity, unit_price_kobo, amount_kobo)
  select v_contribution, l.line_no, l.tier_id, l.item_id, l.quantity, l.unit_price_kobo, l.amount_kobo
  from public.payment_attempt_lines l where l.attempt_id = p_attempt_id;

  update public.stock_reservations set status = 'converted'
  where attempt_id = p_attempt_id and status in ('reserved', 'released');

  if v_obligation.id is not null then
    -- Allowed only because the contribution above exists and matches: see
    -- app.block_manual_paid_status.
    update public.obligations set status = 'paid' where id = v_obligation.id;
  end if;

  if v_created then
    perform app.write_audit_log(
      v_attempt.community_id, 'system', null, 'obligation.assign_on_payment', 'obligation', v_obligation.id,
      null,
      jsonb_build_object('member_id', v_attempt.member_id, 'expected_amount_kobo', v_attempt.contribution_kobo,
                         'cycle_key', null, 'via', 'payment_capture', 'reference', v_attempt.reference,
                         'contribution_id', v_contribution),
      null);
  end if;

  -- Journals. Unique idempotency keys are the backstop behind the row lock.
  v_receivable  := app.ensure_ledger_account(null, null, 'provider_receivable');
  v_fee_income  := app.ensure_ledger_account(null, null, 'platform_fee_income');
  v_vat_payable := app.ensure_ledger_account(null, null, 'vat_payable');
  v_fee_expense := app.ensure_ledger_account(null, null, 'provider_fee_expense');
  v_pending     := app.ensure_ledger_account(v_attempt.community_id, v_attempt.collection_id, 'collection_pending');

  v_journal := app.post_payment_journal(
    v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'capture', v_contribution,
    'Payment ' || v_attempt.reference || ' captured', v_attempt.fee_schedule_version, 'capture:' || p_attempt_id,
    jsonb_build_array(
      jsonb_build_object('account_id', v_receivable, 'direction', 'debit',  'amount_kobo', v_attempt.amount_kobo),
      jsonb_build_object('account_id', v_pending,    'direction', 'credit', 'amount_kobo', v_attempt.amount_kobo)));

  if v_attempt.total_fees_kobo > 0 then
    v_journal := app.post_payment_journal(
      v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'fee', v_contribution,
      'Fees on payment ' || v_attempt.reference || ' (' || v_attempt.fee_bearer || ')',
      v_attempt.fee_schedule_version, 'fee:' || p_attempt_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_pending,     'direction', 'debit',  'amount_kobo', v_attempt.total_fees_kobo),
        jsonb_build_object('account_id', v_fee_income,  'direction', 'credit',
                           'amount_kobo', v_attempt.platform_fee_kobo + v_attempt.gateway_fee_kobo),
        jsonb_build_object('account_id', v_vat_payable, 'direction', 'credit', 'amount_kobo', v_attempt.vat_kobo)));
  end if;

  if v_provider_fee > 0 then
    v_journal := app.post_payment_journal(
      v_attempt.community_id, v_attempt.collection_id, coalesce(v_tx.paid_at, v_now), 'fee', v_contribution,
      'Provider fee on payment ' || v_attempt.reference || ' (' || v_fee_basis || ')',
      v_attempt.fee_schedule_version, 'provider_fee:' || p_attempt_id,
      jsonb_build_array(
        jsonb_build_object('account_id', v_fee_expense, 'direction', 'debit',  'amount_kobo', v_provider_fee),
        jsonb_build_object('account_id', v_receivable,  'direction', 'credit', 'amount_kobo', v_provider_fee)));
  end if;

  -- D-30: close a fundraiser that this payment took to its target. Payments
  -- already in flight are still recorded; nothing is trimmed.
  if v_collection.close_when_target_reached and v_collection.status = 'active' then
    select coalesce(sum(c.contribution_kobo), 0) into v_raised
    from public.contributions c where c.collection_id = v_attempt.collection_id and c.status = 'applied';
    if v_raised >= v_collection.target_amount_kobo then
      update public.collections set status = 'closed', closed_at = v_now where id = v_attempt.collection_id;
      perform app.write_audit_log(
        v_attempt.community_id, 'system', null, 'collection.close', 'collection', v_attempt.collection_id,
        jsonb_build_object('status', 'active'), jsonb_build_object('status', 'closed'), 'target_reached');
    end if;
  end if;

  update public.payment_attempts set status = 'completed' where id = p_attempt_id;

  perform app.write_audit_log(
    v_attempt.community_id, 'system', null, 'payment.captured', 'payment_attempt', p_attempt_id,
    null,
    jsonb_build_object('reference', v_attempt.reference, 'contribution_id', v_contribution,
                       'amount_kobo', v_attempt.amount_kobo, 'provider_fee_basis', v_fee_basis),
    null);

  return query select v_contribution, 'completed'::public.payment_attempt_status, null::text;
end;
$$;
revoke execute on function app.complete_payment_capture(uuid) from public, anon, authenticated;

comment on function app.complete_payment_capture(uuid) is
  'Plan §4.7 T2. From captured only. Decides first whether the payment''s effects are still possible (obligation unchanged and unpaid; stock still available) — if not, needs_review with the reason and stock released. Otherwise, in one transaction: (all_members/groups, one-time fixed, no obligation: the member''s obligation created for the amount paid, audited obligation.assign_on_payment) contribution + lines, reservations converted, obligation → paid, capture/fee/provider-fee journals (balanced, collection-attributed, unique keys), D-30 target close, completed, audit. A second call returns the same contribution.';
