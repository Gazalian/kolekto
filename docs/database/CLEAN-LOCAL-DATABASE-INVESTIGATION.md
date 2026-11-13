# Clean Local Database — Investigation Report

> Read-only investigation. Nothing was modified, deleted, started or stopped.
> Produced: 2026-10-30.

---

## 1. Environment Separation

### Three environments, three boundaries

| Environment | Project identifier | Database host | Organisation |
|---|---|---|---|
| **Local Docker** | `kolekto` (config.toml `project_id`) | `127.0.0.1:54322` | N/A (Docker) |
| **Remote staging** | `kwolxuoeqwuedydxzncb` | `kwolxuoeqwuedydxzncb.supabase.co` | `gffmdnyuzihxoqievxbc` |
| **Legacy production** | `busfgcmbndleljklrcbd` | hosted (Supabase) | separate org |

### Application environment variables (all three `.env.local` files)

All three files (root, `apps/web`, `apps/worker`) set:
- `KOLEKTO_ENV=local`
- `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`
- `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- `KOLEKTO_PRODUCTION_PROJECT_REF=` (empty)
- `KOLEKTO_EXPECTED_PROJECT_REF=` (empty)

**All database URLs point to localhost. No environment variable in any `.env.local` file contains a remote host.**

### Runtime guards in `packages/config/src/env.ts`

| Guard | What it prevents |
|---|---|
| `assertEnvironmentTarget` — local must be loopback | `KOLEKTO_ENV=local` refuses any non-loopback Supabase URL |
| `LEGACY_PROJECT_REFS` constant | Hard-refuses both `busfgcmbndleljklrcbd` and `lpeeckqsltxohppheucz` in every environment |
| `assertNotProduction` | Non-production env refuses to connect to the production project ref |
| `KOLEKTO_ENV=staging` requires `KOLEKTO_EXPECTED_PROJECT_REF` | Staging must explicitly name its project; cannot silently connect |

### Supabase CLI link state

`supabase/.temp/project-ref` contains `kwolxuoeqwuedydxzncb` (staging).
`supabase/.temp/linked-project.json` names "kolekto staging".

**This link matters only for commands that take `--linked` or `--db-url`.** All local npm scripts (`db:start`, `db:reset`, `db:migrate`, `db:test`) use the local stack. The runbook explicitly warns: "Never add `--linked`, `--db-url <remote>`, `--project-ref`, or run `supabase db push`."

### Can local operations accidentally target staging?

**No**, unless someone explicitly adds `--linked` or `--db-url` flags to a command. The following safeguards are in place:
1. Every `npm run db:*` script targets the local Docker stack by default.
2. `supabase start`, `supabase db reset`, `supabase migration up --local` operate on Docker.
3. `packages/config` refuses to start the app against a non-loopback URL when `KOLEKTO_ENV=local`.
4. The backup and restore scripts address the Docker container `supabase_db_kolekto` by name.

### Connection to the old live platform

**None.** No environment variable, configuration file, or script references the legacy production host. Both legacy project refs are hard-refused in code.

---

## 2. Where the Migrated Data Exists

### Local Docker database (volume `supabase_db_kolekto`)

The most recent backup (`pre-reset-2026-10-22T14-23-16-896Z.sql`, 860 lines, 51 COPY tables) shows the local database contained:

- **3 seed users** (Aisha, Tunde, Ngozi — `@example.test` addresses)
- **3 test users** from E2E test runs (`bad-otp-*@example.test`, `path-c-*@example.test`)
- **1 real user**: the product owner (gazalianfellow@gmail.com, "Ghazali Habeebulahi")
- Seed communities, members, collections, obligations, tiers
- Communities and data created during manual testing by the product owner
- Audit logs from those sessions
- Notification events and delivery records
- Empty financial tables (no real money moved)

### Remote staging (`kwolxuoeqwuedydxzncb`)

**Not inspected** (not authorised by this investigation). The staging environment documentation confirms it was migrated and validated on 2026-09-28 and lives in a separate Supabase organisation.

### Both environments contain copies?

Based on documentation: the staging project received migrated data from the legacy system on 2026-09-28. The local database contains seed data plus manual testing data. These are **independent datasets** — local was never a copy of staging.

---

## 3. Inventory of Local Data That Would Be Lost

If the local database is cleared, the following is destroyed:

### Auth users (auth.users, auth.identities)
| User | Type | Notes |
|---|---|---|
| aisha@example.test | Seed | Recreated by `seed.sql` |
| tunde@example.test | Seed | Recreated by `seed.sql` |
| ngozi@example.test | Seed | Recreated by `seed.sql` |
| bad-otp-*@example.test (×2) | E2E test artefact | Not needed |
| path-c-*@example.test | E2E test artefact | Not needed |
| gazalianfellow@gmail.com | **Product owner's test account** | Lost; must re-sign-up |

### Application data (public.* tables)
- **Communities**: seed community "CSC Unilorin" + personal workspaces for each user + any manually created communities
- **Members**: 3 seed members + any manually added
- **Collections**: 2 seed collections (dues + event) + any manually created
- **Obligations, tiers, codes**: seed data + any created during testing
- **Audit logs**: all local testing activity
- **Notification records**: events, deliveries, send attempts from notification testing
- **Financial tables**: empty (no real payments processed locally)

### Storage objects (volume `supabase_storage_kolekto`)
- Any collection cover images uploaded during manual testing
- One storage bucket defined: `collection-covers`

### Migration schema (`migration.*`)
- `migration.import_runs` and related provenance tables
- Likely empty locally (migration runs target staging, not local)

### What is NOT lost
- All 120 migration files (in git)
- `seed.sql` (in git)
- `config.toml` (in git)
- All 15 existing backup files in `backups/`
- Remote staging data (untouched)
- Legacy production data (untouched)
- All application code, tests, documentation (in git)

---

## 4. Current Local Database Schema and Migration State

### Containers are stopped
All Supabase containers are currently stopped. The database cannot be queried directly.

### Migration files on disk
**120 migration files** in `supabase/migrations/`, spanning:
- `20260917120000` (extensions and schemas) through `20261029100100` (fix count_collection_publish_recipients)

### Schemas created by migrations
- `public` — application domain, exposed via PostgREST
- `app` — helper functions (has_permission, guards), not exposed
- `private` — operational views, not exposed
- `migration` — import provenance tables, not exposed

### Extensions required
`pgcrypto`, `citext`, `pg_trgm`, `pg_cron`, `pg_net`, `pgmq`, `pgtap` — all created in the first migration.

### Storage bucket
One bucket: `collection-covers` (public read, server-write only), created by migration `20260920160500`.

### Migration tracker state
Cannot be inspected (containers stopped). Previous investigations noted inconsistencies. The Supabase CLI tracks applied migrations in `supabase_migrations.schema_migrations` inside the database — this is recreated cleanly by `supabase db reset`.

---

## 5. Can the Schema Be Reconstructed From Scratch?

**Yes.** The repository contains everything needed:

1. **120 ordered migration files** that build the complete schema from an empty Postgres database.
2. **`seed.sql`** that populates synthetic test data (3 users, 1 community, members, collections).
3. **`config.toml`** that configures the local stack (ports, auth, storage limits).
4. **`supabase db reset`** (via `npm run db:reset`) replays all migrations and seeds in order.

The runbook (section 3, Path A) documents this as the standard clean-rebuild path:
```
KOLEKTO_CONFIRM_RESET=yes npm run db:reset
```

This command:
1. Takes a backup first (if the container is running)
2. Drops the local database
3. Replays all 120 migrations in order
4. Runs `seed.sql`

---

## 6. Migration or Schema Problems That Could Prevent Reconstruction

### Known: migration tracker inconsistencies
Previous sessions identified that the local `supabase_migrations.schema_migrations` table may be out of sync with the migration files on disk. **This is irrelevant for a clean start** — `supabase db reset` drops and recreates the tracker from scratch.

### Known: CLI version sensitivity
The CLI is pinned to **2.109.1**. The runbook warns: "CLI version is pinned to 2.109.1 (config.toml is authored for it; `latest` fails to parse)." A wrong CLI version would cause parse errors in `config.toml`.

### Known: `.temp/storage-migration` pin
Contains `drop-bucketid-objname-index`. This is a Supabase internal storage migration marker. Must not be deleted — the CLI uses it to determine which internal storage migrations to apply.

### Potential: extension availability
All required extensions (`pg_cron`, `pg_net`, `pgmq`, `pgtap`) must be available in the Docker Postgres image. They are standard in the Supabase local image matching CLI 2.109.1 — no issue expected.

### No missing prerequisites identified
The first migration creates all schemas and extensions. Each subsequent migration builds on the previous ones. The chain is complete and self-contained.

---

## 7. Does Clearing Local Storage Require Separate Handling?

**Yes.** There are two Docker volumes:

| Volume | Contents | Cleared by `supabase db reset`? |
|---|---|---|
| `supabase_db_kolekto` | PostgreSQL data directory | **Yes** — reset drops and recreates the database |
| `supabase_storage_kolekto` | Uploaded files (collection covers) | **No** — reset does not touch the storage volume |

If the goal is a completely clean local environment, the storage volume should also be cleared. However:
- The `collection-covers` bucket definition is in a migration and will be recreated by reset.
- The **files inside** the bucket (actual uploaded images) are in the storage volume and survive a database reset.
- Orphaned files in the storage volume (references gone from the database) are harmless but untidy.

**Options:**
- A. Accept orphaned files — they consume negligible space and cause no errors.
- B. Delete the storage volume separately — requires `docker volume rm supabase_storage_kolekto` when containers are stopped.

---

## 8. Do Local Startup Resource Constraints Remain?

### Machine specifications
- **Physical RAM**: ~8 GB (8,463,495,168 bytes)
- **Docker VM allocation**: ~3,856 MiB (3.77 GiB)
- **Docker version**: 29.9.2

### Previous failure analysis
The previous investigation established that Realtime, Storage, pg-meta and Studio failed health checks. The Supabase CLI has a fixed health-check timeout window, and the constrained Docker VM did not bring all services up within that window.

### Does a clean database help?
**Marginally.** An empty database is slightly faster to start (less WAL to replay, less to checkpoint), but the startup bottleneck is the number of Docker containers competing for 3.77 GiB:
- Postgres
- GoTrue (auth)
- PostgREST (API)
- Realtime
- Storage
- pg-meta
- Studio
- Mailpit

That is 8 containers sharing ~3.8 GiB. The issue is total memory pressure, not database size. A clean database will not materially reduce this.

### Mitigation options (not part of this plan)
- Increase Docker VM memory allocation (requires Docker Desktop settings change).
- Disable non-essential services: `analytics` is already disabled; `edge_runtime` is already disabled. Studio could be disabled (`[studio] enabled = false`) for headless development.
- Accept partial startup: if Postgres, GoTrue, PostgREST and Mailpit start, the app and worker can function without Realtime, Studio or pg-meta.

---

## 9. Safest Proposed Clean-Start Procedure

### Prerequisites
1. Docker Desktop is running (confirmed: Docker 29.9.2 is running).
2. All Supabase containers are stopped (confirmed: no running containers).
3. Supabase CLI is version 2.109.1 (must be verified before execution).
4. Existing backups in `backups/` are preserved (15 files currently exist).

### Procedure

**Phase 1: Verify and protect (read-only)**
1. Verify the CLI version.
2. Verify `supabase/.temp/` files are intact.
3. Verify `backups/` directory contains existing backups.
4. Verify no other process is using the Docker volumes.

**Phase 2: Clear local data (destructive — requires explicit approval)**
5. Delete the database volume: `docker volume rm supabase_db_kolekto`
6. Optionally delete the storage volume: `docker volume rm supabase_storage_kolekto`
7. Optionally delete the edge runtime volume: `docker volume rm supabase_edge_runtime_`

**Phase 3: Rebuild**
8. Start the local stack: `npm run db:start` (which runs `supabase start`)
   - This creates fresh Docker volumes automatically.
   - It replays all 120 migrations on the new empty database.
   - It runs `seed.sql` to populate synthetic test data.
9. Verify the stack is up and healthy.

**Phase 4: Validate**
10. Run `npm run db:test` (pgTAP test suite).
11. Run `npm run db:diff` to confirm zero schema drift.
12. Run `npm run verify` (typecheck, invariants, unit tests).

---

## 10. Exact Commands, in Execution Order

```bash
# Phase 1: Verify (read-only)
supabase --version                              # Must print 2.109.1
cat supabase/.temp/project-ref                  # Must print kwolxuoeqwuedydxzncb
ls backups/                                     # Confirm 15 existing backups
docker ps -a --filter name=supabase             # Confirm no running containers

# Phase 2: Clear local data (DESTRUCTIVE — requires approval)
docker volume rm supabase_db_kolekto            # Deletes ALL local PostgreSQL data
docker volume rm supabase_storage_kolekto       # Deletes ALL local uploaded files
docker volume rm supabase_edge_runtime_         # Deletes edge runtime cache (empty)

# Phase 3: Rebuild
npm run db:start                                # supabase start — creates new volumes,
                                                # replays migrations, seeds

# Phase 4: Validate
npm run db:test                                 # pgTAP suites
npm run db:diff                                 # Schema drift check (empty = pass)
npm run verify                                  # Typecheck, invariants, unit tests
```

---

## 11. Expected Results and Rollback Options

### Expected results
- Fresh PostgreSQL database with all 120 migrations applied.
- Seed data: 3 synthetic users, 1 community, members, collections, obligations.
- Empty `collection-covers` storage bucket (no uploaded files).
- Clean migration tracker matching all 120 files on disk.
- All pgTAP tests passing.

### Rollback options

| If something goes wrong | Recovery |
|---|---|
| Volume deletion completed but `supabase start` fails | Volumes are already gone; retry `supabase start`, or increase Docker memory and retry |
| Migrations fail partway | Fix the failing migration, then `supabase db reset` to retry from scratch |
| Need the old data back | Restore from `backups/pre-reset-2026-10-22T14-23-16-896Z.sql` using `npm run db:restore` (requires the stack to be running with schema applied first) |
| Need the product owner's test account | Re-sign-up with the same email after rebuild |

### What cannot be recovered
- Uploaded files in the storage volume (no backup of these exists outside Docker).
- The exact state of the old migration tracker (irrelevant for a clean start).

---

## 12. Every Destructive Operation Required

### Operation 1: `docker volume rm supabase_db_kolekto`

**What it removes:** The PostgreSQL data directory for the local `kolekto` project. All local database tables, rows, auth users, migration tracker state, and WAL files.

**Why it cannot affect remote staging:** This is a Docker volume on the local machine. Docker volumes are local filesystem storage. The command takes a volume name, not a network address. The staging project `kwolxuoeqwuedydxzncb` runs on Supabase's hosted infrastructure in eu-west-2 and is not addressable by a `docker volume rm` command.

**Why it cannot affect legacy production:** Same reason. The legacy production project `busfgcmbndleljklrcbd` runs on Supabase's hosted infrastructure. No Docker command on this machine can reach it.

### Operation 2: `docker volume rm supabase_storage_kolekto`

**What it removes:** Uploaded files from the local Storage service (collection cover images from manual testing).

**Why it cannot affect remote staging or legacy production:** Same as Operation 1 — this is local Docker filesystem storage, not a network operation.

### Operation 3: `docker volume rm supabase_edge_runtime_`

**What it removes:** Edge runtime cache (empty — edge functions are disabled in config.toml).

**Why it cannot affect remote staging or legacy production:** Same as Operations 1 and 2.

### Operation 4: `npm run db:start` / `supabase start`

**What it does:** Starts Docker containers for the local Supabase stack, creates fresh volumes, applies migrations and seeds.

**Why it cannot affect remote staging or legacy production:** `supabase start` operates exclusively on the local Docker stack defined by `config.toml`. It does not connect to any remote project. The `config.toml` comment explicitly states: "This file describes the LOCAL stack only."

---

## Approval Checkpoint

**This report is the deliverable. No data has been deleted, no volumes removed, no database reset, no migrations run.**

The product owner should review:
1. The data inventory in §3 — confirm it is disposable.
2. The storage volume decision in §7 — decide whether to clear uploaded files.
3. The resource constraint reality in §8 — startup failures may persist regardless.
4. The exact commands in §10 — authorise each destructive step.

Awaiting explicit approval before executing any destructive operation.
