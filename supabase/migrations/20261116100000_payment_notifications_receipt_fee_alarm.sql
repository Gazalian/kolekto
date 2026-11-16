-- ─────────────────────────────────────────────────────────────────────────────
-- 20261116100000 — Payment notifications, the receipt read, and the fee alarm
--
-- Three things, all additive. No stored amount changes, no money state moves
-- differently, no existing row is rewritten.
--
-- 1. PAYMENT EVENTS REACH THE CONTRIBUTOR BY EMAIL (plan §4.7 step 8).
--    The payment lifecycle already writes audit rows for `payment.captured`
--    and `payment.needs_review` (T2). This adds two more, from a trigger on
--    payment_attempts status changes, so the payment functions themselves
--    are not re-created:
--      · `payment.initialized` — created → initialized: Paystack accepted the
--        checkout and the payer is being sent to it.
--      · `payment.failed`      — initialized → failed / expired: a checkout the
--        payer reached ended without payment (declined, or abandoned after
--        the hold). An attempt that never got a checkout (refused or
--        unanswered initialize) produces no event: the payer already saw the
--        error on the page and there is nothing to tell them by email.
--    All four actions join the notification trigger's watched list (not the
--    suppressible list: a payment is never part of a maintenance backfill),
--    and are classified ESSENTIAL in the communication policy: each is a
--    transaction message about the recipient's own payment, sent to the
--    address the payer typed for this payment. This does NOT switch on the
--    payment category (targeted "you still owe" reminders), which stays
--    blocked until payment attribution is approved (M13.3 R0 decision 7).
--
-- 2. app.payment_notification_context(attempt) — what the worker needs to
--    write a payment email: names, slugs, amounts, the payer's address. The
--    least-privilege worker role reads no payment table; it is granted this
--    one function by the operator (scripts/itest WORKER_ROLE_FUNCTIONS; the
--    worker runbook in production). Without the grant the worker records the
--    event and writes no email row.
--
-- 3. app.payment_receipt(reference) — the receipt the callback page, the
--    receipt page and the PDF download show. Read on the server's own
--    connection only (the same session guard as every payment function).
--    Returns a receipt only once money is known (completed, or held for
--    review). The payer's email is masked; the phone is never returned.
--
-- 4. app.payment_fee_alarms(since) — M8.7 alarm 1, over REAL contributions:
--    rows where the provider's REPORTED fee is more than the total fee
--    Kolekto charged on that payment (`provider_fee_exceeds_fee_charged`:
--    Kolekto lost money on it), or more than the attempt's internal provider
--    cost estimate (`provider_fee_exceeds_estimate`: margin below the D-28
--    model — the 1.5% card vs 1% estimate the sandbox showed). Estimated
--    fees never alarm: they ARE the estimate.
--
-- Rollback: drop trigger payment_attempts_audit_transition and
-- app.audit_payment_attempt_transition(); drop app.payment_notification_context(uuid),
-- app.payment_receipt(text), app.payment_fee_alarms(timestamptz); re-create
-- app.enqueue_notification_on_audit() from 20261109100100 and
-- app.communication_category_for_event(text) from 20261109100200. Audit rows
-- already written stay (audit_logs is append-only), which is harmless.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1a. Audit the transitions the payment functions do not audit ────────────

create or replace function app.audit_payment_attempt_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'created' and new.status = 'initialized' then
    perform app.write_audit_log(
      new.community_id, 'system', null, 'payment.initialized', 'payment_attempt', new.id,
      null, jsonb_build_object('reference', new.reference, 'amount_kobo', new.amount_kobo), null);
  elsif old.status = 'initialized' and new.status in ('failed', 'expired') then
    perform app.write_audit_log(
      new.community_id, 'system', null, 'payment.failed', 'payment_attempt', new.id,
      jsonb_build_object('status', old.status::text),
      jsonb_build_object('reference', new.reference, 'status', new.status::text,
                         'failure_code', coalesce(new.failure_code, new.status::text)),
      null);
  end if;
  return null;
end;
$$;
revoke all on function app.audit_payment_attempt_transition() from public;
revoke execute on function app.audit_payment_attempt_transition() from public, anon, authenticated;

comment on function app.audit_payment_attempt_transition() is
  '20261116100000: audits payment.initialized (created → initialized) and payment.failed (initialized → failed/expired). captured and needs_review are audited by app.complete_payment_capture. An attempt that never reached a checkout is not audited here.';

drop trigger if exists payment_attempts_audit_transition on public.payment_attempts;
create trigger payment_attempts_audit_transition
  after update of status on public.payment_attempts
  for each row
  when (old.status is distinct from new.status)
  execute function app.audit_payment_attempt_transition();


-- ── 1b. The notification trigger watches the four payment actions ──────────
-- Identical to 20261109100100 except c_watched gains the payment actions.
-- scripts/invariants keeps c_watched equal to the worker's WATCHED_ACTIONS.

create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_watched     constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
    'collection.remind',
    'collection.remind_unpaid',
    'collection.announce_update',
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite',
    'officer_invitation.accept', 'officer_term.end',
    -- 20261116100000: payment lifecycle, essential, never suppressible.
    'payment.initialized', 'payment.captured', 'payment.needs_review', 'payment.failed'
  ];
  c_suppressible constant text[] := array[
    'collection.publish',
    'collection.publish_remind_unpaid',
    'collection.remind',
    'collection.remind_unpaid',
    'collection.announce_update',
    'member.create', 'member.approve_join', 'member.reject_join', 'member.join_via_invite'
  ];
  v_state   record;
  v_msg     jsonb;
  v_before  jsonb;
  v_name    text;
  v_via     text;
  v_email   text;
begin
  begin
    if new.community_id is null or not (new.action = any (c_watched)) then
      return new;
    end if;

    if new.action like 'member.%' and new.actor_type::text not in ('officer', 'member') then
      return new;
    end if;

    v_msg := jsonb_build_object(
      'audit_log_id', new.id,
      'community_id', new.community_id,
      'action',       new.action,
      'actor_type',   new.actor_type::text,
      'actor_user_id', new.actor_user_id,
      'actor_name',   new.actor_name_snapshot,
      'object_type',  new.object_type,
      'object_id',    new.object_id,
      'after_state',  new.after_state,
      'created_at',   new.created_at
    );

    if new.action = 'member.reject_join' and jsonb_typeof(new.before_state) = 'object' then
      v_before := new.before_state;
      v_name  := case when jsonb_typeof(v_before -> 'full_name') = 'string'
                      then left(v_before ->> 'full_name', 120) end;
      v_via   := case when jsonb_typeof(v_before -> 'joined_via') = 'string'
                      then left(v_before ->> 'joined_via', 40) end;
      v_email := case when v_via = 'invite_link' and jsonb_typeof(v_before -> 'email') = 'string'
                      then left(v_before ->> 'email', 254) end;
      v_msg := v_msg || jsonb_build_object(
        'before_state',
        jsonb_build_object('full_name', v_name, 'joined_via', v_via, 'email', v_email)
      );
    end if;

    -- Operator-only notification suppression (M13.2 P3, preserved).
    select * into v_state from app.notification_suppression_state();
    if v_state.present then
      if not v_state.trusted then
        begin
          insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
          values (new.id, new.community_id, new.action, 'ignored_untrusted_role');
        exception when others then
          null;
        end;
      elsif new.action = any (c_suppressible) then
        if v_state.valid then
          begin
            insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
            values (new.id, new.community_id, new.action, 'suppressed', v_state.reason);
            return new;
          exception when others then
            null;
          end;
        elsif v_state.lapsed then
          begin
            insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome, reason)
            values (new.id, new.community_id, new.action, 'lapsed_held', v_state.reason);
            perform pgmq.send('notification_events_held', v_msg);

            if coalesce(current_setting('kolekto.suppression_lapse_warned', true), '') <> 'on' then
              raise warning 'NOTIFICATION SUPPRESSION LAPSED in this transaction: its window ended, so further notification events are being HELD in notification_events_held (not sent, not discarded). Decide with app.release_held_notifications() or app.discard_held_notifications(reason). Keep maintenance transactions under 10 minutes.';
              perform set_config('kolekto.suppression_lapse_warned', 'on', true);
            end if;
            return new;
          exception when others then
            null;
          end;
        end if;
      end if;
    end if;

    perform pgmq.send('notification_events', v_msg);
    return new;
  exception when others then
    raise log 'notification enqueue failed (sqlstate %): the audited write was allowed to proceed', sqlstate;
    begin
      insert into public.notification_suppression_log (audit_log_id, community_id, action, outcome)
      values (new.id, new.community_id, new.action, 'enqueue_failed');
    exception when others then
      null;
    end;
    return new;
  end;
end;
$$;

comment on function app.enqueue_notification_on_audit() is
  'Member announcements: watches collection.publish, collection.publish_remind_unpaid, '
  'collection.remind, collection.remind_unpaid, collection.announce_update, member.create / '
  'approve_join / reject_join / join_via_invite, officer_invitation.accept, officer_term.end; '
  '20261116100000: payment.initialized / captured / needs_review / failed (never suppressible). '
  'Officer access changes are never suppressible. Preserves lapse-held suppression path from '
  '20261009120000. Never raises.';

revoke all on function app.enqueue_notification_on_audit() from public;
revoke execute on function app.enqueue_notification_on_audit() from public, anon, authenticated;


-- ── 1c. The four payment actions are essential (transaction) messages ───────
-- Identical to 20261109100200 except four rows. Kept equal to the worker's
-- policy by apps/worker/test/communication-policy-sql-parity.test.ts.

create or replace function app.communication_category_for_event(p_event_type text)
returns table (category text, payment_purpose text, topic text)
language sql
immutable
set search_path = ''
as $$
  select m.category, m.payment_purpose, m.topic
  from (values
    -- EVENT-CATEGORY-BEGIN (parsed by apps/worker/test/communication-policy-sql-parity.test.ts; one row per line)
    ('member.create',                    'essential',             null::text,          null::text),
    ('member.approve_join',              'essential',             null,                null),
    ('officer_invitation.accept',        'essential',             null,                null),
    ('officer_term.end',                 'essential',             null,                null),
    ('member.reject_join',               'essential',             null,                null),
    ('member.join_via_invite',           'essential',             null,                null),
    ('collection.publish',               'community_operational', null,                'announcement'),
    ('collection.announce_update',       'community_operational', null,                'update'),
    ('collection.remind',                'community_operational', null,                'reminder'),
    ('collection.publish_remind_unpaid', 'payment',               'targeted_reminder', null),
    ('collection.remind_unpaid',         'payment',               'targeted_reminder', null),
    ('payment.initialized',              'essential',             null,                null),
    ('payment.captured',                 'essential',             null,                null),
    ('payment.needs_review',             'essential',             null,                null),
    ('payment.failed',                   'essential',             null,                null)
    -- EVENT-CATEGORY-END
  ) as m (event_type, category, payment_purpose, topic)
  where m.event_type = p_event_type;
$$;

comment on function app.communication_category_for_event(text) is
  'M13.3 R3: the communication category (and payment purpose / preference topic) of a notification event type, identical to the worker''s central policy. No row = unclassified (the recheck then refuses to send anything non-essential). Internal. 20261116100000: payment lifecycle events are essential.';

revoke all on function app.communication_category_for_event(text) from public;
revoke execute on function app.communication_category_for_event(text) from public, anon, authenticated;


-- ── 2. What the worker needs to write a payment email ───────────────────────

create or replace function app.payment_notification_context(p_attempt_id uuid)
returns table (
  attempt_id         uuid,
  community_id       uuid,
  community_name     text,
  community_slug     text,
  collection_name    text,
  collection_slug    text,
  reference          text,
  status             text,
  contributor_name   text,
  contributor_email  text,
  amount_kobo        bigint,
  contribution_kobo  bigint,
  platform_fee_kobo  bigint,
  gateway_fee_kobo   bigint,
  vat_kobo           bigint,
  total_fees_kobo    bigint,
  fee_bearer         text,
  paid_at            timestamptz,
  channel            text,
  failure_code       text,
  review_reason      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_payment_operator_session();
  return query
  select a.id, a.community_id, cm.name::text, cm.slug::text, co.name::text, co.slug::text,
         a.reference, a.status::text,
         i.contributor_name::text, i.contributor_email::text,
         a.amount_kobo::bigint, a.contribution_kobo::bigint, a.platform_fee_kobo::bigint,
         a.gateway_fee_kobo::bigint, a.vat_kobo::bigint, a.total_fees_kobo::bigint, a.fee_bearer::text,
         c.captured_at, t.channel, a.failure_code, a.review_reason
  from public.payment_attempts a
  join public.contribution_intents i on i.id = a.intent_id
  join public.communities cm on cm.id = a.community_id
  join public.collections co on co.id = a.collection_id
  left join public.contributions c on c.attempt_id = a.id
  left join lateral (
    select pt.channel from public.provider_transactions pt
    where pt.attempt_id = a.id and pt.status_mapped = 'succeeded'
    order by pt.observed_at desc, pt.id desc
    limit 1
  ) t on true
  where a.id = p_attempt_id;
end;
$$;
revoke all on function app.payment_notification_context(uuid) from public;
revoke execute on function app.payment_notification_context(uuid) from public, anon, authenticated;

comment on function app.payment_notification_context(uuid) is
  '20261116100000: the facts a payment email needs (community/collection names and slugs, reference, status, amounts, paid_at, channel, the payer''s name and the address they typed for this payment). Server connection only; the worker role is granted EXECUTE by the operator. Never client-callable.';


-- ── 3. The receipt ──────────────────────────────────────────────────────────

create or replace function app.payment_receipt(p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_receipt jsonb;
begin
  perform app.assert_payment_operator_session();
  if p_reference is null or p_reference !~ '^KLK-[0-9A-HJKMNP-TV-Z]{26}$' then
    return null;
  end if;

  select jsonb_build_object(
    'reference',                a.reference,
    'community_name',           cm.name,
    'community_slug',           cm.slug,
    'collection_name',          co.name,
    'collection_slug',          co.slug,
    'contributor_name',         i.contributor_name,
    'contributor_email_masked', app.mask_email_address(i.contributor_email::text),
    'amount_kobo',              a.amount_kobo::text,
    'contribution_kobo',        a.contribution_kobo::text,
    'platform_fee_kobo',        a.platform_fee_kobo::text,
    'gateway_fee_kobo',         a.gateway_fee_kobo::text,
    'vat_kobo',                 a.vat_kobo::text,
    'total_fees_kobo',          a.total_fees_kobo::text,
    'fee_bearer',               a.fee_bearer::text,
    'paid_at',                  c.captured_at,
    'channel',                  t.channel,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',            coalesce(ti.name, it.name),
               'quantity',        l.quantity,
               'unit_price_kobo', l.unit_price_kobo::text,
               'amount_kobo',     l.amount_kobo::text) order by l.line_no)
      from public.payment_attempt_lines l
      left join public.collection_tiers ti on ti.id = l.tier_id
      left join public.collection_items it on it.id = l.item_id
      where l.attempt_id = a.id), '[]'::jsonb))
    into v_receipt
  from public.payment_attempts a
  join public.contribution_intents i on i.id = a.intent_id
  join public.communities cm on cm.id = a.community_id
  join public.collections co on co.id = a.collection_id
  join public.contributions c on c.attempt_id = a.id
  left join lateral (
    select pt.channel from public.provider_transactions pt
    where pt.attempt_id = a.id and pt.status_mapped = 'succeeded'
    order by pt.observed_at desc, pt.id desc
    limit 1
  ) t on true
  where a.reference = p_reference
    and a.status = 'completed';

  return v_receipt;
end;
$$;
revoke all on function app.payment_receipt(text) from public;
revoke execute on function app.payment_receipt(text) from public, anon, authenticated;

comment on function app.payment_receipt(text) is
  '20261116100000: the receipt for a COMPLETED payment, by its unguessable KLK reference (128 random bits). Null for any other state or an unknown reference. Email masked; phone never returned. Amounts are integer kobo as digit strings. Server connection only.';


-- ── 4. M8.7 alarm 1: the provider''s actual fee against what Kolekto charged ──

create or replace function app.payment_fee_alarms(p_since timestamptz)
returns table (
  alarm                        text,
  contribution_id              uuid,
  community_id                 uuid,
  collection_id                uuid,
  reference                    text,
  channel                      text,
  captured_at                  timestamptz,
  contribution_kobo            bigint,
  total_charged_kobo           bigint,
  total_fees_kobo              bigint,
  provider_cost_estimate_kobo  bigint,
  provider_fee_kobo            bigint,
  overrun_kobo                 bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_payment_operator_session();
  return query
  select x.alarm, c.id, c.community_id, c.collection_id, a.reference, t.channel, c.captured_at,
         c.contribution_kobo::bigint, c.total_charged_kobo::bigint, c.total_fees_kobo::bigint,
         a.provider_cost_estimate_kobo::bigint, c.provider_fee_kobo::bigint, x.overrun
  from public.contributions c
  join public.payment_attempts a on a.id = c.attempt_id
  left join lateral (
    select pt.channel from public.provider_transactions pt
    where pt.attempt_id = a.id and pt.status_mapped = 'succeeded'
    order by pt.observed_at desc, pt.id desc
    limit 1
  ) t on true
  cross join lateral (values
    ('provider_fee_exceeds_fee_charged', (c.provider_fee_kobo - c.total_fees_kobo)::bigint),
    ('provider_fee_exceeds_estimate',    (c.provider_fee_kobo - a.provider_cost_estimate_kobo)::bigint)
  ) as x (alarm, overrun)
  where c.provider_fee_basis = 'reported'
    and c.captured_at >= coalesce(p_since, '-infinity'::timestamptz)
    and x.overrun > 0
  order by c.captured_at, c.id, x.alarm;
end;
$$;
revoke all on function app.payment_fee_alarms(timestamptz) from public;
revoke execute on function app.payment_fee_alarms(timestamptz) from public, anon, authenticated;

comment on function app.payment_fee_alarms(timestamptz) is
  '20261116100000, M8.7 alarm 1. Over real contributions captured since p_since whose provider fee was REPORTED by the provider: provider_fee_exceeds_fee_charged (reported fee > total fees Kolekto charged on the payment — a loss) and provider_fee_exceeds_estimate (reported fee > the attempt''s internal provider cost estimate, D-28). overrun_kobo is by how much. Estimated fees never alarm. Read-only; server connection only.';
