# Legacy control totals — production

**Source:** `busfgcmbndleljklrcbd` ("kolekto prod"), eu-central-1, PostgreSQL 15.8.1.094
**Captured:** 2026-09-26, read-only, via account-level MCP access
**Nature:** **BASELINE, not the final migration snapshot.** Production is live and
two cron jobs are active, so every figure below moves. Re-capture immediately
before the real migration.

All amounts are as stored: **naira, `numeric`**. The kobo column is
`round(v * 100)`, which is **exact** — see §3.

---

## 1. Row counts, all 53 public tables

Exact `count(*)`, not estimates.

| Table | Rows | Class |
|---|---|---|
| `payment_recovery_log` | **30,242** | operational |
| `deposits` | **6,201** | financial |
| `contributions` | **5,576** | financial |
| `email_campaign_recipients` | 4,710 | operational |
| `payment_reference_backfill_snapshot_20260811` | 3,324 | forensic snapshot |
| `pending_payment_context` | 797 | financial (state machine) |
| `profiles` | **622** | identity |
| `withdrawals` | **292** | financial |
| `collections` | **275** | core |
| `wallets` | **245** | financial (cache) |
| `wallets_backup_20260805` | 240 | forensic snapshot |
| `payment_admin_actions` | 220 | financial (audit) |
| `push_notification_events` | 173 | operational |
| `notifications` | 172 | operational |
| `email_campaign_audit_log` | 96 | operational |
| `admin_events` | 71 | staff audit |
| `settlement_runs` | 56 **(57 in the 2026-09-27 backup)** | financial (job audit) |
| `kyc_verification_history` | 55 | compliance |
| `contribution_code_counters` | 53 | core |
| `kyc_files` | 53 | compliance |
| `transfer_recipients` | 52 | financial (bank details) |
| `campuses` | 46 | subsystem |
| `kyc_documents` | 44 | compliance |
| `payout_accounts` | 26 | financial (bank details) |
| `kyc_verifications` | 21 | compliance |
| `email_test_sends` | 15 | operational |
| `push_subscriptions` | 13 | operational |
| `duplicate_void_snapshot_20260812` | 12 | forensic snapshot |
| `user_identity` | 12 | **sensitive PII** |
| `email_templates` | 8 | operational |
| `password_change_otps` | 6 | operational |
| `email_campaigns` | 5 | operational |
| `admin_users` | 2 | staff |
| `ambassador_applications` | 1 | subsystem |
| `ambassador_email_logs` | 1 | subsystem |
| `campaign_images` | 1 | subsystem |
| `campaigns` | 1 | subsystem |
| `email_campaign_attachments` | 1 | operational |
| `students` | 1 | subsystem |
| `verification_documents` | 1 | compliance |

**Empty (13 tables, still require a destination decision under zero data loss):**
`ambassador_influenced_organizers`, `ambassador_payout_accounts`,
`ambassador_profiles`, `ambassador_resources`, `ambassador_withdrawals`,
`campaign_donations`, `collection_access_grants`,
`collection_access_invite_items`, `collection_access_invites`,
`collection_transfer_requests`, `email_change_requests`, `email_unsubscribes`,
`password_reset_otps`.

**Total rows across public schema: 53,742.**

> **Corrected 2026-09-27.** This figure previously read **52,562**, which was an
> arithmetic error — the per-table list above sums to **53,742**. The per-table numbers
> were always right; only the total was wrong. No source data changed.
>
> **The D1 backup taken on 2026-09-27 holds 53,743 rows.** The one-row difference is
> `settlement_runs`, which went from **56 to 57** when the nightly settlement job appended
> an audit row between this 2026-09-26 baseline and the dump. Thirty-nine of the forty
> non-empty tables match this baseline exactly, and **no financial total moved.** Expect
> this figure to keep drifting for as long as production stays live; re-capture before the
> real migration.

---

## 2. Identity totals

| Figure | Value |
|---|---|
| `auth.users` | **623** |
| `auth.users` soft-deleted | 0 |
| `auth.users` with email | **623 (100%)** |
| `auth.users` with phone | **0** |
| `auth.users` email confirmed | 426 (68%) |
| `auth.users` phone confirmed | 0 |
| `auth.identities` | 623 |
| `profiles` | **622** |
| profiles with no auth user | **0** |
| auth users with no profile | **1** |
| `profiles.phone_number` present | **609** |
| `profiles.phone_number` absent | **13** |
| `profiles.is_organizer = true` | **0** |
| distinct `profiles.role` values | 1 |
| Profile date range | 2025-06-02 → 2026-09-14 |

---

## 3. Financial control totals

**Precision result, verified across all 11 monetary columns:** no value has more
than 2 decimal places, and no value is negative. Therefore
**naira → integer kobo is exact (`round(v*100)`) and requires no rounding rule.**

### Deposits — 6,201 rows

| Status | Rows | Gross (₦) | Net (₦) | Gross (kobo) |
|---|---|---|---|---|
| success | **4,260** | 60,423,653.63 | 54,819,041.09 | 6,042,365,363 |
| pending | 1,939 | 29,580,687.63 | 26,091,063.86 | 2,958,068,763 |
| abandoned | 2 | 16,300.00 | 0.00 | 1,630,000 |
| **Total** | **6,201** | **90,020,641.26** | **80,910,104.95** | **9,002,064,126** |

> **Read this table carefully — the two gross figures are routinely confused.**
>
> | Figure | Rows | Gross (kobo) |
> |---|---|---|
> | Gross of **all** deposits | 6,201 | **9,002,064,126** |
> | Gross of **successful** deposits | 4,260 | **6,042,365,363** |
>
> **9,002,064,126 kobo is the all-deposits gross, not the successful-deposit gross.**
> Both were confirmed against the D1 backup on 2026-09-27. The backup manifest previously
> carried `gross_kobo: 9002064126` next to `success: 4260`, which read as though the figure
> belonged to the successful subset; that key is now split into `all_gross_kobo` and
> `success_gross_kobo`. A D2 restore checked against the wrong label would either pass
> falsely or fail for no real reason.

### Contributions — 5,576 rows

`amount` is the contribution; `gross_amount` is what the contributor was charged.

| Status | Rows | Amount (₦) | Gross (₦) |
|---|---|---|---|
| paid | **3,934** | 46,069,689.35 | 47,004,759.50 |
| pending | 1,628 | 21,366,293.63 | 0 |
| duplicate_voided | 14 | 340,500.00 | 347,350.00 |
| **Total** | **5,576** | **67,776,482.98** | **47,352,109.50** |

### Withdrawals — 292 rows

| Status | Rows | Amount (₦) | Date range |
|---|---|---|---|
| approved | **239** | 41,653,495.80 | 2025-12-19 → 2026-09-17 |
| success | 43 | 4,550,917.00 | 2025-06-07 → 2025-12-08 |
| rejected | 10 | 478,460.00 | 2025-06-07 → 2026-08-02 |
| **Total** | **292** | **46,682,872.80** | |

`approved` and `success` do not overlap in time. See
[legacy-withdrawal-model.md](legacy-withdrawal-model.md) — this is a vocabulary
change, not a workflow stage, and it needs a founder ruling.

### Wallets — 245 rows (**a cache, never a source of truth**)

| Column | Total (₦) | Max (₦) |
|---|---|---|
| `available_balance` | 114,038.30 | 35,000.00 |
| `ledger_balance` | 114,038.30 | 35,000.00 |
| `pending_balance` | **0.00** | 0.00 |
| `gross_payment` | 47,004,759.50 | 13,900,000.00 |
| `net_payment` | 46,069,692.94 | 13,622,000.00 |
| `withdrawn` | 46,204,412.80 | 13,622,000.00 |

### Three reconciliations, computed from the above

| Comparison | Result |
|---|---|
| `wallets.net_payment` vs paid `contributions.amount` | 46,069,692.94 − 46,069,689.35 = **₦3.59** |
| `wallets.gross_payment` vs paid `contributions.gross_amount` | 47,004,759.50 − 47,004,759.50 = **₦0.00** |
| `withdrawals.amount` total vs `wallets.withdrawn` | 46,682,872.80 − 46,204,412.80 = **₦478,460.00**, exactly the `rejected` total — consistent |

**The ₦3.59 is the documented drift, independently reproduced by this baseline.**
It is a property of the legacy `wallets` cache and is a reason that cache must
never become an opening balance.

### Unattributed payments — the ₦19.8m matter, reproduced

| Figure | Value |
|---|---|
| Deposits with `collection_id is null` | **1,317** |
| …their total | **₦28,910,087.00** |
| Of those, `status = 'success'` | **923** |
| …their total | **₦19,799,220.00** |
| Deposits with `contributor_id is null` | 1,317 (the same rows) |

---

## 4. Referential integrity — clean

| Check | Result |
|---|---|
| Deposits pointing at a missing collection | **0** |
| Contributions with null collection | **0** |
| Contributions pointing at a missing collection | **0** |
| Collections with no matching profile | **0** |
| Collections with no matching auth user | **0** |
| Withdrawals with null collection | **0** |
| Withdrawals pointing at a missing collection or user | **0** |
| Wallets pointing at a missing collection | **0** |
| Collections with no wallet | 30 |

Every collection has a valid organizer. The only attribution gap in the whole
database is the 1,317 unattributed deposits.

---

## 5. Source control total vs migration target expectation

**These are different things and must not be conflated.**

| Entity | SOURCE control total | MIGRATION TARGET EXPECTATION |
|---|---|---|
| auth users | 623 | 623, **same UUIDs** |
| profiles | 622 | 622 → `public.users` |
| collections | 275 | 275 → `public.collections where is_imported` |
| contributions | 5,576 | 5,576 → `migration.legacy_contribution` |
| deposits | 6,201 | 4,884 → `migration.legacy_deposit`; 1,317 → `migration.unattributed_payments` |
| withdrawals | 292 | 292 → `migration.legacy_withdrawal` (**to be created, F-M2**) |
| wallets | 245 | 245 → preserved as history; **0 ledger entries** |
| **Ledger journals created by import** | — | **exactly 0** |
| **Ledger entries created by import** | — | **exactly 0** |
| **Opening balances created** | — | **exactly 0** |

**No migration has been run. No migration success is claimed.**
