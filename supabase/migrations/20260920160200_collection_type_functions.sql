-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160200 — Write functions for the type-specific configuration
--
-- Same contract as every other write function (ADR 0008): SECURITY DEFINER,
-- re-checks app.has_permission, re-derives tenancy from the row, audits.
--
-- The rule these share with tiers: configuration that a contributor will later
-- be charged against is editable while the collection is a draft and fixed once
-- it is published. Items and ticket types are prices; changing a published price
-- is what `collection.change_amount` covers, and that needs a second approver
-- no table can record yet (PRD 17.5).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Items ────────────────────────────────────────────────────────────────────
-- Full replace matched by item id, exactly as set_collection_tiers does, and
-- for the same reason: an item's identity is its id, so a rename is a rename
-- rather than a delete and a create that loses whatever pointed at it.
create or replace function app.set_collection_items(
  p_collection_id uuid,
  p_items         jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_item       jsonb;
  v_id         uuid;
  v_name       text;
  v_price      bigint;
  v_payload_ids uuid[] := '{}';
  v_names      text[] := '{}';
  v_created_at jsonb   := '{}'::jsonb;
  v_count      integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status <> 'draft' then
    raise exception 'ITEMS_LOCKED: items can only be changed while the collection is a draft'
      using errcode = 'P0001',
            hint = 'Hide an item instead — a sold item is hidden, never removed.';
  end if;
  if v_collection.amount_model <> 'items' then
    raise exception 'NOT_ITEM_BASED: this collection does not sell items' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_ITEMS: an item collection needs at least one item' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_ITEMS: a collection can offer at most 50 items' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_name  := nullif(trim(v_item ->> 'name'), '');
    v_price := (v_item ->> 'price_kobo')::bigint;

    if v_name is null or char_length(v_name) > 80 then
      raise exception 'INVALID_ITEMS: every item needs a name of 80 characters or fewer' using errcode = 'P0001';
    end if;
    if v_price is null or v_price <= 0 then
      raise exception 'INVALID_ITEMS: item "%" needs a price above zero', v_name using errcode = 'P0001';
    end if;
    if lower(v_name) = any (v_names) then
      raise exception 'DUPLICATE_ITEM_NAME: two items are both called "%" — give each a distinct name', v_name
        using errcode = 'P0001',
              hint = 'Two items with one name cannot be told apart on an order or a receipt.';
    end if;
    v_names := v_names || lower(v_name);

    v_id := nullif(v_item ->> 'id', '')::uuid;
    if v_id is not null then
      if not exists (select 1 from public.collection_items where id = v_id and collection_id = p_collection_id) then
        raise exception 'NOT_FOUND: item % does not belong to this collection', v_id using errcode = 'P0002';
      end if;
      v_payload_ids := v_payload_ids || v_id;
    end if;
  end loop;

  -- Delete-then-insert, carrying created_at across, for the reason
  -- set_collection_tiers states: a unique name index makes a row-by-row rename
  -- of two items into each other's names fail halfway.
  select coalesce(jsonb_object_agg(id::text, to_jsonb(created_at)), '{}'::jsonb)
    into v_created_at
  from public.collection_items where collection_id = p_collection_id;

  delete from public.collection_items where collection_id = p_collection_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_id := coalesce(nullif(v_item ->> 'id', '')::uuid, app.uuid_generate_v7());

    insert into public.collection_items (
      id, collection_id, community_id, name, description, price_kobo,
      quantity_available, max_per_order, image_url, hidden, sort_order, created_at
    ) values (
      v_id, p_collection_id, v_collection.community_id,
      trim(v_item ->> 'name'),
      nullif(trim(v_item ->> 'description'), ''),
      (v_item ->> 'price_kobo')::bigint,
      nullif(v_item ->> 'quantity_available', '')::integer,
      nullif(v_item ->> 'max_per_order', '')::integer,
      nullif(trim(v_item ->> 'image_url'), ''),
      coalesce((v_item ->> 'hidden')::boolean, false),
      coalesce(nullif(v_item ->> 'sort_order', '')::smallint, v_count::smallint),
      coalesce((v_created_at ->> v_id::text)::timestamptz, now())
    );

    v_count := v_count + 1;
  end loop;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_items', 'collection', p_collection_id,
    null, jsonb_build_object('item_count', v_count)
  );

  return v_count;
end;
$$;

comment on function app.set_collection_items(uuid, jsonb) is
  'Full replace matched by item id, never by display name (ADR 0010 applied to items). Draft only: a published price is part of the offer.';

create or replace function app.set_item_hidden(p_item_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.collection_items%rowtype;
begin
  select * into v_item from public.collection_items where id = p_item_id;
  if v_item.id is null then
    raise exception 'NOT_FOUND: item % does not exist', p_item_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_item.community_id, 'collection.draft');

  update public.collection_items set hidden = p_hidden where id = p_item_id;

  perform app.write_audit_log(
    v_item.community_id, 'officer', auth.uid(), 'collection.set_items', 'collection_item', p_item_id,
    jsonb_build_object('hidden', v_item.hidden), jsonb_build_object('hidden', p_hidden)
  );
end;
$$;


-- ── The event a ticketed collection is for ───────────────────────────────────
create or replace function app.set_collection_event(
  p_collection_id   uuid,
  p_event_starts_at timestamptz default null,
  p_event_ends_at   timestamptz default null,
  p_venue           text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot be edited', v_collection.status
      using errcode = 'P0001';
  end if;
  if p_event_ends_at is not null and p_event_starts_at is not null and p_event_ends_at < p_event_starts_at then
    raise exception 'INVALID_EVENT_DATES: the event cannot end before it starts' using errcode = 'P0001';
  end if;

  -- Deliberately NOT locked after publication: a venue changes, a date moves,
  -- and telling ticket-holders is exactly what the page is for. The price is
  -- what stays fixed.
  update public.collections set
    event_starts_at = p_event_starts_at,
    event_ends_at   = p_event_ends_at,
    venue           = nullif(trim(coalesce(p_venue, '')), '')
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_event', 'collection', p_collection_id,
    jsonb_build_object('event_starts_at', v_collection.event_starts_at, 'venue', v_collection.venue),
    jsonb_build_object('event_starts_at', p_event_starts_at, 'venue', p_venue)
  );
end;
$$;

comment on function app.set_collection_event is
  'The date and place a ticketed collection is for. Editable after publication on purpose — a moved venue must be publishable; a changed price must not be.';


-- ── Suggested amounts ────────────────────────────────────────────────────────
create or replace function app.set_collection_suggested_amounts(
  p_collection_id uuid,
  p_amounts_kobo  bigint[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_amount     bigint;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.amount_model <> 'open_amount' then
    raise exception 'NOT_OPEN_AMOUNT: suggestions only apply when contributors choose their own amount'
      using errcode = 'P0001';
  end if;

  foreach v_amount in array coalesce(p_amounts_kobo, '{}')
  loop
    if v_amount <= 0 then
      raise exception 'INVALID_AMOUNT: a suggested amount must be above zero' using errcode = 'P0001';
    end if;
    if v_collection.min_amount_kobo is not null and v_amount < v_collection.min_amount_kobo then
      raise exception 'INVALID_AMOUNT: a suggestion cannot be below the smallest contribution allowed'
        using errcode = 'P0001';
    end if;
    if v_collection.max_amount_kobo is not null and v_amount > v_collection.max_amount_kobo then
      raise exception 'INVALID_AMOUNT: a suggestion cannot be above the largest contribution allowed'
        using errcode = 'P0001';
    end if;
  end loop;

  update public.collections
  set suggested_amounts_kobo = coalesce(p_amounts_kobo, '{}')
  where id = p_collection_id;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_suggestions', 'collection', p_collection_id,
    null, jsonb_build_object('count', coalesce(array_length(p_amounts_kobo, 1), 0))
  );
end;
$$;


-- ── Recurrence ───────────────────────────────────────────────────────────────
create or replace function app.set_collection_recurrence(
  p_collection_id  uuid,
  p_frequency      public.recurrence_frequency,
  p_interval_count smallint default 1,
  p_starts_on      date default null,
  p_due_after_days smallint default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.schedule <> 'recurring' then
    raise exception 'NOT_RECURRING: this collection does not repeat' using errcode = 'P0001';
  end if;
  if v_collection.status <> 'draft' then
    raise exception 'RECURRENCE_LOCKED: how often a charge repeats cannot change once it is published'
      using errcode = 'P0001',
            hint = 'Close this collection and start another if the schedule needs to change.';
  end if;

  insert into public.collection_recurrences as r (
    collection_id, community_id, frequency, interval_count, starts_on, due_after_days
  ) values (
    p_collection_id, v_collection.community_id, p_frequency,
    coalesce(p_interval_count, 1), coalesce(p_starts_on, current_date), coalesce(p_due_after_days, 0)
  )
  on conflict (collection_id) do update
    set frequency      = excluded.frequency,
        interval_count = excluded.interval_count,
        starts_on      = excluded.starts_on,
        due_after_days = excluded.due_after_days;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_recurrence', 'collection', p_collection_id,
    null, jsonb_build_object('frequency', p_frequency, 'every', p_interval_count)
  );
end;
$$;

comment on function app.set_collection_recurrence is
  'How a recurring charge repeats. Draft only: members agreed to a monthly service charge, and a collection that silently became weekly would be charging them something they never agreed to.';

-- Opening a cycle is what makes a period exist. It is an officer's act, not a
-- scheduled job: this phase does not create obligations while nobody is looking,
-- and Phase 4 will decide what automation is safe once money is involved.
create or replace function app.open_collection_cycle(p_collection_id uuid)
returns table (cycle_id uuid, cycle_key text, period_start date, period_end date)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_recurrence public.collection_recurrences%rowtype;
  v_last       public.collection_cycles%rowtype;
  v_start      date;
  v_end        date;
  v_key        text;
  v_id         uuid;
  v_step       interval;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'obligation.assign');

  select * into v_recurrence from public.collection_recurrences where collection_id = p_collection_id;
  if v_recurrence.collection_id is null then
    raise exception 'NOT_RECURRING: this collection has no repeat schedule' using errcode = 'P0001';
  end if;
  if v_collection.status not in ('active', 'scheduled', 'paused') then
    raise exception 'COLLECTION_NOT_OPEN: a % collection does not open new periods', v_collection.status
      using errcode = 'P0001';
  end if;

  v_step := case v_recurrence.frequency
              when 'weekly'    then make_interval(weeks  => v_recurrence.interval_count)
              when 'monthly'   then make_interval(months => v_recurrence.interval_count)
              when 'quarterly' then make_interval(months => v_recurrence.interval_count * 3)
              when 'yearly'    then make_interval(years  => v_recurrence.interval_count)
            end;

  select * into v_last
  from public.collection_cycles
  where collection_id = p_collection_id
  order by period_start desc
  limit 1;

  v_start := case when v_last.id is null then v_recurrence.starts_on else v_last.period_end + 1 end;
  v_end   := (v_start + v_step - interval '1 day')::date;

  -- A label a person recognises on a receipt: 2026-10, 2026-Q4, 2026-W40.
  v_key := case v_recurrence.frequency
             when 'weekly'    then to_char(v_start, 'IYYY-"W"IW')
             when 'monthly'   then to_char(v_start, 'YYYY-MM')
             when 'quarterly' then to_char(v_start, 'YYYY-"Q"Q')
             when 'yearly'    then to_char(v_start, 'YYYY')
           end;

  if exists (select 1 from public.collection_cycles where collection_id = p_collection_id and collection_cycles.cycle_key = v_key) then
    raise exception 'CYCLE_EXISTS: % has already been opened for this collection', v_key using errcode = 'P0001';
  end if;

  v_id := app.uuid_generate_v7();

  insert into public.collection_cycles (
    id, collection_id, community_id, cycle_key, period_start, period_end, due_at, opened_by
  ) values (
    v_id, p_collection_id, v_collection.community_id, v_key, v_start, v_end,
    (v_start + make_interval(days => v_recurrence.due_after_days))::timestamptz, auth.uid()
  );

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.open_cycle', 'collection', p_collection_id,
    null, jsonb_build_object('cycle_key', v_key, 'period_start', v_start, 'period_end', v_end)
  );

  return query select v_id, v_key, v_start, v_end;
end;
$$;

comment on function app.open_collection_cycle(uuid) is
  'PRD 5.7: opens the next period of a recurring collection. Deliberately manual — obligations for a new month are money somebody owes, and this phase never creates that unprompted (§38).';
