# Withdrawal Import Implementation Report (B3)

## D2 withdrawal schema

11 columns in `public.withdrawals`:

| Column | Type | Nullable |
|---|---|---|
| id | uuid | NO |
| user_id | uuid | NO |
| collection_id | uuid | NO |
| wallet_id | uuid | NO |
| amount | numeric | NO |
| status | varchar | NO |
| destination_account | jsonb | YES |
| paystack_transfer_code | varchar | YES |
| paystack_recipient_code | varchar | YES |
| created_at | timestamptz | YES |
| updated_at | timestamptz | YES |

## Source row counts

| Status | Count | Amount (₦) |
|---|---|---|
| approved | 239 | 41,653,495.80 |
| success | 43 | 4,550,917.00 |
| rejected | 10 | 478,460.00 |
| **Total** | **292** | **46,682,872.80** |

All 292 rows have non-null values for every column, including
`destination_account` (bank details).

## Destination mapping

All withdrawals → `migration.legacy_withdrawal`.

### Typed columns (10 of 11 D2 columns)

| D2 column | Destination column | Notes |
|---|---|---|
| id | source_id | Legacy UUID preserved |
| user_id | legacy_user_id | NOT NULL |
| collection_id | legacy_collection_id | NOT NULL, always stores legacy UUID |
| collection_id | collection_id | FK to imported collections, NULL if collection was excluded |
| wallet_id | legacy_wallet_id | Nullable in destination, NOT NULL in D2 |
| amount | amount_kobo | `nairaToKobo()` exact conversion |
| status | original_status | NOT NULL, must be non-empty |
| paystack_transfer_code | provider_transfer_code | Nullable |
| paystack_recipient_code | provider_recipient_code | Nullable |
| created_at | original_created_at | Nullable |
| updated_at | original_updated_at | Nullable |

### Excluded column

| D2 column | Reason |
|---|---|
| destination_account | Contains sensitive bank details (accountName, accountNumber, bank_code, bankCode, bank_name). Excluded by schema constraint `legacy_withdrawal_no_bank_details`: `NOT (fields ? 'destination_account')`. |

### Fields jsonb snapshot

The `fields` column stores a non-sensitive snapshot of 9 columns: `user_id`,
`collection_id`, `wallet_id`, `amount`, `status`, `paystack_transfer_code`,
`paystack_recipient_code`, `created_at`, `updated_at`. The
`destination_account` key is intentionally excluded — the CHECK constraint
enforces this at the database level.

## SourceRepository changes

Added to `orchestrator.ts`:

- `LegacyWithdrawal` type — all 11 D2 withdrawal columns, strongly typed
  (including `destination_account: unknown` for type safety)
- `SourceRepository.listWithdrawals()` — returns all withdrawal rows

## Orchestrator changes

Added one new phase to `runImport()`:

- Phase 7: Withdrawals → `migration.legacy_withdrawal`

Each withdrawal in its own `sql.begin()` block with import context and importer
role. Deterministic UUIDs via `targetUuidFor(source_project, "legacy_withdrawal", legacy_id)`.

The `collection_id` FK is resolved from `legacyToNewCollection` — if the
withdrawal's collection was excluded (e.g. rejected campaign), `collection_id`
is NULL while `legacy_collection_id` always stores the original D2 UUID.

New counters: `withdrawals_seen`, `withdrawals_imported`.

## Idempotency result

Second import run produces zero additional `legacy_withdrawal` rows. Verified
in synthetic test case 28 (the unique index on `(source_project, source_table, source_id)`
ensures `ON CONFLICT DO NOTHING`).

## Reconciliation result

New check added to `reconcile.ts`:

- `withdrawals imported = source withdrawals`: PASS

All existing reconciliation checks remain PASS.

## Synthetic test result

3 synthetic withdrawals: approved (with bank details + Paystack codes, on
imported collection), success (null Paystack codes, on imported collection),
rejected (with bank details, on excluded collection → null FK).

7 new B3 test assertions:

1. Withdrawal count matches (3 rows)
2. Typed columns populated correctly (amount_kobo, original_status, legacy IDs,
   Paystack codes, timestamps, collection_id FK)
3. Fields jsonb excludes destination_account, preserves non-sensitive fields
4. Withdrawal on excluded collection has null collection_id FK, legacy ID preserved
5. Null optional fields preserved as null (Paystack codes)
6. Amount precision: ₦10,500.50 → 1,050,050 kobo
7. Every withdrawal has imported_objects provenance (3 entries, individually verified)

## Financial safety result

| Check | Result |
|---|---|
| Ledger journals | 0 |
| Ledger entries | 0 |
| Financial events | 0 |
| Wallet rows | 0 |
| Paystack calls | 0 |

## Test results

| Suite | Result |
|---|---|
| Migration (import + transformers) | 66/66 PASS |
| pgTAP | 769/769 PASS |
| Typecheck | PASS |
| Invariants | 6/6 PASS |
| Lint | PASS |
| Build | PASS |

## Provenance

Every imported withdrawal has a corresponding `migration.imported_objects` row:

- `source_project` — from orchestrator input
- `source_table` — `'public.withdrawals'` (schema-qualified per CHECK constraint)
- `source_id` — the D2 withdrawal UUID
- `target_table` — `'migration.legacy_withdrawal'`
- `target_id` — deterministic UUID from `targetUuidFor(source_project, "legacy_withdrawal", legacy_id)`
- `import_run_id` — the current run

Provenance is created inside the same transaction as the withdrawal insert,
under the importer role, with `ON CONFLICT DO NOTHING` for idempotency.

Verified: all 3 synthetic withdrawals have exactly 1 imported_objects entry each.

## Security note

The `destination_account` field contains sensitive bank account information
(account name, number, bank codes). The schema was designed to intentionally
exclude this data from the migration archive:

1. Typed columns capture every non-sensitive D2 field
2. The `fields` jsonb stores a non-sensitive snapshot
3. The CHECK constraint `legacy_withdrawal_no_bank_details` enforces exclusion
   at the database level — any INSERT that includes `destination_account` in
   `fields` is refused

This is a deliberate security decision, not data loss.

## Final verification

| Check | Result |
|---|---|
| Provenance (imported_objects) | 3/3 withdrawal rows have provenance entries |
| Sensitive data (destination_account) | 0 rows contain bank details in fields; constraint enabled and validated |
| Reconciliation | withdrawals imported = source withdrawals: 3 = 3 |
| Idempotency | second run creates 0 new withdrawal rows, 0 duplicate provenance |
| Immutability | UPDATE, DELETE, TRUNCATE all refused on legacy_withdrawal |
| Financial safety | 0 ledger journals, 0 ledger entries, 0 financial events, 0 wallet rows |
| D2 source stability | 292 unique UUIDs, all non-null, table is `public.withdrawals` |
| Field preservation | 10/11 D2 columns preserved (destination_account intentionally excluded) |

## Limitations

- **B4 — overflow/wallet history** remains unimplemented (~39 tables, ~36,790+ rows)
- The importer is NOT ready for D2 rehearsal until B4 is resolved
