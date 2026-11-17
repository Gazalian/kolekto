-- ─────────────────────────────────────────────────────────────────────────────
-- 20261117100500 — Organiser-initiated payment reminders to unpaid members
--
-- Design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §7
-- Owner decision 2026-11-17: email + in-app; organiser-initiated only.
--
-- WHY NOW. Targeted "you still owe" reminders were blocked (M13.3 R0 decision
-- 7, gap G3) because nothing recorded who had paid. Since M8 every successful
-- payment is an applied `contributions` row carrying the member it was made
-- as, so paid / unpaid is now a database fact. This migration switches the
-- payment category on in the policy matrix and adds the per-member flow.
--
-- WHO CAN BE REMINDED. Only members of the collection's own audience
-- (app.resolve_collection_audience: all members / groups / selected members,
-- archived and merged excluded). A public (open-link) collection has no
-- audience, so no reminder section. Of those:
--   paid       an applied contribution made as that member, or an obligation
--              marked paid (only possible with a matching contribution)
--   exempt     their obligation is exempt or cancelled
--   unpaid     everyone else — failed / abandoned checkouts do not count
-- Recurring collections are not supported in this first version (a member's
-- "paid" depends on the cycle); the summary says so and sending refuses.
--
-- SAFEGUARDS
--   · reminder.send on the collection (owner, admin, treasurer; collector
--     within scope); the collection must be active;
--   · a member reminded about this collection in the last 24 hours is skipped
--     (cooldown), as is anyone paid, exempt, outside the audience, or with no
--     reachable channel (no linked account and no usable email, or opted out);
--   · at most 500 members per call; idempotent per (collection, sender, key);
--     serialised per collection by an advisory lock, so two clicks cannot both
--     pass the cooldown;
--   · nothing recurring is scheduled.
--
-- DELIVERY reuses the notification pipeline unchanged: one audit row
-- `collection.remind_unpaid` with after_state {reminder_batch_id} → the audit
-- trigger queues it → the worker (notification-processor.ts) re-checks every
-- member through app.payment_reminder_batch_recipients at processing time
-- (someone may have paid in between), writes in-app rows for members with a
-- linked account and email rows (pending or skipped with a reason) for the
-- rest. Email is the `payment / targeted_reminder` policy cell: default-on,
-- opt-out honoured, community notice attestation required, sent in the bulk
-- class. A remind_unpaid audit row WITHOUT a batch (the older
-- send_collection_publish_reminder path) still reaches nobody.
--
-- POLICY MATRIX. app.communication_requirement is re-created with the eight
-- payment rows enabled (identical to the worker's channelRequirement with
-- paymentAttribution = true). Every other row is byte-for-byte unchanged.
--
-- Worker grant (operator step, not in this migration, as for the other
-- worker-facing functions):
--   grant execute on function app.payment_reminder_batch_recipients(uuid) to <worker role>;
-- (itest: WORKER_ROLE_FUNCTIONS in scripts/itest/itest.mjs.)
--
-- Rollback: re-create app.communication_requirement from
-- 20261109100000_m13_3_communication_policy.sql; drop the five functions;
-- drop tables payment_reminders, payment_reminder_batches.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. Records ──────────────────────────────────────────────────────────────

create table public.payment_reminder_batches (
  id              uuid primary key default app.uuid_generate_v7(),
  community_id    uuid not null references public.communities (id) on delete restrict,
  collection_id   uuid not null references public.collections (id) on delete restrict,
  sent_by         uuid not null references public.users (id)       on delete restrict,
  idempotency_key text not null,
  member_count    integer not null,
  audit_log_id    uuid references public.audit_logs (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint payment_reminder_batches_key check (char_length(idempotency_key) between 8 and 120),
  constraint payment_reminder_batches_count check (member_count between 1 and 500)
);
create unique index payment_reminder_batches_idempotency
  on public.payment_reminder_batches (collection_id, sent_by, idempotency_key);
create index payment_reminder_batches_collection_idx
  on public.payment_reminder_batches (collection_id, created_at desc);

create table public.payment_reminders (
  id            uuid primary key default app.uuid_generate_v7(),
  batch_id      uuid not null references public.payment_reminder_batches (id) on delete restrict,
  community_id  uuid not null references public.communities (id) on delete restrict,
  collection_id uuid not null references public.collections (id) on delete restrict,
  member_id     uuid not null references public.members (id)     on delete restrict,
  sent_by       uuid not null references public.users (id)       on delete restrict,
  created_at    timestamptz not null default now()
);
create unique index payment_reminders_batch_member on public.payment_reminders (batch_id, member_id);
create index payment_reminders_member_idx on public.payment_reminders (collection_id, member_id, created_at desc);

comment on table public.payment_reminder_batches is
  'One organiser click: who sent which reminders, for which collection, and the audit row that queued delivery. Append-only.';
comment on table public.payment_reminders is
  'One reminder to one member. The cooldown and "already reminded" are read from here; delivery status from notification_deliveries of the batch''s event.';

alter table public.payment_reminder_batches enable row level security;
alter table public.payment_reminder_batches force  row level security;
alter table public.payment_reminders        enable row level security;
alter table public.payment_reminders        force  row level security;
create policy payment_reminder_batches_no_client_read on public.payment_reminder_batches for select to authenticated using (false);
create policy payment_reminders_no_client_read        on public.payment_reminders        for select to authenticated using (false);
revoke all on public.payment_reminder_batches from anon, authenticated;
revoke all on public.payment_reminders        from anon, authenticated;

create or replace function app.block_payment_reminder_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The one permitted update: the batch learns its audit row once.
  -- Nested, not one AND: PL/pgSQL does not promise short-circuit, and
  -- payment_reminders rows have no audit_log_id field to read.
  if tg_op = 'UPDATE' and tg_table_name = 'payment_reminder_batches' then
    if to_jsonb(old) ->> 'audit_log_id' is null and to_jsonb(new) ->> 'audit_log_id' is not null
       and (to_jsonb(new) - 'audit_log_id') = (to_jsonb(old) - 'audit_log_id') then
      return new;
    end if;
  end if;
  raise exception 'REMINDER_HISTORY_IS_APPEND_ONLY: %.% cannot be %', tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'P0001';
end;
$$;
revoke execute on function app.block_payment_reminder_mutation() from public, anon, authenticated;

create trigger payment_reminder_batches_append_only before update or delete on public.payment_reminder_batches
  for each row execute function app.block_payment_reminder_mutation();
create trigger payment_reminders_append_only before update or delete on public.payment_reminders
  for each row execute function app.block_payment_reminder_mutation();


-- ── 2. Member state (internal) ──────────────────────────────────────────────

create or replace function app.payment_reminder_member_state(p_collection_id uuid)
returns table (
  member_id        uuid,
  user_id          uuid,
  full_name        text,
  member_code      text,
  paid             boolean,
  payment_count    integer,
  exempt           boolean,
  last_reminded_at timestamptz,
  reminder_count   integer,
  email_usable     boolean,
  email_opted_out  boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with aud as (
    select a.member_id from app.resolve_collection_audience(p_collection_id) a
  ),
  paid as (
    select c.member_id, count(*)::integer as n
    from public.contributions c
    where c.collection_id = p_collection_id and c.status = 'applied' and c.member_id is not null
    group by c.member_id
  ),
  obl as (
    select o.member_id, bool_or(o.status = 'paid') as paid, bool_or(o.status in ('exempt', 'cancelled')) as exempt
    from public.obligations o
    where o.collection_id = p_collection_id and o.cycle_key is null
    group by o.member_id
  ),
  rem as (
    select r.member_id, max(r.created_at) as last_at, count(*)::integer as n
    from public.payment_reminders r
    where r.collection_id = p_collection_id
    group by r.member_id
  )
  select
    m.id, m.user_id, m.full_name, m.member_code,
    (p.member_id is not null or coalesce(o.paid, false)),
    coalesce(p.n, 0),
    coalesce(o.exempt, false) and p.member_id is null,
    r.last_at, coalesce(r.n, 0),
    case when m.user_id is not null
         then exists (select 1 from auth.users u where u.id = m.user_id and u.email_confirmed_at is not null
                      and app.email_address_usable(u.email::text))
         else m.email is not null and app.email_address_usable(m.email::text) end,
    app.member_communication_opted_out(m.id, 'payment', 'email')
      or coalesce((select np.email_enabled is false or np.reminders_enabled is false
                   from public.notification_preferences np
                   where np.member_id = m.id and np.community_id = m.community_id), false)
  from aud
  join public.members m on m.id = aud.member_id
  left join paid p on p.member_id = m.id
  left join obl  o on o.member_id = m.id
  left join rem  r on r.member_id = m.id;
$$;
revoke execute on function app.payment_reminder_member_state(uuid) from public, anon, authenticated;


-- ── 3. Organiser reads ──────────────────────────────────────────────────────

create or replace function app.payment_reminder_summary(p_collection_id uuid)
returns table (
  supported            boolean,
  unsupported_reason   text,
  collection_active    boolean,
  collection_reachable boolean,
  can_send             boolean,
  eligible_count       integer,
  paid_count           integer,
  unpaid_count         integer,
  exempt_count         integer,
  reminded_count       integer,
  remindable_now_count integer,
  reminders_sent       integer,
  last_sent_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_c public.collections%rowtype;
  v_reachable boolean;
begin
  select * into v_c from public.collections c where c.id = p_collection_id;
  if v_c.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id using errcode = '42501';
  end if;

  select exists (select 1 from public.communities cm where cm.id = v_c.community_id and cm.status = 'active')
         and v_c.visibility in ('public', 'unlisted') and v_c.status in ('active', 'paused', 'closed')
    into v_reachable;

  if v_c.audience_mode = 'public' then
    return query select false, 'public_collection'::text, v_c.status = 'active', v_reachable, false,
                        0, 0, 0, 0, 0, 0, 0, null::timestamptz;
    return;
  end if;
  if v_c.schedule = 'recurring' then
    return query select false, 'recurring_collection'::text, v_c.status = 'active', v_reachable, false,
                        0, 0, 0, 0, 0, 0, 0, null::timestamptz;
    return;
  end if;

  return query
  select true, null::text, v_c.status = 'active', v_reachable,
         app.has_permission_for_collection(p_collection_id, 'reminder.send'),
         count(*)::integer,
         (count(*) filter (where s.paid))::integer,
         (count(*) filter (where not s.paid and not s.exempt))::integer,
         (count(*) filter (where s.exempt))::integer,
         (count(*) filter (where not s.paid and not s.exempt and s.reminder_count > 0))::integer,
         (count(*) filter (where not s.paid and not s.exempt
                             and (s.user_id is not null or (s.email_usable and not s.email_opted_out))
                             and (s.last_reminded_at is null or s.last_reminded_at <= now() - interval '24 hours')))::integer,
         (select count(*)::integer from public.payment_reminders r where r.collection_id = p_collection_id),
         (select max(b.created_at) from public.payment_reminder_batches b where b.collection_id = p_collection_id)
  from app.payment_reminder_member_state(p_collection_id) s;
end;
$$;

create or replace function app.payment_reminder_roster(
  p_collection_id uuid,
  p_filter        text default 'unpaid',
  p_search        text default null,
  p_limit         integer default 50,
  p_offset        integer default 0
)
returns table (
  member_id        uuid,
  full_name        text,
  member_code      text,
  paid             boolean,
  payment_count    integer,
  exempt           boolean,
  last_reminded_at timestamptz,
  reminder_count   integer,
  last_email_status text,
  can_remind       boolean,
  blocked_reason   text,
  total_count      bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_c       public.collections%rowtype;
  v_pattern text;
begin
  select * into v_c from public.collections c where c.id = p_collection_id;
  if v_c.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if not app.has_permission_for_collection(p_collection_id, 'transaction.view') then
    raise exception 'FORBIDDEN: missing permission transaction.view for collection %', p_collection_id using errcode = '42501';
  end if;
  if p_filter not in ('all', 'unpaid', 'paid', 'reminded') then
    raise exception 'INVALID_FILTER: all, unpaid, paid or reminded' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 or p_offset is null or p_offset < 0 then
    raise exception 'INVALID_PAGE: limit 1..200, offset ≥ 0' using errcode = '22023';
  end if;
  if v_c.audience_mode = 'public' or v_c.schedule = 'recurring' then
    return;
  end if;

  v_pattern := case when nullif(btrim(p_search), '') is null then null
                    else '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  return query
  with st as (
    select s.*,
      case
        when s.paid then 'paid'
        when s.exempt then 'exempt'
        when s.user_id is null and not (s.email_usable and not s.email_opted_out)
          then case when s.email_opted_out then 'opted_out' else 'no_contact' end
        when s.last_reminded_at is not null and s.last_reminded_at > now() - interval '24 hours' then 'cooldown'
        else null
      end as blocked
    from app.payment_reminder_member_state(p_collection_id) s
  ),
  f as (
    select st.*, count(*) over () as total
    from st
    where (p_filter = 'all'
           or (p_filter = 'unpaid' and not st.paid and not st.exempt)
           or (p_filter = 'paid' and st.paid)
           or (p_filter = 'reminded' and st.reminder_count > 0))
      and (v_pattern is null
           or lower(st.full_name) like v_pattern escape '\'
           or lower(coalesce(st.member_code, '')) like v_pattern escape '\')
  )
  select f.member_id, f.full_name, f.member_code, f.paid, f.payment_count, f.exempt,
         f.last_reminded_at, f.reminder_count,
         (select d.status::text
            from public.payment_reminders r
            join public.payment_reminder_batches b on b.id = r.batch_id
            join public.notification_events e on e.event_key = 'collection.remind_unpaid:' || b.audit_log_id::text
            join public.notification_deliveries d on d.notification_event_id = e.id
                 and d.recipient_member_id = r.member_id and d.channel = 'email'
           where r.collection_id = p_collection_id and r.member_id = f.member_id
           order by r.created_at desc limit 1),
         f.blocked is null, f.blocked, f.total
  from f
  order by f.paid, f.full_name, f.member_id
  limit p_limit offset p_offset;
end;
$$;

revoke all on function app.payment_reminder_summary(uuid) from public;
revoke all on function app.payment_reminder_roster(uuid, text, text, integer, integer) from public;
grant execute on function app.payment_reminder_summary(uuid) to authenticated;
grant execute on function app.payment_reminder_roster(uuid, text, text, integer, integer) to authenticated;


-- ── 4. Send ─────────────────────────────────────────────────────────────────

create or replace function app.send_payment_reminders(
  p_collection_id   uuid,
  p_member_ids      uuid[],
  p_idempotency_key text
)
returns table (
  batch_id            uuid,
  sent_count          integer,
  skipped_paid        integer,
  skipped_cooldown    integer,
  skipped_ineligible  integer,
  skipped_unreachable integer,
  reused              boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid      uuid := auth.uid();
  v_c        public.collections%rowtype;
  v_existing public.payment_reminder_batches%rowtype;
  v_ids      uuid[];
  v_send     uuid[];
  v_paid     integer;
  v_cool     integer;
  v_inel     integer;
  v_unreach  integer;
  v_batch    uuid;
  v_audit    uuid;
begin
  select * into v_c from public.collections c where c.id = p_collection_id;
  if v_c.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;
  if v_uid is null or not app.has_permission_for_collection(p_collection_id, 'reminder.send') then
    raise exception 'FORBIDDEN: missing permission reminder.send for collection %', p_collection_id using errcode = '42501';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 120 then
    raise exception 'INVALID_IDEMPOTENCY_KEY: 8 to 120 characters' using errcode = '22023';
  end if;

  select * into v_existing from public.payment_reminder_batches b
  where b.collection_id = p_collection_id and b.sent_by = v_uid and b.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    return query select v_existing.id, v_existing.member_count, 0, 0, 0, 0, true;
    return;
  end if;

  if v_c.audience_mode = 'public' then
    raise exception 'REMINDERS_NOT_SUPPORTED: an open-link collection has no member list to remind' using errcode = 'P0001';
  end if;
  if v_c.schedule = 'recurring' then
    raise exception 'REMINDERS_NOT_SUPPORTED: reminders for recurring collections are not available yet' using errcode = 'P0001';
  end if;
  if v_c.status <> 'active' then
    raise exception 'COLLECTION_NOT_ACTIVE: reminders can only be sent while the collection is taking payments'
      using errcode = 'P0001';
  end if;

  select array_agg(distinct x) into v_ids from unnest(p_member_ids) x where x is not null;
  if v_ids is null or cardinality(v_ids) = 0 then
    raise exception 'NO_MEMBERS: choose at least one member' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'TOO_MANY_MEMBERS: at most 500 members per send' using errcode = '22023';
  end if;

  -- Two clicks (or two officers) cannot both pass the cooldown.
  perform pg_advisory_xact_lock(hashtextextended('payment_reminders:' || p_collection_id::text, 0));

  with st as (select * from app.payment_reminder_member_state(p_collection_id)),
  classified as (
    select ch.id as x_member_id, case
      when st.member_id is null or st.exempt then 'ineligible'
      when st.paid then 'paid'
      when st.user_id is null and not (st.email_usable and not st.email_opted_out) then 'unreachable'
      when st.last_reminded_at is not null and st.last_reminded_at > now() - interval '24 hours' then 'cooldown'
      else 'send' end as verdict
    from unnest(v_ids) ch(id)
    left join st on st.member_id = ch.id
  )
  select array_agg(x_member_id) filter (where verdict = 'send'),
         (count(*) filter (where verdict = 'paid'))::integer,
         (count(*) filter (where verdict = 'cooldown'))::integer,
         (count(*) filter (where verdict = 'ineligible'))::integer,
         (count(*) filter (where verdict = 'unreachable'))::integer
    into v_send, v_paid, v_cool, v_inel, v_unreach
  from classified;

  if v_send is null or cardinality(v_send) = 0 then
    return query select null::uuid, 0, v_paid, v_cool, v_inel, v_unreach, false;
    return;
  end if;

  insert into public.payment_reminder_batches (community_id, collection_id, sent_by, idempotency_key, member_count)
  values (v_c.community_id, p_collection_id, v_uid, p_idempotency_key, cardinality(v_send))
  returning id into v_batch;

  insert into public.payment_reminders (batch_id, community_id, collection_id, member_id, sent_by)
  select v_batch, v_c.community_id, p_collection_id, x, v_uid from unnest(v_send) x;

  v_audit := app.write_audit_log(
    v_c.community_id, 'officer', v_uid, 'collection.remind_unpaid', 'collection', p_collection_id, null,
    jsonb_build_object('reminder_batch_id', v_batch, 'member_count', cardinality(v_send)));

  update public.payment_reminder_batches set audit_log_id = v_audit where id = v_batch;

  return query select v_batch, cardinality(v_send), v_paid, v_cool, v_inel, v_unreach, false;
end;
$$;
revoke all on function app.send_payment_reminders(uuid, uuid[], text) from public;
grant execute on function app.send_payment_reminders(uuid, uuid[], text) to authenticated;

comment on function app.send_payment_reminders(uuid, uuid[], text) is
  'reminder.send: remind the chosen members of an active, one-time, member-audience collection. Skips paid, exempt, out-of-audience, unreachable and anyone reminded in the last 24 hours. Records the batch and one reminder per member and writes one collection.remind_unpaid audit row (with reminder_batch_id) that the notification pipeline delivers. Idempotent per (collection, sender, key).';


-- ── 5. Worker: who in a batch still gets it, and where ─────────────────────
-- Re-checked when the worker processes the batch: a member who paid since the
-- organiser clicked is skipped (already_paid). Same address rules as
-- collection announcements (account → confirmed auth email; otherwise the
-- member record's email).

create or replace function app.payment_reminder_batch_recipients(p_batch_id uuid)
returns table (
  member_id   uuid,
  user_id     uuid,
  eligible    boolean,
  address     text,
  assurance   text,
  skip_reason text,
  in_app      boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_b         public.payment_reminder_batches%rowtype;
  v_c         public.collections%rowtype;
  v_reachable boolean;
  v_req       text;
  v_detail    text;
  v_attested  boolean;
begin
  select * into v_b from public.payment_reminder_batches b where b.id = p_batch_id;
  if v_b.id is null then
    return;
  end if;
  select * into v_c from public.collections c where c.id = v_b.collection_id;

  select exists (select 1 from public.communities cm where cm.id = v_c.community_id and cm.status = 'active')
         and v_c.visibility in ('public', 'unlisted') and v_c.status in ('active', 'paused', 'closed')
    into v_reachable;
  select r.requirement, r.detail into v_req, v_detail
  from app.communication_requirement('payment', 'email', 'targeted_reminder') r;
  v_attested := app.community_communication_notice_attested(v_c.community_id);

  return query
  with st as (select * from app.payment_reminder_member_state(v_b.collection_id)),
  facts as (
    select r.member_id as f_member_id, m.user_id as f_user_id, m.email::text as f_member_email,
           m.status::text as f_status, m.archived_at as f_archived_at, m.merged_into_id as f_merged,
           st.member_id is not null as f_in_audience, coalesce(st.paid, false) as f_paid,
           coalesce(st.exempt, false) as f_exempt, coalesce(st.email_opted_out, false) as f_opted_out,
           u.email::text as f_auth_email, u.email_confirmed_at as f_auth_confirmed
    from public.payment_reminders r
    join public.members m on m.id = r.member_id
    left join st on st.member_id = r.member_id
    left join auth.users u on u.id = m.user_id
    where r.batch_id = p_batch_id
  ),
  decided as (
    select f.*,
      case
        when f.f_status in ('archived', 'merged') or f.f_archived_at is not null or f.f_merged is not null then 'member_unavailable'
        when not f.f_in_audience or f.f_exempt then 'member_unavailable'
        when f.f_paid then 'already_paid'
        when not v_reachable then 'collection_not_reachable'
        when v_req = 'disabled' then coalesce(v_detail, 'category_not_on_channel')
        when v_req is distinct from 'default_on' then 'category_not_on_channel'
        when f.f_opted_out then 'opted_out'
        when v_detail = 'community_notice' and not coalesce(v_attested, false) then 'community_notice_missing'
        when f.f_user_id is not null and (f.f_auth_email is null or f.f_auth_confirmed is null) then 'unverified_account_email'
        when f.f_user_id is not null and not app.email_address_usable(f.f_auth_email) then 'invalid_recipient_address'
        when f.f_user_id is null and f.f_member_email is null then 'no_recipient'
        when f.f_user_id is null and not app.email_address_usable(f.f_member_email) then 'invalid_recipient_address'
        else null
      end as d_skip,
      case when f.f_user_id is not null then f.f_auth_email else f.f_member_email end as d_candidate,
      case when f.f_user_id is not null then 'verified_account' else 'unverified_supplied' end as d_assurance
    from facts f
  )
  select d.f_member_id, d.f_user_id, d.d_skip is null,
         case when d.d_skip is null then d.d_candidate end,
         case when d.d_skip is null then d.d_assurance end,
         d.d_skip,
         -- In-app: linked account, still unpaid, still in the audience.
         d.f_user_id is not null and d.f_in_audience and not d.f_paid and not d.f_exempt
           and d.f_status not in ('archived', 'merged') and d.f_archived_at is null and d.f_merged is null
  from decided d
  order by d.f_member_id;
end;
$$;
revoke all on function app.payment_reminder_batch_recipients(uuid) from public;
revoke execute on function app.payment_reminder_batch_recipients(uuid) from public, anon, authenticated;

comment on function app.payment_reminder_batch_recipients(uuid) is
  'Worker: for each member in a reminder batch, re-checked now — email address and assurance, or a skip reason (member_unavailable, already_paid, collection_not_reachable, opted_out, community_notice_missing, unverified_account_email, invalid_recipient_address, no_recipient, or a policy-matrix reason), and whether an in-app row is due. No client role may execute it.';


-- ── 6. The policy matrix: payment communications are now possible ───────────
-- Identical to 20261109100000 except the eight payment rows.

create or replace function app.communication_requirement(
  p_category        text,
  p_channel         text,
  p_payment_purpose text default null
)
returns table (requirement text, detail text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_purpose text;
begin
  if p_category is null or p_category not in ('essential', 'community_operational', 'marketing', 'payment') then
    raise exception 'INVALID_CATEGORY: %', p_category using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('in_app', 'email', 'whatsapp', 'sms') then
    raise exception 'INVALID_CHANNEL: %', p_channel using errcode = '22023';
  end if;
  if p_payment_purpose is not null and p_payment_purpose not in ('status', 'targeted_reminder') then
    raise exception 'INVALID_PAYMENT_PURPOSE: %', p_payment_purpose using errcode = '22023';
  end if;
  -- A payment communication with no stated purpose is a targeted reminder,
  -- never essential (worker: same rule).
  v_purpose := case when p_category = 'payment' then coalesce(p_payment_purpose, 'targeted_reminder') else '' end;

  return query
  select m.requirement, m.detail
  from (values
    -- POLICY-MATRIX-BEGIN (parsed by apps/worker/test/communication-policy-sql-parity.test.ts; keep one row per line)
    ('essential',             '',                  'in_app',   'always',     null::text),
    ('essential',             '',                  'email',    'always',     null),
    ('essential',             '',                  'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('essential',             '',                  'sms',      'disabled',   'channel_disabled'),
    ('community_operational', '',                  'in_app',   'always',     null),
    ('community_operational', '',                  'email',    'default_on', 'community_notice'),
    ('community_operational', '',                  'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('community_operational', '',                  'sms',      'disabled',   'channel_disabled'),
    ('marketing',             '',                  'in_app',   'disabled',   'category_not_on_channel'),
    ('marketing',             '',                  'email',    'opt_in',     'marketing_consent'),
    ('marketing',             '',                  'whatsapp', 'opt_in',     'marketing_consent,whatsapp_permission'),
    ('marketing',             '',                  'sms',      'disabled',   'channel_disabled'),
    ('payment',               'status',            'in_app',   'always',     null),
    ('payment',               'status',            'email',    'always',     null),
    ('payment',               'status',            'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('payment',               'status',            'sms',      'disabled',   'channel_disabled'),
    ('payment',               'targeted_reminder', 'in_app',   'always',     null),
    ('payment',               'targeted_reminder', 'email',    'default_on', 'community_notice'),
    ('payment',               'targeted_reminder', 'whatsapp', 'opt_in',     'whatsapp_permission'),
    ('payment',               'targeted_reminder', 'sms',      'disabled',   'channel_disabled')
    -- POLICY-MATRIX-END
  ) as m (category, purpose, channel, requirement, detail)
  where m.category = p_category
    and m.purpose  = v_purpose
    and m.channel  = p_channel;
end;
$$;

comment on function app.communication_requirement(text, text, text) is
  'The communication policy matrix (category × channel → always / default_on / opt_in / disabled), identical to apps/worker/src/communication-policy.ts with today''s capabilities (payment attribution: on since 20261117100500; SMS not approved). Changing a row is a reviewed product decision; the worker parity test fails if the two disagree.';

revoke all on function app.communication_requirement(text, text, text) from public;
revoke execute on function app.communication_requirement(text, text, text) from public, anon, authenticated;
