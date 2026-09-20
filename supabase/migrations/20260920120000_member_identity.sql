-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920120000 — Member identity: community member codes and attribute values
--
-- Phase 1 gave every community the ability to DEFINE its own member attributes
-- (member_attribute_definitions: a stable key, a label, a type, options). What
-- it did not give them was a place to put the VALUES that a database could
-- reason about: they went into `members.attributes`, one jsonb object per
-- member.
--
-- That was fine while an attribute was decoration. It stops being fine the
-- moment an attribute is an identity — a matric number, a house number, a
-- membership number. Those get searched, they get used to tell two people
-- apart, and at least one of them per community has to be UNIQUE.
--
-- Uniqueness is what forces this migration. Enforcing "matric number is unique
-- within this community" against a jsonb column means a partial unique index on
-- an expression naming that key, created per community, per field, at runtime —
-- DDL issued by application code, which this repository does not do and should
-- not start doing. As rows, it is one index that has always existed.
--
-- This migration therefore:
--   1. gives every community a member-code sequence it controls (KWASU/0001)
--   2. moves attribute values out of jsonb into member_attribute_values
--   3. lets a definition be marked unique, and one of them primary
--   4. leaves exactly one source of truth: the jsonb column is dropped, after
--      its contents are carried across in the same transaction
--
-- What it deliberately does NOT do: touch obligations, collections or anything
-- financial. This is the member foundation the collection audience will later
-- resolve against.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Community member codes (KWASU/0001) ──────────────────────────────────────
-- One row per community, created lazily the first time a code is issued.
--
-- `next_number` is the sequence. It is a column rather than a Postgres sequence
-- because it is per community, must be settable by an administrator, and must
-- survive being read back — and because incrementing it inside an UPDATE takes
-- a row lock, which is precisely the serialisation a member code needs. Two
-- officers adding a member at the same instant queue behind each other and get
-- 0042 and 0043. Nothing about that calculation happens in a browser.
create table public.community_member_code_settings (
  community_id    uuid primary key references public.communities (id) on delete cascade,

  -- 'KWASU/', 'EST/', 'MEM/'. NULL means codes are numbers alone.
  prefix          text,
  -- 4 gives 0001. Changing it changes how future codes are rendered; codes
  -- already issued are stored on the member and are not re-rendered.
  padding         smallint not null default 4,
  next_number     bigint   not null default 1,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint community_member_code_settings_prefix_format
    check (prefix is null or prefix ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,15}$'),
  constraint community_member_code_settings_padding_sane
    check (padding between 1 and 12),
  constraint community_member_code_settings_next_number_positive
    check (next_number >= 1)
);

comment on table public.community_member_code_settings is
  'The per-community member code sequence (KWASU/0001). next_number is advanced by app.next_member_code() inside an UPDATE, so concurrent member creation cannot issue the same code twice.';
comment on column public.community_member_code_settings.prefix is
  'Community-chosen prefix. Changing it affects codes issued afterwards; codes already on a member are never rewritten.';

create trigger community_member_code_settings_set_updated_at
  before update on public.community_member_code_settings
  for each row execute function app.set_updated_at();

alter table public.community_member_code_settings enable row level security;
alter table public.community_member_code_settings force row level security;


-- ── The code on the member ───────────────────────────────────────────────────
alter table public.members
  add column member_code text;

comment on column public.members.member_code is
  'The community membership ID (KWASU/0021). Issued once by app.next_member_code() and stable thereafter — it appears on receipts and is what a contributor types to find themselves.';

alter table public.members
  add constraint members_member_code_length
  check (member_code is null or char_length(member_code) between 1 and 32);

-- Unique within the community, never globally: two communities may each run a
-- MEM/0001, and they are different people.
create unique index members_community_member_code_key
  on public.members (community_id, member_code)
  where member_code is not null;

-- A contributor searching for themselves types the code. This is that lookup.
create index members_member_code_search_idx
  on public.members (community_id, lower(member_code))
  where member_code is not null;


-- ── Definitions gain identity semantics ──────────────────────────────────────
alter table public.member_attribute_definitions
  add column is_unique boolean not null default false,
  add column is_primary_identifier boolean not null default false;

comment on column public.member_attribute_definitions.is_unique is
  'Two members in this community cannot share a value for this field. Enforced by member_attribute_values_unique_value, not by application code.';
comment on column public.member_attribute_definitions.is_primary_identifier is
  'The field this community identifies people by — matric number for a school, house number for an estate. Drives search, duplicate detection and contributor self-identification. At most one per community.';

-- A primary identifier that could repeat would not identify anything.
alter table public.member_attribute_definitions
  add constraint member_attribute_definitions_primary_is_unique
  check (not is_primary_identifier or is_unique);

create unique index member_attribute_definitions_one_primary
  on public.member_attribute_definitions (community_id)
  where is_primary_identifier;


-- ── Attribute values, as rows ────────────────────────────────────────────────
create table public.member_attribute_values (
  member_id     uuid not null references public.members (id) on delete cascade,
  definition_id uuid not null references public.member_attribute_definitions (id) on delete cascade,

  -- Denormalised tenancy, like every other table here: RLS re-derives community
  -- from the row rather than joining two tables on every policy evaluation
  -- (SEC-18, and NFR-08's one-second member list at 5,000 members).
  community_id  uuid not null references public.communities (id) on delete cascade,

  -- The value as the person typed it. Display uses this.
  value_text    text not null,
  -- The value as the database compares it: trimmed and case-folded. Uniqueness
  -- and search use this, so "20/53A/021" and "20/53a/021 " are the same matric
  -- number — which is what an officer means, and what a contributor typing on a
  -- phone keyboard needs.
  value_norm    text not null,

  -- Copied from the definition by a trigger below, never written by a caller.
  -- A partial unique index needs its predicate in this table; a subquery into
  -- member_attribute_definitions is not something an index can do. The trigger
  -- is what keeps this true rather than merely asserted.
  is_unique     boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (member_id, definition_id),

  constraint member_attribute_values_text_length check (char_length(value_text) between 1 and 200),
  constraint member_attribute_values_norm_length check (char_length(value_norm) between 1 and 200)
);

comment on table public.member_attribute_values is
  'One community-defined attribute of one member. Rows rather than jsonb, because a matric number has to be unique and searchable, and neither is something an index can do to a jsonb key without runtime DDL.';

-- The index this table exists for.
create unique index member_attribute_values_unique_value
  on public.member_attribute_values (definition_id, value_norm)
  where is_unique;

-- "Find the member whose matric number is this", and the partial-match version
-- a search box needs.
create index member_attribute_values_lookup_idx
  on public.member_attribute_values (community_id, definition_id, value_norm);
create index member_attribute_values_search_idx
  on public.member_attribute_values using gin (value_norm extensions.gin_trgm_ops);
create index member_attribute_values_definition_idx
  on public.member_attribute_values (definition_id);

create trigger member_attribute_values_set_updated_at
  before update on public.member_attribute_values
  for each row execute function app.set_updated_at();

alter table public.member_attribute_values enable row level security;
alter table public.member_attribute_values force row level security;


-- ── Tenancy and the is_unique mirror ─────────────────────────────────────────
-- Three things must agree: the value's community, its member's community, and
-- its definition's community. A client-supplied id never implies tenancy
-- (SEC-18), so the database checks rather than trusting the call site.
create or replace function app.assert_member_attribute_value_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_member_community     uuid;
  v_definition_community uuid;
  v_definition_unique    boolean;
begin
  select community_id into v_member_community
  from public.members where id = new.member_id;

  select community_id, is_unique into v_definition_community, v_definition_unique
  from public.member_attribute_definitions where id = new.definition_id;

  if v_member_community is distinct from new.community_id
     or v_definition_community is distinct from new.community_id then
    raise exception
      'TENANCY_MISMATCH: attribute value community %, member community %, definition community %',
      new.community_id, v_member_community, v_definition_community
      using errcode = 'P0001';
  end if;

  -- Whatever the caller passed for is_unique is discarded. The definition
  -- decides, so a write cannot opt a value out of the unique index.
  new.is_unique := coalesce(v_definition_unique, false);
  new.value_norm := lower(trim(new.value_text));

  return new;
end;
$$;

create trigger member_attribute_values_assert_consistent
  before insert or update on public.member_attribute_values
  for each row execute function app.assert_member_attribute_value_consistent();

-- Marking a definition unique has to reach the rows already stored against it,
-- or the index would only govern values written afterwards. Doing it here means
-- an administrator turning uniqueness on for a field that already has duplicates
-- gets a unique-violation at that moment — which is the correct answer, and a
-- far better one than silently permitting the duplicates to persist.
create or replace function app.propagate_definition_uniqueness()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_unique is distinct from old.is_unique then
    update public.member_attribute_values
    set is_unique = new.is_unique
    where definition_id = new.id;
  end if;

  return new;
end;
$$;

create trigger member_attribute_definitions_propagate_uniqueness
  after update on public.member_attribute_definitions
  for each row execute function app.propagate_definition_uniqueness();

comment on function app.propagate_definition_uniqueness() is
  'Turning on is_unique re-stamps existing values so the partial unique index covers them. If the field already holds duplicates, this fails loudly at the moment of the decision rather than leaving them unpoliced.';


-- ── members.identifier becomes a definition, like every other field ──────────
-- Phase 1 gave every member one `identifier` column: "the community-defined
-- identifier — matric number, member ID, unit code" (MEM-01), unique per
-- community (MEM-10). That is the same concept this migration has just made
-- configurable, which means keeping both would leave a matric number with two
-- places to live and no rule about which one wins.
--
-- So the column becomes a definition marked as that community's primary
-- identifier, its values become rows, and the column goes. The label comes from
-- community_labels where the community set one (COM-05 already lets a community
-- call it "Matric number"), and the uniqueness MEM-10 guaranteed is now carried
-- by member_attribute_values_unique_value.
insert into public.member_attribute_definitions
  (community_id, key, label, type, required_at_join, is_unique, is_primary_identifier, sort_order)
select c.id,
       'member_identifier',
       coalesce(l.label, 'Member ID'),
       'text',
       false,
       true,
       true,
       0
from public.communities c
left join public.community_labels l
  on l.community_id = c.id and l.key = 'member_identifier'
where exists (
        select 1 from public.members m
        where m.community_id = c.id and m.identifier is not null
      )
  -- Never overwrite a primary identifier a community already chose, and never
  -- collide with a key it already uses.
  and not exists (
        select 1 from public.member_attribute_definitions d
        where d.community_id = c.id
          and (d.is_primary_identifier or d.key = 'member_identifier')
      );

insert into public.member_attribute_values (member_id, definition_id, community_id, value_text, value_norm)
select m.id, d.id, m.community_id, trim(m.identifier), lower(trim(m.identifier))
from public.members m
join public.member_attribute_definitions d
  on d.community_id = m.community_id and d.key = 'member_identifier'
where nullif(trim(coalesce(m.identifier, '')), '') is not null
on conflict (member_id, definition_id) do nothing;

alter table public.members drop column identifier;


-- ── Carry the jsonb values across, then remove the jsonb ─────────────────────
-- Both halves run in this migration's transaction: there is never a moment
-- where the values exist in neither place, and never a moment afterwards where
-- they exist in both.

-- A key with no matching definition has nowhere to go. Rather than dropping it
-- quietly — which is exactly how the previous estate lost attribution — stop
-- and name it. Whoever hits this decides whether to define the field first or
-- to discard the data on purpose.
do $$
declare
  v_orphans text;
begin
  select string_agg(distinct format('%s (community %s)', v.key, m.community_id), ', ')
    into v_orphans
  from public.members m
  cross join lateral jsonb_each_text(m.attributes) as v(key, value)
  left join public.member_attribute_definitions d
    on d.community_id = m.community_id and d.key = v.key
  where d.id is null
    and nullif(trim(v.value), '') is not null;

  if v_orphans is not null then
    raise exception
      'UNDEFINED_MEMBER_ATTRIBUTES: these attribute keys hold values but have no member_attribute_definitions row: %',
      v_orphans
      using errcode = 'P0001',
            hint = 'Define the field for that community before migrating, or clear the values deliberately. This migration will not discard member data.';
  end if;
end;
$$;

insert into public.member_attribute_values (member_id, definition_id, community_id, value_text, value_norm)
select m.id, d.id, m.community_id, trim(v.value), lower(trim(v.value))
from public.members m
cross join lateral jsonb_each_text(m.attributes) as v(key, value)
join public.member_attribute_definitions d
  on d.community_id = m.community_id and d.key = v.key
where nullif(trim(v.value), '') is not null;

alter table public.members drop column attributes;


-- ── Every existing member gets a code ────────────────────────────────────────
-- Issued in creation order, so the oldest member of a community holds the
-- lowest number — the ordering a person would expect if they ever look.
insert into public.community_member_code_settings (community_id)
select id from public.communities
on conflict (community_id) do nothing;

with numbered as (
  select id,
         community_id,
         row_number() over (partition by community_id order by created_at, id) as n
  from public.members
)
update public.members m
set member_code = lpad(numbered.n::text, 4, '0')
from numbered
where m.id = numbered.id;

update public.community_member_code_settings s
set next_number = coalesce(
  (select count(*) + 1 from public.members m where m.community_id = s.community_id),
  1
);


-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same three rules as 20260917121000: anon gets nothing, authenticated gets
-- SELECT only, tenancy is re-derived rather than trusted. Writes go through the
-- functions in the companion migration, which re-check app.has_permission.

create policy community_member_code_settings_select_officer
  on public.community_member_code_settings for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

-- An attribute value is as sensitive as the member it describes — a matric
-- number or a house number identifies a person — so it follows the member roll's
-- own permission rather than the weaker dashboard one.
create policy member_attribute_values_select_officer
  on public.member_attribute_values for select to authenticated
  using (app.has_permission(community_id, 'member.view_contact'));

-- SEC-11: a member who has claimed their record reads their own attributes and
-- nobody else's.
create policy member_attribute_values_select_own_member
  on public.member_attribute_values for select to authenticated
  using (exists (
    select 1 from public.members m
    where m.id = member_attribute_values.member_id
      and m.user_id = (select auth.uid())
  ));

grant select on table public.community_member_code_settings to authenticated;
grant select on table public.member_attribute_values          to authenticated;

-- Postgres grants EXECUTE to PUBLIC on every new function, and PUBLIC is
-- inherited by anon and authenticated. 20260917121100's retroactive revoke
-- could only reach the functions that existed when it ran, which is why every
-- migration since issues its own — and why 02_grant_matrix.sql asserts the
-- anonymous surface exactly. These two are trigger functions: a trigger fires
-- them regardless of any grant, so nobody needs EXECUTE on them at all.
revoke all on function app.assert_member_attribute_value_consistent() from public;
revoke all on function app.propagate_definition_uniqueness()          from public;
