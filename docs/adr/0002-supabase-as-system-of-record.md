# 0002 — Supabase Postgres as the system of record

**Status:** Accepted · 2026-09-17

## Context

The previous system already ran on Supabase. The audit found serious problems
in how it was operated — two tables with RLS disabled and full DML granted to
`anon`, seven `SECURITY DEFINER` views bypassing RLS, three `SECURITY DEFINER`
functions callable by `anon` that could drive the payment state machine, and a
schema with 38 applied migrations and 52 committed files sharing zero versions.

None of those are Supabase problems. Every one is the result of managing a
database by hand through a web console.

## Decision

Keep Supabase Postgres as the system of record. Use, specifically:

- **Postgres + RLS** for multi-tenancy by `community_id`
- **Postgres functions** for every money mutation, one transaction each
- **`pgmq`** for the job queue and **`pg_cron`** for schedules — in the
  database, not a separate broker
- **`pgtap`** for database tests, including RLS per role per table
- **Supabase Auth** for phone OTP and TOTP
- **Supabase Storage** with private buckets and signed URLs
- **Supabase Realtime** for officer dashboards

## Consequences

- Vendor coupling is real and accepted deliberately. Domain logic stays in
  portable Postgres and pure TypeScript; provider calls stay behind adapters.
  A migration away would be expensive but not architectural surgery.
- `pgmq`, `pgtap` and `pgaudit` were available in the old project and never
  installed. They are installed here in the first migration.
- No Redis, no SQS, no external scheduler, no second database.

## Operating rules this ADR imposes

1. All DDL through `supabase/migrations`, applied by CI. No console SQL against
   staging or production.
2. RLS enabled and **forced** on every table in `public`, asserted by pgTAP.
3. A grant matrix asserted in CI: `anon` and `authenticated` hold `SELECT` on a
   named allowlist and nothing else.
4. No `SECURITY DEFINER` views. Operational views live in a schema not exposed
   to PostgREST and are read through the service role.
5. `SECURITY DEFINER` functions are exceptional, always `SET search_path`,
   always `REVOKE EXECUTE FROM PUBLIC`.
