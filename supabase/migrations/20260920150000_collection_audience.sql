-- ─────────────────────────────────────────────────────────────────────────────
-- 20260920150000 — Collection audience
--
-- "Who is this collection for?" as a stored decision rather than an implication
-- (§12, §24, §37).
--
-- Phase 1 gave a collection `participation_mode`: open (anyone with the link) or
-- managed (a defined list of members). That answers half the question. The other
-- half — WHICH members — was answered by whoever clicked names in a dialog, and
-- was therefore not answered anywhere a later reader could find it.
--
-- Four modes, and the pairing with participation_mode is enforced rather than
-- assumed, because two columns that can disagree about the same fact eventually
-- will:
--
--   public            anyone with the link          (participation_mode = open)
--   all_members       every active member           (managed)
--   groups            members of the chosen groups  (managed)
--   selected_members  named individuals             (managed)
--
-- THE RULE THAT MATTERS MOST (§38, and the operator's own instruction):
-- audience is configuration; an obligation is a record. Eligibility is resolved
-- from membership and groups, live. Obligations are materialised from it
-- deliberately, by someone pressing a button, and are NEVER created because
-- somebody joined a group afterwards — that would be the system inventing a
-- debt. Equally, an obligation is never deleted because the audience changed:
-- what a member was asked for is history, not a view.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.collection_audience_mode as enum (
  'all_members',
  'groups',
  'selected_members',
  'public'
);

alter table public.collections
  add column audience_mode public.collection_audience_mode;

-- Existing collections already carry the answer in participation_mode; this is
-- the same fact, said precisely.
-- Cast explicitly: a CASE over text literals is text, and Postgres will not
-- coerce text into a newly created enum on its own.
update public.collections
set audience_mode = (case when participation_mode = 'open' then 'public' else 'all_members' end)::public.collection_audience_mode;

alter table public.collections
  alter column audience_mode set not null;

-- Derived rather than defaulted, because a column default cannot see the row it
-- belongs to: a default of 'all_members' would make every directly-inserted
-- OPEN collection violate the pairing constraint below, and every caller would
-- have to remember to say the same thing twice.
--
-- A BEFORE trigger fires ahead of the NOT NULL check, so omitting the column is
-- allowed and means "whatever participation_mode implies". Supplying it
-- explicitly still wins, which is what app.set_collection_audience does.
create or replace function app.derive_collection_audience_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.audience_mode is null then
    new.audience_mode := case
      when new.participation_mode = 'open' then 'public'
      else 'all_members'
    end;
  end if;

  return new;
end;
$$;

create trigger collections_derive_audience_mode
  before insert or update on public.collections
  for each row execute function app.derive_collection_audience_mode();

revoke all on function app.derive_collection_audience_mode() from public;

comment on column public.collections.audience_mode is
  'Who the collection is for. Paired with participation_mode by collections_audience_matches_participation: public is the open mode, the other three are managed.';

-- The pairing. Without it, a collection could be "open" and "for 300 Level" at
-- the same time, and nothing would say which one the obligations followed.
alter table public.collections
  add constraint collections_audience_matches_participation
  check ((audience_mode = 'public') = (participation_mode = 'open'));


-- ── The groups a collection is for ───────────────────────────────────────────
-- Rows referencing groups, not copies of their members (§38). A member joining
-- "300 Level" tomorrow changes who is eligible; it does not change this table,
-- and it does not create an obligation on its own.
create table public.collection_audience_groups (
  collection_id uuid not null references public.collections (id)   on delete cascade,
  group_id      uuid not null references public.member_groups (id) on delete restrict,
  community_id  uuid not null references public.communities (id)   on delete cascade,
  added_by      uuid references public.users (id) on delete set null,
  added_at      timestamptz not null default now(),

  primary key (collection_id, group_id)
);

comment on table public.collection_audience_groups is
  'Which groups a collection is for. The group is referenced, never copied: eligibility is resolved from live membership, and this table records the decision rather than its result. ON DELETE RESTRICT on the group, because a group named in an audience is part of how that audience is read.';

create index collection_audience_groups_group_idx on public.collection_audience_groups (group_id);

alter table public.collection_audience_groups enable row level security;
alter table public.collection_audience_groups force row level security;

create policy collection_audience_groups_select_officer
  on public.collection_audience_groups for select to authenticated
  using (app.has_permission(community_id, 'community.view_dashboard'));

grant select on table public.collection_audience_groups to authenticated;

-- Tenancy, checked rather than trusted (SEC-18): the collection, the group and
-- the row must all belong to the same community.
create or replace function app.assert_audience_group_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_collection_community uuid;
  v_group_community      uuid;
begin
  select community_id into v_collection_community from public.collections   where id = new.collection_id;
  select community_id into v_group_community      from public.member_groups where id = new.group_id;

  if v_collection_community is distinct from new.community_id
     or v_group_community is distinct from new.community_id then
    raise exception
      'TENANCY_MISMATCH: audience row community %, collection community %, group community %',
      new.community_id, v_collection_community, v_group_community
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger collection_audience_groups_assert_tenancy
  before insert or update on public.collection_audience_groups
  for each row execute function app.assert_audience_group_tenancy();

revoke all on function app.assert_audience_group_tenancy() from public;


-- ── Setting the audience ─────────────────────────────────────────────────────
create or replace function app.set_collection_audience(
  p_collection_id uuid,
  p_audience_mode public.collection_audience_mode,
  p_group_ids     uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_mode       public.participation_mode;
  v_group_id   uuid;
  v_kept       integer := 0;
begin
  select * into v_collection from public.collections where id = p_collection_id;
  if v_collection.id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_collection.community_id, 'collection.draft');

  if v_collection.status in ('closed', 'archived', 'suspended') then
    raise exception 'COLLECTION_NOT_EDITABLE: a % collection cannot change who it is for', v_collection.status
      using errcode = 'P0001';
  end if;

  -- Changing between open and managed changes what the collection IS, not just
  -- who it is for, and the amount lock in app.update_collection already refuses
  -- that after publication. Keep the two rules consistent.
  v_mode := case when p_audience_mode = 'public' then 'open' else 'managed' end;

  if v_collection.status <> 'draft' and v_mode <> v_collection.participation_mode then
    raise exception 'AUDIENCE_LOCKED: a published collection cannot switch between open and managed'
      using errcode = 'P0001',
            hint = 'Close this collection and create another one if it needs to work differently.';
  end if;

  if p_audience_mode = 'groups' and coalesce(array_length(p_group_ids, 1), 0) = 0 then
    raise exception 'NO_GROUPS: choose at least one group, or make the collection for all members'
      using errcode = 'P0001';
  end if;

  if v_collection.amount_model = 'per_member' and p_audience_mode = 'public' then
    raise exception 'INVALID_CONFIGURATION: a per-member amount needs a member list, so it cannot be public'
      using errcode = 'P0001';
  end if;

  update public.collections
  set audience_mode      = p_audience_mode,
      participation_mode = v_mode
  where id = p_collection_id;

  delete from public.collection_audience_groups where collection_id = p_collection_id;

  if p_audience_mode = 'groups' then
    foreach v_group_id in array coalesce(p_group_ids, '{}')
    loop
      -- A group id from another community matches nothing rather than erroring;
      -- an archived one is refused, because an audience nobody can join is a
      -- collection nobody can pay.
      insert into public.collection_audience_groups (collection_id, group_id, community_id, added_by)
      select p_collection_id, g.id, v_collection.community_id, auth.uid()
      from public.member_groups g
      where g.id = v_group_id
        and g.community_id = v_collection.community_id
        and g.archived_at is null
      on conflict do nothing;

      if found then v_kept := v_kept + 1; end if;
    end loop;

    if v_kept = 0 then
      raise exception 'NO_GROUPS: none of those groups belong to this community' using errcode = 'P0001';
    end if;
  end if;

  perform app.write_audit_log(
    v_collection.community_id, 'officer', auth.uid(), 'collection.set_audience', 'collection', p_collection_id,
    jsonb_build_object('audience_mode', v_collection.audience_mode),
    jsonb_build_object('audience_mode', p_audience_mode, 'groups', v_kept)
  );
end;
$$;

comment on function app.set_collection_audience is
  'collection.draft. Records who a collection is for. Groups are referenced, never expanded into a member list — eligibility is resolved live, and obligations are materialised separately and deliberately.';


-- ── Resolving eligibility ────────────────────────────────────────────────────
-- The live answer to "who is this collection for, right now".
--
-- Not granted to any client role: it returns the member list of a community,
-- and the screens that need it already read `members` under RLS. It exists so
-- the sync below and the count beside it agree by construction rather than by
-- two queries that were written to match.
create or replace function app.resolve_collection_audience(p_collection_id uuid)
returns table (member_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.collections c
  join public.members m
    on m.community_id = c.community_id
   -- An archived or merged member is not expected to pay anything new. Their
   -- existing obligations are untouched; this is about who is eligible now.
   and m.status in ('active', 'unclaimed', 'invited')
  where c.id = p_collection_id
    and c.audience_mode <> 'public'
    and (
      c.audience_mode = 'all_members'
      or (
        c.audience_mode = 'groups'
        and exists (
          select 1
          from public.collection_audience_groups cag
          join public.member_group_memberships mgm
            on mgm.group_id = cag.group_id
           and mgm.member_id = m.id
          where cag.collection_id = c.id
        )
      )
      -- selected_members is the audience whose membership IS its obligations:
      -- there is no separate list, because naming someone and asking them to
      -- pay are the same act. Resolving it returns who already has one.
      or (
        c.audience_mode = 'selected_members'
        and exists (
          select 1 from public.obligations o
          where o.collection_id = c.id and o.member_id = m.id
        )
      )
    );
$$;

comment on function app.resolve_collection_audience(uuid) is
  '§38: eligibility resolved from community membership, group membership and the collection audience — never from a copied list. Returns nobody for a public collection, which has no member list by definition.';


-- ── The count that drives the prompt ────────────────────────────────────────
-- "3 new members are eligible — Review & Add Obligations" (§38). A number, not
-- an action: nothing here writes.
create or replace function app.count_collection_audience(p_collection_id uuid)
returns table (eligible integer, with_obligation integer, awaiting integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_community_id uuid;
begin
  select community_id into v_community_id from public.collections where id = p_collection_id;
  if v_community_id is null then
    raise exception 'NOT_FOUND: collection % does not exist', p_collection_id using errcode = 'P0002';
  end if;

  perform app.require_permission(v_community_id, 'community.view_dashboard');

  return query
  with audience as (select member_id from app.resolve_collection_audience(p_collection_id)),
       assigned as (
         select o.member_id from public.obligations o
         where o.collection_id = p_collection_id and o.status <> 'cancelled'
       )
  select
    (select count(*)::integer from audience),
    (select count(*)::integer from assigned),
    (select count(*)::integer from audience a where not exists (select 1 from assigned s where s.member_id = a.member_id));
end;
$$;

comment on function app.count_collection_audience(uuid) is
  'How many members the audience covers, how many already have an obligation, and how many do not — the third is what the "newly eligible" prompt counts. Reads only.';


-- ── Materialising obligations ────────────────────────────────────────────────
-- Idempotent by construction: it inserts for eligible members who have no
-- obligation, and the unique index (collection_id, member_id, cycle_key) is what
-- decides, not a prior read. Running it twice creates nothing the second time.
--
-- It NEVER deletes. A member who left the group keeps the obligation they were
-- given, because it records what they were asked for. And it never runs by
-- itself: no trigger calls it, so joining a group cannot create a debt.
create or replace function app.sync_collection_obligations(
  p_collection_id        uuid,
  p_expected_amount_kobo bigint default null,
  p_due_at               timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_collection public.collections%rowtype;
  v_expected   bigint;
  v_due_at     timestamptz;
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

  v_due_at := coalesce(p_due_at, v_collection.deadline_at);

  for v_member_id in
    select a.member_id
    from app.resolve_collection_audience(p_collection_id) a
    where not exists (
      select 1 from public.obligations o
      where o.collection_id = p_collection_id and o.member_id = a.member_id
    )
  loop
    v_obligation_id := app.uuid_generate_v7();

    insert into public.obligations (
      id, community_id, collection_id, member_id, expected_amount_kobo, due_at, assigned_by
    ) values (
      v_obligation_id, v_collection.community_id, p_collection_id, v_member_id, v_expected, v_due_at, auth.uid()
    )
    on conflict (collection_id, member_id, cycle_key) do nothing;

    if found then
      v_created := v_created + 1;
      perform app.write_audit_log(
        v_collection.community_id, 'officer', auth.uid(), 'obligation.assign', 'obligation', v_obligation_id,
        null, jsonb_build_object('member_id', v_member_id, 'expected_amount_kobo', v_expected, 'via', 'audience_sync')
      );
    end if;
  end loop;

  return v_created;
end;
$$;

comment on function app.sync_collection_obligations is
  'obligation.assign. Materialises obligations for eligible members who have none, idempotently. Never deletes one, and is never called by a trigger — a member joining a group must not silently acquire a debt (§38).';

revoke all on function app.resolve_collection_audience(uuid) from public;
