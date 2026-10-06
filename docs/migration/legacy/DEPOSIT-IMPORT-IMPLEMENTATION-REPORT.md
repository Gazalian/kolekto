# Deposit Import Implementation Report (B2)

## D2 deposit schema

23 columns in `public.deposits`:

| Column | Type | Nullable |
|---|---|---|
| id | uuid | NO |
| full_name | varchar | NO |
| email | varchar | NO |
| phone_number | varchar | YES |
| amount | numeric | NO |
| status | varchar | NO |
| payment_reference | varchar | NO |
| access_code | varchar | YES |
| authorization_url | text | YES |
| contributor_id | uuid | YES |
| collection_id | uuid | YES |
| created_at | timestamptz | YES |
| updated_at | timestamptz | YES |
| paid_at | timestamptz | YES |
| channel | varchar | YES |
| currency | varchar | YES |
| wallet_id | uuid | YES |
| settled_at | timestamptz | YES |
| settlement_status | text | YES |
| net_amount | numeric | NO |
| init_email_sent | boolean | NO |
| contributor_confirmed_sent | boolean | NO |
| organizer_notified_sent | boolean | NO |

## Source row counts

| Population | Count | Amount (₦) | Net (₦) |
|---|---|---|---|
| Attributed (success) | 3,337 | 40,624,433.63 | 35,408,041.09 |
| Attributed (pending) | 1,545 | 20,469,820.63 | 17,213,005.81 |
| Attributed (abandoned) | 2 | 16,300.00 | 0.00 |
| **Attributed total** | **4,884** | **61,110,554.26** | **52,621,046.90** |
| Unattributed (success) | 923 | 19,799,220.00 | 19,411,000.00 |
| Unattributed (pending) | 394 | 9,110,867.00 | 8,878,058.05 |
| **Unattributed total** | **1,317** | **28,910,087.00** | **28,289,058.05** |
| **Grand total** | **6,201** | **90,020,641.26** | **80,910,104.95** |

Attribution is determined by `contributor_id IS NOT NULL` (attributed) vs
`contributor_id IS NULL` (unattributed). This partitioning is clean in D2 —
no unattributed deposits have a `collection_id`, and every attributed deposit
has both `contributor_id` and `collection_id`.

## Destination mapping

| Population | Destination table | Storage |
|---|---|---|
| Attributed | `migration.legacy_deposit` | `source_id` (uuid) + `fields` (jsonb snapshot of all 23 columns) |
| Unattributed | `migration.unattributed_payments` | `source_id` + typed columns (`amount_kobo`, `net_amount_kobo`, `original_status`, `original_created_at`, `original_paid_at`, `payment_reference`) + `raw_payload` (jsonb snapshot of all 23 columns) |

Both tables use `(source_table, source_id)` unique indexes for idempotency.

## All preserved fields

Every one of the 23 D2 deposit columns is preserved:

- `id` → `source_id` column on both destination tables
- All 22 remaining columns → `fields` jsonb (legacy_deposit) or `raw_payload`
  jsonb (unattributed_payments)
- For unattributed_payments, key fields are additionally stored in typed columns:
  `amount` → `amount_kobo` (bigint, Naira×100 via `nairaToKobo`),
  `net_amount` → `net_amount_kobo`, `status` → `original_status`,
  `created_at` → `original_created_at`, `paid_at` → `original_paid_at`,
  `payment_reference` → `payment_reference`

## SourceRepository changes

Added to `orchestrator.ts`:

- `LegacyDeposit` type — all 23 D2 deposit columns, strongly typed
- `SourceRepository.listAttributedDeposits()` — returns deposits where
  `contributor_id IS NOT NULL`
- `SourceRepository.listUnattributedDeposits()` — returns deposits where
  `contributor_id IS NULL`

## Orchestrator changes

Added two new phases to `runImport()`:

- Phase 5: Attributed deposits → `migration.legacy_deposit`
- Phase 6: Unattributed deposits → `migration.unattributed_payments`

Each deposit in its own `sql.begin()` block with import context and importer
role. Deterministic UUIDs via `targetUuidFor(source_project, "legacy_deposit"|"unattributed_payment", legacy_id)`.

New counters: `attributed_deposits_seen`, `attributed_deposits_imported`,
`unattributed_deposits_seen`, `unattributed_deposits_imported`.

## Idempotency result

Second import run produces zero additional `legacy_deposit` or
`unattributed_payments` rows. Verified in synthetic test case 28.

## Reconciliation result

New checks added to `reconcile.ts`:

- `attributed deposits imported = source attributed deposits`: PASS
- `unattributed deposits imported = source unattributed deposits`: PASS

All existing reconciliation checks remain PASS.

## Synthetic test result

5 synthetic deposits: 3 attributed (success, pending, abandoned) + 2
unattributed (success, pending).

6 new B2 test assertions:

1. Attributed deposit count matches
2. All 23 source fields preserved in legacy_deposit.fields
3. Unattributed deposit count matches
4. Typed columns + raw_payload populated correctly
5. Amount precision: ₦7,500.50 → 750,050 kobo
6. Null optional fields preserved as null

## Financial safety result

| Check | Result |
|---|---|
| Ledger journals | 0 |
| Ledger entries | 0 |
| Financial events | 0 |
| Wallet rows | 0 |
| Paystack calls | 0 |

The importer role (`kolekto_importer`) cannot read or write ledger, financial
event, or wallet tables. Verified by pgTAP test 28 (24/24 PASS).

## Test results

| Suite | Result |
|---|---|
| Migration (import + transformers) | 59/59 PASS |
| pgTAP | 769/769 PASS |
| Typecheck | PASS |
| Invariants | 6/6 PASS |
| Lint | PASS |
| Build | PASS |

## Limitations

- **B3 — withdrawals** remain unimplemented (292 rows, ₦46.7M)
- **B4 — overflow/wallet history** remains unimplemented (~39 tables, ~36,790+ rows)
- The importer is NOT ready for D2 rehearsal until B3 and B4 are resolved
