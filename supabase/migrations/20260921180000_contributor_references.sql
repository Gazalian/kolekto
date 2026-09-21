-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921180000 — Contributor references
--
-- M7.6 parts H–N. "BIO26-0042" — the code an organiser writes on a receipt,
-- reads out at a door, and searches for when somebody calls to ask whether
-- their money arrived.
--
-- WHAT IT IS ATTACHED TO, AND WHY. Part AA: "if a stable collection
-- participation entity already exists, attach the contributor reference to it
-- rather than creating another duplicate identity table." It does exist. An
-- `obligation` is exactly one member's participation in exactly one
-- collection (and, for a recurring collection, one cycle of it), it is
-- created by an officer, it never disappears (OBL-05 forbids deleting it),
-- and it already carries what that person was asked for. So a reference is a
-- row hanging off an obligation, one to one.
--
-- WHAT THAT MEANS FOR A PUBLIC COLLECTION, SAID PLAINLY. A public collection
-- has no obligations, because nothing about a contributor to one is persisted
-- anywhere in this phase — ADR 0012 rejected a pending-contribution table on
-- purpose and ADR 0006 gates the real one. There is therefore no participation
-- to hang a reference off, and this migration does not invent one. When Phase
-- 4 records a confirmed contribution, that contribution becomes the second
-- thing a reference can attach to: a nullable `contribution_id` beside
-- `obligation_id`, a CHECK that exactly one is set, and the same sequence,
-- the same format, the same uniqueness. Nothing here has to be rewritten for
-- that; the columns are shaped for it.
--
-- WHY FOUR IDENTIFIERS AND NOT ONE (part M). They answer different questions
-- and they change at different times:
--
--   members.member_code               KWASU/0042  who this is, in this community
--   member attribute "matric no"      21/52/1234  who this is, by the community's
--                                                 own rules
--   contributor_references.reference  BIO26-0042  this person's participation in
--                                                 THIS collection
--   collection_tiers.code_prefix      VIP         which package that
--                                                 participation is for
--
-- A member code follows a person across every collection for years. A
-- contributor reference is scoped to one collection and is meaningless
-- outside it. Collapsing them is how a printed ticket ends up identifying the
-- wrong year's dinner.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── Format configuration (part I) ────────────────────────────────────────────
-- `collection_code_settings` already exists (20260917120700) with prefix,
-- style, attribute_basis, per_unit and next_number. What it lacks is the rest
-- of what an organiser configures on screen: the separator, how many digits,
-- and where the numbering starts.
alter table public.collection_code_settings
  add column separator    text     not null default '-',
  add column digits       smallint not null default 4,
  add column start_number bigint   not null default 1;

alter table public.collection_code_settings
  add constraint collection_code_settings_separator_format
    check (separator in ('-', '/', '.', '')),
  add constraint collection_code_settings_digits_range
    check (digits between 1 and 8),
  add constraint collection_code_settings_start_positive
    check (start_number >= 1);

comment on column public.collection_code_settings.separator is
  'What sits between the prefix and the number: BIO26-0001, BIO26/0001, BIO26.0001, or BIO260001. A fixed set rather than free text, because it ends up inside a filename and inside a spoken instruction.';
comment on column public.collection_code_settings.digits is
  'How many digits the number is padded to. 4 gives 0001..9999; the number is NOT truncated when it outgrows the padding, it simply gets longer, because a reference that wrapped would collide.';
comment on column public.collection_code_settings.start_number is
  'The first number this collection issues. An organiser continuing a paper series from last year starts at 250 rather than at 1.';
comment on column public.collection_code_settings.next_number is
  'A SEED, not a live counter. Nothing increments it. The live counters are collection_code_sequences, seeded from greatest(this, start_number) the first time a collection issues a reference — that is how a migrated collection continues the old system''s numbering instead of colliding with codes already printed (CODE-04).';
comment on column public.collection_code_settings.attribute_basis is
  'CODE-03, not implemented in M7.6. No function reads it and no screen sets it. A reference is built from the prefix, the separator and the number; basing one on a member attribute is a later change to app.build_contributor_reference alone.';
comment on column public.collection_code_settings.per_unit is
  'CODE-04, not implemented in M7.6. One reference per participation, always, because a participation is the only thing a reference can attach to until purchases exist (ADR 0006).';


-- ── Which package a member was put down for ─────────────────────────────────
-- Part K wants REG-0001 and VIP-0001 to come out of the same collection, and
-- that is only answerable if the roll records which tier each person is on.
-- It did not. The column is nullable because a collection that is not tiered
-- has no answer, and because every obligation written before today has none.
alter table public.obligations
  add column tier_id uuid references public.collection_tiers (id) on delete restrict;

comment on column public.obligations.tier_id is
  'M7.6: which tier this member was assigned to, on a tiered collection. Null everywhere else. Feeds the tier-scoped reference sequence (part K) and the export''s Tier column.';

create index obligations_tier_idx on public.obligations (tier_id) where tier_id is not null;

-- A tier named on an obligation must be a tier OF that obligation's
-- collection. SEC-18 again: a client-supplied id never implies anything.
create or replace function app.assert_obligation_tenancy()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_collection_community uuid;
  v_member_community     uuid;
  v_tier_collection      uuid;
begin
  select community_id into v_collection_community
  from public.collections where id = new.collection_id;

  select community_id into v_member_community
  from public.members where id = new.member_id;

  if v_collection_community is distinct from new.community_id
     or v_member_community is distinct from new.community_id then
    raise exception
      'TENANCY_MISMATCH: obligation community %, collection community %, member community %',
      new.community_id, v_collection_community, v_member_community
      using errcode = 'P0001';
  end if;

  if new.tier_id is not null then
    select collection_id into v_tier_collection
    from public.collection_tiers where id = new.tier_id;

    if v_tier_collection is distinct from new.collection_id then
      raise exception
        'TENANCY_MISMATCH: tier % belongs to collection %, not to collection %',
        new.tier_id, v_tier_collection, new.collection_id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;


-- ── The counters (parts J, AB) ───────────────────────────────────────────────
--
-- One row per numbering scope. A collection with no tier prefixes has exactly
-- one scope and numbers 0001, 0002, 0003 straight through. A collection whose
-- tiers carry prefixes has one scope per prefixed tier, so REG and VIP each
-- count from the beginning.
--
-- WHY A ROW AND NOT `select count(*) + 1`. Part J says it outright, and it is
-- worth saying why in the schema: count+1 reads a number that two concurrent
-- transactions both see, and issues it twice. It is also wrong after a
-- deletion, handing out a number that is already printed on somebody's
-- ticket. A row can be locked. `update … returning` takes that lock, and the
-- second transaction waits rather than guessing.
--
-- WHY NOT A POSTGRES SEQUENCE. A sequence per scope means DDL at runtime, and
-- sequences deliberately do not roll back — a failed insert would burn a
-- number, which is fine for a surrogate key and not fine for a code somebody
-- reads out loud. This counter is transactional: if the reference is not
-- issued, the number is not spent.
create table public.collection_code_sequences (
  collection_id uuid   not null references public.collections (id)      on delete cascade,
  -- Null means the collection-wide scope. A tier id means that tier's own.
  tier_id       uuid            references public.collection_tiers (id) on delete cascade,
  next_number   bigint not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint collection_code_sequences_next_positive check (next_number >= 1)
);

comment on table public.collection_code_sequences is
  'M7.6: the live counter behind a contributor reference, one row per numbering scope. Locked with UPDATE … RETURNING so two simultaneous requests cannot be handed the same number (part AB).';

create unique index collection_code_sequences_scope
  on public.collection_code_sequences (collection_id, tier_id)
  nulls not distinct;

create trigger collection_code_sequences_set_updated_at
  before update on public.collection_code_sequences
  for each row execute function app.set_updated_at();

alter table public.collection_code_sequences enable row level security;
alter table public.collection_code_sequences force row level security;


-- ── The references themselves ────────────────────────────────────────────────
create table public.contributor_references (
  id              uuid primary key default app.uuid_generate_v7(),
  community_id    uuid not null references public.communities (id) on delete restrict,
  collection_id   uuid not null references public.collections (id)  on delete restrict,

  -- The participation this identifies. Phase 4 adds `contribution_id` beside
  -- it with a CHECK that exactly one is set; today there is one kind of
  -- participation, so this is NOT NULL.
  obligation_id   uuid not null references public.obligations (id) on delete restrict,

  -- Denormalised from the obligation at issue time on purpose: the reference
  -- is immutable, so the scope it was numbered in must be too. Moving a
  -- member to a different tier afterwards must not make VIP-0007 look like it
  -- came out of the REG sequence.
  tier_id         uuid references public.collection_tiers (id) on delete restrict,

  reference       text   not null,
  sequence_number bigint,

  issued_at       timestamptz not null default now(),
  issued_by       uuid references public.users (id) on delete set null,

  constraint contributor_references_format
    check (reference ~ '^[A-Z0-9][A-Z0-9./-]{0,31}$'),
  constraint contributor_references_sequence_positive
    check (sequence_number is null or sequence_number >= 1)
);

comment on table public.contributor_references is
  'M7.6: "BIO26-0042". One per participation, issued by the server, never reissued and never edited. The unique index on (collection_id, reference) is the last line of defence behind the counter — if the counter is ever wrong the insert fails, rather than two people sharing a code.';
comment on column public.contributor_references.sequence_number is
  'The number the counter handed out. Null for a randomly styled reference, which has no position in a series.';

-- The promise, enforced. CODE-04: unique within the collection, never reused.
create unique index contributor_references_unique_in_collection
  on public.contributor_references (collection_id, reference);

-- One per participation. This is also what makes issuing idempotent: a second
-- request inserts nothing and returns what is already there.
create unique index contributor_references_one_per_obligation
  on public.contributor_references (obligation_id);

create index contributor_references_collection_idx
  on public.contributor_references (collection_id, sequence_number);

-- Searching by a code somebody read out at a door. `text_pattern_ops` so a
-- prefix search can use the index whatever the database's collation is.
create index contributor_references_lookup_idx
  on public.contributor_references (community_id, reference text_pattern_ops);

alter table public.contributor_references enable row level security;
alter table public.contributor_references force row level security;


-- ── Issued means issued (part J: stable, immutable after issuance) ──────────
create or replace function app.enforce_reference_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'REFERENCE_NOT_DELETABLE: % has been issued and may already be printed on a ticket or a receipt (CODE-04)',
      old.reference
      using errcode = 'P0001',
            hint = 'A reference is never withdrawn. If the participation itself was a mistake, cancel the obligation — the reference stays attached to the record of it.';
  end if;

  if new.reference is distinct from old.reference
     or new.obligation_id is distinct from old.obligation_id
     or new.collection_id is distinct from old.collection_id
     or new.sequence_number is distinct from old.sequence_number then
    raise exception
      'REFERENCE_IMMUTABLE: % cannot be changed after it is issued (CODE-04)', old.reference
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger contributor_references_immutable
  before update or delete on public.contributor_references
  for each row execute function app.enforce_reference_immutability();


-- ── Who may read them ────────────────────────────────────────────────────────
-- The same door as the roll they belong to: a collector scoped to a
-- collection sees that collection's references and no others (SEC-10).
create policy contributor_references_select_officer
  on public.contributor_references for select to authenticated
  using (app.has_permission_for_collection(collection_id, 'transaction.view'));

-- The counters are operational plumbing rather than a record anyone reads.
-- Officers who can see the collection can see where its numbering has got to,
-- which is what the settings screen shows as "next reference".
create policy collection_code_sequences_select_officer
  on public.collection_code_sequences for select to authenticated
  using (exists (
    select 1 from public.collections c
    where c.id = collection_code_sequences.collection_id
      and app.has_permission(c.community_id, 'community.view_dashboard')
  ));


-- ── Configuring the format is not the same as running the collection ────────
-- Part X: "Configure contributor codes — Owner/Admin." Changing a prefix
-- after references exist is refused outright by the function in the next
-- migration, so this permission governs setting it up, not rewriting history.
insert into public.permissions (key, description) values
  ('collection.configure_codes', 'Set the contributor reference format for a collection')
on conflict (key) do nothing;

insert into public.role_permissions (role, permission) values
  ('owner', 'collection.configure_codes'),
  ('admin', 'collection.configure_codes')
on conflict (role, permission) do nothing;

grant select on public.contributor_references    to authenticated;
grant select on public.collection_code_sequences to authenticated;
