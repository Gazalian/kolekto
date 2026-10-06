# Staging — `kwolxuoeqwuedydxzncb`

**Read this before running anything against staging.**
**Validated:** 2026-09-28 — [STAGING-ENVIRONMENT-VALIDATION.md](../migration/STAGING-ENVIRONMENT-VALIDATION.md)
**Parent document:** [docs/phase-4/environments.md](../phase-4/environments.md) (all environments)

## Identity

| | |
|---|---|
| Project name | **kolekto staging** |
| Project ref | **`kwolxuoeqwuedydxzncb`** |
| Organisation | `gffmdnyuzihxoqievxbc` — **separate** from the legacy estate's organisation |
| Region | eu-west-2 |
| Postgres | 17.6 (major 17, matching `supabase/config.toml`) |
| API URL | `https://kwolxuoeqwuedydxzncb.supabase.co` |
| Session pooler host | `aws-0-eu-west-2.pooler.supabase.com:5432` |

A project ref and URL are not secrets. Keys, passwords and connection strings
are, and none appear here.

## Staging is not either legacy project

| Ref | What it is | Relationship to staging |
|---|---|---|
| `kwolxuoeqwuedydxzncb` | **NEW staging** | This document |
| `lpeeckqsltxohppheucz` | Legacy **test** ("Kolekto test") | **Not staging.** Never wiped, reset, migrated or repurposed |
| `busfgcmbndleljklrcbd` | Legacy **production**, live | **Never touched** |

The CLI account used for staging work belongs only to the staging organisation
and **cannot see either legacy project**. That is deliberate: a mis-typed ref
fails rather than succeeding against the wrong estate.

## How to verify what you are connected to — every time

Before any command that takes `--linked` or writes to a remote:

```bash
cat supabase/.temp/project-ref           # must print kwolxuoeqwuedydxzncb
cat supabase/.temp/linked-project.json   # name must be "kolekto staging"
supabase projects list                   # staging must be visible; legacy must not be
```

If `project-ref` prints `busfgcmbndleljklrcbd` or `lpeeckqsltxohppheucz`,
**stop**. `supabase/.temp/` is git-ignored, so the link is per-machine and a
fresh clone is linked to nothing.

For the running app, `KOLEKTO_ENV=staging`, `NEXT_PUBLIC_SUPABASE_URL` must
point at `kwolxuoeqwuedydxzncb`, and `KOLEKTO_EXPECTED_PROJECT_REF` must be
`kwolxuoeqwuedydxzncb`.

**The CLI account matters as much as the link.** On 2026-09-28 the CLI reverted to
the legacy account partway through a session; the link still named staging, so a push
was refused with 403 and nothing happened. Re-check `supabase projects list` before
every remote command — not once per session.

## Preventing an accidental production connection

1. **Organisation separation** — staging credentials cannot reach legacy projects.
2. **`packages/config` refuses both legacy projects in every environment**
   (`busfgcmbndleljklrcbd`, `lpeeckqsltxohppheucz`), including production, however
   the URL is spelled. They are a constant in code, not a variable, so a missing
   setting cannot switch the check off.
3. **`KOLEKTO_ENV=staging` requires `KOLEKTO_EXPECTED_PROJECT_REF`** to equal the
   ref in the URL, and refuses to start otherwise. `KOLEKTO_ENV=local` accepts only
   this machine.
4. **`KOLEKTO_PRODUCTION_PROJECT_REF`** is for the **new** production project, once
   it exists. Do not set it to a legacy ref — the legacy refs are already refused.
5. **`supabase/config.toml` is local-only** and must never be applied to staging
   with `supabase config push` without an explicit decision (ADR 0007).

## Environment variables

**Names only. Never commit a value.** All `.env*` files except `.env.example` are
git-ignored (verified: `.env.local`, `.env.staging`, `.env.staging.local`,
`.env.production`).

### A. Public client configuration — browser-safe

| Name | Staging value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://kwolxuoeqwuedydxzncb.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Staging's **publishable** key (`sb_publishable_…`), from the dashboard |

### B. Server-only secrets — never in the browser, never in Git

| Name | Purpose | Staging status |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Service role. Bypasses RLS. | **Not supplied yet** |
| `SUPABASE_DB_URL` | Direct Postgres connection. **The app's write path** — `app.*` functions are unreachable over REST. Use the **session pooler, port 5432**. | **Not supplied yet** |
| `KOLEKTO_SESSION_SECRET` | Signs contributor identification cookies. ≥ 32 chars. **Generate a new one for staging** — never reuse local's. | **Not supplied yet** |

Each loader throws if called in a browser context, and the 2026-09-28 build was
scanned: none of these names, their loaders, a connection string or
`service_role` appears in any of the 32 client bundles.

### C. Database / CLI configuration — not app variables

| Item | Notes |
|---|---|
| `supabase/.temp/` link | Per-machine, git-ignored |
| CLI login | `supabase login` as an account in the staging organisation. Its token is never stored in the repository |

### D. Future provider configuration — must stay UNSET in staging

| Names | Status |
|---|---|
| `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_CALLBACK_URL` | **Unset.** No code reads any of them. When M8.9 arrives, staging takes **Paystack TEST keys only** — never live, never legacy |
| `EMAIL_PROVIDER`/`EMAIL_API_KEY`, `SMS_PROVIDER`/`SMS_API_KEY`, `WHATSAPP_PROVIDER`/`WHATSAPP_API_KEY`, `SENTRY_DSN` | Unset. No code reads them yet |

### E. Required / optional operational

| Name | Notes |
|---|---|
| `KOLEKTO_ENV` | **Required.** Exactly `staging` |
| `KOLEKTO_EXPECTED_PROJECT_REF` | **Required for staging.** Exactly `kwolxuoeqwuedydxzncb` |
| `KOLEKTO_PRODUCTION_PROJECT_REF` | The **new** production ref, once it exists. Leave empty until then |
| `LOG_LEVEL` | Optional, defaults to `info` |
| `NEXT_DIST_DIR`, `KOLEKTO_DB_CONTAINER`, `KOLEKTO_CONFIRM_RESET`, `DATABASE_URL` | Local development and scripts only. Not for staging |

**Never copy any value from the legacy estate** (`kolekto-be-old`, `kolekto-fe-old`,
legacy dashboards) into staging.

## Hosted Auth settings — not yet verified

`config.toml` configures only the local stack. The hosted project's Auth settings
must be set in the dashboard, and only these are readable without an admin key:

| Setting | Staging (verified 2026-09-28) |
|---|---|
| Providers enabled | email only |
| Sign-up | enabled |
| Email confirmation | required |
| Anonymous sign-in | off |
| Phone | off (no SMS provider — DEC-17) |

**Unverified, and required before the sign-in journey works:**

- **Email template must show the 6-digit code** (`{{ .Token }}`). The hosted
  default sends a link; the app's sign-in expects a code. Local uses
  `supabase/templates/otp.html`.
- OTP expiry **300 s** and length **6** (SEC-05).
- **Site URL and redirect URLs** set to the staging app's URL, once it is hosted.
- **SMTP.** Supabase's built-in mailer only delivers to organisation members' own
  addresses at a low hourly rate. Either configure an SMTP provider or test with
  an organisation member's inbox.

## Current limitations

- **No money moves in staging.** No Paystack adapter exists (`createPaymentProvider()`
  throws), no payment or webhook endpoint exists, and no code reads a Paystack key.
- **No legacy data.** Migration Rehearsal #1 has not started.
- **KYC migration is blocked on L-1/L-2.** No KYC destination exists in the new schema.
- **The app is not hosted.** No hosting platform has been chosen — see
  [docs/deployment/staging.md](../deployment/staging.md).
