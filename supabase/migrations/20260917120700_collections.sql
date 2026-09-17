-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120700 — Collections, tiers and custom fields
--
-- The core product object (PRD 0.3). A named purpose, owned by a COMMUNITY, for
-- which money is collected under defined rules.
--
-- Two things to notice, both deliberate:
--
--   1. There is no `user_id`. A collection belongs to `community_id` and
--      records `created_by` as an actor (ADR 0004 / OWN-01). The previous
--      schema's root was `collections.user_id`, which is why a treasurer
--      graduating took the record with them.
--
--   2. There are no payment-method columns. COL-00: a collection can never
--      restrict, reorder or disable payment methods. The checkout shows
--      whatever Paystack enables. A column that cannot be set is a column that
--      should not exist.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.collections (
  id                    uuid primary key default app.uuid_generate_v7(),
  community_id          uuid not null references public.communities (id) on delete restrict,
  slug                  text not null,

  name                  text not null,
  description           text,
  cover_image_url       text,
  category              public.collection_category not null,

  -- PRD 4.1, the four configuration axes.
  participation_mode    public.participation_mode  not null,
  amount_model          public.amount_model        not null,
  payment_plan          public.payment_plan        not null default 'full_only',
  schedule              public.collection_schedule not null default 'one_time',

  -- ADR 0003: money is bigint kobo. `fixed_amount` is what one person pays when
  -- amount_model = 'fixed'; tier prices live on collection_tiers.
  fixed_amount_kobo     app.kobo,
  min_amount_kobo       app.kobo,
  max_amount_kobo       app.kobo,
  target_amount_kobo    app.kobo,

  starts_at             timestamptz,
  deadline_at           timestamptz,

  status                public.collection_status     not null default 'draft',
  visibility            public.collection_visibility not null default 'unlisted',

  -- PRD 4.3 display toggles. One jsonb rather than six booleans because they
  -- are presentation, they change together, and nothing authorizes on them.
  display_options       jsonb not null default
    '{"show_amount_raised": true, "show_target": true, "show_progress_bar": true,
      "show_contributor_count": true, "show_recent_contributors": false}'::jsonb,

  fee_mode              public.fee_mode not null default 'community_absorbs',

  -- Managed collections may optionally accept payment from non-members.
  allow_non_members     boolean not null default false,

  -- CODE-01: contributor codes are available on EVERY template, not only
  -- tickets. Format rules live in collection_code_settings.
  codes_enabled         boolean not null default false,

  -- Fundraisers only (PRD 4.3). The name is still stored privately for officers.
  allow_anonymous       boolean not null default false,

  thank_you_message     text,

  created_by            uuid not null references public.users (id) on delete restrict,
  published_by          uuid references public.users (id) on delete set null,
  published_at          timestamptz,
  closed_at             timestamptz,
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint collections_name_length         check (char_length(name) between 3 and 80),
  constraint collections_description_length  check (description is null or char_length(description) <= 2000),
  constraint collections_slug_format         check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])$'),

  -- Money is never negative. ADR 0003 allows a signed kobo domain because
  -- ledger entries are directional; nothing here is.
  constraint collections_amounts_not_negative
    check (coalesce(fixed_amount_kobo, 0)  >= 0
       and coalesce(min_amount_kobo, 0)    >= 0
       and coalesce(max_amount_kobo, 0)    >= 0
       and coalesce(target_amount_kobo, 0) >= 0),
  constraint collections_min_below_max
    check (min_amount_kobo is null or max_amount_kobo is null
           or min_amount_kobo <= max_amount_kobo),

  -- The amount model decides which amount columns mean anything. Enforcing it
  -- here means a tiered collection can never carry a stray fixed amount that
  -- some later code path decides to trust.
  constraint collections_fixed_has_amount
    check (amount_model <> 'fixed' or fixed_amount_kobo is not null),
  constraint collections_open_amount_has_no_fixed
    check (amount_model <> 'open_amount' or fixed_amount_kobo is null),
  constraint collections_per_member_is_managed
    check (amount_model <> 'per_member' or participation_mode = 'managed'),
  constraint collections_recurring_is_managed
    check (schedule <> 'recurring' or participation_mode = 'managed'),

  -- PRD 4.2: a fundraiser's every amount is already a complete contribution, so
  -- installments make no sense there.
  constraint collections_open_amount_has_no_installments
    check (not (amount_model = 'open_amount' and payment_plan = 'installments_allowed')),

  -- COL-03 / INS-05: installments require a deadline. Without one, "unfinished
  -- at the deadline" has no meaning and DEC-23's rule cannot be applied.
  constraint collections_installments_need_deadline
    check (payment_plan <> 'installments_allowed' or deadline_at is not null),

  constraint collections_dates_ordered
    check (starts_at is null or deadline_at is null or deadline_at > starts_at),
  constraint collections_published_consistently
    check ((published_at is null) = (published_by is null)),
  constraint collections_archived_has_timestamp
    check ((status = 'archived') = (archived_at is not null))
);

comment on table public.collections is
  'The core product object. Belongs to a community, never to a person (ADR 0004). Carries no payment-method columns by design (COL-00).';
comment on column public.collections.display_options is
  'PRD 4.3 progress-display toggles. Presentation only; nothing authorizes on this.';

create unique index collections_community_slug_key on public.collections (community_id, slug);
create index collections_community_status_idx on public.collections (community_id, status);
create index collections_public_idx on public.collections (community_id)
  where status = 'active' and visibility = 'public';
create index collections_deadline_idx on public.collections (deadline_at)
  where status = 'active' and deadline_at is not null;

create trigger collections_set_updated_at
  before update on public.collections
  for each row execute function app.set_updated_at();

alter table public.collections enable row level security;
alter table public.collections force row level security;


-- ── Tiers (ADR 0010) ─────────────────────────────────────────────────────────
-- Rows, with identity, and a unique name per collection.
--
-- This is the structural fix for the 2026-08-06 incident. The previous system
-- kept tiers in a `price_tiers` jsonb array, which no constraint could police,
-- and resolved a tier with a single `.find()` matching on ID *or* name — so two
-- tiers sharing a display name collapsed every selection onto whichever came
-- first in the array. Five collections in the old production database still
-- have duplicate tier names today.
create table public.collection_tiers (
  id                uuid primary key default app.uuid_generate_v7(),
  collection_id     uuid not null references public.collections (id) on delete cascade,
  community_id      uuid not null references public.communities (id) on delete cascade,

  name              text not null,
  description       text,
  price_kobo        app.kobo not null,

  -- COL-13: quantity-limited tiers. Units held by active installment plans
  -- count as reserved, which is why this needs a row to lock rather than a
  -- jsonb field to rewrite.
  quantity_limit    integer,
  per_order_limit   integer,

  -- CODE-02: an optional per-tier prefix, so a code reads DIN26-VIP-0042.
  code_prefix       text,

  -- PRD 4.7: a sold tier is hidden, never removed. The record must keep it.
  hidden            boolean not null default false,

  sort_order        smallint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint collection_tiers_name_length      check (char_length(name) between 1 and 60),
  constraint collection_tiers_price_positive   check (price_kobo > 0),
  constraint collection_tiers_quantity_positive
    check (quantity_limit is null or quantity_limit > 0),
  constraint collection_tiers_per_order_positive
    check (per_order_limit is null or per_order_limit > 0),
  constraint collection_tiers_code_prefix_format
    check (code_prefix is null or code_prefix ~ '^[A-Z0-9]{1,8}$')
);

comment on table public.collection_tiers is
  'ADR 0010: tiers are rows with identity. UNIQUE (collection_id, name) makes the 2026-08-06 duplicate-name incident structurally impossible.';

-- The constraint this table exists for.
create unique index collection_tiers_unique_name
  on public.collection_tiers (collection_id, lower(name));

create unique index collection_tiers_unique_code_prefix
  on public.collection_tiers (collection_id, code_prefix)
  where code_prefix is not null;

create index collection_tiers_collection_idx on public.collection_tiers (collection_id, sort_order);

create trigger collection_tiers_set_updated_at
  before update on public.collection_tiers
  for each row execute function app.set_updated_at();

alter table public.collection_tiers enable row level security;
alter table public.collection_tiers force row level security;

-- A tier only makes sense on a tiered collection, and it must belong to the
-- same community as its collection. The second half matters: it stops a tenancy
-- mix-up from ever producing a tier that RLS would evaluate against the wrong
-- community.
create or replace function app.assert_tier_is_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_model        public.amount_model;
  v_community_id uuid;
begin
  select amount_model, community_id
    into v_model, v_community_id
  from public.collections
  where id = new.collection_id;

  if v_model <> 'tiers' then
    raise exception
      'TIER_ON_NON_TIERED_COLLECTION: collection % has amount_model %, so it cannot have tiers',
      new.collection_id, v_model
      using errcode = 'P0001';
  end if;

  if new.community_id <> v_community_id then
    raise exception
      'TENANCY_MISMATCH: tier community % does not match collection community %',
      new.community_id, v_community_id
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger collection_tiers_assert_consistent
  before insert or update on public.collection_tiers
  for each row execute function app.assert_tier_is_consistent();


-- ── Custom questions (PRD 4.3) ───────────────────────────────────────────────
-- "Up to 10 custom questions." Each answer becomes a column in the
-- people-who-paid export (RPT-00).
create table public.collection_fields (
  id             uuid primary key default app.uuid_generate_v7(),
  collection_id  uuid not null references public.collections (id) on delete cascade,
  community_id   uuid not null references public.communities (id) on delete cascade,
  key            text not null,
  label          text not null,
  type           public.member_attribute_type not null,
  options        text[],
  required       boolean not null default false,
  sort_order     smallint not null default 0,
  created_at     timestamptz not null default now(),

  constraint collection_fields_key_format   check (key ~ '^[a-z][a-z0-9_]{0,38}$'),
  constraint collection_fields_label_length check (char_length(label) between 1 and 80),
  constraint collection_fields_options_for_select
    check ((type = 'single_select') = (options is not null and array_length(options, 1) > 0))
);

create unique index collection_fields_key on public.collection_fields (collection_id, key);

alter table public.collection_fields enable row level security;
alter table public.collection_fields force row level security;


-- ── Contributor code settings (CODE-02, CODE-03) ─────────────────────────────
create type public.code_style as enum ('sequential', 'random');

create table public.collection_code_settings (
  collection_id    uuid primary key references public.collections (id) on delete cascade,
  community_id     uuid not null references public.communities (id) on delete cascade,
  prefix           text,
  style            public.code_style not null default 'sequential',
  -- CODE-03: base the code on a member attribute or group, e.g. CSC-300L-0015.
  attribute_basis  text,
  -- CODE-04: one code per unit when quantity > 1, or one per order.
  per_unit         boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint collection_code_settings_prefix_format
    check (prefix is null or prefix ~ '^[A-Z0-9]{2,10}$')
);

create trigger collection_code_settings_set_updated_at
  before update on public.collection_code_settings
  for each row execute function app.set_updated_at();

alter table public.collection_code_settings enable row level security;
alter table public.collection_code_settings force row level security;


-- ── COL-14: a collection with contributions is never deleted ────────────────
-- Written now, before there is anything to protect, so it exists the day
-- contributions arrive. Modelled on the previous system's
-- `enforce_collection_delete_guard`, which worked and is worth keeping.
create or replace function app.enforce_collection_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_has_obligations boolean;
begin
  select exists (select 1 from public.obligations where collection_id = old.id)
    into v_has_obligations;

  -- When the money tables arrive (ADR 0006), this guard gains checks for
  -- contributions, ledger entries and withdrawals. The Phase 3 migration that
  -- creates them is responsible for extending it, and a pgTAP test asserts it.
  if v_has_obligations or old.status <> 'draft' then
    raise exception
      'COLLECTION_NOT_DELETABLE: collection % is % and has obligations=% (COL-14). Only an unpaid draft can be deleted.',
      old.id, old.status, v_has_obligations
      using errcode = 'P0001',
            hint = 'Close or archive the collection instead. Financial history is never deleted.';
  end if;

  return old;
end;
$$;
-- Trigger created in the obligations migration, once that table exists.
