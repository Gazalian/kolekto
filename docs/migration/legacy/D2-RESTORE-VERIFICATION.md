# D2 — verified local restore

**Date:** 2026-09-27 · **Gate:** D2 · **Result: PASS**

The verified D1 backup of legacy production was restored into a brand-new disposable
PostgreSQL 15 container and every control total reproduced, including the ₦3.59 drift.

**Nothing outside the disposable container was touched.** No connection was opened to
legacy production, legacy test, Supabase cloud, or the new Kolekto local development stack.
No migration was run. The five backup SQL files were mounted **read-only** and their
checksums verify unchanged after the exercise.

---

## 1. Environment

| Item | Value |
|---|---|
| Docker | client 29.7.2 / server 29.7.2 |
| Image | `postgres:15` |
| Image digest | `sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550` |
| Container name | `kolekto-legacy-restore` |
| Container id | `01a3a38f098a7ba2` |
| Server version | **PostgreSQL 15.19** (Debian 15.19-1.pgdg13+2) |
| Client version | **psql 15.19** — required for `\restrict`, satisfied |
| Source server version | 15.8 (client newer than server, as required) |
| Port binding | **`127.0.0.1:55432 -> 5432`** — localhost only |
| Database | `legacy_restore` |
| Password | throwaway, generated in-shell, never printed, never persisted |
| Backup mount | `/backup`, **RW=false (read-only)** |

**Backup directory used:**
`C:\Users\USER\Desktop\Kolekto-codebase\Kolekto-Preservation\2026-09-27-busfgcmbndleljklrcbd\`

## 2. Checksum verification before restore

`sha256sum -c SHA256SUMS` — **5/5 OK**:
`legacy-prod-auth.sql`, `legacy-prod-cron.sql`, `legacy-prod-public-data.sql`,
`legacy-prod-schema.sql`, `legacy-prod-storage-metadata.sql`.

Re-verified **after** the full exercise: still 5/5 OK. **The backup files were not modified.**

## 3. Roles created before the schema load

Ten stand-in roles, all `NOLOGIN`, non-superuser, one statement each:

`anon` · `authenticated` · `service_role` · `dashboard_user` · `pgbouncer` ·
`supabase_admin` · `supabase_auth_admin` · `supabase_functions_admin` ·
`supabase_realtime_admin` · `supabase_storage_admin`

> ### Prerequisite correction — §13.1 listed only four roles
>
> The first schema load used the four roles named in
> [production-backup-plan.md §13.1](production-backup-plan.md) and produced **116 errors**.
> Extracting every role name referenced anywhere in the dump revealed **six further
> Supabase platform roles**. Creating them and reloading cut the errors to **52**, a
> reduction of 64. The four-role list was incomplete and §13.1 must be corrected.
>
> `normalized` also appears in a `FROM` clause in the dump but is a CTE inside a function
> body, not a role.

## 4. Schema restore

`psql -f legacy-prod-schema.sql`, **without** `ON_ERROR_STOP` as required. Exit code 0.

**52 errors, 2 warnings. Every single error is attributable to the five unavailable
extensions. Zero structural or data statements failed.**

### Expected extension errors — all five confirmed

| Root cause | Errors | Statements affected |
|---|---|---|
| `CREATE EXTENSION` for the five unavailable extensions | 5 | `pg_cron`, `pg_net`, `supabase_vault`, `hypopg`, `index_advisor` |
| `COMMENT ON EXTENSION` for the same five | 5 | consequence of the above |
| `GRANT`/`REVOKE` on `cron` schema objects | 13 | `cron` schema absent without `pg_cron` |
| `GRANT` on `net` schema objects | 5 | `net` schema absent without `pg_net` |
| `GRANT` on `vault` objects | 10 | `vault.secrets`, `vault.decrypted_secrets`, `vault.create_secret`, `vault.update_secret`, `vault._crypto_aead_det_decrypt` |
| `GRANT` on `hypopg` / `index_advisor` objects | 14 | 11 `hypopg_*` functions, 2 `hypopg` views, `index_advisor(text)` |
| **Total** | **52** | |

By verb: 39 `GRANT`, 5 `CREATE EXTENSION`, 5 `COMMENT ON EXTENSION`, 3
`ALTER DEFAULT PRIVILEGES`. Of the dump's 801 standalone `GRANT` statements, **39 failed
and 762 applied** — and all 39 target objects that belong to the five absent extensions.

### Unexpected errors

**None.** Every one of the 52 failing lines was mapped back to its originating statement
and checked against the forbidden list. Zero failures touch `CREATE TABLE`, `COPY`,
`CREATE INDEX`, `ADD CONSTRAINT`, `ALTER TABLE`, function creation, trigger creation,
view creation, RLS, types or sequences.

### Warnings (2) — benign

`WARNING: wal_level is insufficient to publish logical changes`, twice, on two
`CREATE PUBLICATION` statements. The publications were created; they are inert in this
container and carry no data.

## 5. Data restore

All three data files loaded with `ON_ERROR_STOP=on`, each in a **single transaction**.

| File | COPY blocks | Errors | Result |
|---|---|---|---|
| `legacy-prod-auth.sql` | 2 | 0 | **PASS** |
| `legacy-prod-public-data.sql` | **53** | 0 | **PASS** |
| `legacy-prod-storage-metadata.sql` | 2 | 0 | **PASS** |

**57 COPY blocks, zero data errors.**

### Load order

`auth` → `public` → `storage`, not the order the brief listed. **Eleven public tables hold
foreign keys into `auth.users`** — `profiles`, `admin_users`, `campaigns`, `kyc_documents`
(2), `kyc_verification_history`, `notifications`, `password_reset_otps`, `payout_accounts`,
`push_notification_events`, `push_subscriptions`, `user_identity`. Loading `public` first
would reference rows that do not yet exist. Within each file `pg_dump` had already ordered
the COPY blocks by dependency (`auth.users` before `auth.identities`; `profiles` before
`collections` before `contributions` before `deposits` before `wallets` before
`withdrawals`), so only the cross-file order needed correcting.

> ### Prerequisite correction — triggers must be disabled during the data load
>
> **The first attempt failed, and the reason matters.** Loading `auth.users` fired the live
> application trigger `on_auth_user_created` → `handle_new_user()`, which tried to
> **insert fabricated rows into `public.profiles`**:
>
> ```
> ERROR: null value in column "first_name" of relation "profiles" violates not-null constraint
> CONTEXT: PL/pgSQL function handle_new_user() line 13 at SQL statement
> ```
>
> The failing row carried **today's timestamp**, not production data — proof it was invented
> by the trigger rather than restored from the dump. The single transaction rolled back
> completely (all counts verified back to zero).
>
> **A data-only restore of this dump must run with `session_replication_role = replica`.**
> Without it the restore does not merely fail — it silently manufactures rows that were
> never in production. This applies to all 18 non-internal triggers, not just this one.
>
> Because that setting also defers foreign-key triggers, **every foreign key was validated
> explicitly afterwards** (section 7). That is stronger evidence than load-time enforcement,
> since it checks all 80 constraints against the fully populated database.

## 6. Control totals — 45 of 45 PASS

| Section | Check | Expected | Actual | |
|---|---|---|---|---|
| AUTH | users | 623 | 623 | PASS |
| AUTH | profiles | 622 | 622 | PASS |
| AUTH | identities | 623 | 623 | PASS |
| AUTH | users without profile | 1 | 1 | PASS |
| AUTH | profiles without user | 0 | 0 | PASS |
| COLLECTIONS | total | 275 | 275 | PASS |
| COLLECTIONS | active | 237 | 237 | PASS |
| COLLECTIONS | closed | 21 | 21 | PASS |
| COLLECTIONS | deleted | 12 | 12 | PASS |
| COLLECTIONS | paused | 4 | 4 | PASS |
| COLLECTIONS | rejected | 1 | 1 | PASS |
| CONTRIBUTIONS | total | 5,576 | 5,576 | PASS |
| CONTRIBUTIONS | paid | 3,934 | 3,934 | PASS |
| CONTRIBUTIONS | **paid amount kobo** | **4,606,968,935** | **4,606,968,935** | **PASS** |
| CONTRIBUTIONS | pending | 1,628 | 1,628 | PASS |
| CONTRIBUTIONS | duplicate_voided | 14 | 14 | PASS |
| DEPOSITS | total | 6,201 | 6,201 | PASS |
| DEPOSITS | successful | 4,260 | 4,260 | PASS |
| DEPOSITS | **successful gross kobo** | **6,042,365,363** | **6,042,365,363** | **PASS** |
| DEPOSITS | **all-deposit gross kobo** | **9,002,064,126** | **9,002,064,126** | **PASS** |
| DEPOSITS | pending | 1,939 | 1,939 | PASS |
| DEPOSITS | abandoned | 2 | 2 | PASS |
| DEPOSITS | unattributed | 1,317 | 1,317 | PASS |
| DEPOSITS | unattributed successful | 923 | 923 | PASS |
| DEPOSITS | **unattributed successful kobo** | **1,979,922,000** | **1,979,922,000** | **PASS** |
| WITHDRAWALS | total | 292 | 292 | PASS |
| WITHDRAWALS | approved | 239 | 239 | PASS |
| WITHDRAWALS | success | 43 | 43 | PASS |
| WITHDRAWALS | rejected | 10 | 10 | PASS |
| WITHDRAWALS | **total kobo** | **4,668,287,280** | **4,668,287,280** | **PASS** |
| WALLETS | total | 245 | 245 | PASS |
| WALLETS | **available kobo** | **11,403,830** | **11,403,830** | **PASS** |
| WALLETS | **net payment kobo** | **4,606,969,294** | **4,606,969,294** | **PASS** |
| WALLETS | **KNOWN DRIFT kobo** | **359** | **359** | **PASS** |
| WALLETS | gross vs paid gross kobo | 0 | 0 | PASS |

**The ₦3.59 drift reproduced exactly.** Per the preservation plan, that was the decisive
faithfulness test: a restore that "fixed" the drift would not be a faithful copy.

All monetary comparisons are integer kobo computed as `sum(round(amount*100))`. No value in
the database exceeds two decimal places, so naira→kobo is exact and no rounding rule applies.

## 7. Referential integrity

| Check | Expected | Actual | |
|---|---|---|---|
| deposits → missing collection | 0 | 0 | PASS |
| contributions with null collection | 0 | 0 | PASS |
| contributions → missing collection | 0 | 0 | PASS |
| collections → missing profile | 0 | 0 | PASS |
| collections → missing auth user | 0 | 0 | PASS |
| withdrawals with null collection | 0 | 0 | PASS |
| withdrawals → missing collection | 0 | 0 | PASS |
| withdrawals → missing user | 0 | 0 | PASS |
| wallets → missing collection | 0 | 0 | PASS |
| **collections without wallet** | **30** | **30** | **PASS** |

### Exhaustive foreign-key validation

Beyond the named checks, every foreign key in the database was validated by generated
orphan query:

```
FKs checked: 80   violations: 0   skipped: 0
```

**All 80 foreign keys, zero orphans, none skipped.**

## 8. Structural comparison

| Object | Dump | Restored | |
|---|---|---|---|
| `public` tables | 53 | 53 | PASS |
| Tables, all schemas | 99 | 99 | PASS |
| Functions (dump-provided, all schemas) | **94** | **94** | PASS |
| — of which in `public` | 48 | 48 | PASS |
| Triggers (non-internal) | **18** | **18** | PASS |
| Views (dump-provided) | **8** | **8** | PASS |
| Policies | 80 | 80 | PASS |
| Tables with RLS enabled | 78 | 78 | PASS |
| Tables with RLS **forced** | 3 | 3 | PASS |
| Enum types | 14 | 14 | PASS |
| Enum labels | — | 74 | recorded |
| Sequences | 3 explicit + 1 identity | 4 | PASS |
| `ADD CONSTRAINT` statements | 213 | 0 failed | PASS |
| — primary keys | 98 | 98 | PASS |
| — unique | 34 | 34 | PASS |
| — foreign keys | 80 | 80 | PASS |
| — check | 86 | 86 | PASS |
| Standalone indexes | 176 | 176 | PASS |
| Indexes incl. constraint-backed | — | 308 | recorded |
| **Exact `public` row count** | **53,743** | **53,743** | **PASS** |

### Notes on the structural figures

**Corrected counts.** The D1 report quoted **96** functions, **19** triggers and **9**
views. Those came from unanchored greps that also matched four string literals inside an
event-trigger function body enumerating DDL tags (`'CREATE FUNCTION'`, `'CREATE TRIGGER'`,
`'CREATE VIEW'`, `'ALTER FUNCTION'`). The correct statement counts are **94 / 18 / 8**, and
the restored database matches them exactly. The brief inherited 96/19/9 from that report;
this section supersedes it.

**`citext` installs into `public`.** The restored `public` schema holds 95 functions: the 48
from the dump plus 47 belonging to the `citext` extension. Extension-owned objects were
separated using `pg_depend.deptype='e'`.

**Two extra views and two extra CHECK constraints are not from the dump.**
`pg_stat_statements` provides 2 views in `extensions`; `information_schema` contributes
`cardinal_number_domain_check` and `yes_or_no_check`, which exist in every PostgreSQL
database. All 86 dump-attributable CHECK constraints were confirmed present by name.

**Constraint arithmetic closes exactly:** 98 PK + 34 UNIQUE + 80 FK + 86 CHECK = 298
dump-attributable constraints, plus the 2 `information_schema` domain checks = 300 total.

**Index arithmetic closes exactly:** 176 standalone + 132 constraint-backed (98 PK + 34
UNIQUE) = 308.

**Extensions present after restore:** `plpgsql`, `citext`, `pgcrypto`, `uuid-ossp`,
`pg_stat_statements`. The five Supabase-specific extensions are absent by design.

## 9. The 53,743 vs 53,742 row count

**This is expected and is not corruption.**

| | Rows |
|---|---|
| Production baseline, 2026-09-26 | 53,742 |
| D1 backup, 2026-09-27 | **53,743** |
| Restored copy | **53,743** |

The difference is one row appended to `settlement_runs` (**56 → 57**) by the nightly
settlement cron between the baseline capture and the dump. The restored database holds 57,
matching the backup exactly.

**No restored data was altered to match the older baseline.** Doing so would have destroyed
the very property being tested.

## 10. Cron inspection — file only, not restored

`legacy-prod-cron.sql` was **deliberately not loaded.** `pg_cron` is unavailable in
`postgres:15`, so the `cron` schema does not exist in the target — confirmed: 0 namespaces
named `cron`.

Inspected as a file: **1 COPY block, exactly 2 cron job definitions.**

| jobid | schedule | jobname | command |
|---|---|---|---|
| 5 | `*/5 * * * *` | `scheduled-payment-recovery` | **[REDACTED — 360 chars]** |
| 6 | `0 4 * * *` | `settlement-recompute-wallets` | **[REDACTED — 51 chars]** |

**Job 5's command contains a shared secret. It was not printed, and this file remains
secret-bearing.** The standing recommendation to rotate that secret is unchanged.

## 11. Isolation

| Check | Result |
|---|---|
| Port exposure | `127.0.0.1:55432` only — not reachable off-host |
| Docker network | `bridge` — **not** `supabase_network_kolekto` |
| New Kolekto local stack | separate container `supabase_db_kolekto`, **PostgreSQL 17.6 on 54322**, untouched |
| Server identity | `system_identifier` 7690204190737338416 — a distinct instance |
| Foreign servers | 0 |
| Foreign data wrappers | 0 |
| `dblink` / `postgres_fdw` | not installed |
| Logical subscriptions | 0 |
| Publications | 2, local and inert (`wal_level` insufficient) |

**The restored database has no mechanism by which it could reach legacy production, legacy
test, any Supabase cloud project, or the local development stack.** It cannot replicate
outward and nothing replicates into it.

## 12. Final classification

# PASS

- Checksums verified before and after — **5/5, unchanged**
- Schema restored: **52 errors, all attributable to the 5 unavailable extensions, zero structural failures**
- Data restored: **57 COPY blocks, zero errors**
- Control totals: **45 of 45 PASS**, including the **359-kobo drift**
- Referential integrity: **all named checks pass; 80 of 80 foreign keys, zero orphans**
- Structural: every object class matches, with all residuals explained to the object
- Row count: **exactly 53,743**, matching the backup
- Isolation: **verified**

**The D1 backup is now a proven-restorable artefact, not merely a verified file. D2 is
satisfied.**

## 13. Actions arising

Three corrections to the restore documentation, all discovered by actually running it:

1. **§13.1 must list ten roles, not four.** Add `pgbouncer`, `supabase_admin`,
   `supabase_auth_admin`, `supabase_functions_admin`, `supabase_realtime_admin`,
   `supabase_storage_admin`. Without them the schema load produces 116 errors instead of 52.
2. **§13.2 must specify `session_replication_role = replica` for the data phase**, and must
   state why: otherwise `handle_new_user()` fabricates `public.profiles` rows. It must also
   require explicit post-load foreign-key validation as compensation.
3. **§13.2 must load `auth` before `public`**, because 11 public tables reference
   `auth.users`.

Plus the structural figures **94 / 18 / 8** supersede 96 / 19 / 9 wherever they appear.

## 14. State on completion

**The container `kolekto-legacy-restore` is left running, as instructed.** It holds the
restored forensic copy on `127.0.0.1:55432`, database `legacy_restore`.

**Not done, deliberately:** D6 storage object download, D7 Edge Function download, D8
encryption-key archival. The backup directory is still **one unencrypted copy on one
machine** — that remains the highest-priority open item, ahead of everything else.
