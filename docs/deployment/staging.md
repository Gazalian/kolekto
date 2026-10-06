# Deploying to staging

**Target:** `kwolxuoeqwuedydxzncb` ("kolekto staging") only.
**Environment detail:** [docs/environments/staging.md](../environments/staging.md)

There are two separate things to deploy: the **database schema** (done, and
repeatable below) and the **web application** (not yet possible — no hosting
platform has been chosen).

## 1. Applying migrations to staging

Staging's migration history is the repository's. Migrations are applied in order,
forward only, with the Supabase CLI.

```bash
# 0. Be logged in as an account in the staging organisation.
supabase projects list          # kwolxuoeqwuedydxzncb visible; legacy projects not

# 1. Verify the link. STOP if this is not the staging ref.
cat supabase/.temp/project-ref  # kwolxuoeqwuedydxzncb

# 2. See what would change, without changing anything.
supabase db push --linked --dry-run

# 3. Apply.
supabase db push --linked

# 4. Confirm local and remote history match exactly.
supabase migration list --linked
```

**Never, against any remote project:** `supabase db reset`, `supabase config push`,
editing or deleting an already-applied migration, or `--include-all` to force
old versions in. A defect in an applied migration is fixed by a **new** forward
migration.

**After every push, compare structure against local** with the fingerprint query
in [STAGING-ENVIRONMENT-VALIDATION.md §5](../migration/STAGING-ENVIRONMENT-VALIDATION.md).
Counts alone are not enough: on 2026-09-28 every count matched while one RLS
policy had silently resolved a different operator (§13, finding F-2).

### A known hazard in `supabase db push`

CLI 2.109.1 pushes as a temporary role, `cli_login_postgres`, whose search path
**does not include the `extensions` schema**. Any stored expression parsed during a
push — an RLS policy, a view, a column default — that relies on an operator from an
extension (citext's `=`, in particular) resolves differently on staging than
locally, **without an error**. Until this is fixed at the source (finding F-2),
verify structure after every push.

### Rollback

Staging is new, empty of real data, and disposable. A failed migration rolls back
its own transaction; earlier migrations stay applied. A full rollback is
recreating the staging project — a founder action.

## 2. Validating staging

The full procedure and the 2026-09-28 results are in
[STAGING-ENVIRONMENT-VALIDATION.md](../migration/STAGING-ENVIRONMENT-VALIDATION.md). In short:

| Check | How |
|---|---|
| Identity | `supabase/.temp/project-ref`, `supabase projects list` |
| History | `supabase migration list --linked` — local = remote |
| Structure | Catalog counts **and** definition fingerprints, staging vs local |
| Clean data | Row counts: only migration-seeded reference tables are non-empty |
| Anonymous surface | REST reads/writes with the publishable key must return 401 |
| Test suites | Run locally: `npm run typecheck`, `npm run invariants`, `npm test`, `npm run lint`, `npm run db:test`, `npm run build` |

pgTAP runs against the **local** stack (`supabase test db` defaults to local even
when a project is linked). Running it against staging would install `pgtap` and
write fixture rows there, so it is not done; the structural fingerprint is what
ties local's test results to staging's schema.

## 3. Deploying the web application — not yet possible

**No hosting platform has been chosen.** The repository has no `vercel.json`,
`Dockerfile`, `fly.toml`, `netlify.toml` or `render.yaml`, and CI has **no deploy
job** — its own comment says deployment is configured once staging exists. It now
does, so this is the next infrastructure decision.

What is already true of the application:

- `npm run build` **passes** (2026-09-28).
- **Server/client boundary holds:** no server-only variable, loader, connection
  string or legacy ref appears in the client bundle.
- **All Supabase addressing is environment-driven.** No legacy ref and no Paystack
  endpoint is hardcoded in application code or configuration.
- `packages/config` fails at startup on a missing variable — there are no defaults.

What a staging deployment needs, in order:

1. **Founder decision: hosting platform** (and whether it can reach the staging
   session pooler over IPv4).
2. **Staging secrets** in that platform's secret store — **not** in Git, not in
   chat: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, a **new**
   `KOLEKTO_SESSION_SECRET`. Plus the public values and
   `KOLEKTO_ENV=staging` and `KOLEKTO_EXPECTED_PROJECT_REF=kwolxuoeqwuedydxzncb`
   (required; the app refuses to start without it). The legacy refs are refused by
   code, so `KOLEKTO_PRODUCTION_PROJECT_REF` stays empty until a new production
   project exists.
3. **Hosted Auth configuration** — code-bearing email template, OTP 300 s / 6
   digits, site and redirect URLs set to the staging app's URL, and SMTP.
4. A **CI deploy job** for staging only, gated on the existing CI jobs. No
   production deployment configuration until a production project exists.

**Paystack stays unconnected** after all four. The webhook URL staging will
provide is one prerequisite of M8.9, not all of them.
