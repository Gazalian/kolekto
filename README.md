# Kolekto

**The financial operating system for communities.**

Kolekto helps communities collect money, track every contribution, manage
members, reconcile payments and keep their financial records across
generations of leadership.

Two rules govern every decision in this repository:

1. **The Collection is the core product object.**
2. **The community owns the financial record, not the treasurer.**

The second rule has a direct schema consequence, and it is the reason this
repository exists rather than a refactor of the old ones: *no financial object
references a person as its owner.* Collections, contributions, balances,
withdrawal accounts and reports all belong to a `community_id`. People appear
only as actors — `created_by`, `requested_by`, `approved_by`.

---

## Status

**Phase 3 — Collections, obligations and the contributor experience.** Phases 1
(schema, authorization, testing, CI), 1.5 (migration compatibility, production
hardening) and 2 (application foundation) are complete. This phase made the
collection a working product object: configured, published, shared as one link,
and answerable to "who is expected to pay?". It still does **not** move money,
deliberately — see [`docs/adr/0012`](docs/adr/0012-collections-stop-at-the-money-boundary.md).

| Area | State |
|---|---|
| Repository, CI, invariant gates | Built |
| Environment isolation (local / staging / production) | Configured; no cloud projects created |
| Identity, communities, members, groups, officers, invites (schema) | Migrated |
| Sign-up bootstrap (personal community + owner term) | Built (20260918140000) |
| Application write functions (communities, members, invites, officer terms) | Built (20260918140100/140200, ADR 0011) |
| Audit log | Migrated, written by every application write function |
| Collection write functions, lifecycle, tiers, questions, obligations | Built (20260919120000/120100) |
| Collections UI: list, guided creation, detail, settings, sharing | Built |
| Published collection page + contributor form (no account needed) | Built |
| Money primitives (integer kobo) + fee engine | Ported, tested; used to price a selection, **wired to no payment** |
| `apps/web`: auth (email/phone OTP), community switcher, members, invitations, settings, RBAC-aware nav | Built |
| Design system (`packages/ui`) | Baseline built |
| Ledger, payment attempts, transactions, contributions, withdrawals | **Not built** — gated on DEC-01/DEC-03 |
| Paystack integration | **Not built** — gated on DEC-01/DEC-02/DEC-03 |
| Notifications (WhatsApp/SMS/email) | **Not built** — gated on DEC-17 |

Because payment is not built, no screen anywhere reports an amount received, a
contributor count or a progress bar, and no obligation can be marked paid. A
contributor who completes the public form is told plainly that nothing has been
charged and nothing has been stored.

Why the gates matter is in [`docs/adr/0006-ledger-deferred.md`](docs/adr/0006-ledger-deferred.md).
The decisions themselves live in the PRD's Decision Register (section 25).

---

## Layout

```
apps/web          The single deployable. Next.js App Router, SSR public pages, PWA.
apps/worker       Long-lived process consuming the pgmq queue.
packages/domain   Pure TypeScript. Integer kobo. No I/O. Golden-vector tested.
packages/db       Generated database types and query helpers.
packages/adapters Paystack, settlement, WhatsApp, SMS, email, KYC. The ONLY outbound callers.
packages/ui       Design system.
packages/validation  zod schemas shared by client and server.
packages/config   Environment loading and guards.
supabase/migrations  The ONLY way the schema changes.
supabase/tests       pgTAP: RLS per role per table, invariants, grant matrix.
docs/adr          Architecture decisions, numbered.
docs/history      Incident post-mortems carried from the old repositories.
scripts/invariants  The four CI gates.
```

## Getting started

```bash
nvm use                 # Node 22
npm install
cp .env.example .env.local
npm run db:start        # local Supabase via the CLI
npm run db:migrate      # apply migrations, keep your data
npm run verify          # typecheck, invariant gates, tests
npm run db:test         # pgTAP suite
```

### Applying a migration without losing your work

`npm run db:reset` drops the database and re-seeds it. That includes every
community, collection and member you created by hand while using the app, and
`auth.users` — so your next sign-in creates a *new* account and the app looks
like it forgot everything. It is the right command exactly once, on a fresh
clone, and almost never afterwards.

```bash
npm run db:migrate      # apply pending migrations, keep all data
npm run db:backup       # snapshot your rows to backups/<timestamp>.sql
npm run db:restore      # put them back, and verify every row arrived
npm run db:marker create|check   # prove persistence with marker data
```

The backup carries data only — the schema always comes from
`supabase/migrations` (ADR 0007) — and includes your `auth.users` row, so the
same email signs back into the same account with its history intact. `backups/`
is git-ignored.

You do not need a cloud Supabase project to work on this repository, and you
should not point a local checkout at one.

### Running the web app

```bash
npm run db:start                        # local Supabase, if not already up
cp .env.example apps/web/.env.local     # Next.js loads env files from its own
                                         # directory, not the repo root — fill
                                         # in the same values as the root one
npm run dev --workspace apps/web        # http://127.0.0.1:3000
```

Sign in with any email address — the local stack has no real mail provider,
so open Mailpit (`supabase status` prints `MAILPIT_URL`, typically
`http://127.0.0.1:54324`) to read the OTP code it "sent". A brand-new
sign-up gets a personal community immediately (COM-01); create a named one
from `/communities`.

## The five invariants

CI fails if any of these is violated. They exist because the previous system
violated all five, and they are checked before features are written rather
than after.

1. **Money is `bigint` kobo.** No floats, no `numeric`, no `toFixed`, no
   `parseFloat` anywhere in a money path.
2. **RLS is enabled on every table in `public`,** and the `anon` /
   `authenticated` grant matrix matches the allowlist exactly.
3. **No money write happens outside a database function.** Application code
   proposes; the database posts.
4. **One Paystack caller.** `api.paystack.co` appears only in
   `packages/adapters`.
5. **One fee implementation.** Fee arithmetic exists only in
   `packages/domain/src/fees.ts`, and `calculateFees()` is called only from an
   explicit allowlist. The previous system had two implementations of "net" and
   the difference between them was the largest drift bucket in production.

Run them locally with `npm run invariants`.

## Contributing rules that are not negotiable

- **Schema changes only through `supabase/migrations`, applied by CI.** No
  console SQL against staging or production, ever. The previous database had 38
  applied migrations and 52 committed files with *zero* versions in common.
- **No Supabase Edge Functions.** See [`docs/adr/0005-no-edge-functions.md`](docs/adr/0005-no-edge-functions.md).
- **Terminology from the PRD section 0.3 everywhere** — in the UI, in code
  identifiers, in support scripts. It is "Community", never "workspace".
