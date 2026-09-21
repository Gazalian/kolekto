-- ─────────────────────────────────────────────────────────────────────────────
-- 20260921170000 — Checking people in at the door
--
-- M7.5 part E. What this can honestly be built on, and what it cannot:
--
-- A ticket does not exist as a row anywhere. Nothing records a purchase —
-- ADR 0012 rejected a pending-contribution table on purpose and ADR 0006
-- gates the real one, so "the people who bought VIP tickets" has no rows
-- behind it and inventing some would be inventing financial state, which
-- §46 of this milestone forbids outright.
--
-- What DOES exist is the collection's own roll: `obligations`, one row per
-- member the collection asks, created by an officer. For a managed event —
-- an estate's dinner, an association's gala, a church's harvest — that roll
-- IS the guest list, and checking it at the door is a real operation on real
-- data with no money in it anywhere.
--
-- So check-in attaches to an obligation. A public ticket sale has no
-- obligations and therefore has nobody to check in yet; the UI says that
-- plainly rather than showing an empty list. When Phase 4 records purchases,
-- a purchased ticket becomes the second thing that can be checked in, and it
-- attaches here the same way: one row per thing admitted, with the same
-- server operation, the same permission, and the same audit trail.
--
-- WHY A TABLE RATHER THAN COLUMNS ON `obligations`:
--   · a person may be admitted and leave and be admitted again; that is a
--     history, not a flag
--   · the row records WHO admitted them, which an obligation has no place for
--   · obligations are money-shaped rows, and an operational fact does not
--     belong in the same row as an expected amount
-- ─────────────────────────────────────────────────────────────────────────────

create table public.event_check_ins (
  id             uuid primary key default app.uuid_generate_v7(),
  community_id   uuid not null references public.communities (id) on delete restrict,
  collection_id  uuid not null references public.collections (id)  on delete restrict,

  -- What was admitted. Today always an obligation; Phase 4's purchased
  -- ticket becomes a sibling column with a CHECK that exactly one is set.
  obligation_id  uuid not null references public.obligations (id) on delete restrict,

  checked_in_at  timestamptz not null default now(),
  checked_in_by  uuid references public.users (id) on delete set null,
  -- Null while they are still inside. Set when they leave, so the pair reads
  -- as one visit rather than two unrelated events.
  checked_out_at timestamptz,
  checked_out_by uuid references public.users (id) on delete set null,

  created_at     timestamptz not null default now(),

  constraint event_check_ins_out_after_in
    check (checked_out_at is null or checked_out_at >= checked_in_at)
);

comment on table public.event_check_ins is
  'M7.5: who has been admitted to a collection''s event, and when. Attaches to an obligation — the roll an officer created — because no purchase is recorded anywhere in this phase (ADR 0006/0012). Carries no money.';

-- One open visit per person: admitting somebody who is already inside is the
-- duplicate this prevents, while a second visit after checkout is allowed.
create unique index event_check_ins_one_open_visit
  on public.event_check_ins (obligation_id)
  where checked_out_at is null;

create index event_check_ins_collection_idx on public.event_check_ins (collection_id, checked_in_at desc);

alter table public.event_check_ins enable row level security;
alter table public.event_check_ins force row level security;

-- ── The permission door staff hold ─────────────────────────────────────────
--
-- §34: the organiser is rarely the person on the door. `collector` is this
-- schema's existing field-agent role — the person who collects in person —
-- and it is the smallest correct home for admitting people at an entrance.
-- Owner, admin and treasurer hold it too, because they can already do
-- everything a collection allows. A viewer does not, and neither does a
-- member.
insert into public.permissions (key, description) values
  ('attendance.check_in', 'Check people in and out at a collection''s event')
on conflict (key) do nothing;

insert into public.role_permissions (role, permission) values
  ('owner',     'attendance.check_in'),
  ('admin',     'attendance.check_in'),
  ('treasurer', 'attendance.check_in'),
  ('collector', 'attendance.check_in')
on conflict (role, permission) do nothing;

-- An operational record is readable by whoever may work the door, and
-- written only through the functions below (ADR 0008: the client proposes,
-- the server decides).
create policy event_check_ins_read
  on public.event_check_ins for select
  to authenticated
  using (app.has_permission(community_id, 'attendance.check_in'));
