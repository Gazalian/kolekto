-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120500 — Members, attributes, groups and contacts
--
-- A member record belongs to the community. It is NOT a user account
-- (PRD 0.3, 3.3). A member needs no password, may never log in, and proves
-- themselves with an OTP to their phone when they need to see their own record.
--
-- This table does not exist in the previous system at all. It is the second of
-- the three pillars the PRD adds — Community, Member/Obligation, Handover.
-- ─────────────────────────────────────────────────────────────────────────────

create table public.members (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete cascade,

  full_name           text not null,
  phone_e164          text,
  email               extensions.citext,

  -- MEM-01: the community-defined identifier — matric number, member ID, unit
  -- code. The community chooses its label, format hint and whether it is
  -- required; those settings live on the community's attribute definitions.
  identifier          text,

  -- MEM-02: up to ten custom attributes, validated against
  -- member_attribute_definitions by the server, not by a database constraint —
  -- a jsonb schema check would have to be rewritten on every definition change.
  attributes          jsonb not null default '{}'::jsonb,

  status              public.member_status    not null default 'unclaimed',
  joined_via          public.member_joined_via not null default 'manual',

  -- PRD 14.3: a member record may represent a non-person entity — an estate
  -- unit, with residents as contacts on it. The unit is the billable record and
  -- its arrears survive a change of occupant (EST-07).
  is_entity           boolean not null default false,

  -- Set when the person claims this record (MEM-08) and verifies their phone.
  -- A claimed member with a login sees their own history; a member without one
  -- uses OTP (CON-22).
  user_id             uuid references public.users (id) on delete set null,
  claimed_at          timestamptz,

  -- MEM-07 / NOT-01a: consent to receive community messages. Without it, no
  -- announcement or reminder may be sent — only receipts, codes and security
  -- messages, which are not optional (NOT-10).
  consent_messages_at timestamptz,

  -- MEM-17: a merge points the loser at the survivor. Reversible for 30 days,
  -- and never automatic (CON-27).
  merged_into_id      uuid references public.members (id) on delete restrict,
  merged_at           timestamptz,

  invite_link_id      uuid,   -- FK added in the invites migration
  created_by          uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,

  constraint members_full_name_length
    check (char_length(full_name) between 1 and 120),
  constraint members_phone_is_e164
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,15}$'),
  constraint members_identifier_length
    check (identifier is null or char_length(identifier) between 1 and 60),
  constraint members_attributes_is_object
    check (jsonb_typeof(attributes) = 'object'),
  constraint members_merged_consistently
    check ((status = 'merged') = (merged_into_id is not null)
           and (merged_into_id is null) = (merged_at is null)),
  constraint members_not_merged_into_self
    check (merged_into_id is null or merged_into_id <> id),
  constraint members_archived_has_timestamp
    check ((status = 'archived') = (archived_at is not null)),
  constraint members_claimed_consistently
    check ((user_id is null) = (claimed_at is null)),

  -- An active member has confirmed their details and verified their phone
  -- (PRD 3.3), so they must have a number to have verified.
  constraint members_active_has_phone
    check (status <> 'active' or phone_e164 is not null)
);

comment on table public.members is
  'A person (or an estate unit) on a community roll. Not a user account: no password, may never log in (PRD 0.3, SEC-06).';
comment on column public.members.identifier is
  'MEM-01: the community-defined member identifier. Unique within the community (MEM-10).';
comment on column public.members.is_entity is
  'PRD 14.3: the record represents a unit rather than a person. Residents attach as member_contacts.';

-- MEM-10: duplicate identifiers inside one community are blocked. Partial, so
-- a community that does not use identifiers is unaffected.
create unique index members_community_identifier_key
  on public.members (community_id, identifier)
  where identifier is not null;

-- Not unique: a household may legitimately share a phone number, and MEM-08
-- resolves the ambiguity by asking the person rather than by rejecting the row.
-- Indexed because member lookup by phone is on the contributor payment path
-- (OBL-10) and must answer in under a second at 5,000 members (NFR-08).
create index members_community_phone_idx on public.members (community_id, phone_e164)
  where phone_e164 is not null;
create index members_community_status_idx on public.members (community_id, status);
create index members_user_idx             on public.members (user_id) where user_id is not null;
create index members_name_trgm_idx        on public.members using gin (full_name extensions.gin_trgm_ops);
create index members_attributes_idx       on public.members using gin (attributes);

create trigger members_set_updated_at
  before update on public.members
  for each row execute function app.set_updated_at();

alter table public.members enable row level security;
alter table public.members force row level security;


-- ── MEM-13: members with financial history are never hard-deleted ────────────
-- The guard is written now, while there is nothing to protect, so it cannot be
-- forgotten when obligations and contributions arrive. It mirrors the previous
-- system's `enforce_collection_delete_guard`, which was one of the genuinely
-- good things it did.
create or replace function app.enforce_member_delete_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_has_obligations boolean;
begin
  select exists (select 1 from public.obligations where member_id = old.id)
    into v_has_obligations;

  if v_has_obligations then
    raise exception
      'MEMBER_HAS_FINANCIAL_HISTORY: member % cannot be deleted (MEM-13). Archive instead.',
      old.id
      using errcode = 'P0001',
            hint = 'Set status to archived. History is kept and the member is not assigned new obligations.';
  end if;

  return old;
end;
$$;
-- The trigger itself is created in the obligations migration, once the table it
-- reads exists.


-- ── MEM-02: custom member attributes ─────────────────────────────────────────
create table public.member_attribute_definitions (
  id               uuid primary key default app.uuid_generate_v7(),
  community_id     uuid not null references public.communities (id) on delete cascade,
  key              text not null,
  label            text not null,
  type             public.member_attribute_type not null,
  options          text[],
  required_at_join boolean not null default false,
  sort_order       smallint not null default 0,
  created_at       timestamptz not null default now(),

  constraint member_attribute_definitions_key_format
    check (key ~ '^[a-z][a-z0-9_]{0,38}$'),
  constraint member_attribute_definitions_label_length
    check (char_length(label) between 1 and 40),
  constraint member_attribute_definitions_options_for_select
    check ((type = 'single_select') = (options is not null and array_length(options, 1) > 0))
);

create unique index member_attribute_definitions_key
  on public.member_attribute_definitions (community_id, key);

alter table public.member_attribute_definitions enable row level security;
alter table public.member_attribute_definitions force row level security;

-- MEM-02: at most ten per community. A trigger rather than a constraint,
-- because the limit is across rows.
create or replace function app.assert_attribute_definition_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.member_attribute_definitions
  where community_id = new.community_id;

  if v_count > 10 then
    raise exception
      'TOO_MANY_MEMBER_ATTRIBUTES: a community may define at most 10 custom member attributes (MEM-02)'
      using errcode = 'P0001';
  end if;

  return null;
end;
$$;

create constraint trigger member_attribute_definitions_limit
  after insert on public.member_attribute_definitions
  deferrable initially deferred
  for each row execute function app.assert_attribute_definition_limit();


-- ── MEM-03: groups ───────────────────────────────────────────────────────────
-- Used to target announcements, assign dues and scope collectors. A member may
-- belong to several.
create table public.member_groups (
  id                  uuid primary key default app.uuid_generate_v7(),
  community_id        uuid not null references public.communities (id) on delete cascade,
  name                text not null,
  description         text,
  -- MEM-04: may a joiner pick this group on the invite form?
  pickable_at_join    boolean not null default false,
  sort_order          smallint not null default 0,
  created_by          uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint member_groups_name_length check (char_length(name) between 1 and 60)
);

create unique index member_groups_community_name_key
  on public.member_groups (community_id, lower(name));

create trigger member_groups_set_updated_at
  before update on public.member_groups
  for each row execute function app.set_updated_at();

alter table public.member_groups enable row level security;
alter table public.member_groups force row level security;

create table public.member_group_memberships (
  member_id   uuid not null references public.members (id)       on delete cascade,
  group_id    uuid not null references public.member_groups (id) on delete cascade,
  added_at    timestamptz not null default now(),
  added_by    uuid references public.users (id) on delete set null,
  primary key (member_id, group_id)
);

create index member_group_memberships_group_idx on public.member_group_memberships (group_id);

alter table public.member_group_memberships enable row level security;
alter table public.member_group_memberships force row level security;


-- ── EST-02: several contacts on one member ───────────────────────────────────
-- An estate unit has an owner, a tenant and an occupant. Officers choose who
-- receives bills and reminders. Contacts change without changing the unit's
-- history, which is the whole point.
create table public.member_contacts (
  id               uuid primary key default app.uuid_generate_v7(),
  member_id        uuid not null references public.members (id) on delete cascade,
  community_id     uuid not null references public.communities (id) on delete cascade,
  name             text not null,
  phone_e164       text,
  email            extensions.citext,
  relation         text,
  receives_notices boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint member_contacts_name_length check (char_length(name) between 1 and 120),
  constraint member_contacts_phone_is_e164
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,15}$'),
  constraint member_contacts_reachable
    check (phone_e164 is not null or email is not null)
);

create index member_contacts_member_idx on public.member_contacts (member_id);

create trigger member_contacts_set_updated_at
  before update on public.member_contacts
  for each row execute function app.set_updated_at();

alter table public.member_contacts enable row level security;
alter table public.member_contacts force row level security;
