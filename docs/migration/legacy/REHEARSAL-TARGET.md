# Rehearsal Target

The rehearsal target is an isolated PostgreSQL container used exclusively for
import rehearsals. It is separate from the local development database, the D2
legacy restore, staging, and production.

## Connection details

| Property | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `5455` |
| Database | `postgres` |
| User | `postgres` |
| Container name | `kolekto-rehearsal-target` |
| Connection string | `postgres://postgres:@127.0.0.1:5455/postgres` |

## Creation

The rehearsal target is created via Docker:

```bash
npm run rehearsal:up
```

This starts a fresh PostgreSQL container on port 5455, applies all 94 migrations
via Supabase, and leaves it ready for import runs.

## Start / Stop

```bash
# Start (if stopped)
docker start kolekto-rehearsal-target

# Stop (preserves data)
docker stop kolekto-rehearsal-target

# Check status
docker ps --filter name=kolekto-rehearsal-target
```

## Isolation guarantees

The rehearsal target is isolated from every other environment:

| Environment | Address | Isolation |
|---|---|---|
| Local development | `127.0.0.1:54322` | Different port, different container |
| D2 legacy restore | `127.0.0.1:5544` | Different port, different container, read-only |
| Staging (kwolxuoeqwuedydxzncb) | Supabase cloud | Not connected, no credentials used |
| Production | Supabase cloud | Not connected, no credentials used |

The importer test suite enforces this by connecting only to port 5455 and
skipping if unreachable.

## Migration application

All 94 migrations are applied during `rehearsal:up`. To verify:

```bash
docker exec kolekto-rehearsal-target psql -U postgres -d postgres \
  -c "select count(*) from supabase_migrations.schema_migrations;"
```

Expected: 94.

## Protected environments

The importer must NEVER connect to:

- **D2 legacy restore** (`127.0.0.1:5544`) — read-only preservation, not a target
- **Staging** — not hosted yet, intentionally untouched
- **Production** — never touched during rehearsal or migration development
- **Paystack** — no payment calls during any migration phase

## Safety checks

Before running an import against the rehearsal target:

1. Confirm the container is running: `docker ps --filter name=kolekto-rehearsal-target`
2. Confirm the port is 5455: `docker port kolekto-rehearsal-target`
3. Confirm migrations are applied: query `supabase_migrations.schema_migrations`
4. Confirm no prior import data conflicts (the test suite's `before()` cleans up)

After running an import:

1. Run the reconciliation (`reconcile.ts`) against the target
2. Verify zero financial movement (ledger, financial_events = 0)
3. Verify immutability (UPDATE on migration tables is refused)

## Inspecting state

```bash
# Connect interactively
docker exec -it kolekto-rehearsal-target psql -U postgres -d postgres

# Quick counts
docker exec kolekto-rehearsal-target psql -U postgres -d postgres -c "
  select 'users' as tbl, count(*) from public.users
  union all select 'collections', count(*) from public.collections
  union all select 'import_runs', count(*) from migration.import_runs;"
```

## Teardown

To safely destroy the rehearsal target:

```bash
docker stop kolekto-rehearsal-target
docker rm kolekto-rehearsal-target
```

This destroys all data in the container. It can be recreated with `npm run rehearsal:up`.

The rehearsal target is disposable by design — it exists only for import
rehearsals and can be recreated at any time.
