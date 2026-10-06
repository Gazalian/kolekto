# Synthetic Import Report

## Summary

| Metric | Result |
|---|---|
| Transformer unit tests | 37/37 PASS |
| Synthetic import assertions | 29/29 PASS |
| Total migration test suite | 66/66 PASS |
| pgTAP database tests | 769/769 PASS |
| Target environment | `127.0.0.1:5455` (kolekto-rehearsal-target) |
| Source | `synthetic:import-test` |

## Fixture inventory

4 synthetic users, 16 collections (15 imported + 1 excluded), 16 tiers across
8 collections, 4 contributions across 2 collections (with full 16-column legacy
shape including contributor_information JSONB and gross_amount), 5 deposits
(3 attributed + 2 unattributed, all 23 columns), 3 withdrawals (approved +
success + rejected, covering bank-details exclusion, null FK, and amount
precision), 2 code counters.

### Cases tested (30 cases, mapped to synthetic fixtures)

| # | Case | Fixture |
|---|---|---|
| 1 | Normal organizer/user | U1 |
| 2 | No-phone legacy user (F-M1) | U2 |
| 3 | Multiple organizers | U3, U4 |
| 4 | Personal community creation (F-L1) | U1–U4 |
| 5 | Fixed collection | C_FIXED |
| 6 | Flat collection (legacy type) | C_FLAT |
| 7 | Tiered collection | C_TIERED |
| 8 | Ticket collection | C_TICKET |
| 9 | Fundraising collection | C_FUND |
| 10 | open_pool collection | C_OPEN_POOL |
| 11 | Deleted collection → archived (E-COL-1) | C_DELETED |
| 12 | Rejected campaign excluded (E-COL-2) | C_REJECTED |
| 13 | Duplicate tier names (F-L4) | C_DUP_NAMES |
| 14 | Duplicate tier prefixes (D6) | C_DUP_PREFIX |
| 15 | Invalid tier prefixes (D5) | C_INV_PREFIX |
| 16 | Tier quantity=0 (D7) | C_QTY_ZERO |
| 17 | Zero-price fixed collection (D5) | C_FREE_FIXED |
| 18 | Ticket collection with zero tiers (A03) | C_EMPTY_TICK |
| 19 | Tiers with missing legacy IDs | C_NO_TIER_ID |
| 20 | Legacy contributor codes → legacy_links (A-1) | C_WITH_CODES |
| 21 | Legacy code counter → seed next_number | C_WITH_CODES |
| 22 | Collection fields preserved in legacy_collection.fields | C_FIXED |
| 23 | Campaign row → legacy_overflow (no-op) | C_REJECTED |
| 24 | Wallet overflow (no-op) | — |
| 25 | Withdrawal history — 3 synthetic withdrawals with bank-details exclusion | B3 fixtures |
| 26 | Unattributed deposit history (no-op) | — |
| 27 | Provenance via imported_objects | all collections |
| 28 | Idempotent re-import | full re-run |
| 29 | Immutable migration history — refuses UPDATE | legacy_collection |
| 30 | auth import context — sign-up trigger stands aside | auth.users |

## Before/after counts (rehearsal target)

| Table | Before | After (run 1) | After (run 2) |
|---|---|---|---|
| auth.users | 0 | 4 | 4 |
| public.users | 0 | 4 | 4 |
| public.communities (personal) | 0 | 4 | 4 |
| public.officer_terms (migration) | 0 | 4 | 4 |
| public.collections (imported) | 0 | 15 | 15 |
| public.collection_tiers | 0 | 16 | 16 |
| public.legacy_links (contributor_code) | 0 | 3 | 3 |
| public.collection_code_sequences | 0 | 2 | 2 |
| migration.import_runs | 0 | 1 | 2 |
| migration.legacy_profile | 0 | 4 | 4 |
| migration.legacy_collection | 0 | 16 | 16 |
| migration.legacy_contribution | 0 | 4 | 4 |
| migration.legacy_deposit | 0 | 3 | 3 |
| migration.unattributed_payments | 0 | 2 | 2 |
| migration.legacy_withdrawal | 0 | 3 | 3 |
| migration.imported_objects | 0 | 39 | 39 |

## Test results

### Synthetic import E2E assertions (29/29 PASS)

1. **Clean import runs** — counts match control totals (including deposit and withdrawal counts)
2. **Reconcile passes every hard check** — all PASS, zero FAIL (including B2 deposit and B3 withdrawal checks)
3. **Case 12: rejected campaign excluded** — zero live collection rows
4. **Case 13: duplicate tier names** — unique, bracketed, history preserved (4 original tiers)
5. **Case 14: shared TAB2026** — higher-priced tier keeps prefix
6. **Case 15: invalid prefixes normalised** — FRONTEN, UIUX
7. **Case 16: quantity=0 → null** — Late Bird unlimited, legacy value preserved as 0
8. **B1: all 16 contribution fields preserved** — name, email, phone, contributor_information, gross_amount, amount, payment_id, check_in_status, line_index, updated_at, and all others verified in legacy_contribution.fields
9. **B1: gross_amount != amount** — both preserved independently (3000 vs 3060)
10. **B1: null optional fields** — pending contribution preserves explicit nulls for all optional columns
11. **Case 20: contributor code links** — 3 links, both namespaces populated
12. **B2: attributed deposit count** — 3 attributed deposits preserved in legacy_deposit
13. **B2: attributed deposit fields** — all 23 source columns in fields jsonb (full_name, email, phone_number, amount, net_amount, status, payment_reference, access_code, contributor_id, collection_id, channel, currency, settlement_status, wallet_id, timestamps, notification flags)
14. **B2: unattributed deposit count** — 2 unattributed deposits preserved in unattributed_payments
15. **B2: unattributed typed columns + raw_payload** — amount_kobo, net_amount_kobo, original_status, original_created_at, original_paid_at, payment_reference all populated; raw_payload contains complete source snapshot
16. **B2: amount precision** — ₦7,500.50 → 750,050 kobo exact
17. **B2: null optional fields** — abandoned deposit preserves null phone, access_code, paid_at, channel, settled_at, settlement_status
18. **B3: withdrawal count** — 3 withdrawals preserved in legacy_withdrawal
19. **B3: typed columns** — amount_kobo, original_status, legacy_user_id, legacy_collection_id, legacy_wallet_id, provider_transfer_code, provider_recipient_code, timestamps all correct
20. **B3: fields excludes destination_account** — bank details intentionally excluded; non-sensitive fields (user_id, collection_id, wallet_id, amount, status, Paystack codes, timestamps) preserved
21. **B3: excluded collection → null FK** — withdrawal on rejected collection has null collection_id, legacy_collection_id preserved
22. **B3: null optional fields** — withdrawal with null Paystack codes preserves nulls
23. **B3: amount precision** — ₦10,500.50 → 1,050,050 kobo exact
24. **B3: provenance** — every withdrawal has imported_objects entry (3/3, individually verified)
25. **Case 27: provenance** — every imported collection has imported_objects entry
26. **Case 28: idempotency** — second run creates zero new rows (including deposits and withdrawals)
27. **Case 29: immutability** — UPDATE on legacy_collection refused
28. **Case 30: import context** — zero extra personal communities from sign-up trigger
29. **Financial safety** — 0 ledger journals, 0 ledger entries, 0 financial events

### Reconciliation (all PASS)

- users imported = source profiles: 4 = 4
- personal communities = source profiles: 4 = 4
- owner terms = source profiles: 4 = 4
- auth.users imported = source profiles: 4 = 4
- imported collections = source − rejected: 15 = 15
- rejected campaign zero live rows: 0 = 0
- provenance columns filled: 0 missing = 0
- tier rows imported: 16 ≥ 16
- contributor code links: 3 ≥ 3
- no ledger journals: 0 = 0
- no ledger entries: 0 = 0
- no financial events: 0 = 0
- withdrawals imported = source withdrawals: 3 = 3
- legacy_collection refuses UPDATE: refused

### Idempotency result

Second run produces identical counts — zero new users, communities, collections,
tiers, legacy links, deposits, or withdrawals.

### Financial safety result

| Check | Result |
|---|---|
| Ledger journals | 0 |
| Ledger entries | 0 |
| Financial events | 0 |
| Wallet rows created | 0 |
| Paystack calls | 0 |
| Real payment records | 0 |

### Immutability result

`migration.legacy_collection` refuses UPDATE — trigger fires and raises.
