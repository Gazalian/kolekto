# Production-readiness audit — importer vs D2 legacy production

**Date:** 2026-09-29
**Scope:** Read-only audit of the migration importer against the D2 legacy
production restore at `127.0.0.1:5544/legacy_restore`.
**Method:** Compared orchestrator implementation, SourceRepository interface,
synthetic fixtures, migration schema, and documentation against every table
and column in the D2 restore.

---

## Classification

```
NOT_READY — 5 BLOCKERS
```

The importer handles users, collections, tiers, contributions (partially), and
code sequences. It does NOT handle deposits, withdrawals, wallets, or the ~38
legacy overflow tables. The contribution field capture is also incomplete.
A D2 rehearsal run would succeed technically but would silently skip the
majority of financial history rows.

---

## 1. Users and profiles

| Metric | D2 | Importer |
|---|---|---|
| auth.users | 623 | Reads from `listProfiles` (622 profiles) |
| profiles | 622 | All 622 imported to `public.users` + `legacy_profile` |
| Orphan auth users (no profile) | **1** | **Skipped** |

**Finding:** One auth user (`6a2a3492…`, adaudiqueen@gmail.com) has an
`auth.users` row but no profile. The importer's `listProfiles` path never
sees this user. The user owns zero collections, zero contributions, zero
deposits, zero withdrawals — no product data exists.

**Severity:** Low. Zero-loss violation in principle, but the user has no
data to lose. The orchestrator should handle this (create an auth.users row
with no public.users row, or create a minimal profile), but it is not a
rehearsal blocker if documented.

## 2. Collections

| Metric | D2 | Importer |
|---|---|---|
| Total collections | 275 | All 275 read; 1 excluded (rejected campaign) |
| Deleted → archived | 12 | Handled |
| "Mr" collection | 1 | Archived with rename |
| Fixed+tiered (lose structured tiers) | **2** | Tiers preserved in `legacy_collection.fields.price_tiers` jsonb only — no `collection_tiers` rows |

**Finding:** 2 collections with `collection_type` in (fixed, flat) also carry
`price_tiers` with entries. The transformer drops structured tier rows when
`amount_model === "fixed"` (by design — `collection_type` is authoritative per
F-L3). Original tier data is preserved in the legacy_collection JSONB snapshot.

**Severity:** Low — documented architectural decision, not a bug. The tier
data is preserved (in jsonb), just not as live `collection_tiers` rows.

## 3. Contributions — BLOCKER B1

| Metric | D2 | Importer |
|---|---|---|
| Total contributions | 5,576 | All read via `listContributionsForCollection` |
| Columns in D2 | **16** | **5 captured** in `legacy_contribution.fields` |
| Amount total | ₦67,776,482.98 | `amount` captured |
| Gross amount total | ₦47,352,109.50 | **NOT captured** — differs from `amount` for ALL 5,576 rows |

**Fields captured:** `contributor_unique_code`, `payment_reference`, `amount`,
`status`, `created_at`

**Fields NOT captured:**

| Column | Why it matters |
|---|---|
| `collection_id` | Links contribution to collection — needed for any future cross-reference |
| `name` | Contributor's name at payment time |
| `email` | Contributor's email at payment time |
| `phone` | Contributor's phone at payment time |
| `contributor_information` | **Rich JSONB receipt data** — tier selections, payment details, unique codes, fee breakdowns. Present for ALL 5,576 rows |
| `gross_amount` | Differs from `amount` for every row — carries fee/split information |
| `updated_at` | Timestamp of last modification |
| `payment_id` | Provider reference |
| `check_in_status` | Event attendance tracking |
| `line_index` | Position in collection |

**Root cause:** The `SourceRepository.listContributionsForCollection` interface
type signature only returns 6 fields. The orchestrator stores whatever the
interface provides. This is an interface design gap, not just an orchestrator
oversight.

**Verdict:** BLOCKER. Zero-loss requirement (F-M3) demands every field be
preserved. `contributor_information` and `gross_amount` carry information that
cannot be reconstructed from other fields.

## 4. Deposits — BLOCKER B2

| Metric | D2 | Importer |
|---|---|---|
| Total deposits | 6,201 | **Zero imported** |
| Attributed (have contributor_id) | 4,884 | Destination: `legacy_deposit` — **no orchestrator step** |
| Unattributed (no contributor_id) | 1,317 | Destination: `unattributed_payments` — **no orchestrator step** |
| Unattributed successful | 923 | ₦19,799,220 |
| Total deposit amount | ₦90,020,641.26 | — |
| Deposit columns | 23 | — |

**Root cause:** No `listDeposits` method on `SourceRepository`. No import
step in the orchestrator. The migration schema tables (`legacy_deposit`,
`unattributed_payments`) exist and have grants — the orchestrator simply
never writes to them.

**Verdict:** BLOCKER. ₦90M in provider transaction history would be lost.

## 5. Withdrawals — BLOCKER B3

| Metric | D2 | Importer |
|---|---|---|
| Total withdrawals | 292 | **Zero imported** |
| Total withdrawal amount | ₦46,682,872.80 | — |
| Withdrawal columns | 11 | — |
| `destination_account` (bank details) | Present | `legacy_withdrawal` schema has constraint blocking it (`legacy_withdrawal_no_bank_details`) |

**Root cause:** No `listWithdrawals` method on `SourceRepository`. No import
step in the orchestrator. The `migration.legacy_withdrawal` table exists with
the bank-detail redaction constraint already in place.

**Verdict:** BLOCKER. ₦46.7M in withdrawal history would be lost.

## 6. Wallets and overflow — BLOCKER B4

| Metric | D2 | Importer |
|---|---|---|
| Wallets | 245 | **Zero imported** |
| Wallet total balance | ₦114,038.30 (available = ledger) | — |
| Other overflow tables | ~38 tables | **Zero imported** |
| Largest overflow table | `payment_recovery_log` (30,242 rows) | — |

**Destination for all:** `migration.legacy_overflow` (exists, has grants,
has `source_id` as TEXT to handle diverse PK types).

**Root cause:** No `listOverflowRows` method on `SourceRepository`. No import
step in the orchestrator. The table exists and is tested (pgTAP test 28
confirms the importer role can write and read back from `legacy_overflow`).

**Notable overflow tables by row count:**

| Table | Rows |
|---|---|
| `payment_recovery_log` | 30,242 |
| `email_campaign_recipients` | 4,710 |
| `pending_payment_context` | 797 |
| `payment_admin_actions` | 220 |
| `push_notification_events` | 173 |
| `notifications` | 172 |
| `email_campaign_audit_log` | 96 |
| `admin_events` | 71 |
| `settlement_runs` | 57 |
| 33 more tables | < 55 rows each |

**Verdict:** BLOCKER. Zero-loss requires every table to have a destination,
and those destinations exist in the schema — the orchestrator just doesn't
write to them.

## 7. SourceRepository interface — BLOCKER B5

The `SourceRepository` interface (`orchestrator.ts:24-38`) exposes five
methods:

```
listProfiles()
listCollections()
listTiersForCollection(id)
listContributionsForCollection(id)
listContributionCodeCounters()
```

**Missing methods needed for D2 coverage:**

| Method | Destination table | D2 rows |
|---|---|---|
| `listDepositsForCollection(id)` | `legacy_deposit` | 4,884 |
| `listUnattributedDeposits()` | `unattributed_payments` | 1,317 |
| `listWithdrawals()` | `legacy_withdrawal` | 292 |
| `listWallets()` | `legacy_overflow` | 245 |
| `listOverflowTable(name)` | `legacy_overflow` | ~36,300+ |

Additionally, `listContributionsForCollection` returns only 6 of 16 columns.
The return type must be widened to include at minimum: `collection_id`, `name`,
`email`, `phone`, `contributor_information`, `gross_amount`, `updated_at`,
`payment_id`, `check_in_status`, `line_index`.

**Verdict:** BLOCKER — this is the root constraint. The orchestrator can only
import what the interface exposes.

## 8. Financial safety

| Check | Result |
|---|---|
| Importer can read `ledger_entries` | **PASS — denied** |
| Importer can read `ledger_journals` | **PASS — denied** |
| Importer can read `financial_events` | **PASS — denied** |
| Importer can read `wallets` (new schema) | N/A — table does not exist in new schema |
| Importer can read `wallet_transactions` | N/A — table does not exist in new schema |
| Importer can read `deposits` (new schema) | N/A — table does not exist in new schema |
| Importer can read `withdrawals` (new schema) | N/A — table does not exist in new schema |
| No Paystack import in orchestrator | **PASS — verified by code inspection** |
| `kolekto_importer` has UPDATE/DELETE/TRUNCATE | **PASS — zero grants** (pgTAP test 5) |
| Completed runs are frozen | **PASS** (pgTAP test 14) |

**Verdict:** PASS. The importer cannot create financial events, ledger entries,
or wallet balances. The new schema does not even have wallet/deposit/withdrawal
tables — those concepts are redesigned. Financial safety is sound.

## 9. Idempotency

| Check | Result |
|---|---|
| UUID derivation | SHA-256 of `(source_project\|kind\|legacyId)` → version-8 UUID |
| Collision within same source | Impossible — inputs are unique by construction |
| Collision across sources | Impossible — `source_project` discriminates |
| ON CONFLICT handling | `DO NOTHING` on all inserts |
| Re-import produces zero new rows | **PASS** (synthetic test case 28) |
| Import run counter increments | **PASS** (new `import_runs` row, no duplicate data) |

**Verdict:** PASS. The deterministic UUID strategy is sound. SHA-256 space
with unique composite keys eliminates collision risk. Idempotency is verified
in the synthetic suite.

## 10. Provenance

| Check | Result |
|---|---|
| `imported_objects` links every target row | **PASS** for users, communities, collections, tiers |
| `legacy_profile` preserves original fields | **PASS** — 10 fields captured |
| `legacy_collection` preserves original fields | **PASS** — 17 fields including `price_tiers` |
| `legacy_contribution` preserves original fields | **PARTIAL** — only 5 of 16 fields |
| Collections carry inline provenance | **PASS** — `is_imported`, `source_system`, `source_table`, `source_id`, `imported_at`, `import_run_id` |
| Deposits have provenance | **NOT IMPLEMENTED** |
| Withdrawals have provenance | **NOT IMPLEMENTED** |
| Overflow tables have provenance | **NOT IMPLEMENTED** |

**Verdict:** PARTIAL. Provenance is complete for users, communities, collections,
and tiers. Incomplete for contributions (5 of 16 fields). Non-existent for
deposits, withdrawals, and overflow.

## 11. Synthetic vs D2 gap matrix

| Entity | Synthetic | D2 production | Gap |
|---|---|---|---|
| Users/profiles | 4 | 622 + 1 orphan | Orphan not tested |
| Collections | 16 (15 imported + 1 excluded) | 275 | Scale only — shapes covered |
| Tiers | 16 across 8 collections | 305 entries / 79 collections | Shapes covered (dup names, dup prefix, qty=0, missing IDs) |
| Contributions | 4 (5 fields each) | 5,576 (16 fields each) | **11 fields untested** |
| Deposits | **0** | **6,201** | **Entire entity untested** |
| Withdrawals | **0** | **292** | **Entire entity untested** |
| Wallets | **0** | **245** | **Entire entity untested** |
| Overflow tables | **0** | **~38 tables, ~36,300+ rows** | **Entire category untested** |
| Code counters | 2 | 53 | Scale only |
| Contributor codes | 3 links | ~5,576 potential | Scale only |

**Triple duplicate tier names:** Exist in D2 — the `resolveTierNames` algorithm
handles N-way duplicates (not just pairs). Verified by code inspection.

**Duplicate phone numbers:** Up to 7 profiles share a single phone. Not a
blocking issue — `phone_e164` is not unique-constrained in the new schema.

**ticket+flat type mismatch:** Exists in D2 — classifier handles it correctly
(`collection_type` is authoritative per F-L3).

## 12. Documentation accuracy

| Document | Accurate? | Notes |
|---|---|---|
| `IMPORTER-IMPLEMENTATION-REPORT.md` | **Yes** | Correctly lists "Legacy withdrawals not yet imported" and "Legacy overflow not yet populated" as known limitations |
| `SYNTHETIC-IMPORT-REPORT.md` | **Yes** | Accurately reports 13/13 pass, correctly lists cases 24-26 as "(no-op)" |
| `IMPORT-RECONCILIATION-CONTRACT.md` | **Yes** | All checks are implemented and accurate. Does NOT claim to cover deposits/withdrawals/overflow |
| `REHEARSAL-TARGET.md` | **Yes** | Connection details, isolation guarantees, and safety checks all accurate |
| `migration-destination-matrix.md` | **Yes** | All 53 tables accounted for. Row counts and destinations match D2 reality. Financial totals verified: ₦19,799,220 unattributed deposits (923 success), ₦46,682,872.80 withdrawals |

**Claim check — importer role grants:** Documentation says "INSERT + SELECT
on nine migration-schema tables and nine public destination tables." pgTAP
test 28 verifies exactly 18 INSERT tables and 19 SELECT tables (18 + 
`community_slug_history`). Accurate.

**Claim check — zero financial movement:** Documentation says "No access to
`ledger_*`, `financial_events`, or payment tables." Verified directly: importer
role is denied SELECT on all three. Accurate.

## 13. Blocker summary and remediation estimate

| ID | Blocker | Rows affected | Financial exposure | Remediation |
|---|---|---|---|---|
| **B1** | Contribution fields incomplete (5 of 16 columns) | 5,576 | ₦67.8M amount, ₦47.4M gross_amount not captured | Widen `SourceRepository.listContributionsForCollection` return type; update orchestrator to capture all 16 columns |
| **B2** | No deposit import step | 6,201 | ₦90.0M | Add `listDeposits*` to `SourceRepository`; add orchestrator step for `legacy_deposit` and `unattributed_payments` |
| **B3** | No withdrawal import step | 292 | ₦46.7M | Add `listWithdrawals` to `SourceRepository`; add orchestrator step for `legacy_withdrawal` (with bank-detail redaction per existing constraint) |
| **B4** | No wallet/overflow import step | ~36,790+ across ~39 tables | ₦114K wallet balances (read-only history, never opening balances) | Add generic overflow loader; iterate all non-primary tables |
| **B5** | `SourceRepository` interface too narrow | — | — | Root cause of B1-B4; interface must grow to expose all legacy data |

### Remediation order

1. **B5 first** — extend `SourceRepository` with new methods and widen
   contribution return type
2. **B1** — contribution field capture (smallest orchestrator change)
3. **B2** — deposit import step (highest row count)
4. **B3** — withdrawal import step (highest financial single-table exposure)
5. **B4** — overflow/wallet step (most tables, but structurally simple —
   `legacy_overflow` handles arbitrary tables via `source_table` + `fields` jsonb)

### What is already sound

- User/profile import — complete and correct
- Collection import — complete including all edge cases
- Tier transformation — handles duplicates, quantity=0, invalid prefixes
- Financial safety — importer role is locked out of ledger/financial tables
- Idempotency — deterministic UUIDs, ON CONFLICT DO NOTHING
- Immutability — triggers and grants prevent modification of history
- Migration schema — all destination tables exist and have correct grants
- pgTAP privilege boundary — 24/24 tests pass
- Documentation — accurate and consistent with implementation

---

**Recommendation:** Do NOT proceed to a D2 rehearsal until blockers B1-B5 are
resolved. The rehearsal would succeed mechanically (no crashes) but would
silently skip ₦204M+ in financial history across deposits, withdrawals, and
incomplete contributions. That outcome would be worse than not running the
rehearsal at all, because it would produce a misleading "success" result.
