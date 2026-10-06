# Environments

**Read this before running anything that writes.** It answers one question:
*which database am I about to touch?*

**Opened:** 2026-09-24 (M8.2)
**Authority:** [ADR 0007 — environment isolation](../adr/0007-environment-isolation.md)
**Companions:** [financial decisions](financial-decisions.md) ·
[provider assumptions](provider-assumptions.md) ·
[Phase 4 plan](phase-4-implementation-plan.md)

---

## The Supabase projects that exist, and what each one is

There are more projects in play than "local, staging, production", and mixing
them up is the single most expensive mistake available in this repository. All
of them are named here so no one has to infer which is which from a URL.

| Project ref | What it is | May the new app connect? |
|---|---|---|
| *(local Docker)* | The local stack. `project_id = "kolekto"` in `supabase/config.toml`, API on `54321`, database on `54322`. | **Yes.** This is where you work. |
| **`kwolxuoeqwuedydxzncb`** | **NEW Kolekto STAGING.** "kolekto staging", organisation `gffmdnyuzihxoqievxbc`, eu-west-2, Postgres 17. Created 2026-09-26; migrated and validated 2026-09-28. | **Yes — staging only.** See §STAGING. |
| `lpeeckqsltxohppheucz` | The **legacy TEST** project, "Kolekto test". **Not staging.** Kept intact as a reference snapshot of the old estate. | **Never.** Not wiped, not reset, not migrated, not repurposed. |
| `busfgcmbndleljklrcbd` | **LEGACY PRODUCTION.** The live system, currently processing real customer transactions. | **Never.** Not read, not written, not linked, not migrated. |
| *(does not exist)* | The future **new** production project. | **Not created.** |

> **Superseded 2026-09-28.** This table previously designated the legacy test
> project `lpeeckqsltxohppheucz` as the future staging environment, pending
> founder decision **F-E1**. F-E1 is now **resolved as option B**: a new project
> was created for staging, and the legacy test project is left alone. Anything
> that still describes `lpeeckqsltxohppheucz` as staging is out of date.
>
> The new staging project lives in a **different Supabase organisation** from
> both legacy projects, so a credential scoped to one estate cannot reach the
> other. The CLI account used for staging work sees only the staging
> organisation.

A project ref is not a secret — it appears in every URL the browser sees — so
naming them here is deliberate. What is secret is the keys, and none appear in
this document or any tracked file.

### How to tell where you are pointed, before you run anything

```
grep NEXT_PUBLIC_SUPABASE_URL .env.local apps/web/.env.local
```

`127.0.0.1:54321` is local. Anything else is a hosted project, and you should
know why before proceeding. `packages/config`'s `loadConfig()` also asserts at
process start that a non-production `KOLEKTO_ENV` is not pointed at
`KOLEKTO_PRODUCTION_PROJECT_REF`, and throws rather than continuing — but that
guard only helps once the ref is configured, so it is a backstop and not a
substitute for looking.

---

## LOCAL

| | |
|---|---|
| **Supabase** | Local Docker stack, started with `supabase start` |
| **Payment provider** | `FakePaymentProvider` only. No network, ever. |
| **Data** | Synthetic. Whatever a developer created by using the app. |
| **Secrets** | Development values only. Both `.env.local` files are git-ignored. |
| **Purpose** | Development, pgTAP, unit tests, destructive migration experiments |

**Allowed:** schema experiments, `npm run db:migrate`, running the full pgTAP
suite, `npm run db:backup` and `db:restore`.

**Guarded:** `npm run db:reset` takes a backup first and refuses without
`KOLEKTO_CONFIRM_RESET=yes`. That wrapper exists because a reset destroyed a
developer's local data on 2026-09-20, and they reported it as a product bug —
their account appearing to vanish on sign-in — which took a marker-data
investigation to trace to the command rather than the stack. For applying
migrations the right command is `db:migrate`, which changes the schema and keeps
the data.

---

## STAGING — `kwolxuoeqwuedydxzncb`

**Full operating detail:** [docs/environments/staging.md](../environments/staging.md).
**Validation evidence:** [docs/migration/STAGING-ENVIRONMENT-VALIDATION.md](../migration/STAGING-ENVIRONMENT-VALIDATION.md).

| | |
|---|---|
| **Supabase** | A new, dedicated project in its own organisation. **Not** the legacy test project. |
| **Payment provider** | **Paystack TEST keys only.** Never a live key. |
| **Data** | No real customer money. Synthetic, plus migration-rehearsal data. |
| **Secrets** | Distinct from local and from production. Held in the host's secret store. |
| **Purpose** | Realistic migration rehearsals, E2E, the webhook endpoint Paystack can actually reach |

**Why staging is on the critical path:** a webhook needs a public HTTPS URL.
Until staging is deployed, the Paystack adapter cannot be integration-tested at
all, which is why this is the longest lead-time item in Phase 4 and why no amount
of local work substitutes for it.

**A staging Paystack key must be a test key.** Staging is publicly reachable and
will have a real webhook pointed at it. A live key there would move real money
from a non-production deployment.

### Resolved: why staging is not the legacy test project (F-E1, historical)

> **F-E1 was resolved as option B on 2026-09-28.** The analysis below is kept as
> the record of why. It no longer describes an open question.

`lpeeckqsltxohppheucz` is the legacy **test** project. It holds the legacy schema
and legacy test data — the old estate's own financial forensics report describes
running a reconciliation against it across **57 collections**.

The new Kolekto is 77 migrations that assume an empty database. Several create
tables whose names the legacy schema already uses — `collections`, `members`,
`profiles` — with different shapes. So:

> **Applying the new migrations to this project as it stands will collide with
> the legacy schema.** And the M8.2 brief says explicitly: *do not reset the
> staging database.*

Those two facts cannot both be honoured without a decision. The options, none of
which this milestone took:

| Option | Consequence |
|---|---|
| **A.** Reset/wipe the project and migrate fresh | Simplest technically. Destroys the legacy test data, which may still have forensic value, and the brief currently forbids it. Needs explicit confirmation. |
| **B.** Create a NEW Supabase project for staging; leave the test project alone | Cleanest separation, keeps the legacy test data intact as a reference snapshot. Costs one more project. **Recommended.** |
| **C.** Migrate the new schema into a separate schema namespace inside the same project | Avoids the collision without deleting anything, but staging then does not resemble production, which is most of the value of having a staging environment. |

**F-E1 — RESOLVED, option B.** Staging is `kwolxuoeqwuedydxzncb`. The legacy
test project was not touched.

---

## PRODUCTION — does not exist yet

| | |
|---|---|
| **Supabase** | A **separate, new** project. Not the legacy production project. |
| **Payment provider** | Paystack LIVE, on credentials provisioned for the new system |
| **Data** | Real customer money |
| **Secrets** | Production-only, in the host's secret store, never in a file |
| **Purpose** | Serving real organisers after cutover |

**Not created during M8.2, deliberately.** Creating it early means a project
holding no data, with no PITR, that somebody may point something at.

### Release gates before real money moves

Each of these is a gate, not a nice-to-have. The ledger is append-only and
authoritative, which makes recovery a design requirement rather than an
operational detail: there is no way to reconstruct a balance from anywhere else.

| # | Gate | Status |
|---|---|---|
| P1 | Point-in-time recovery enabled | not done — no project |
| P2 | Backup schedule defined, with retention | not done |
| P3 | Restore **procedure written** | not done |
| P4 | Restore **rehearsed against a real backup** | not done — an untested backup is a hope |
| P5 | RPO and RTO stated and agreed | **not decided** (founder) |
| P6 | Migration rollback plan for the production import | not done |
| P7 | Counsel's answer on holding/timing third-party funds (O-1) | open |
| P8 | Monitoring and financial alarms live (§17 of the plan) | not built |

**PITR cannot be enabled from this repository** and was not touched. It requires
the production project to exist and a paid plan; both are founder actions.

---

## Secret classes

Grouped by what leaking one would cost, because that is what decides where it may
live.

| Class | Variables | May appear in |
|---|---|---|
| **Publishable** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, a Paystack **public** key | The browser. These ship in the JavaScript bundle by design. |
| **Server secret** | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `KOLEKTO_SESSION_SECRET` | Server process only. **Never** a `NEXT_PUBLIC_` name. Never a tracked file. |
| **Operational** | `SENTRY_DSN`, email and messaging API keys | Server process only |

**The `NEXT_PUBLIC_` prefix is load-bearing.** Anything carrying it is compiled
into pages the public can read. The previous estate's audit found an anon key in
a service-role slot; the reverse mistake is worse and is one rename away.

---

## Prohibited operations, by environment

| Operation | Local | Staging | Legacy production | New production |
|---|---|---|---|---|
| `supabase db reset` | with `KOLEKTO_CONFIRM_RESET=yes` | **no** (F-E1) | **never** | **never** |
| Apply migrations | yes | after F-E1 | **never** | via release process |
| Live Paystack keys | **never** | **never** | untouched | yes, when gated |
| Test Paystack keys | yes | yes | **never** | **never** |
| Real customer data | **never** | **never** | it is already there | yes |
| Link with `supabase link` | not needed | after F-E1 | **never** | via release process |
| Read legacy production | **never** | **never** | read-only snapshot, at migration time only | — |

---

## Current state, verified 2026-09-28

- **This checkout is linked to STAGING, `kwolxuoeqwuedydxzncb`.** The link lives
  in `supabase/.temp/`, which is git-ignored, so it is local to this machine and
  a fresh clone is linked to nothing. Before any `--linked` command, run
  `cat supabase/.temp/project-ref` and confirm it reads `kwolxuoeqwuedydxzncb`.
- **Staging holds all 79 migrations**, applied 2026-09-28, and its migration
  history matches the repository exactly.

*Still true from 2026-09-24:*
- No deployment configuration of any kind: no `vercel.json`, `Dockerfile`,
  `fly.toml`, `render.yaml` or `netlify.toml`.
- CI has four jobs — invariants, typecheck and unit tests, migrations and pgTAP,
  secret and dependency scanning — and **no deploy job**, which its own comment
  explains: deployment is configured when staging exists.
- `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` are **empty** in both
  `.env.local` files, and nothing in the codebase reads either.
- CI asserts no `.env` file and no Supabase link file is ever tracked, and runs
  gitleaks over full history.
