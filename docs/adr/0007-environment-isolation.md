# 0007 — Three environments, migration-only schema changes

**Status:** Accepted · 2026-09-17

## Context

The previous setup had two Supabase projects and no staging. They were not
comparable: production ran Postgres 15.8 in `eu-central-1`, test ran 17.4.1 in
`eu-north-1`, and test carried `workspaces` tables that production has never
had. Testing against it proved little.

Worse, the repository could not describe production.
`kolekto-fe-old/supabase/migrations` held 52 files; production had 38 applied
migrations; **zero versions appeared in both.** Every local file was named
`*_undocumented_historical_migration.sql`. The schema was built by hand through
the console, which is also how two tables reached production with RLS disabled
and full DML granted to `anon`.

Separately, `supabase/.temp/linked-project.json` was tracked in Git in
`kolekto-be-old` from 2026-08-06 until 2026-08-31, pointing a fresh clone at
production.

## Decision

Three environments, and schema changes only through migrations applied by CI.

| | Local | Staging | Production |
|---|---|---|---|
| Supabase | `supabase start`, or `kolekto-dev` | `kolekto-staging` | `kolekto-prod` |
| Postgres version and region | Matches production | Matches production exactly | Set by DEC-13 |
| Paystack | Test keys | Test keys | Live keys |
| Data | Seeded, synthetic | Synthetic; never a production copy | Real |
| Deploys | — | Automatic on merge to `main` | Tagged release, manual approval |

**No cloud project is created until it is needed.** `kolekto-prod` is created
only after DEC-13 settles data residency, because a Supabase project's region
cannot be changed afterwards without a full migration. Local development uses
the Supabase CLI and needs no cloud project at all.

## Rules

1. **All DDL through `supabase/migrations`.** No console SQL against staging or
   production. A migration check in CI fails if the committed migrations do not
   reproduce the expected schema.
2. **A fresh clone does nothing until configured.** `.gitignore` carries
   `.env*` (except `.env.example`) and `supabase/.temp/` from the first commit.
   No committed file names a Supabase project ref.
3. **Fail fast on missing configuration.** The app throws at import time if a
   required variable is absent rather than defaulting. Carried from the old
   backend's `assertSupabaseConfig()`, which was added after an anon key was
   placed in a service-role slot.
4. **Non-production asserts it is not production.** Any non-production code path
   compares its project ref against `KOLEKTO_PRODUCTION_PROJECT_REF` and fails
   loudly on a match. Generalised from the old repository's integration-test
   guard, which already hard-refused to run against the production ref.
5. **Production secrets exist in one place** — the production secret store.
   Never on a laptop. Rotated at least every 180 days and on staff change
   (NFR-02).

## Consequences

- Onboarding is `npm install`, `npm run db:start`, `npm run db:reset`. No
  credentials are needed to contribute.
- Staging must be created before the Phase 3 reconciliation soak, which
  requires fourteen consecutive break-free days.
- The two existing projects are untouched. `kolekto prod` stays frozen except
  for the security lockdown and reconciliation; `Kolekto test` is retired once
  dev and staging exist, because its major version and schema mislead.
