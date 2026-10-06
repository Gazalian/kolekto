# Service-role privilege decision (F-1)

**Date:** 2026-09-28 · **Finding:** F-1, [STAGING-ENVIRONMENT-VALIDATION.md §13](STAGING-ENVIRONMENT-VALIDATION.md)
**Decision:** `service_role` holds **no privileges on any table or sequence** in the
application schemas (`public`, `app`, `private`, `migration`), in every environment,
pinned by a forward migration and by pgTAP.

## 1. Current posture

| `service_role` on application tables | Local | Staging |
|---|---|---|
| SELECT / INSERT / UPDATE / DELETE | **none** | **all 46 `public` tables** |
| TRUNCATE / REFERENCES / TRIGGER | all 46 `public` tables | all 46 `public` tables |
| MAINTAIN | all 46 (PG 17 `m`) | all 46 |
| Table privilege rows | 138 | 322 |
| EXECUTE on application functions | **0 of 112** | **0 of 112** |
| Schema USAGE | `public` only | `public` only |
| Sequences in application schemas | none exist | none exist |
| Role attributes | `BYPASSRLS`, **NOLOGIN** | `BYPASSRLS`, **NOLOGIN** |

**Root cause of the difference.** No migration mentions `service_role`'s table
privileges, so each environment inherits the default privileges its platform image
ships for tables created by `postgres`:

| Default ACL for role `postgres`, schema `public`, tables | |
|---|---|
| Local CLI image | `service_role=Dxtm` — truncate, references, trigger, maintain |
| Hosted project | `service_role=arwdDxtm` — **everything** |

Functions agree because the migrations revoke EXECUTE explicitly. Tables differ
because nothing revokes them for `service_role`. Only the tables drifted.

## 2. Actual usage — who needs what

**Evidence, from the code as it stands on `ce0b6db` plus the working tree:**

| Credential | Used by | What it does | Needs `service_role` on application tables? |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | `apps/web/lib/collection-cover.ts`, `apps/web/lib/item-image.ts` — **the only two** | `storage.from(bucket).upload / getPublicUrl / remove` | **No.** Storage acts on the `storage` schema. The only storage policy checks `bucket_id` and reads no application table. |
| `SUPABASE_DB_URL` | `packages/db/src/client.ts` — **the only one** | Connects as the URL's user (`postgres`), then `set local role authenticated` / `anon` per transaction in `withCallerContext` | **No.** This path never becomes `service_role`. |
| Publishable key | Every other Supabase client in `apps/web` | User-session reads through RLS | No |

- **No `.from(table)` and no `.rpc()` call uses the service-role client.**
- **No pgTAP file, script or invariant sets `role service_role`.**
- **No Edge Function exists** (ADR 0005).
- `service_role` is **NOLOGIN**, so it can only be reached as a JWT through
  PostgREST, Storage or GraphQL, or by a session already allowed to `SET ROLE`.

**Conclusion: nothing in Kolekto uses a single one of `service_role`'s table
privileges, in either environment.**

## 3. Migration-rehearsal requirements

**No import or rehearsal tooling exists yet**, and no document names the role it
should connect as. What the rehearsal will need to do is known from the destination
design:

- **INSERT** into `migration.*` history tables and into the `public` tables that take
  imported rows (`users`, `communities`, `collections`, `members`, tiers, items,
  references, `legacy_links`, code sequences), and into `auth.users` to preserve UUIDs.
- **SELECT** for lookups and reconciliation.
- **Never UPDATE, DELETE or TRUNCATE** imported history. The immutability triggers
  already refuse UPDATE/DELETE for **every** role.
- **Pass RLS**: every table forces RLS, so the writer needs `BYPASSRLS` or an explicit
  policy.

**`service_role` is the wrong tool for this, in either posture:**

- It is **NOLOGIN**. An importer must log in as something else and `SET ROLE`.
- **Locally it cannot write any table today**, so a rehearsal designed against the
  local stack could never have used it. The two environments would behave
  differently if it did.
- Granting it write access would hand the same power to **every holder of the
  service key**, including the web server, which only needs Storage.

**A dedicated importer role is preferable** (§5). It is designed with the rehearsal,
not now.

## 4. Security implications of the staging posture

With the hosted default, anyone holding the staging (or future production)
**service-role JWT** can, through the public REST API:

| Table class | Staging posture allows | Stopped by |
|---|---|---|
| All 46 tables | **Read every row** — all PII, all financial records. RLS is bypassed. | Nothing |
| `ledger_entries`, `ledger_journals`, `ledger_accounts` | **INSERT** a new journal | The balancing trigger rejects an *unbalanced* one. **A balanced fraudulent journal is accepted.** |
| `financial_events`, `financial_event_processing_attempts`, `financial_operation_claims` | **INSERT** fabricated events and claims | Nothing |
| `fee_schedules`, `withdrawal_fee_schedules`, … | INSERT a new schedule version | Nothing |
| Non-imported `users`, `communities`, `members`, `collections`, `obligations` | **UPDATE and DELETE** | Only the guards that exist per table |
| Append-only and imported rows | UPDATE, DELETE | Immutability triggers — **these hold for every role** |

The web server holds this key for image uploads. **A leak from the web tier would
therefore become a ledger-write and full-read capability**, which the local posture
never had and which no feature needs.

### A related finding, F-4: `TRUNCATE` is not guarded (both environments)

All 15 append-only or immutable tables (the ledger tables, `financial_events`,
`audit_logs`, `fee_schedules`, imported `collections` and `members`,
`migration.unattributed_payments` and others) protect themselves with **row-level**
UPDATE/DELETE triggers. **None has a `BEFORE TRUNCATE` trigger**, and `TRUNCATE` does
not fire row-level triggers. `service_role` holds TRUNCATE on all of them **locally
as well as on staging**.

Its practical reach through `service_role` is small. PostgREST never issues TRUNCATE,
and `service_role` cannot log in. But the same gap applies to **`postgres`**, the
table owner, which is the role `SUPABASE_DB_URL` connects as. **This decision removes
`service_role`'s TRUNCATE. It does not close F-4.** Closing F-4 is a statement-level
`BEFORE TRUNCATE` guard on each append-only table, which holds even for the owner
unless the trigger is deliberately disabled. **Recommended before Migration
Rehearsal #1**, whose whole point is producing immutable history.

### Observation, F-5: the app's database connection is the table owner

`SUPABASE_DB_URL` connects as `postgres`: table owner, `BYPASSRLS`, `CREATEROLE`.
Correctness depends on every query passing through `withCallerContext`, which drops
to `authenticated` or `anon`. The module's own comment warns that calling
`getClient()` directly "runs as the connection's own (privileged) role". A dedicated
**non-owner, non-BYPASSRLS login role** for the application, able only to `SET ROLE`
to `authenticated` and `anon`, would make that mistake harmless. **Not in scope here.
Recorded for the hosting milestone**, when the production connection string is
first created.

## 5. Recommended posture

**`service_role`: no privileges on any table or sequence in `public`, `app`,
`private` or `migration`, in every environment.** Stricter than local's current
`Dxtm`, because nothing uses that either.

| | Before (local) | Before (staging) | **After (both)** |
|---|---|---|---|
| Table privileges | Dxtm × 46 | arwdDxtm × 46 | **none** |
| Default privileges, tables created by `postgres` | Dxtm | arwdDxtm | **none** |
| Function EXECUTE | none | none | none — unchanged |
| Schema USAGE on `public` | yes | yes | yes — unchanged. Storage and the REST API resolve the schema; with no table grant, nothing is readable |
| `storage` / `auth` schemas | platform-managed | platform-managed | **untouched** |

**What still works, unchanged:** image upload, read and delete through Storage;
every server action; every read; pgTAP; invariants; reconciliation queries (run as
the connection role, not `service_role`).

**What a leaked service key can still do:** Storage operations, and the Auth admin
API (create or delete users). Those are inherent to the key and outside table
privileges. **It can no longer read or write any application table.**

### The importer: a dedicated role, designed with the rehearsal

> **Update 2026-09-28:** `kolekto_importer` now exists for the `migration` schema
> (`20260928120600`), with explicit RLS rather than `BYPASSRLS`; the public-schema
> grants are specified and land with the importer.
> [IMPORT-FOUNDATIONS-REPORT.md §5](IMPORT-FOUNDATIONS-REPORT.md).

Recommended, for the rehearsal design rather than now:

| | |
|---|---|
| Role | `kolekto_importer`, **NOLOGIN**, entered by `SET ROLE` from the migration connection |
| Tables | **INSERT** on exactly the destination tables; **SELECT** where lookups need it |
| Never | UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES; any `app` function EXECUTE not needed by the import |
| RLS | Explicit INSERT policies `to kolekto_importer` — visible and testable — in preference to `BYPASSRLS` |
| Lifetime | Created for the rehearsal. Its privileges can be revoked after cutover without touching the application |

This keeps "who can write history" to a single named role whose grants are all on
the record.

## 6. Exact change

**Migration `20260928110000_service_role_no_application_table_privileges.sql`:**

```sql
revoke all on all tables    in schema public, app, private, migration from service_role;
revoke all on all sequences in schema public, app, private, migration from service_role;
alter default privileges for role postgres in schema public    revoke all on tables    from service_role;
alter default privileges for role postgres in schema public    revoke all on sequences from service_role;
-- … the same for app, private, migration
```

**Pinned by `supabase/tests/25_service_role_privileges.sql`**: zero table, sequence and
application-function privileges for `service_role`, and zero `service_role` entries in
`postgres`'s default privileges for the application schemas. pgTAP previously
asserted nothing about `service_role`, which is why the drift was invisible.

**Rollout:** local (`npm run db:migrate`) → full local suite → staging
(`supabase db push --linked`) → staging-vs-local fingerprint comparison.

## 7. Status

| | |
|---|---|
| Local | **Implemented and validated.** Migration applied with `npm run db:migrate`; `25_service_role_privileges.sql` 3/7 before, **7/7 after**; full local suite green except E2E, which did not complete for environmental reasons ([STAGING-ENVIRONMENT-VALIDATION.md §21](STAGING-ENVIRONMENT-VALIDATION.md)) |
| Staging | **NOT applied. Staging still carries the hosted default** — `service_role` full read/write on all 46 tables. The push was refused with 403 because the CLI had reverted to the legacy account. Apply with `supabase db push --linked` once the CLI is logged in as a staging-organisation member with sufficient role, then rerun the staging-vs-local fingerprint comparison |

**F-4 and F-5 remain open** and are listed in
[MIGRATION-REHEARSAL-1-READINESS.md](MIGRATION-REHEARSAL-1-READINESS.md).
