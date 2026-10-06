# Staging environment validation

**Date:** 2026-09-28 · **Staging:** `kwolxuoeqwuedydxzncb` ("kolekto staging")

**Result: DATABASE VALIDATED · APPLICATION JOURNEY BLOCKED ON SECRETS AND HOSTING ·
2 FINDINGS REQUIRING DECISIONS**

> This report supersedes the 2026-09-28 version that stopped at Phase 1, when the
> staging project was not yet visible to the CLI.

> ### Founder decision, 2026-09-28: LOCAL FIRST
>
> Staging stays built and validated but **is not used for hosting or migration
> rehearsal yet.** The sequence is: local correctness → local migration rehearsal →
> local reconciliation → review → host staging → staging golden path → rehearsal
> against staging → production preparation.
>
> **Hosting, hosted Auth, SMTP, public URLs and the Paystack sandbox are out of scope
> until then.** §11, §12 and §15 items 3–5 below are therefore **deferred by decision**,
> not outstanding work. The local correctness closure that followed is recorded in
> **§21**.

## 1. Executive summary

**The new staging database is built, clean, and structurally identical to the schema
the test suites validate — with two exceptions that the validation was designed to
find.**

All 79 migrations were applied to a never-migrated project, in order, with no
failures. Staging's migration history matches the repository exactly. It contains
no legacy data, no users and no balances — only reference rows the migrations
themselves seed. Every one of its 48 tables has row-level security enabled **and
forced**; the anonymous role can read none of them and write none of them, and
this was confirmed by attacking staging's live REST API, not just by reading
catalogs.

**Every automated suite passes: 976 tests, 0 failures**, plus the six source-tree
invariants, typecheck, lint and the production build.

Two differences between staging and the locally tested schema were found and traced
to root cause:

- **F-1.** On staging, `service_role` holds full read/write on every table; locally it
  holds none. The migrations never set this, so each environment inherits its
  platform's default. **Needs a decision.**
- **F-2.** One RLS policy compares emails **case-sensitively** on staging but
  case-insensitively locally, because the CLI's push role cannot see the `extensions`
  schema. Tracing it exposed a **pre-existing bug in every environment**: accepting
  an officer invitation, and duplicate-member detection, are case-sensitive, so an
  invite sent to `Ada@Example.com` cannot be accepted by `ada@example.com`.

**The end-to-end user journey could not be run against staging.** The app writes
through a direct database connection, which needs staging's database password and
service-role key — secrets that are not in this environment and that must not be
pasted into chat. No hosting platform has been chosen, and hosted Auth is not yet
configured to send sign-in codes.

**No money moved, no Paystack request was made, no legacy data was imported, and
neither legacy project was touched.**

## 2. Staging project verification

| Check | Result |
|---|---|
| CLI sees `kwolxuoeqwuedydxzncb` | **Yes** — and **only** it. The CLI account cannot see either legacy project |
| Ref ≠ `busfgcmbndleljklrcbd` (legacy production) | **Confirmed** |
| Ref ≠ `lpeeckqsltxohppheucz` (legacy test) | **Confirmed** |
| Name | **kolekto staging** |
| Organisation | `gffmdnyuzihxoqievxbc` — separate from the legacy organisation `wzkhbvbimazkabmdbawa` |
| Region / Postgres | eu-west-2 / 17.6.1.166 |
| Link | `supabase link --project-ref kwolxuoeqwuedydxzncb` → `supabase/.temp/project-ref` reads the staging ref; `linked-project.json` names "kolekto staging" |
| Confirmed independently | Supabase CLI **and** the Supabase connector report the same identity |

The organisation id in the instruction contained a one-character typo
(`gffmdnyuzhoxqievxbc`); both independent sources report `gffmdnyuzihxoqievxbc`. The
ref and name matched exactly, so this was not treated as ambiguity.

**Staging was empty before migration:** 0 tables, 0 functions, 0 users, 0 buckets,
0 objects, no migration-history table, only Supabase's default extensions.

## 3. Repository and commit

| | |
|---|---|
| Branch | `m8.1-financial-foundation` |
| Commit | `ce0b6db` |
| Working tree | **Not clean**, by standing instruction: the M8.2 provider boundary and the legacy-preservation documentation remain uncommitted pending review |

> **Pushed while uncommitted.** Migrations `20260924160000_financial_event_processing`
> and `20260924170000_app_function_execute_hardening` are part of the uncommitted
> M8.2 work, and are now applied to staging. **If the M8.2 review changes either
> file, staging will already have recorded the old version as applied**, and the
> change will have to ship as a new forward migration. Staging is disposable, so
> this was accepted — but it should be known.

## 4. Migration count

**79 migrations**, `20260917120000_extensions_and_schemas` through
`20260924170000_app_function_execute_hardening`.

> The previous version of this report said 80. That was a miscount of a file
> listing; there are 79, verified by filename and by the CLI's migration history.

| | |
|---|---|
| Applied to staging | **79 of 79**, `supabase db push --linked`, exit 0 |
| History (`supabase migration list --linked`) | **79 local = 79 remote**, 0 local-only, 0 remote-only |
| Local stack head | Same 79, same head `20260924170000` |
| Notices during push | Benign only: `pgcrypto already exists`; `drop … if exists` no-ops; SMS provider not configured |

**This push was the migration replay**: every migration applied, in order, to a
database that had never been migrated. The local database was **not** reset to
produce a replay, because a reset destroyed a developer's local data on 2026-09-20.

## 5. Database schema verification

The same catalog query ran on staging and on the local stack. All 19 counts match:

| | Staging | Local |
|---|---|---|
| Tables | 48 | 48 |
| Views | 4 | 4 |
| Functions | 112 | 112 |
| — `SECURITY DEFINER` | 76 | 76 |
| Enums / domains | 33 / 1 | 33 / 1 |
| Triggers | 61 | 61 |
| Indexes | 141 | 141 |
| Constraints / foreign keys | 310 / 101 | 310 / 101 |
| RLS policies | 53 | 53 |
| RLS enabled / **forced** | 48 / **48** | 48 / 48 |
| Tables without RLS | **none** | none |
| Storage buckets | `collection-covers` (public) | same |
| `anon` table privileges | **0** | 0 |
| Functions with a PUBLIC `EXECUTE` grant | **0** | 0 |
| Functions `anon` may execute | 8 | 8 |

Counts can agree while definitions differ, so every object class was also
**fingerprinted** (MD5 over the full definition text, in a fixed order):

| Fingerprint | Result |
|---|---|
| Function definitions, including their grants and `SECURITY DEFINER` flag | **identical** |
| Constraints | **identical** |
| Triggers | **identical** |
| Indexes | **identical** |
| Views | **identical** |
| Enums and their values | **identical** |
| Columns, types, defaults, nullability | **identical** |
| Functions `anon` may execute | **identical** |
| Table grants — `authenticated`, `postgres`, `anon` | **identical** |
| Table grants — `service_role` | **DIFFERENT** — F-1 |
| RLS policies — `migration`, `storage` schemas | **identical** |
| RLS policies — `public` schema, 46 of 47 | **identical** |
| RLS policy `officer_invitations_select_invitee` | **DIFFERENT** — F-2 |

The 8 functions `anon` may execute are the intended public surface:
`get_public_collection`, `get_public_collection_fields`, `get_public_collection_items`,
`get_public_collection_tiers`, `get_public_invite`, `redeem_invite_link`,
`find_collection_member`, `get_collection_member_context`.

### Clean database — no legacy data

Every table's row count on staging:

| Table | Rows | Why |
|---|---|---|
| `role_permissions` | 107 | Seeded by migrations |
| `permissions` | 36 | Seeded by migrations |
| `ledger_account_codes` | 12 | Seeded by migrations — the chart of accounts |
| `fee_schedules` | 1 | Seeded by migrations — schedule v1 |
| **All 44 other tables** | **0** | |

Zero users, communities, members, collections, obligations, ledger journals, ledger
entries, financial events, or rows in any `migration.legacy_*` table. `auth.users`
and `storage.objects` are 0. **No legacy table exists**: every table is part of the
new schema. **No wallet balance, transaction, user or collection from either legacy
project is present.**

## 6. RLS, grants and security verification

**Against staging's live REST API**, using only the browser-safe publishable key:

| Probe | Result |
|---|---|
| Read `users`, `collections`, `ledger_entries`, `financial_events`, `communities`, `members`, `fee_schedules` | **HTTP 401 — permission denied** on every one |
| Insert into `ledger_entries` | **HTTP 401 — denied** |
| Call an internal `app` function over REST | **Not found** — the `app` schema is not served |
| Upload to the `collection-covers` bucket | **Refused — row-level security** |
| List the `collection-covers` bucket | Empty, as designed for a public-read bucket with no objects |

**Sixth security invariant** — *every app function states who may execute it*:
**holds** (`npm run invariants`, 6/6). On staging specifically: **0** functions carry
a PUBLIC `EXECUTE` grant, and function grants fingerprint identically to local.

**Financial protections:** append-only and balancing triggers, the idempotency
constraints and the financial functions' grants all fingerprint identically to local,
where 644 pgTAP assertions exercise them.

## 7. Test matrix

All suites ran locally on 2026-09-28. **Nothing was skipped, weakened or deleted.**

| Suite | Command | Result |
|---|---|---|
| Migration replay | `supabase db push --linked` onto an empty staging DB | **PASS** — 79/79 |
| pgTAP | `supabase test db` (local stack) | **PASS** — 23 files, **644** tests |
| Invariants | `npm run invariants` | **PASS** — 6/6 |
| Domain | `packages/domain` | **PASS** — 154/154 |
| Validation | `packages/validation` | **PASS** — 58/58 |
| Provider adapter + fake provider | `packages/adapters` | **PASS** — 37/37 |
| Web / unit | `apps/web` vitest | **PASS** — 83/83, 4 files |
| Typecheck | `npm run typecheck` | **PASS** — 0 errors |
| Lint | `npm run lint` | **PASS** — 0 problems |
| Production build | `npm run build` | **PASS** — compiled in 3.6 min |
| E2E (Playwright) | `npm run test:e2e` | **NOT RUN** — targets the local stack; the staging journey is blocked (§11) |
| Golden path on staging | — | **BLOCKED** — §11 |

**Totals: 976 tests run · 976 passed · 0 failed · 0 skipped.** Plus 6 invariants,
typecheck, lint, build and the 79-migration replay.

**What the passing pgTAP run does not prove about staging.** pgTAP runs on the local
stack. It did **not** catch F-1 or F-2, because both are cases where staging differs
from local — and F-2's underlying bug is present locally too, untested because the
suite uses same-case emails.

## 8. Provider and fake-provider verification

| Requirement | Result |
|---|---|
| `createPaymentProvider()` cannot create a live Paystack client | **Confirmed** — it throws unconditionally; no gateway is implemented |
| `FakePaymentProvider` and all deterministic scenarios | **PASS** — 37/37 |
| Webhook signature verification | **PASS** — within the 37 |
| Timeout / unknown represented as a value | **Confirmed** — `ProviderResult` carries `unknown` with `safeToRetry` |
| Provider fee may be null | **Confirmed** — `providerFee: Kobo \| null` |
| Raw payload is evidence-only | **Confirmed** by contract; written only to `financial_events.payload`, which no client role can read |
| Paystack variables | **No code reads** `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_PUBLIC_KEY` or `PAYSTACK_CALLBACK_URL` |
| `api.paystack.co` | Appears only in `packages/adapters` (4th invariant) and in **no** client bundle |
| Payment or webhook endpoint in the app | **None exists.** The only route handler is logout. The contributor action states in code that no payment is taken |

**No real Paystack request was possible, let alone made.** Paystack sandbox access is
a future dependency of M8.9, together with a public staging webhook URL and written
answers to PA-04…PA-09.

## 9. Auth verification

| | Result |
|---|---|
| Staging Auth, public settings | Email provider only · sign-up on · **email confirmation required** · anonymous sign-in **off** · phone off |
| `auth.users` | 0 |
| Protected routes, logout, session handling | **Covered locally** by the web suite and pgTAP; **not run on staging** |
| Community isolation, cross-user access | **Covered by pgTAP locally**; staging's policies fingerprint identically except F-2 |
| Email OTP sign-in **on staging** | **BLOCKED** — see below |

Staging's email sign-in cannot yet work end to end:

- **The hosted email template has not been set to send a code.** The hosted default
  sends a link; the app expects a 6-digit code. Locally this comes from
  `supabase/templates/otp.html`, which `config.toml` does not push to hosted projects.
- **OTP expiry (300 s), OTP length (6), site URL and redirect URLs** are unverified —
  they are not readable without an admin key.
- **Supabase's built-in mailer only delivers to organisation members' addresses**, at
  a low hourly rate. A real journey needs an SMTP provider or an organisation
  member's inbox.

## 10. Storage verification

| | Result |
|---|---|
| Buckets on staging | **One**: `collection-covers` — public read, 5 MiB limit, jpeg/png/webp — the new product's only bucket |
| Storage policies | **One**, public read; fingerprint identical to local |
| Anonymous upload | **Refused by RLS** (tested live) |
| Client write path | None by design — uploads go through a server action using the service role |
| Legacy buckets | **None copied** |
| Legacy files | **None migrated.** The 53 KYC objects and 15 non-KYC objects remain untouched in legacy production |

## 11. Golden-path verification

**BLOCKED — not run.** Nothing in steps 1–14 was executed against staging.

The web application **writes through a direct Postgres connection**
(`SUPABASE_DB_URL`): `app.*` functions are not reachable over REST by design, and the
server impersonates each user per call. Running the app against staging therefore
needs three secrets this environment does not have:

| Secret | Why it is missing |
|---|---|
| `SUPABASE_DB_URL` for staging | Contains the database password, which the Supabase API does not reveal |
| `SUPABASE_SERVICE_ROLE_KEY` for staging | Not supplied |
| `KOLEKTO_SESSION_SECRET` for staging | Should be newly generated, then held in the host's secret store |

They were not requested in chat, per standing instruction. The journey also needs
§9's hosted Auth configuration before step 1, "Sign up/login", can succeed.

Everything the journey would exercise **at the database layer** is validated
indirectly: the schema is fingerprint-identical to the one 644 pgTAP assertions and
83 web tests pass against.

## 12. Deployment readiness

| Check | Result |
|---|---|
| Build | **PASS** |
| Environment validation | `packages/config` fails at startup on any missing variable, has no defaults, and refuses a non-production process pointed at `KOLEKTO_PRODUCTION_PROJECT_REF` |
| Server/client boundary | **Holds.** None of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `KOLEKTO_SESSION_SECRET`, `PAYSTACK_*`, their loader functions, `postgresql://`, `service_role`, `sk_live_`/`sk_test_` or either legacy ref appears in any of the 32 client bundles |
| Legacy refs hardcoded | **None** in application code or configuration. They appear only in the legacy-backup manifests and one warning comment |
| Legacy Paystack configuration | **None** |
| Secrets in tracked files | **None** — tracked files scanned for key, JWT, `sb_secret_` and credentialed-URL patterns |
| `.env*` files | All git-ignored except `.env.example` |
| Supabase addressing | Entirely environment-driven |
| Hosting configuration | **None exists, and no platform has been chosen** — founder decision |
| CI deploy job | None |

**Minimum safe staging configuration created:** documentation only —
[docs/environments/staging.md](../environments/staging.md) and
[docs/deployment/staging.md](../deployment/staging.md). No deployment configuration
was invented for an unchosen platform, and **no production configuration was
created.**

## 13. Security findings

### F-1 — `service_role` has full table read/write on staging, none locally · MEDIUM

| | Staging | Local |
|---|---|---|
| `service_role` privileges per table | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER | TRUNCATE, REFERENCES, TRIGGER only |
| Total | 322 | 138 |

**Root cause:** no migration grants or revokes table access for `service_role`. Each
environment therefore inherits its platform's default privileges: the hosted
project's default for `postgres` grants `service_role` everything; the local CLI
image's grants it only `Dxtm`.

**Why it matters:** the design routes every write through `SECURITY DEFINER`
functions, and the tested posture — local — gives `service_role` no direct table
access. On staging, and on any future hosted production, a leaked service-role key
can insert directly into `ledger_entries`, `financial_events` or any other table,
bypassing those functions. The append-only and balancing triggers still hold, so a
leaked key cannot rewrite history or post an unbalanced journal — but it can post a
balanced one. The app never uses this access (it works locally without it).

**Recommendation:** a forward migration that explicitly sets `service_role`'s table
privileges, and pgTAP assertions that pin them, so environments cannot drift
silently. **Decide first** whether Migration Rehearsal #1's import tooling will need
direct table access, because this change would remove it.

### F-2 — citext case-insensitivity is silently lost in some comparisons · MEDIUM (functional)

**On staging only:** policy `officer_invitations_select_invitee`
(`20260917121000_rls_policies.sql:195`) compares emails as `text` rather than
`citext`:

```
local:    u.email = officer_invitations.invitee_email
staging:  (u.email)::text = (officer_invitations.invitee_email)::text
```

**Root cause:** CLI 2.109.1 pushes as a temporary role, `cli_login_postgres`, with
no `search_path` setting, so the `extensions` schema holding `citext` is not visible.
Postgres cannot find citext's `=` operator and silently falls back to text
equality — no error or warning. Verified directly:

| Session `search_path` | `'Ada@X.com'::citext = 'ada@x.com'::citext` |
|---|---|
| includes `extensions` | **true** |
| empty | **false** |
| `"$user", public` | **false** |

**The same mechanism causes a bug in every environment, local included.** Functions
declared `set search_path = ''` compare citext columns as text:

| Function | Comparison | Effect |
|---|---|---|
| `app.assert_is_invitee` | `u.email = p_invitation.invitee_email` | **An invitation cannot be accepted** if its email's case differs from the account's |
| `app.find_member_duplicates` | `m.email = p_email` | Duplicate detection **misses** `Ada@…` vs `ada@…` |

Emails are **not** lowercased before storage — validation only lowercases tier and
item names — so an officer typing an invitee's email with any capital letter
reaches this. Locally, the invitee can *see* the invitation and then be refused on
*accepting* it. It fails closed, denying rather than granting access: **a
functional bug, not an escalation.**

**Recommendation:** a forward migration that recreates the policy and the affected
functions with explicitly qualified comparisons — `operator(extensions.=)`, or a
search path including `extensions` — plus pgTAP tests using mixed-case emails.
Until then, compare staging's structure against local after every push.

### F-3 — the production-connection guard covers one ref, and is not configured · LOW

`assertNotProduction` compares against `KOLEKTO_PRODUCTION_PROJECT_REF` only, and
does nothing when it is empty — which it is in `.env.local`. It would not catch a
process pointed at legacy test.

> **Resolved 2026-09-28 (§21):** both legacy refs are now refused by code in every
> environment, and staging requires `KOLEKTO_EXPECTED_PROJECT_REF`. The interim
> advice previously here — setting `KOLEKTO_PRODUCTION_PROJECT_REF` to the legacy
> ref — is withdrawn; that variable is for the new production project only.

### No finding in these areas

Service-role leakage to the client · exposed secrets · client-side financial
authority · direct client writes to financial tables · missing RLS · PUBLIC
`EXECUTE` · unauthorized REST RPC · amount or provider-result manipulation paths ·
webhook forgery paths (no webhook endpoint exists) · legacy refs or Paystack secrets
in code. **Cross-community and cross-user access** rely on pgTAP locally plus
staging's policy fingerprints; they were **not** exercised live on staging, because
that needs signed-in users (§11).

## 14. Blocked

| Item | Blocker |
|---|---|
| Golden path on staging | Staging secrets not supplied (§11) |
| Auth sign-in on staging | Hosted email template, OTP settings, URLs and SMTP (§9) |
| Application deployment | No hosting platform chosen (§12) |
| Live cross-user / cross-community tests on staging | Needs the two above |

## 15. Requiring founder decision

1. **F-1** — should `service_role` have direct table access? Consider Migration
   Rehearsal #1's import needs before deciding.
2. **F-2** — approve a forward migration fixing citext comparisons in one policy and
   two functions.
3. **Hosting platform** for the staging web app.
4. **Supply staging secrets** into a git-ignored local file or the host's secret
   store — **not into chat**: `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, a new
   `KOLEKTO_SESSION_SECRET`.
5. **Configure hosted Auth** — the code-bearing email template, OTP 300 s / 6 digits,
   site and redirect URLs, and SMTP.
6. **Review and commit M8.2**, now that two of its migrations are applied to staging.

## 16. Requiring legal or provider decision

- **KYC migration remains blocked on L-1 / L-2.** No KYC destination exists in the new
  schema; the 53 legacy KYC objects are untouched.
- **Paystack (M8.9)** needs a Paystack **test** account, a public staging webhook URL
  (which item 3 above makes possible), and PA-04…PA-09 answered in writing.

## 17. Legacy production and legacy test were not modified

**Confirmed.** `busfgcmbndleljklrcbd` and `lpeeckqsltxohppheucz` were not linked,
queried, migrated, reset or written to. The CLI account used for this work cannot
see either. The only contact with them was a metadata listing before the CLI was
switched to the staging account.

## 18. No real payment occurred

**Confirmed.** No payment was initiated and no Paystack API was called. No payment
code path exists, no code reads a Paystack key, and the provider factory throws.

## 19. No legacy data was imported

**Confirmed.** Staging holds only the reference rows the migrations seed (§5). No
users, collections, members, contributions, deposits, withdrawals, wallets, balances,
KYC records or storage objects were imported.

## 20. Recommended next milestone

**Not Migration Rehearsal #1 yet.** First, close the gaps that make staging usable
end to end:

1. Decide **F-1** and **F-2**, and ship their forward migrations, with pgTAP
   coverage, through local → staging.
2. Choose hosting, configure hosted Auth, supply staging secrets.
3. Re-run §11's golden path on staging.

Then Migration Rehearsal #1 — against a staging environment whose grants are pinned
and whose case-insensitive matching works, which is what imported legacy emails will
depend on.

---

## State at stop

| | |
|---|---|
| Branch | `m8.1-financial-foundation` |
| Commit | `ce0b6db` |
| Staging project ref | `kwolxuoeqwuedydxzncb` (linked) |
| Migrations | 79 in repository · 79 applied to staging · histories match |
| Tests | 976 run · 976 passed · 0 failed · 0 skipped · + 6 invariants, typecheck, lint, build |
| Remaining blockers | Staging secrets · hosted Auth config · hosting platform · F-1 and F-2 decisions |

**Not committed. Migration Rehearsal #1 not started.**

---

## 21. Local correctness closure — 2026-09-28

Done under the local-first decision. Two new forward migrations; **no applied
migration was edited.**

### F-2 — citext email comparisons · FIXED LOCALLY

`20260928100000_citext_explicit_email_comparisons.sql` rewrites the three comparisons
with `operator(extensions.=)`, which resolves by name rather than search path:
policy `officer_invitations_select_invitee` (via `ALTER POLICY`), `app.assert_is_invitee`
and `app.find_member_duplicates`. No stored email was rewritten. Every authorisation
check, security mode, search path and grant is unchanged; both functions now state
their reachability explicitly, so `assert_is_invitee` leaves the sixth invariant's
grandfather list.

**Proven by a failing test first.** `supabase/tests/24_email_case_insensitivity.sql`
(15 assertions) ran **12/15 before the fix** — the three failures were exactly the
defect: a mixed-case invitation refused on accept (`42501 FORBIDDEN`), so no role
granted, and `NGOZI@Example.Test` not detected as `ngozi@example.test`. **15/15
after.** Covered: exact-case, mixed-case, mixed-case acceptance, duplicate detection
with case variation, genuinely different addresses, unrelated users and other
communities' officers unable to exploit the comparison, and a structural check that
the policy contains citext's operator — which the current staging policy fails.

### F-1 — service_role privileges · FIXED LOCALLY

Architecture audit and decision: [SERVICE-ROLE-PRIVILEGE-DECISION.md](SERVICE-ROLE-PRIVILEGE-DECISION.md).
Nothing uses any `service_role` table privilege, so
`20260928110000_service_role_no_application_table_privileges.sql` removes all of them
in the application schemas, existing and future.
`supabase/tests/25_service_role_privileges.sql` (7 assertions): **3/7 before, 7/7
after.** Local before: 138 table privileges, including TRUNCATE on append-only
history. Local after: 0.

It surfaced **F-4** — no append-only table blocks `TRUNCATE`, for any role — and
**F-5** — the application's database connection is the table owner. Both are open
and listed in [MIGRATION-REHEARSAL-1-READINESS.md](MIGRATION-REHEARSAL-1-READINESS.md).

### F-3 — environment guard · FIXED

`packages/config` now refuses **both legacy refs in every environment**, including
production, however the URL is spelled. `local` accepts only this machine. `staging`
requires `KOLEKTO_EXPECTED_PROJECT_REF` to equal the URL's ref, so an unknown or
mistyped project is refused. Production gets no new requirement beyond legacy
refusal. The legacy refs are a constant rather than configuration, because a missing
variable is what switched the old guard off. `packages/config` had **no tests**; it now
has 20. The real local `.env.local` still loads.

### Applied

| | Local | Staging |
|---|---|---|
| Migrations | **81** — both new ones via `npm run db:migrate`, no reset; development data intact (503 users, 983 communities, 368 collections) | **79 — NOT updated.** See below |

**Staging was not updated, and so still carries F-1 and F-2.** The push was refused:
creating the CLI's login role returned **403 — insufficient privileges**. The CLI had
reverted to the **legacy account**, which sees only the two legacy projects and cannot
see staging. **Nothing was pushed and no command ran against either legacy project.**
The link file still names staging, which is why the refusal was the safe outcome. The
Supabase connector was **not** used as a workaround: it records its own migration
versions and would split staging's history from the repository.

### Local test matrix

| Suite | Result |
|---|---|
| pgTAP | **PASS — 25 files, 666 tests** (644 + 15 + 7). The CLI then exited 1 on a telemetry error, `Timeout while shutting down PostHog`, printed *after* "All tests successful" — environmental, CLI-side |
| Invariants | **PASS — 6/6** |
| Domain | **PASS — 154/154** |
| Validation | **PASS — 58/58** |
| Provider + fake provider | **PASS — 37/37** |
| Config | **PASS — 20/20** (new) |
| Web / unit | **PASS — 83/83** |
| Typecheck | **PASS — 0 errors** |
| Lint | **PASS — 0 problems** |
| Production build | **PASS** |
| **E2E (Playwright)** | **NOT COMPLETED — environmental** |

**1,018 tests passed, 0 failed, 0 skipped**, plus the invariants, typecheck, lint and build.

**E2E did not complete, and no application failure was found.**

1. First attempt: **0 tests ran.** Playwright's web server timed out at 180 s; on this
   machine the production build it starts takes ~3 min.
2. Second attempt, with the server pre-built and started separately (the config's own
   `reuseExistingServer`): **43 tests queued, 1 ran — and failed**, the audience spec
   (sign-in and community creation succeeded; the Collections page never rendered
   within the 180 s test timeout). The server logged **no error** of any kind. At
   that moment the host had **0.1 GB of 7.9 GB RAM free and CPU at 100%**, with
   Postgres at 80%.
3. **Claude Code then stopped the server and the run** because the machine was
   critically low on memory. **42 tests never ran.** They were not restarted.

This matches this machine's documented pattern: 4 CPU / 3.76 GB for Docker, with
the local stack degrading under test load. Running the suite needs other workloads
closed first — the development server, browsers, other editor sessions.

### Local golden path · NOT VERIFIED

The E2E suite *is* the golden path — its specs cover sign-in, community, member
identity, member, group, collection creation, audience, contributor references,
collection types, contributor identification, invitations and protected routes. Since
it did not complete, **the local golden path is unverified in this session.** It was
not replaced by a manual walkthrough, which would prove less.
