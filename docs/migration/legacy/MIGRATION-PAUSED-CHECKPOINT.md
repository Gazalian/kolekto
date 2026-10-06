# Migration Paused — Checkpoint

**Date:** 2026-09-29
**Branch:** `m8.1-financial-foundation`
**Commit:** `ce0b6db` (last committed; migration work is staged but uncommitted)
**Status:** PAUSED — all B1–B4 implementation complete, D2 rehearsal deferred

## Current migration phase

The legacy D2 production migration importer is fully implemented through
Phase B4 (overflow archive). All code and tests are passing. The next step
is the full D2 production-shaped rehearsal, which has been deferred.

## Completed milestones

| Milestone | Status | Detail |
|---|---|---|
| B1 — Identity + collections + contributions | PASS | 508 profiles, 275 collections (1 rejected excluded), tiers, contributions, contributor codes |
| B1 — Phone deduplication | PASS | 27 dup phone groups (66 profiles) handled; first by UUID keeps phone, rest nulled with `_phone_deduped` flag |
| B2 — Deposits | PASS | Attributed → `legacy_deposit`, unattributed → `unattributed_payments` |
| B3 — Withdrawals | PASS | 292 rows → `legacy_withdrawal`; bank details excluded per security constraint |
| B4 — Overflow archive | PASS | 7 tables (31,678 rows) → `legacy_overflow`; 28 tables excluded (sensitive/ephemeral) |
| Importer role | PASS | `kolekto_importer` with INSERT+SELECT only, NOBYPASSRLS |
| Reconciliation engine | PASS | Control-total reconciliation with per-table overflow checks |
| Immutability guards | PASS | UPDATE/DELETE/TRUNCATE blocked on migration history tables |
| Provenance tracking | PASS | Every imported object tracked in `imported_objects` |
| Financial safety | PASS | No ledger/financial_events rows created; importer has no access to financial tables |

## Test results (last full run, 2026-09-29)

| Suite | Result |
|---|---|
| Synthetic E2E (import + reconciliation) | 49/49 PASS |
| Transformer unit tests | 37/37 PASS |
| pgTAP (database constraints + policies) | 769/769 PASS |
| Domain tests | 154/154 PASS |
| Invariants | 6/6 PASS |
| TypeScript typecheck (`tsc --build`) | PASS |
| ESLint | PASS |
| Build | PASS |

## Remaining work

1. **Full D2 production-shaped rehearsal** — run the complete importer
   (B1–B4) against the D2 restore → rehearsal target. Verify exact counts,
   financial safety, idempotency, immutability, phone dedup, and D2 source
   integrity. Produce `B4-D2-REHEARSAL-REPORT.md`.

2. **Report** — produce the rehearsal report with sections:
   source/imported control totals, per-table reconciliation, provenance,
   idempotency, financial safety, immutability, D2 source integrity, phone
   dedup verification, mismatches, blockers.

## How to resume

### Prerequisites

1. Docker Desktop running
2. D2 restore container started: `docker start kolekto-legacy-restore-ro`
3. Rehearsal target container started: `docker start kolekto-rehearsal-target`
4. Local Supabase stack running: `supabase start` (from project root)

### Database locations

| Environment | Host | Port | Database | Role |
|---|---|---|---|---|
| D2 legacy restore | 127.0.0.1 | 5544 | legacy_restore | READ-ONLY source |
| Rehearsal target | 127.0.0.1 | 5455 | postgres | Write target |
| Local dev | 127.0.0.1 | 54322 | postgres | DO NOT DESTROY |
| Staging (kwolxuoeqwuedydxzncb) | — | — | — | DO NOT CONNECT |

### D2 restore password

The D2 restore container requires a temporary password to be set before
connecting. Run inside the container:

```bash
docker exec -i kolekto-legacy-restore-ro psql -U postgres -d legacy_restore \
  -c "ALTER USER postgres PASSWORD '<temporary-password>';"
```

Use this password in the connection string. Do not commit the password.

### Rehearsal execution

Write a one-off `d2-rehearsal.ts` script (do not commit it) that:

1. Connects to both databases
2. Captures D2 source control totals before import
3. Cleans the rehearsal target
4. Runs `runImport()` from `packages/migration/src/index.ts`
5. Runs `reconcile()` with the captured control totals
6. Verifies overflow breakdown, provenance, financial safety
7. Verifies phone dedup (no duplicate phone_e164 in users)
8. Tests immutability (UPDATE/DELETE/TRUNCATE probes)
9. Runs a second import for idempotency (row counts unchanged)
10. Verifies D2 source integrity (counts unchanged after import)

Execute with: `npx tsx d2-rehearsal.ts`

### Expected D2 control totals

| Entity | Expected count |
|---|---|
| profiles | 508 |
| collections | 275 (+ 1 rejected = 276 total) |
| wallets | 245 |
| payment_recovery_log | 30,242 |
| pending_payment_context | 797 |
| payment_admin_actions | 220 |
| settlement_runs | 57 |
| admin_events | 71 |
| campuses | 46 |
| Total B4 overflow | 31,678 |
| attributed deposits | 4,884 |
| unattributed deposits | 1,317 |
| withdrawals | 292 |

## Safety requirements

- NEVER connect to real legacy production Supabase
- NEVER connect to staging (kwolxuoeqwuedydxzncb)
- NEVER call Paystack or process real payments
- NEVER create real ledger entries, wallets, or balances
- NEVER modify the D2 restore data (read-only)
- NEVER run destructive `supabase db reset` on local dev
- NEVER commit temporary passwords or connection strings
- Rehearsal target (127.0.0.1:5455) is the ONLY write target

## Known decisions

- Rejected campaign (`2b4fe58a-d1b2-4081-8f59-90287b96eba0`) excluded from
  `public.collections`, preserved in `legacy_collection`
- "Mr" collection archived on import
- Deleted collections mapped to archived status
- Phone dedup: first profile by UUID sort keeps phone_e164, rest nulled
- Duplicate tier names resolved with `[PREFIX]` suffix
- Shared tier prefixes: highest-priced tier wins
- Images deferred (all image fields null)
- Bank details excluded from withdrawal import (security)
- 28 sensitive/ephemeral D2 tables excluded from overflow

## Known deferred items

- Storage/image migration
- Live production delta strategy (new data arriving between restore and cutover)
- auth.users credential migration (Supabase platform limitation)
- Staging deployment of migration (blocked until rehearsal passes)

## Key files

| File | Purpose |
|---|---|
| `packages/migration/src/orchestrator.ts` | Import entry point (`runImport`) |
| `packages/migration/src/reconcile.ts` | Post-import reconciliation |
| `packages/migration/src/transformers/` | Pure transformation functions |
| `packages/migration/test/synthetic-import.test.ts` | Synthetic E2E tests (49 assertions) |
| `packages/migration/test/synthetic-fixtures.ts` | Test data fixtures |
| `docs/migration/legacy/IMPORTER-IMPLEMENTATION-REPORT.md` | Implementation decisions |
| `docs/migration/legacy/B4-DISCOVERY-AND-DESIGN-REPORT.md` | B4 overflow design |
| `docs/migration/legacy/IMPORT-RECONCILIATION-CONTRACT.md` | Reconciliation contract |
