-- ─────────────────────────────────────────────────────────────────────────────
-- 20260917120000 — Extensions, schemas and shared helpers
--
-- The first migration of the rebuilt Kolekto. See docs/adr/0002 for why
-- Supabase, docs/adr/0007 for why every schema change is a file like this one.
--
-- Three schemas:
--   public   — tenant data, exposed through PostgREST, RLS enabled and FORCED
--   app      — helper functions (has_permission, guards). NOT exposed.
--   private  — operational views and staff-only reads. NOT exposed.
--
-- `app` and `private` are deliberately outside the PostgREST search path. The
-- previous system put seven SECURITY DEFINER views in `public` and granted them
-- to `anon`, which bypassed RLS on contributions, deposits and payment context.
-- A schema PostgREST cannot see cannot be reached with an anon key at all.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists app;
create schema if not exists private;

comment on schema app is
  'Helper functions used by RLS policies and server functions. Not exposed via PostgREST.';
comment on schema private is
  'Operational views and staff-only reads. Not exposed via PostgREST. Read through the service role only.';

-- Extensions live in `extensions`, never in `public`. The previous project had
-- citext installed in public and flagged for it.
create extension if not exists "pgcrypto"  with schema extensions;
create extension if not exists "citext"    with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;

-- Job queue and scheduling (ADR 0002). Both were available in the previous
-- project and never installed; jobs ran in an Express process instead.
create extension if not exists "pg_cron";
create extension if not exists "pg_net"    with schema extensions;
create extension if not exists "pgmq";

-- Database testing. Available in the previous project, never installed, and the
-- reason RLS had no tests at all.
create extension if not exists "pgtap"     with schema extensions;


-- ── UUIDv7 ───────────────────────────────────────────────────────────────────
-- PRD DAT-04 requires time-ordered identifiers. Postgres gains a native
-- uuidv7() in 18; until every environment is there, this is the implementation.
-- Time-ordered UUIDs keep index locality, which matters for the tables that
-- grow fastest (audit logs, notifications, and later the ledger).
create or replace function app.uuid_generate_v7()
returns uuid
language plpgsql
parallel safe
set search_path = ''
as $$
declare
  v_time  timestamptz := clock_timestamp();
  v_unix  bigint;
  v_bytes bytea;
begin
  v_unix := floor(extract(epoch from v_time) * 1000)::bigint;

  -- 16 random bytes, then overwrite the first 48 bits with the timestamp and
  -- set the version (7) and variant (RFC 4122) bits.
  v_bytes := extensions.gen_random_bytes(16);
  v_bytes := set_byte(v_bytes, 0, ((v_unix >> 40) & 255)::int);
  v_bytes := set_byte(v_bytes, 1, ((v_unix >> 32) & 255)::int);
  v_bytes := set_byte(v_bytes, 2, ((v_unix >> 24) & 255)::int);
  v_bytes := set_byte(v_bytes, 3, ((v_unix >> 16) & 255)::int);
  v_bytes := set_byte(v_bytes, 4, ((v_unix >>  8) & 255)::int);
  v_bytes := set_byte(v_bytes, 5, ( v_unix        & 255)::int);
  v_bytes := set_byte(v_bytes, 6, ((get_byte(v_bytes, 6) & 15)  | 112));
  v_bytes := set_byte(v_bytes, 8, ((get_byte(v_bytes, 8) & 63)  | 128));

  return encode(v_bytes, 'hex')::uuid;
end;
$$;

comment on function app.uuid_generate_v7() is
  'Time-ordered UUIDv7 (PRD DAT-04). Replace with native uuidv7() once every environment runs Postgres 18.';


-- ── updated_at ───────────────────────────────────────────────────────────────
create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ── Phone normalisation (MEM-16) ─────────────────────────────────────────────
-- Every phone number is stored E.164. The previous system stored whatever was
-- typed, which made duplicate detection unreliable and contributed to the
-- 2026-08-05 phone/email cross-contamination incident.
--
-- Nigeria-first: 0803… and 234803… and +234803… all normalise to +234803….
-- Returns NULL when the input cannot be normalised, so a CHECK can reject it
-- rather than storing something that looks plausible and is not.
create or replace function app.normalise_phone(p_raw text, p_default_country text default 'NG')
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_digits text;
begin
  if p_raw is null then
    return null;
  end if;

  v_digits := regexp_replace(p_raw, '[^0-9+]', '', 'g');

  if v_digits like '+%' then
    v_digits := '+' || regexp_replace(substring(v_digits from 2), '[^0-9]', '', 'g');
    return case when length(v_digits) between 8 and 16 then v_digits else null end;
  end if;

  if p_default_country = 'NG' then
    -- 0803… (11 digits, local trunk prefix)
    if v_digits ~ '^0[789][01][0-9]{8}$' then
      return '+234' || substring(v_digits from 2);
    end if;
    -- 234803… (13 digits, country code without +)
    if v_digits ~ '^234[789][01][0-9]{8}$' then
      return '+' || v_digits;
    end if;
    -- 803… (10 digits, no trunk prefix)
    if v_digits ~ '^[789][01][0-9]{8}$' then
      return '+234' || v_digits;
    end if;
  end if;

  return null;
end;
$$;

comment on function app.normalise_phone(text, text) is
  'Normalise a phone number to E.164 (PRD MEM-16). Returns NULL when the input is not a recognisable number, so callers must handle failure explicitly.';


-- ── Kobo ─────────────────────────────────────────────────────────────────────
-- ADR 0003. Money is bigint kobo everywhere. The domain is what makes an
-- accidental `numeric` money column obvious in review, and it is what
-- supabase/tests/03_money_invariants.sql asserts is bigint-backed.
--
-- It carries NO constraint, deliberately. `bigint` is already whole, so there is
-- nothing to check — and a domain CHECK is evaluated against NULL, unlike a
-- table CHECK. An earlier version of this line read
-- `constraint kobo_is_whole check (value is not null)`, which is the documented
-- way to make a domain NOT NULL: it silently made every nullable money column
-- mandatory and rejected a tiered collection with no fixed amount.
-- Nullability belongs on the column, not on the type.
--
-- Signedness also belongs on the column: ledger entries are directional, so the
-- domain permits negatives and non-ledger columns add CHECK (col >= 0).
create domain app.kobo as bigint;

comment on domain app.kobo is
  'A whole number of kobo. 100 kobo = 1 naira. ADR 0003: money is never floating point and never numeric. Carries no constraint: nullability and sign are column-level decisions.';
