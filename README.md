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

**Phase 1 — Foundation.** This repository currently contains the schema,
authorization model, testing and CI foundation. It does **not** contain
payment or withdrawal functionality, deliberately.

| Area | State |
|---|---|
| Repository, CI, invariant gates | Built |
| Environment isolation (local / staging / production) | Configured; no cloud projects created |
| Identity, communities, members, groups, officers, invites | Migrated |
| Audit log | Migrated |
| Collections, tiers, obligations | Migrated (no money applied) |
| Money primitives (integer kobo) + fee engine | Ported, tested, **not wired to anything** |
| Ledger, payment attempts, transactions, contributions, withdrawals | **Not built** — gated on DEC-01/DEC-03 |
| Paystack integration | **Not built** — gated on DEC-01/DEC-02/DEC-03 |
| Notifications (WhatsApp/SMS/email) | **Not built** — gated on DEC-17 |

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
npm run db:reset        # apply every migration + seed
npm run verify          # typecheck, invariant gates, tests
npm run db:test         # pgTAP suite
```

You do not need a cloud Supabase project to work on this repository, and you
should not point a local checkout at one.

## The four invariants

CI fails if any of these is violated. They exist because the previous system
violated all four, and they are checked before features are written rather
than after.

1. **Money is `bigint` kobo.** No floats, no `numeric`, no `toFixed`, no
   `parseFloat` anywhere in a money path.
2. **RLS is enabled on every table in `public`,** and the `anon` /
   `authenticated` grant matrix matches the allowlist exactly.
3. **No money write happens outside a database function.** Application code
   proposes; the database posts.
4. **One Paystack caller.** `api.paystack.co` appears only in
   `packages/adapters`.

Run them locally with `npm run invariants`.

## Contributing rules that are not negotiable

- **Schema changes only through `supabase/migrations`, applied by CI.** No
  console SQL against staging or production, ever. The previous database had 38
  applied migrations and 52 committed files with *zero* versions in common.
- **No Supabase Edge Functions.** See [`docs/adr/0005-no-edge-functions.md`](docs/adr/0005-no-edge-functions.md).
- **Terminology from the PRD section 0.3 everywhere** — in the UI, in code
  identifiers, in support scripts. It is "Community", never "workspace".
