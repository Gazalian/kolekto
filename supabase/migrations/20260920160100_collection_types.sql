-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920160100 — What each kind of collection needs to say
--
-- Seven collection types share one collection table, and each needs a little
-- that the others do not. This migration adds exactly that little, as columns
-- and tables rather than as a jsonb bag, because every one of these is
-- something the product will later have to query, validate or charge against:
--
--   suggested amounts   an open collection offers ₦5,000 / ₦10,000 / ₦20,000
--   event date + venue  a ticketed collection is for something, somewhere
--   items               a thing with a price, stock, and a quantity per order
--   recurrence + cycles a charge that repeats, and the periods it repeats over
--
-- Money is bigint kobo throughout (ADR 0003). Items carry stable ids and are
-- never identified by their display name (ADR 0010, extended from tiers to the
-- new shape for the same reason: the 2026-08-06 incident).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Open and fundraising: what to suggest ────────────────────────────────────
alter table public.collections
  add column suggested_amounts_kobo bigint[] not null default '{}';

comment on column public.collections.suggested_amounts_kobo is
  'Amounts offered as one-tap choices on an open collection (§26, §29). Suggestions only — the contributor may type any amount the min/max allow, and the server still resolves the figure.';

-- A CHECK cannot contain a subquery, and "every element is above zero" needs to
-- look at every element. An immutable function is the supported way to say it.
create or replace function app.all_amounts_positive(p_amounts bigint[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(bool_and(amount > 0), true) from unnest(coalesce(p_amounts, '{}')) as amount;
$$;

revoke all on function app.all_amounts_positive(bigint[]) from public;

alter table public.collections
  add constraint collections_suggested_amounts_positive
  check (app.all_amounts_positive(suggested_amounts_kobo)),
  add constraint collections_suggested_amounts_bounded
  check (coalesce(array_length(suggested_amounts_kobo, 1), 0) <= 6);


-- ── Ticketing: the event the tickets are for ─────────────────────────────────
-- A ticketed collection is a collection, not a second product (§30). What makes
-- it one is that it has a date and a place; the ticket types are tiers, which
-- already carry stable ids and availability limits.
alter table public.collections
  add column event_starts_at timestamptz,
  add column event_ends_at   timestamptz,
  add column venue           text;

comment on column public.collections.event_starts_at is
  'When the event happens. Distinct from starts_at (when the collection opens) and deadline_at (when it stops taking contributions) — a dinner sells tickets for six weeks and happens on one evening.';

alter table public.collections
  add constraint collections_event_dates_ordered
  check (event_ends_at is null or event_starts_at is null or event_ends_at >= event_starts_at),
  add constraint collections_venue_length
  check (venue is null or char_length(venue) between 1 and 200);


-- ── Items ────────────────────────────────────────────────────────────────────
create table public.collection_items (
  id                uuid primary key default app.uuid_generate_v7(),
  collection_id     uuid not null references public.collections (id) on delete cascade,
  community_id      uuid not null references public.communities (id) on delete cascade,

  name              text not null,
  description       text,
  price_kobo        app.kobo not null,

  -- How many exist to sell, and how many one person may take. Both optional:
  -- an aso-ebi order may be unlimited, or capped at what was ordered from the
  -- tailor.
  quantity_available integer,
  max_per_order      integer,

  image_url         text,
  -- PRD 4.7's rule, applied to items: a sold-out item is hidden, never removed,
  -- because an order already placed refers to it.
  hidden            boolean not null default false,
  sort_order        smallint not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint collection_items_name_length        check (char_length(name) between 1 and 80),
  constraint collection_items_description_length check (description is null or char_length(description) <= 500),
  constraint collection_items_price_positive     check (price_kobo > 0),
  constraint collection_items_quantity_positive  check (quantity_available is null or quantity_available >= 0),
  constraint collection_items_max_per_order_positive check (max_per_order is null or max_per_order > 0)
);

comment on table public.collection_items is
  'What an item-based collection sells. Identity is the id: an item is never resolved by its display name, for the same reason tiers are not (ADR 0010).';

-- Two items called "Blue" in one collection would be indistinguishable on a
-- receipt, which is the failure ADR 0010 exists to prevent.
create unique index collection_items_unique_name
  on public.collection_items (collection_id, lower(name));

create index collection_items_collection_idx on public.collection_items (collection_id, sort_order);

create trigger collection_items_set_updated_at
  before update on public.collection_items
  for each row execute function app.set_updated_at();

alter table public.collection_items enable row level security;
alter table public.collection_items force row level security;

create policy collection_items_select_officer
  on public.collection_items for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

grant select on table public.collection_items to authenticated;

-- An item only makes sense on an item-based collection, and must share its
-- community — the same guard collection_tiers carries (SEC-18).
create or replace function app.assert_item_is_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_model        public.amount_model;
  v_community_id uuid;
begin
  select amount_model, community_id into v_model, v_community_id
  from public.collections where id = new.collection_id;

  if v_model <> 'items' then
    raise exception
      'ITEM_ON_NON_ITEM_COLLECTION: collection % has amount_model %, so it cannot have items',
      new.collection_id, v_model
      using errcode = 'P0001';
  end if;

  if new.community_id <> v_community_id then
    raise exception
      'TENANCY_MISMATCH: item community % does not match collection community %',
      new.community_id, v_community_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger collection_items_assert_consistent
  before insert or update on public.collection_items
  for each row execute function app.assert_item_is_consistent();

revoke all on function app.assert_item_is_consistent() from public;


-- ── Recurring: the configuration, and the periods it produces ────────────────
-- Not "frequency = monthly on an otherwise fixed collection" (§32). A recurring
-- charge is a collection that produces CYCLES, and a member's obligation belongs
-- to one of them — which is why obligations.cycle_key has existed, unused, since
-- Phase 1. This gives it something to hold.
create type public.recurrence_frequency as enum ('weekly', 'monthly', 'quarterly', 'yearly');

create table public.collection_recurrences (
  collection_id uuid primary key references public.collections (id) on delete cascade,
  community_id  uuid not null references public.communities (id) on delete cascade,

  frequency     public.recurrence_frequency not null,
  -- Every 1 month, every 2 months. Kept separate from frequency so "quarterly"
  -- does not have to mean three different things in three communities.
  interval_count smallint not null default 1,

  starts_on     date not null,
  -- How long after a cycle opens its obligations are due. An estate bills on the
  -- 1st and expects payment by the 10th.
  due_after_days smallint not null default 0,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint collection_recurrences_interval_sane check (interval_count between 1 and 12),
  constraint collection_recurrences_due_days_sane check (due_after_days between 0 and 180)
);

comment on table public.collection_recurrences is
  'PRD 5.7 / §32: how a recurring collection repeats. Producing a cycle is a deliberate act (app.open_collection_cycle), never a scheduled job in this phase — Kolekto does not create debt while nobody is looking.';

alter table public.collection_recurrences enable row level security;
alter table public.collection_recurrences force row level security;

create policy collection_recurrences_select_officer
  on public.collection_recurrences for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

grant select on table public.collection_recurrences to authenticated;

create trigger collection_recurrences_set_updated_at
  before update on public.collection_recurrences
  for each row execute function app.set_updated_at();

create table public.collection_cycles (
  id            uuid primary key default app.uuid_generate_v7(),
  collection_id uuid not null references public.collections (id) on delete cascade,
  community_id  uuid not null references public.communities (id) on delete cascade,

  -- The label obligations are filed under: '2026-10', '2026-Q1', '2026-W40'.
  -- obligations.cycle_key holds exactly this string.
  cycle_key     text not null,
  period_start  date not null,
  period_end    date not null,
  due_at        timestamptz,

  opened_by     uuid references public.users (id) on delete set null,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,

  constraint collection_cycles_period_ordered check (period_end >= period_start),
  constraint collection_cycles_key_format     check (cycle_key ~ '^[0-9A-Za-z-]{4,20}$')
);

comment on table public.collection_cycles is
  'One period of a recurring collection. A member owes once per cycle, which is what obligations'' unique index on (collection_id, member_id, cycle_key) has always enforced.';

create unique index collection_cycles_unique_key on public.collection_cycles (collection_id, cycle_key);
create index collection_cycles_collection_idx on public.collection_cycles (collection_id, period_start desc);

alter table public.collection_cycles enable row level security;
alter table public.collection_cycles force row level security;

create policy collection_cycles_select_officer
  on public.collection_cycles for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

grant select on table public.collection_cycles to authenticated;
