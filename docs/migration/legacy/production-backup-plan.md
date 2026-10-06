# Legacy production backup plan — EXECUTED AND RESTORE-VERIFIED

**Status: D1 EXECUTED AND VERIFIED · D2 RESTORE VERIFIED — PASS.**

| Gate | State | Evidence |
| --- | --- | --- |
| **D1** backup | **Executed 2026-09-27, verified** | 7 artefacts · 5/5 checksums · all 20 control totals reproduce from the artefact |
| **D2** restore | **PASS 2026-09-27** | **[D2-RESTORE-VERIFICATION.md](D2-RESTORE-VERIFICATION.md)** — 45/45 control totals · 80/80 FKs, zero orphans · the 359-kobo drift reproduced |
| **D5** structural capture | **Closed by D1** | Function bodies, trigger and view definitions, policy expressions and grants are all in `legacy-prod-schema.sql` |

**Sections 13 and 14 are no longer a proposal. They are a procedure that has been run
end to end, and their prerequisites were corrected by what the run actually found** — see
§13.1 (ten roles, not four) and **§13.3 (application triggers must not fire)**.

**Still outstanding, and the highest priority of the three:** the artefact is **one
unencrypted copy on one machine** (§11). D6 storage object files and D8 encryption-key
archival also remain open.

**Target:** `busfgcmbndleljklrcbd` (legacy production), eu-central-1,
PostgreSQL 15.8.1.094, **LIVE**

---

## 1. Mechanism

**`pg_dump` over the pooler-free direct connection, run from your machine, via the
Supabase CLI.**

```bash
# Schema only — fast, and the authoritative structural capture (D5).
supabase db dump --db-url "<PRODUCTION_DIRECT_CONNECTION_STRING>" \
  --file legacy-prod-schema-<UTC>.sql

# Application data.
supabase db dump --db-url "<...>" --data-only \
  --file legacy-prod-data-<UTC>.sql

# auth and storage metadata, which --data-only skips by default.
supabase db dump --db-url "<...>" --data-only \
  --schema auth,storage \
  --file legacy-prod-auth-storage-<UTC>.sql
```

Three files rather than one, because the schema dump is the piece that satisfies the
structural-preservation requirement independently, and because a failure in one does
not cost the others.

**Why the CLI rather than raw `pg_dump`:** it selects flags Supabase's managed Postgres
accepts, and avoids the common failure of dumping roles and extensions that cannot be
restored into a managed instance.

**Why not Supabase's own backup feature:** the project's automated backups are not
retrievable as a logical file you can restore into an arbitrary local Postgres, which
is precisely what restore verification (D2) requires. PITR is a
restore-into-a-Supabase-project mechanism, not an export.

## 2. Is it supported by Supabase?

**Yes.** `supabase db dump` is the documented export path, and `pg_dump` against the
direct connection is supported on the current plan. The database is PostgreSQL 15, so
the client `pg_dump` must be **version 15 or newer** — a 14 client will refuse.

## 3. Is it read-only with respect to application data?

**Yes, with one honest caveat.**

`pg_dump` issues only `SELECT` and takes `ACCESS SHARE` locks. It writes no application
data, changes no schema, and runs inside a single repeatable-read transaction so the
dump is internally consistent.

**The caveat, stated plainly:** `ACCESS SHARE` does not block reads or writes, but it
_does_ conflict with `ACCESS EXCLUSIVE`. If anything tried to run `ALTER TABLE`,
`DROP`, `TRUNCATE` or `VACUUM FULL` during the dump, that statement would wait. Nothing
in normal Kolekto operation does any of those, and the two cron jobs (an HTTP post and
a wallet recompute) do not. The realistic risk is a long-running transaction holding a
snapshot open, which costs some WAL retention and nothing else.

**It is as close to zero-risk as a production read gets, but it is not literally
nothing, so it is your call.**

## 4. What it captures

| Captured                                                         | Notes                                               |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| All 53 `public` table definitions and data                       | **53,743 rows — see §4.1**                          |
| Constraints, indexes, defaults, generated columns                | **300 constraints, 308 indexes** (restored totals)  |
| Sequences **and their current values**                           | `campuses_campus_id_seq`, `students_student_id_seq` |
| The 2 enums with their full value lists                          | 14 enum types / 74 labels across all schemas        |
| All **94** functions, with bodies                                | 48 of them in `public`                              |
| All **18** triggers                                              |                                                     |
| All **8** views, with definitions                                |                                                     |
| RLS policies and `ENABLE`/`FORCE` state                          | 80 policies · 78 enabled · 3 forced                 |
| Table and function grants                                        | 801 standalone `GRANT` statements                   |
| `auth` schema data, including `auth.users` and `auth.identities` | **623 users — see §6**                              |
| `storage.buckets` and `storage.objects` **metadata**             | **not the files — see §7**                          |

### 4.1 The row count is 53,743, not 53,742 — and that is correct

**Verified by restore.** Evidence: [D2-RESTORE-VERIFICATION.md](D2-RESTORE-VERIFICATION.md).

| | Rows |
| --- | --- |
| Production baseline, 2026-09-26 | 53,742 |
| **The backup, 2026-09-27** | **53,743** |
| **The restored copy** | **53,743** |

The one-row difference is `settlement_runs`, which went from **56 to 57** when the nightly
settlement cron appended an audit row between the baseline capture and the dump. It is
expected liveness in a live system, it is non-financial, and **no financial control total
moved.** Thirty-nine of the forty non-empty tables match the baseline exactly.

> **Do not "correct" this during a restore.** Deleting that row to make the total match the
> older baseline would destroy the only property a restore is being tested for — that the
> restored copy is identical to the artefact. A restore that reproduces 53,742 has been
> tampered with.

### 4.2 Structural counts — D2-verified

These supersede any earlier figures. The counts previously published as **96 functions, 19
triggers and 9 views** were inflated by unanchored greps that also matched four string
literals inside an event-trigger function body enumerating DDL tags. Evidence:
[D2-RESTORE-VERIFICATION.md §8](D2-RESTORE-VERIFICATION.md).

| Object | Count | Reconciliation |
| --- | --- | --- |
| `public` tables | 53 | exact |
| Tables, all schemas | 99 | exact |
| **Functions** | **94** | 48 `public` · 19 `storage` · 15 `realtime` · 6 `extensions` · 4 `auth` · 1 `graphql_public` · 1 `pgbouncer`. Excludes 47 `citext` functions, which the extension installs into `public` |
| **Triggers** | **18** | non-internal |
| **Views** | **8** | excludes 2 `pg_stat_statements` views |
| Policies | 80 | exact |
| RLS enabled / forced | 78 / 3 | exact |
| Enum types / labels | 14 / 74 | exact |
| Sequences | 4 | 3 explicit `CREATE SEQUENCE` + 1 identity sequence |
| **Constraints** | **300** | 98 PK + 34 UNIQUE + 80 FK + 86 CHECK = 298 from the dump, plus 2 built-in `information_schema` domain checks |
| **Indexes** | **308** | 176 standalone `CREATE INDEX` + 132 backing PK/UNIQUE constraints |

`ADD CONSTRAINT` statements in the dump: 213 (98 PK + 34 UNIQUE + 80 FK + 1 CHECK). The
remaining 85 CHECK constraints are declared inline in `CREATE TABLE`. All 86
dump-attributable CHECK constraints were confirmed present by name in the restored copy.

## 5. What it does NOT capture

| Not captured                     | Consequence                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| **Storage object files**         | 68 objects, ~24.4 MB. Separate mechanism — §7                                                |
| **Edge Function source**         | 13 functions. Already in git — §8                                                            |
| **Supabase project settings**    | Auth providers, SMTP, rate limits, JWT config. Manual capture                                |
| **`cron.job` rows**              | In the `cron` schema, not `public`. **Must be added explicitly** — and one contains a secret |
| **The `ACCOUNT_ENCRYPTION_KEY`** | Lives in a legacy `.env`, not the database                                                   |
| **Supabase platform roles**      | Not restorable into local Postgres anyway                                                    |
| Vault secrets                    | Vault is empty (verified: 0 secrets)                                                         |

**`cron.job` is the easy thing to miss.** Add `--schema cron` to the dump, or capture
those two rows separately — with the caveat that job 5's command contains a shared
secret, so that capture must be treated as a secret-bearing file.

## 6. Is `auth.users` included?

**Yes, if `--schema auth` is passed** — and it must be, because auth UUID preservation
is the one migration property that cannot be corrected afterwards.

**This makes the dump credential-bearing.** `auth.users` contains
`encrypted_password`, and `auth.refresh_tokens` and `auth.sessions` contain live
session material. Consequences:

- The dump must be treated as a **secret**, not merely as private data.
- It must never be committed, and never be placed anywhere with broad access.
- The restore target must be isolated and disposable.
- **Recommendation:** dump `auth.users` and `auth.identities` specifically rather than
  the whole `auth` schema, so live session and token tables are excluded. Sessions have
  no migration value — users will re-authenticate — and excluding them removes the
  most dangerous rows from the artefact entirely.

## 7. Storage objects

**Metadata yes, files no.**

Six buckets, 68 objects, ~24.4 MB:

| Bucket               | Public      | Objects | Size    | Content                |
| -------------------- | ----------- | ------- | ------- | ---------------------- |
| `kyc-documents`      | **private** | 53      | 19.7 MB | **identity documents** |
| `avatars`            | public      | 13      | 4.0 MB  | user avatars           |
| `email-attachments`  | public      | 1       | 12 KB   |                        |
| `campaign_assets`    | public      | 1       | 649 KB  |                        |
| `campaign-documents` | private     | 0       | —       |                        |
| `campaign-images`    | public      | 0       | —       |                        |

The volume is small enough that a full object backup is trivial. The sensitivity is
not: `kyc-documents` holds 53 identity documents behind a legal question (L-1/L-2).

**Proposed mechanism — and this needs its own approval:**

```bash
# Read-only. Writes to a protected local directory, never into Git.
supabase storage cp -r ss:///kyc-documents <PROTECTED_DIR>/kyc-documents --experimental
# …repeat per bucket
```

**I am not proposing to run this yet.** Downloading 53 identity documents is a
data-protection act, not just a file copy, and it should be a deliberate decision with
counsel's view on retention. **STOP point.**

## 8. Edge Functions

**Already preserved, and verified this session.** All 13 deployed slugs have
git-tracked source in `kolekto-fe-old/supabase/functions/` (24 tracked files).

**But local may be stale.** Deployed versions are high (`verify-paystack-payment` v39,
`initiate-paystack-payment` v16), and the repository contains
`verify-paystack-payment.pre-download-2026-08-06` and `.stale-backup-2026-08-06` —
which is direct evidence that local _was_ stale once and had to be re-downloaded.

**Recommended, read-only:**

```bash
for f in rapid-service create-collection update-collection update-collection-status \
         initiate-paystack-payment verify-paystack-payment get-all-fundraising-campaigns \
         get-fundraising-campaign-by-id profile-update change-password zepto-debug \
         delete-collection scheduled-payment-recovery; do
  supabase functions download "$f" --project-ref busfgcmbndleljklrcbd
done
# then diff against kolekto-fe-old/supabase/functions/
```

A diff is the deliverable, not the download. If deployed matches git, D7 is closed on
evidence rather than assumption.

## 9. Functions, triggers, views, sequences, RLS, grants

All included in the schema dump (§4). That dump is the **authoritative** structural
capture; the inventory in
[legacy-production-baseline.md](legacy-production-baseline.md) and
[legacy-structural-capture.md](legacy-structural-capture.md) is a _summary_ and is not
a substitute. **This is why D5 depended on D1 — and D1 has now closed it.**

**D2-verified counts are in §4.2.** They were confirmed twice over: once by counting
statements in the dump, and once by counting the objects that actually exist in the restored
database. The two agree. Evidence:
[D2-RESTORE-VERIFICATION.md §8](D2-RESTORE-VERIFICATION.md).

## 10. Expected size

**Actuals, measured after execution.** The estimates held.

| Artefact                             | Estimated                 | **Actual**          |
| ------------------------------------ | ------------------------- | ------------------- |
| `legacy-prod-schema.sql`             | < 1 MB                    | **561,112 B**       |
| `legacy-prod-public-data.sql` (53,743 rows, jsonb-heavy) | **20–60 MB** | **27,679,303 B**    |
| `legacy-prod-auth.sql` (623 + 623)   | < 1 MB                    | **699,985 B**       |
| `legacy-prod-storage-metadata.sql`   | < 1 MB                    | **36,019 B**        |
| `legacy-prod-cron.sql`               | < 10 KB                   | **1,419 B**         |
| `SHA256SUMS` + `high-water-mark.json`| —                         | **456 B + 899 B**   |
| **Total, seven artefacts**           | **well under 100 MB**     | **28,979,193 B (27.64 MB)** |
| Storage object **files**             | **24.4 MB** (exact)       | *not downloaded — D6, needs B5* |

Small enough that there is no technical reason to take a partial backup.

## 11. Storage location

**Outside the repository, encrypted, on a machine you control.**

```
<OUTSIDE_REPO>/kolekto-legacy-preservation/
  2026-09-27T00-45Z-busfgcmbndleljklrcbd/
    legacy-prod-schema.sql
    legacy-prod-data.sql
    legacy-prod-auth.sql          <- credential-bearing
    legacy-prod-cron.sql          <- secret-bearing
    storage/                      <- only after §7 approval
    MANIFEST.json                 <- may be committed
    SHA256SUMS
```

**Explicitly not:** inside `Desktop/Kolekto-codebase/`, any Git repository, any shared
drive with broad access, or any third-party service. The repository's CI already fails
if a `.env` or link file is tracked; a 60 MB dump of customer data must not be the
thing that slips past it.

**Recommended protection:** an encrypted archive (age, GPG, or an encrypted disk
image), with the passphrase stored in a password manager and **not** alongside the
archive.

## 12. Manifest

The manifest may be committed; the data may not. Fields: creation timestamp (UTC),
source project ref, `source_environment: legacy-production`, format, per-file SHA-256,
per-file size, encryption status, retention, the high-water mark, and the control
totals from
[legacy-control-totals.md](legacy-control-totals.md).

A manifest template is at
`migration/manifests/legacy-production-backup-manifest.template.json`.

## 13. Restore

**Into a disposable local PostgreSQL 15 container. Never into any Supabase project.**

### 13.1 Prerequisites — D2-VERIFIED on 2026-09-27

> **These prerequisites are no longer predictions. The restore was performed and passed.**
> Full evidence: **[D2-RESTORE-VERIFICATION.md](D2-RESTORE-VERIFICATION.md)** — 45 of 45
> control totals reproduced, including the 359-kobo drift, and 80 of 80 foreign keys
> validated with zero orphans.
>
> **Two prerequisites below were wrong when first written and are corrected here.** The role
> list named four roles; **ten** are required. And the data phase needs application triggers
> disabled, which the original text did not mention at all — the omission that mattered most.

**The schema dump will not restore cleanly into a vanilla `postgres:15` container.** That
is not a defect in the backup; it is what a Supabase-hosted schema looks like once it is
taken out of Supabase. Four prerequisites must be handled before the restore is run, or
its errors will be indistinguishable from corruption.

**1. Five extensions do not exist in the `postgres:15` image.** The schema dump issues
`CREATE EXTENSION` for eleven extensions. Six are fine: `plpgsql`, `citext`, `pgcrypto`,
`uuid-ossp`, `pg_stat_statements` are bundled with the image or in contrib. These five are
**not available** and their `CREATE EXTENSION` statements **will error**:

| Extension        | Why it is absent                                    | Consequence for D2                                                                        |
| ---------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pg_cron`        | Supabase-provided, needs `shared_preload_libraries` | `cron` schema is not created, so `legacy-prod-cron.sql` cannot be loaded into this target |
| `pg_net`         | Supabase-provided                                   | Any function body calling `net.*` will not resolve                                        |
| `supabase_vault` | Supabase-specific                                   | `vault` schema absent; verified to hold **0 secrets**, so nothing is lost                 |
| `hypopg`         | Supabase-provided tuning aid                        | Advisory only; no data depends on it                                                      |
| `index_advisor`  | Supabase-provided tuning aid                        | Advisory only; no data depends on it                                                      |

**These five errors are expected and acceptable — but only here.** Enumerate them before the
run and tick them off. **No table, no row and no constraint depends on any of the five.**

**The measured result: 52 errors, and all 52 were attributable to these five extensions.**

| Root cause | Errors |
| --- | --- |
| `CREATE EXTENSION` for the five | 5 |
| `COMMENT ON EXTENSION` for the same five | 5 |
| `GRANT`/`REVOKE` on `cron` schema objects | 13 |
| `GRANT` on `net` schema objects | 5 |
| `GRANT` on `vault` objects | 10 |
| `GRANT` on `hypopg` / `index_advisor` objects | 14 |
| **Total** | **52** |

Also expect **2 benign warnings**: `wal_level is insufficient to publish logical changes`,
on two `CREATE PUBLICATION` statements. The publications are created and inert.

> **This tolerance is scoped to the disposable restore and to these five extensions only.**
> It is not a general licence to ignore errors. **Any other schema or data error is a
> failure.** In particular, treat as a real failure any error touching `CREATE TABLE`,
> `COPY`, `CREATE INDEX`, `ADD CONSTRAINT`, `ALTER TABLE`, function creation, trigger
> creation, view creation, RLS, types or sequences. In the verified run, **zero** errors
> touched any of those. Audit by mapping each failing line number back to its originating
> statement — do not judge by error text alone.

**2. Ten roles do not exist in a fresh container.** The dump carries **801 standalone
`GRANT` statements** plus 79 `ALTER DEFAULT PRIVILEGES` statements naming roles the image has
never heard of. Create all ten before loading the schema:

```bash
for r in service_role authenticated anon dashboard_user \
         pgbouncer supabase_admin supabase_auth_admin supabase_functions_admin \
         supabase_realtime_admin supabase_storage_admin; do
  psql -h localhost -p 55432 -U postgres -d legacy_restore \
    -c "create role $r nologin" || true   # "already exists" here is harmless
done
```

| Group | Roles |
| --- | --- |
| Application roles | `service_role`, `authenticated`, `anon`, `dashboard_user` |
| **Supabase platform roles** | `pgbouncer`, `supabase_admin`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_realtime_admin`, `supabase_storage_admin` |

> **Corrected after D2.** This section originally listed only the four application roles.
> Loading the schema with just those four produced **116 errors**; adding the six platform
> roles reduced that to **52**, eliminating 64. Deriving the list by eye was the mistake —
> it should be derived from the dump, by extracting every role named in a `GRANT`, `REVOKE`
> or `ALTER DEFAULT PRIVILEGES` statement. Note that `normalized` also appears after a
> `FROM` in the dump but is a CTE inside a function body, not a role.

One statement per role, deliberately. A single `DO` block with one
`exception when duplicate_object` handler would swallow the first duplicate and **skip
every remaining role**, leaving grants to fail later for a reason that no longer looks
related.

`postgres` already exists as the container superuser, so it needs nothing. These ten
stand-ins exist **only so the grants apply and can be inspected**. They are `NOLOGIN`,
non-superuser, carry no password and cannot authenticate. The restored copy is a forensic
artefact, not a running application, so the roles need no real privileges of their own.

**4. Application triggers must not fire during the data load.** This is the prerequisite
whose omission caused the first data load to fail, and it is the one with teeth. See §13.3.

**3. The dump requires a psql that understands `\restrict`.** `pg_dump` **15.19** wraps
each file in `\restrict <nonce>` / `\unrestrict <nonce>`. An older psql treats those as
unknown commands and the load fails immediately at the top of the file. Use a client at
**15.14 or newer**; the `postgres:15` image currently ships **15.19**, which is correct.
Those nonces are per-dump random guard tokens introduced as a psql security mitigation —
**they are not credentials and carry no database secret.**

### 13.2 Procedure

**The order below is mandatory, not stylistic.** It is the order that was verified.

| # | Phase | `ON_ERROR_STOP` | Why this position |
| --- | --- | --- | --- |
| 1 | Schema prerequisites — container, database, **ten roles** | n/a | Grants fail without the roles |
| 2 | `legacy-prod-schema.sql` | **off** | The 5 extension errors must not abort the load |
| 3 | **`legacy-prod-auth.sql`** (`auth.users`, `auth.identities`) | **on** | **11 public tables hold FKs into `auth.users`** |
| 4 | `legacy-prod-public-data.sql` | **on** | Depends on auth being present |
| 5 | `legacy-prod-storage-metadata.sql` | **on** | `storage.objects` references `auth.users` |
| 6 | **Explicit FK validation** | n/a | **Mandatory** — see §13.3 |
| — | `legacy-prod-cron.sql` | **never loaded** | `pg_cron` unavailable, so no `cron` schema exists |

```bash
docker run --name kolekto-legacy-restore -e POSTGRES_PASSWORD=<local-throwaway> \
  -p 127.0.0.1:55432:5432 \
  -v "<BACKUP_DIR>:/backup:ro" \
  -d postgres:15
createdb -h localhost -p 55432 -U postgres legacy_restore

# 1. create ALL TEN stand-in roles FIRST — see 13.1 item 2

# 2. schema: NO ON_ERROR_STOP, capture stderr, then audit every error
psql -h localhost -p 55432 -U postgres -d legacy_restore \
  -f legacy-prod-schema.sql 2> schema.err

# 3-5. data: triggers disabled (see 13.3), ON_ERROR_STOP on, one transaction each
for f in legacy-prod-auth.sql legacy-prod-public-data.sql legacy-prod-storage-metadata.sql; do
  psql -h localhost -p 55432 -U postgres -d legacy_restore \
    --set ON_ERROR_STOP=on --single-transaction \
    -c "set session_replication_role = replica" \
    -f "$f"
done

# 6. THEN validate every foreign key explicitly — see 13.3
# legacy-prod-cron.sql is NOT loadable here: pg_cron is unavailable, so the cron schema
# does not exist. Preserve the file; verify its 2 rows by reading it, not by restoring it.
```

Mount the backup directory **read-only** (`:ro`) and bind the port to **`127.0.0.1`** only.
The first protects the artefact structurally rather than by good intentions; the second keeps
the forensic copy — which contains `auth.users.encrypted_password` — off the network.

Use a **throwaway** local password, never a production one, and never print it. All
subsequent commands can run as `docker exec -u postgres`, which uses local peer
authentication and needs no password at all.

Run the schema file **without** `--set ON_ERROR_STOP=on`, so the five expected extension
errors do not abort the load — then read the error log and confirm every error is one of the
five. For the data files, **do** use `ON_ERROR_STOP=on` together with `--single-transaction`:
a `COPY` failure is never acceptable, and the single transaction guarantees a failed load
rolls back completely instead of leaving a partially populated database that looks restored.

PostgreSQL **15**, matching production. Restoring a 15 dump into 17 may work but is not
the thing being verified. The verified run used `postgres:15` at server and client **15.19**.

> **Filename corrected 2026-09-27:** this procedure previously named
> `legacy-prod-data.sql`. The artefact is **`legacy-prod-public-data.sql`**. The auth,
> storage-metadata and cron files were also missing from the steps entirely.
>
> **Order corrected after D2:** this procedure previously loaded `public` before `auth`.
> Eleven public tables hold foreign keys into `auth.users` — `profiles`, `admin_users`,
> `campaigns`, `kyc_documents` (2 FKs), `kyc_verification_history`, `notifications`,
> `password_reset_otps`, `payout_accounts`, `push_notification_events`,
> `push_subscriptions`, `user_identity`. Within each file `pg_dump` already ordered the COPY
> blocks by dependency, so only the cross-file order was wrong.

### 13.3 Historical data loading must not let application triggers fabricate rows

**This is the most important correction in this document, and it was found only by running
the restore.**

The first data load failed like this:

```
ERROR: null value in column "first_name" of relation "profiles"
       violates not-null constraint
CONTEXT: PL/pgSQL function handle_new_user() line 13 at SQL statement
```

Loading `auth.users` fired the live application trigger `on_auth_user_created`, which calls
`handle_new_user()`, which **inserted rows into `public.profiles` that were never in
production.** The failing row carried the restore's own timestamp, not a production one.

> **A `NOT NULL` constraint is the only reason this was caught.** Had `first_name` been
> nullable, the load would have reported success while silently manufacturing profile rows.
> The restore would then have "passed" a row-count check against a database containing
> invented customer records. **Restoring historical data must never execute application
> logic**, because that logic is written to react to new events, and a restore is not a new
> event.

**Required: disable session triggers for every data phase.**

```bash
psql ... --set ON_ERROR_STOP=on --single-transaction \
  -c "set session_replication_role = replica" \
  -f <data-file>
```

`session_replication_role = replica` suppresses all non-replica triggers for the session —
all **18** non-internal triggers, not just the one that failed. It is transaction-scoped
here, requires superuser, and is the same mechanism `pg_dump --disable-triggers` relies on.
It leaves `CHECK` and `NOT NULL` constraints fully enforced.

**Required consequence: foreign keys must then be validated explicitly.** Foreign keys are
implemented as triggers, so disabling triggers also defers FK enforcement during the load.
That debt must be settled immediately afterwards, and not with a spot check:

```sql
do $$
declare r record; n bigint; checked int := 0; violated int := 0;
begin
  for r in
    select con.conname, con.conrelid::regclass::text as child,
           con.confrelid::regclass::text as parent,
           (select string_agg('c.'||quote_ident(a.attname), ',' order by u.ord)
              from unnest(con.conkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid=con.conrelid and a.attnum=u.attnum) as ccols,
           (select string_agg('p.'||quote_ident(a.attname), ',' order by u.ord)
              from unnest(con.confkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid=con.confrelid and a.attnum=u.attnum) as pcols
    from pg_constraint con where con.contype='f' order by 2,1
  loop
    execute format(
      'select count(*) from %s c where (%s) is not null
         and not exists (select 1 from %s p where (%s)=(%s))',
      r.child, r.ccols, r.parent, r.pcols, r.ccols) into n;
    checked := checked + 1;
    if n > 0 then
      violated := violated + 1;
      raise notice 'FK VIOLATION: % on % -> % : % orphan row(s)',
        r.conname, r.child, r.parent, n;
    end if;
  end loop;
  raise notice 'FKs checked: %   violations: %', checked, violated;
end $$;
```

**Pass condition: `FKs checked: 80   violations: 0`.** That is what the verified run
returned. This is *stronger* than load-time enforcement, because it tests all 80 constraints
against the fully populated database rather than incrementally as rows arrive.

**The restore target must not be:** legacy production, legacy test, any new project, or
the Kolekto local development stack — that last one matters, because the local stack
holds the new schema and a developer's work, and `collections` and `profiles` exist in
both with different shapes.

## 14. Restore verification

> ## This has been done, and it passed.
>
> **[D2-RESTORE-VERIFICATION.md](D2-RESTORE-VERIFICATION.md) — result: PASS, 2026-09-27.**
> 45 of 45 control totals reproduced · 80 of 80 foreign keys validated, zero orphans ·
> 57 COPY blocks, zero data errors · 52 schema errors, all attributable to the five
> unavailable extensions, zero structural failures · exactly 53,743 public rows ·
> **the 359-kobo drift reproduced.**
>
> The checklist below remains the standing procedure for any future restore.

The backup is not verified until the restored copy reproduces the baseline. Compare, on
the restored database, every figure in
[legacy-control-totals.md](legacy-control-totals.md):

**Auth** — `auth.users` 623 · `profiles` 622 · identities 623 · users without profile 1
· profiles without user 0.

**Collections** — 275 · status: active 237, closed 21, deleted 12, paused 4, rejected 1
· `collection_type`: fixed 173, tiered 74, fundraising 13, open_pool 11, ticket 4.

**Contributions** — 5,576 · paid 3,934 (₦46,069,689.35) · pending 1,628
(₦21,366,293.63) · duplicate_voided 14 (₦340,500.00).

**Deposits** — 6,201 · success 4,260 (₦60,423,653.63) · pending 1,939 · abandoned 2 ·
gross ₦90,020,641.26 · **unattributed 1,317 (₦28,910,087.00), of which success 923
(₦19,799,220.00)**.

**Withdrawals** — 292 · approved 239 (₦41,653,495.80) · success 43 (₦4,550,917.00) ·
rejected 10 (₦478,460.00).

**Wallets** — 245 · available ₦114,038.30 · gross ₦47,004,759.50 · net
₦46,069,692.94 · withdrawn ₦46,204,412.80 · **the ₦3.59 drift must reproduce**.

**Referential integrity** — all ten orphan checks zero; `collections_without_wallet` 30.
Then the **exhaustive** check of §13.3: `FKs checked: 80   violations: 0`.

**Structural** — 53 `public` tables · 99 tables all schemas · **94** functions · **18**
triggers · **8** views · 80 policies · 78 RLS enabled · 3 RLS forced · 14 enum types ·
4 sequences · **300** constraints · **308** indexes. See §4.2 for how each reconciles.

**Row count** — **exactly 53,743**, per §4.1. Not 53,742.

**If any figure differs, STOP. The backup is not verified.** Do not repair the restored
database by hand, and do not adjust data to make a total match. Preserve the container and
investigate.

One caveat worth stating: production is live, so a dump taken later than the 2026-09-26
baseline may legitimately differ. That is why the **dump's own high-water mark** is
recorded at dump time and the comparison is made against figures captured _from the
dump_, with the 2026-09-26 baseline as a sanity bound rather than an exact target.

**This is exactly what happened, and it is the reason §4.1 exists.** `settlement_runs` grew
from 56 to 57 between the baseline and the dump, so the artefact holds 53,743 rows against a
53,742 baseline. The restored copy reproduced 53,743. **A legitimate difference of this kind
is evidence the high-water-mark design works — not a defect, and never something to edit
away.** Distinguish it from corruption by the test that matters: every financial control
total must be unchanged, and the growth must be explicable by a known writer. Here the
writer is the nightly settlement cron, and no financial total moved.

## 15. High-water mark recording

Captured **inside the dump transaction**, so the mark and the data are consistent. The
method and the values already captured are in
[live-production-delta-strategy.md](live-production-delta-strategy.md) §3.

---

## What I need from you

| #      | Decision                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | Approve the `pg_dump` approach, or name a different mechanism                                                                                                 |
| **B2** | Provide the production direct connection string, **or** run the commands yourself — I do not have production database credentials and have not asked for them |
| **B3** | Confirm the storage location outside the repository                                                                                                           |
| **B4** | Decide `auth`: full schema, or `auth.users` + `auth.identities` only (**I recommend the latter** — it excludes live session and token material)               |
| **B5** | Separately approve the Storage object download, given 53 identity documents                                                                                   |
| **B6** | Confirm the restore target is a disposable local PostgreSQL 15 container                                                                                      |

**Nothing runs until B1–B4 are answered.** B5 is its own gate. B6 can follow.
