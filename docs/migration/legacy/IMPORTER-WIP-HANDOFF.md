# Importer milestone — work-in-progress handoff

**Date:** 2026-09-29 · **Status: IN PROGRESS — DID NOT FINISH.** The usage limit hit
mid-milestone. This file records exactly where things stand so the next session picks
up cleanly rather than restarting.

## Safety confirmations (unchanged)

- **Local development database: unchanged.** 508 users, 990 communities, 370
  collections, `migration.*` = 0 rows.
- **D2 restore: unchanged.** 275 collections, 5,576 contributions.
- **Staging: untouched.**
- **Legacy Supabase (prod, test): not connected to.**
- **Paystack: not touched.**
- **No real money moved. No ledger, financial event, wallet or opening balance
  created anywhere.**

## What is built

### Phase B — public-schema importer grants and RLS

Four new forward migrations (**90 → 94** locally):

| | |
|---|---|
| `20260929100000_importer_public_grants.sql` | Grants + RLS `with check` on users, communities, officer_terms, collection_tiers, collection_fields, collection_code_sequences, legacy_links (running-context check) and collections, members (running-context + `is_imported=true`). New `app.is_running_import_context()` helper. |
| `20260929100100_importer_helper_function_grants.sql` | EXECUTE on `app.slugify`, `app.uuid_generate_v7` |
| `20260929100200_importer_slug_history_read.sql` | SELECT on `public.community_slug_history` (read for slug uniqueness) |
| `20260929100300_importer_check_fn_grants.sql` | EXECUTE on `app.all_amounts_positive` (invoked by a CHECK constraint) |

All applied locally; kolekto_importer now holds a documented, tested set of public
grants for the migration schema and the eight destination public tables.

### Phase C — deterministic pure transformation functions

`packages/migration/` — new package. **37 transformer unit tests passing.**

Files:
- `src/transformers/money.ts` — exact naira → integer kobo
- `src/transformers/prefix.ts` — normalisation + shared-prefix rule (D5, D6)
- `src/transformers/tier-name.ts` — F-L4 rename `<name> [<prefix>]`
- `src/transformers/collection.ts` — full collection + tier transformation, including
  D1 (E-COL-1), D2 (Mr → archived), E-COL-2 (rejected campaign excluded), F-L3
  classification, D5 free-fixed, D6 shared-prefix, D7 quantity=0 → null, D10 cover null
- `src/transformers/user.ts` — profile → user + personal community + owner term (F-M1,
  F-L1, D10 avatar null)
- `src/transformers/contributor-code.ts` — A-1 link builder with
  `contributor:<legacy_collection>:<code>` namespacing (34 legacy codes reuse across
  collections, verified against D2)
- `src/transformers/code-sequence.ts` — resolves counters to new tier ids by
  normalised prefix

### Phase D — orchestrator

`packages/migration/src/orchestrator.ts` — `runImport({source_project, source, target, …})`.
Uses one `sql.begin()` block per entity because `set_config(..., true)` and
`SET LOCAL role` are transaction-scoped. Alternates between the connection role
(auth.users insert to keep the sign-up trigger's import-context contract) and
`kolekto_importer` for everything else.

### Phase E — synthetic fixtures

`packages/migration/test/synthetic-fixtures.ts` — **all 30 brief-required cases** shaped as
constants: 4 users, 16 collections (incl. the rejected-campaign UUID reused, duplicate
names, shared prefixes, invalid prefixes, quantity=0, free-fixed, empty ticket, no-tier-id,
contributor codes cross-collection collision).

### Phase F — reconciliation

`packages/migration/src/reconcile.ts` — control-total driven, returns `PASS/FAIL/NOTE`
rows for identity, collections by status, tier counts, contributor code links,
financial safety (0 ledger/entries/events), immutability probe.

### Phase G — isolated rehearsal target

`scripts/migration/rehearsal-target.mjs` + npm scripts `rehearsal:up`/`:down`/`:status`.

- Container: **`kolekto-rehearsal-target`** on **127.0.0.1:5455** (plain `postgres:17` image).
- Database: `postgres` (pg_cron requires that name).
- Isolated from local dev (`supabase_db_kolekto:54322`), D2 restore
  (`kolekto-legacy-restore-ro:5544`), staging.
- Preprocesses migrations to skip 7 Supabase-only extensions (`pg_cron`, `pg_net`,
  `hypopg`, `index_advisor`, `supabase_vault`, `pgmq`, `pgtap`) — the exact same
  approach D2 used. Migration files on disk are untouched.
- Trust auth on 127.0.0.1 only. Refuses to touch the three protected container names.
- **All 94 migrations applied successfully.**

## What is broken

**Transformer unit tests: 37/37 PASS. Full suite: 44/50 PASS, 6 FAIL** in `synthetic-import.test.ts`.
Cascade failure: 4 of the 6 fail because the initial import failed and the state they
check is absent.

**Root cause of the initial import failure — three specific bugs left:**

1. **`invalid input syntax for type uuid: "cn-4"`** — my synthetic fixture uses string
   ids like `cn-4` for contributions, but `migration.legacy_contribution.id` is uuid.
   Fix: either make the synthetic contribution ids uuids, or the source_id column takes
   text and the derived rowId is the uuid (the orchestrator already derives one via
   `targetUuidFor`, but I pass source_id=c.id which is `"cn-4"` — text is fine there,
   but I also insert `id = rowId` where the rowId derivation uses `c.id` and that's a
   uuid — actually the current failure trace suggests source_id (which is uuid in some
   version of the schema) — I need to verify the exact column type on
   `legacy_contribution.source_id` and pass appropriately, or change fixture ids to real
   uuids).
2. **`UNDEFINED_VALUE`** somewhere in a `sql\`\`` template. Every field I check has `?? null`;
   the remaining candidate is inside the second (`case 28`) idempotency run's second-pass
   INSERT, or one of the profile fields I haven't guarded. Need to bisect by adding a
   guard around every parameter.
3. **`officer_terms_community_id_fkey`** — the officer_terms insert precedes the
   community insert-guard's success branch. Fix: only insert officer_terms if the
   community insert succeeded (`RETURNING id` or a separate `where exists`).

## To finish this milestone

1. Fix the three orchestrator bugs above. Estimated: one focused pass, mostly local edits
   in `packages/migration/src/orchestrator.ts` and possibly `synthetic-fixtures.ts` (use
   real uuids for contribution ids).
2. Get all 12 synthetic-import assertions green (currently 6 pass, 6 fail).
3. Run the full local test matrix: `npm run typecheck && npm run invariants && npm run test && npm run lint && npm run build`.
4. Run pgTAP: `supabase test db`.
5. Produce the four remaining docs:
   - `docs/migration/legacy/IMPORTER-IMPLEMENTATION-REPORT.md`
   - `docs/migration/legacy/SYNTHETIC-IMPORT-REPORT.md`
   - `docs/migration/legacy/IMPORT-RECONCILIATION-CONTRACT.md`
   - `docs/migration/legacy/REHEARSAL-TARGET.md`
6. Confirm every safety gate in the brief §23 and produce the final decision report
   (§24) — do **not** run Rehearsal #1 against real D2 data without explicit approval.

## Do not do without approval

- Do **not** start Migration Rehearsal #1 against the D2 restore.
- Do **not** commit any of the WIP.
- Do **not** connect to staging or legacy.
- Do **not** invent an installments subsystem — the founder clarification explicitly says
  legacy tier duplicates were **simulating** installments; the new system preserves them
  as history via the F-L4 rename, and does **not** implement partial payments.

## State

| | |
|---|---|
| Branch / commit | `m8.1-financial-foundation` / `ce0b6db` (nothing committed) |
| Migrations in repo / local | 94 / 94 |
| Rehearsal target | up on `postgres://postgres@127.0.0.1:5455/postgres`, all 94 applied |
| D2 restore | up on `127.0.0.1:5544`, unchanged |
| Development DB | unchanged |
| Staging | untouched |
| Transformer unit tests | 37/37 PASS |
| End-to-end synthetic tests | 6/12 PASS — 3 bugs above block the rest |
