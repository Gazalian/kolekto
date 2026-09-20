-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160300 — What the public page sees, and obligations per cycle
--
-- Two changes that could not go in the previous file:
--
--   · app.get_public_collection gains the event and suggestion columns. A
--     function's return type cannot be altered by CREATE OR REPLACE, so it is
--     dropped and recreated — and re-granted in the companion grants file,
--     because dropping a function takes its grants with it.
--
--   · app.sync_collection_obligations learns about cycles. A recurring
--     collection's obligation belongs to a period: "October's service charge",
--     not "the service charge". obligations.cycle_key has carried that shape
--     since Phase 1 and now has cycles to point at.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── The published collection page ────────────────────────────────────────────
drop function if exists app.get_public_collection(text, text);

create or replace function app.get_public_collection(
  p_community_slug  text,
  p_collection_slug text
)
returns table (
  collection_id        uuid,
  collection_name      text,
  description          text,
  cover_image_url      text,
  category             public.collection_category,
  participation_mode   public.participation_mode,
  amount_model         public.amount_model,
  payment_plan         public.payment_plan,
  fixed_amount_kobo    bigint,
  min_amount_kobo      bigint,
  max_amount_kobo      bigint,
  target_amount_kobo   bigint,
  suggested_amounts_kobo bigint[],
  deadline_at          timestamptz,
  event_starts_at      timestamptz,
  event_ends_at        timestamptz,
  venue                text,
  status               public.collection_status,
  display_options      jsonb,
  fee_mode             public.fee_mode,
  thank_you_message    text,
  community_name       text,
  community_logo_url   text,
  community_verified   public.verification_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.id, c.name, c.description, c.cover_image_url, c.category,
    c.participation_mode, c.amount_model, c.payment_plan,
    c.fixed_amount_kobo, c.min_amount_kobo, c.max_amount_kobo, c.target_amount_kobo,
    c.suggested_amounts_kobo,
    c.deadline_at, c.event_starts_at, c.event_ends_at, c.venue,
    c.status, c.display_options, c.fee_mode, c.thank_you_message,
    com.name, com.logo_url, com.verification_status
  from public.collections c
  join public.communities com on com.id = c.community_id
  where com.slug = p_community_slug
    and c.slug   = p_collection_slug
    -- CON-08: closed, paused and suspended pages still resolve, so a contributor
    -- sees a clear state instead of a 404. Drafts never resolve.
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
    and com.status = 'active';
$$;

comment on function app.get_public_collection(text, text) is
  'SEC-12: the whitelisted public collection page. Carries what a contributor needs to decide — including the event it is for and the amounts it suggests — and nothing about members, officers or money received.';

-- Items, for the same page and under the same rules as tiers. A hidden item is
-- not offered; quantity_available is exposed because "only 3 left" is something
-- the contributor is entitled to know before choosing.
create or replace function app.get_public_collection_items(p_collection_id uuid)
returns table (
  item_id            uuid,
  name               text,
  description        text,
  price_kobo         bigint,
  quantity_available integer,
  max_per_order      integer,
  image_url          text,
  sort_order         smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.name, i.description, i.price_kobo,
         i.quantity_available, i.max_per_order, i.image_url, i.sort_order
  from public.collection_items i
  join public.collections c on c.id = i.collection_id
  where i.collection_id = p_collection_id
    and not i.hidden
    and c.status in ('active', 'paused', 'closed')
    and c.visibility in ('public', 'unlisted')
  order by i.sort_order, i.name;
$$;

comment on function app.get_public_collection_items(uuid) is
  'SEC-12: the items a published collection offers. Identity travels as item_id — the page sends back an id, never a name or a price.';


-- ── Obligations belong to a cycle when a collection has cycles ──────────────
drop function if exists app.sync_collection_obligations(uuid, bigint, timestamptz);

create or replace function app.sync_collection_obligations(
  p_collection_id        uuid,
  p_expected_amount_kobo bigint default null,
  p_due_at               timestamptz default null,
  p_cycle_key            text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_cycle      public.collection_cycles%rowtype;
  v_expected   bigint;
  v_due_at     timestamptz;
  v_cycle_key  text;
  v_member_id  uuid;
  v_created    integer := 0;
  v_obligation_id uuid;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'obligation.assign');

  if v_collection.audience_mode = 'public' then
    raise exception 'NOT_MANAGED: an open collection has no member list to assign from'
      using errcode = 'P0001',
            hint = 'Anyone with the link can contribute, so there is nobody to expect.';
  end if;
  if v_collection.audience_mode = 'selected_members' then
    raise exception 'AUDIENCE_IS_SELECTION: this collection is for named members, so add them directly'
      using errcode = 'P0001',
            hint = 'Use Add members — for a hand-picked audience, choosing someone and expecting them to pay are the same act.';
  end if;
  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot take new assignments', v_collection.status
      using errcode = 'P0001';
  end if;

  -- A recurring collection charges per period, so an obligation without a cycle
  -- would be a debt for no particular month.
  if v_collection.schedule = 'recurring' then
    if p_cycle_key is null then
      raise exception 'CYCLE_REQUIRED: say which period these obligations are for'
        using errcode = 'P0001',
              hint = 'Open a period first — a recurring charge is owed for a month, not in general.';
    end if;

    select * into v_cycle
    from public.collection_cycles
    where collection_id = p_collection_id and cycle_key = p_cycle_key;

    if v_cycle.id is null then
      raise exception 'NOT_FOUND: this collection has no period called %', p_cycle_key using errcode = 'P0002';
    end if;
    if v_cycle.closed_at is not null then
      raise exception 'CYCLE_CLOSED: % has been closed', p_cycle_key using errcode = 'P0001';
    end if;

    v_cycle_key := v_cycle.cycle_key;
    v_due_at    := coalesce(p_due_at, v_cycle.due_at, v_collection.deadline_at);
  else
    if p_cycle_key is not null then
      raise exception 'NOT_RECURRING: this collection has no periods' using errcode = 'P0001';
    end if;
    v_cycle_key := null;
    v_due_at    := coalesce(p_due_at, v_collection.deadline_at);
  end if;

  -- The amount comes from the collection wherever the collection states it
  -- (SEC-18 applied to money); only per_member reads the caller's figure.
  if v_collection.amount_model = 'fixed' then
    v_expected := v_collection.fixed_amount_kobo;
  else
    v_expected := p_expected_amount_kobo;
    if v_expected is null or v_expected <= 0 then
      raise exception 'INVALID_AMOUNT: say how much these members are expected to pay' using errcode = 'P0001';
    end if;
  end if;

  for v_member_id in
    select a.member_id
    from app.resolve_collection_audience(p_collection_id) a
    where not exists (
      select 1 from public.obligations o
      where o.collection_id = p_collection_id
        and o.member_id = a.member_id
        and o.cycle_key is not distinct from v_cycle_key
    )
  loop
    v_obligation_id := app.uuid_generate_v7();

    insert into public.obligations (
      id, community_id, collection_id, member_id, cycle_key, expected_amount_kobo, due_at, assigned_by
    ) values (
      v_obligation_id, v_collection.community_id, p_collection_id, v_member_id, v_cycle_key,
      v_expected, v_due_at, auth.uid()
    )
    on conflict (collection_id, member_id, cycle_key) do nothing;

    if found then
      v_created := v_created + 1;
      perform app.write_audit_log(
        v_collection.community_id, 'officer', auth.uid(), 'obligation.assign', 'obligation', v_obligation_id,
        null,
        jsonb_build_object('member_id', v_member_id, 'expected_amount_kobo', v_expected,
                           'cycle_key', v_cycle_key, 'via', 'audience_sync')
      );
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function app.sync_collection_obligations is
  'obligation.assign. Materialises obligations for eligible members who have none for this period, idempotently. A recurring collection must name the period: a debt for no particular month is not a debt anybody can settle.';

-- app.resolve_collection_audience reads obligations for the selected_members
-- mode, and now has to ignore the cycle when deciding "is this member part of
-- the audience" — being in the audience is about the person, not the month.
create or replace function app.count_collection_audience(p_collection_id uuid)
returns table (eligible integer, with_obligation integer, awaiting integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
  v_schedule     public.collection_schedule;
  v_cycle_key    text;
begin
  select community_id, schedule into v_community_id, v_schedule
  from public.collections where id = p_collection_id;

  if v_community_id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'community.view_dashboard');

  -- For a recurring collection the question is about the open period: whether
  -- somebody owes October, not whether they have ever owed anything.
  if v_schedule = 'recurring' then
    select cycle_key into v_cycle_key
    from public.collection_cycles
    where collection_id = p_collection_id and closed_at is null
    order by period_start desc
    limit 1;
  end if;

  return query
  with audience as (select member_id from app.resolve_collection_audience(p_collection_id)),
       assigned as (
         select o.member_id from public.obligations o
         where o.collection_id = p_collection_id
           and o.status <> 'cancelled'
           and (v_schedule <> 'recurring' or o.cycle_key is not distinct from v_cycle_key)
       )
  select
    (select count(*)::integer from audience),
    (select count(*)::integer from assigned),
    (select count(*)::integer from audience a where not exists (select 1 from assigned s where s.member_id = a.member_id));
end;
$$;
