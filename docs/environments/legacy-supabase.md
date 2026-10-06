# Legacy Supabase projects — access and switching

**Read this before running any Supabase CLI command.** It answers one question:
*which project am I about to touch?*

**No key, token, JWT secret, password or Paystack credential appears in this
document.** Project refs are not secrets — they appear in every URL the browser
sees — so they are named here deliberately, because inferring which project is
which from a URL is how the expensive mistake happens.

**Companion:** [docs/phase-4/environments.md](../phase-4/environments.md) covers the
new environments and their release gates.

---

## 1. Every project, and what may be done to it

| Project ref | Name | Region | Postgres | Status | Access |
|---|---|---|---|---|---|
| `busfgcmbndleljklrcbd` | kolekto prod | eu-central-1 | 15.8.1.094 | **legacy / LIVE** | **READ-ONLY, migration only** |
| `lpeeckqsltxohppheucz` | Kolekto test | eu-north-1 | 17.4.1.064 | legacy / test | **READ-ONLY, migration only** |
| *(not yet created)* | new staging | — | — | future | will be the app's staging target |
| *(not yet created)* | new production | — | — | future | will be the app's production target |

All four live in organization `Kolekto Org` (`wzkhbvbimazkabmdbawa`). The new
staging and production projects are to be created in a **new account/organization**.

**Note the Postgres major-version gap:** legacy production is 15, legacy test is 17.
Test is *ahead* of production, so test is not a reliable rehearsal surface for
version-sensitive behaviour.

---

## 2. Prohibited operations

| Operation | Legacy prod | Legacy test | New staging | New production |
|---|---|---|---|---|
| `supabase db push` | **NEVER** | **NEVER** | yes | release process |
| `supabase db reset` | **NEVER** | **NEVER** | with confirmation | **NEVER** |
| `supabase migration up` | **NEVER** | **NEVER** | yes | release process |
| Any INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE | **NEVER** | **NEVER** | yes | via `app.*` functions |
| Change RLS, grants or auth config | **NEVER** | **NEVER** | yes | release process |
| `SELECT` for migration discovery | **yes** | **yes** | yes | yes |
| Point the application runtime at it | **NEVER** | **NEVER** | yes | yes |

**The new Kolekto schema must never be deployed into either legacy project.** The
79 migrations assume an empty database and several create tables whose names the
legacy schema already uses (`collections`, `profiles`) with different shapes. A
`db push` against either legacy project would collide at best and corrupt at worst.

---

## 3. Identify the current project before doing anything

Three independent checks. Run them; do not assume.

```bash
# 1. Is this repository linked to a cloud project at all?
cat supabase/.temp/project-ref 2>/dev/null || echo "NOT LINKED (local only)"

# 2. What is the application configured to talk to?
grep NEXT_PUBLIC_SUPABASE_URL .env.local apps/web/.env.local

# 3. What does the CLI think?
npx supabase projects list
```

Interpretation:

| Signal | Meaning |
|---|---|
| no `project-ref` file, URL is `127.0.0.1:54321` | **local only.** Safe. This is the normal state. |
| `project-ref` contains `busfgcmbndleljklrcbd` | **linked to LEGACY PRODUCTION. Stop.** Unlink before running anything. |
| `project-ref` contains `lpeeckqsltxohppheucz` | linked to legacy test. Stop and confirm intent. |

**State at the time of writing: NOT LINKED.** `supabase/.temp/project-ref` does not
exist, and both `.env.local` files point at the local Docker stack. The application
runtime cannot reach either legacy project.

---

## 4. Switching, deliberately

Environment switching is never incidental. Every transition should be stated out
loud: **current project → target project → why → what will be done → what will not
be done.**

```bash
# Unlink whatever is linked.
npx supabase unlink

# Link legacy production — READ-ONLY discovery only.
# Do NOT follow this with db push, db reset, or migration up.
npx supabase link --project-ref busfgcmbndleljklrcbd

# Link legacy test — READ-ONLY discovery only.
npx supabase link --project-ref lpeeckqsltxohppheucz

# Later: new staging.
npx supabase link --project-ref <NEW_STAGING_REF>

# Later: new production. Via the release process, not by hand.
npx supabase link --project-ref <NEW_PRODUCTION_REF>
```

**`supabase link` alone is read-safe.** The danger is what habitually follows it.
`db push` and `db reset` take the linked project as their target with no second
confirmation, so a link left in place is a loaded command.

**Unlink when discovery finishes.** The safe resting state for this repository is
unlinked.

### For read-only discovery, prefer not linking at all

This baseline was produced without linking anything, using account-level MCP access
with the project ref named explicitly on every single query. That is safer than
linking, because there is no ambient target for a later command to inherit.

---

## 5. Guards that already exist in the repository

| Guard | What it does |
|---|---|
| `packages/config` `loadConfig()` | Throws at process start if a non-production `KOLEKTO_ENV` is pointed at `KOLEKTO_PRODUCTION_PROJECT_REF` |
| `npm run db:reset` wrapper | Takes a backup and refuses without `KOLEKTO_CONFIRM_RESET=yes` |
| CI: no `.env` or link file tracked | Fails if `supabase/.temp/` or any `.env` is committed — the legacy estate committed `.env` twice, and a stale `linked-project.json` once pointed a fresh clone at production for three weeks |
| CI: gitleaks over full history | Secret scanning |

**A gap worth closing (`E-ENV-1`):** `KOLEKTO_PRODUCTION_PROJECT_REF` refers to the
*new* production project, which does not exist. Nothing in the repository names the
two **legacy** refs as forbidden. A guard listing them explicitly would make an
accidental legacy connection fail loudly rather than succeed quietly. Not
implemented.

---

## 6. Secrets — do not place these here

This document must never contain: service-role keys, anon keys, JWT secrets,
database passwords, Paystack keys of any kind, cron shared secrets, or connection
strings with credentials.

Two secrets are known to need rotation. Recorded by **type and location only**, with
values in neither this file nor any other artifact:

| # | Type | Location | Severity |
|---|---|---|---|
| 1 | Cron shared secret | `cron.job` command, jobid 5, legacy production | **HIGH** |
| 2 | Paystack **live** secret key | `kolekto-be-old/.env`, `.env.bak.pre-email-fix`, and 2 diffs in that repo's git history | **HIGH** |

Rotating either touches live systems and must be scheduled with a deploy. Neither
was rotated, printed or copied.
