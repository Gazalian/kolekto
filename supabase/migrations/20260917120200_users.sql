-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120200 — Users
--
-- A user is a LOGIN. That is all it is.
--
-- ADR 0004: a user never owns a financial object. Authority comes from
-- `officer_terms`; a user appears on financial rows only as an actor
-- (created_by, requested_by, approved_by).
--
-- Note what is absent: there is no `role` column. The previous system had
-- `profiles.role`, editable by the user through the weaker of two overlapping
-- RLS policies. Nothing authorized on it, which made it a landmine rather than
-- a breach — one feature away from self-service privilege escalation. ADR 0008
-- forbids authorizing on user-editable data, so the column does not exist.
--
-- Members and contributors are NOT users. A member needs no password and may
-- never log in (PRD 0.3, SEC-06). Only officers hold accounts.
-- ─────────────────────────────────────────────────────────────────────────────

-- PRD 10.1, the verification ladder. Identity level gates money movement:
-- contact-verified is enough to create a community and draft collections;
-- identity-verified is required to withdraw or manage a withdrawal account.
-- Exactly which checks each level requires is DEC-04 and is not encoded here.
create type public.identity_level as enum (
  'none',
  'contact_verified',   -- phone OTP and/or email OTP
  'identity_verified'   -- legal name, DOB, BVN/NIN, liveness — per DEC-04
);

create type public.user_status as enum (
  'active',
  'suspended',   -- trust action: cannot act in any community
  'closed'       -- OWN-03: login anonymised, officer terms ended, actions kept
);

create table public.users (
  id                  uuid primary key references auth.users (id) on delete restrict,
  full_name           text        not null,
  phone_e164          text,
  email               extensions.citext,
  identity_level      public.identity_level not null default 'none',
  status              public.user_status    not null default 'active',
  -- OWN-03: closing an account anonymises the login but keeps every action
  -- attributed to the name the person held at the time. That name lives on the
  -- audit row and the officer term, not here, so this can be emptied safely.
  anonymised_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint users_full_name_length
    check (char_length(full_name) between 1 and 120),

  -- A phone number is stored E.164 or not at all (MEM-16). Rejecting at the
  -- boundary is the only way duplicate detection stays reliable.
  constraint users_phone_is_e164
    check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,15}$'),

  -- A user must be reachable somehow, or they cannot be authenticated.
  constraint users_has_a_contact_method
    check (phone_e164 is not null or email is not null or status = 'closed')
);

comment on table public.users is
  'A login. Never owns a financial object (ADR 0004). Has no role column by design (ADR 0008).';
comment on column public.users.identity_level is
  'Verification ladder (PRD 10.1). Gates withdrawal and withdrawal-account management. The checks behind each level are DEC-04.';
comment on column public.users.anonymised_at is
  'Set when the account is closed (OWN-03). Historical actions keep the name held at the time, stored on the audit row.';

create unique index users_phone_key on public.users (phone_e164) where phone_e164 is not null;
create unique index users_email_key on public.users (email)      where email is not null;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function app.set_updated_at();

alter table public.users enable row level security;
alter table public.users force row level security;


-- ── Who is calling ───────────────────────────────────────────────────────────
-- Used by RLS policies and server functions. STABLE so the planner can hoist it
-- out of a per-row context; a policy calling this once per statement rather
-- than once per row is the difference between a member list that loads in a
-- second and one that does not.
create or replace function app.current_user_id()
returns uuid
language sql
stable
parallel safe
set search_path = ''
as $$
  select auth.uid();
$$;

comment on function app.current_user_id() is
  'The calling user, or NULL for an anonymous request. Indirection so tests can reason about identity without a JWT.';
