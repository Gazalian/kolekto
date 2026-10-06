# Legacy data inventory — quality and distributions

**Source:** `busfgcmbndleljklrcbd`, verified 2026-09-26.
Row counts are in [legacy-control-totals.md](legacy-control-totals.md); this
document covers **data quality**: distributions, nulls, orphans, duplicates.

**No raw rows were extracted.** Every figure is an aggregate, and no dump exists
anywhere in this repository.

---

## 1. Date coverage

| Entity | Earliest | Latest |
|---|---|---|
| profiles | 2025-06-02 | 2026-09-14 |
| withdrawals (`success`) | 2025-06-07 | 2025-12-08 |
| withdrawals (`approved`) | 2025-12-19 | 2026-09-17 |
| withdrawals (`rejected`) | 2025-06-07 | 2026-08-02 |

Roughly 15 months of operation. Note the clean, non-overlapping split in withdrawal
status — analysed in [legacy-withdrawal-model.md](legacy-withdrawal-model.md).

---

## 2. Status distributions

**Collections (275)** — active 237 · closed 21 · **deleted 12** · paused 4 ·
rejected 1.

**Contributions (5,576)** — paid 3,934 · pending 1,628 · **duplicate_voided 14**.

**Deposits (6,201)** — success 4,260 · pending 1,939 · abandoned 2.

**Withdrawals (292)** — approved 239 · success 43 · rejected 10.

**`pending_payment_context` (797)** — states `initialized`, `completed`, `failed`,
`reconciled`; reconciliation states `null`, `recovered`.

Three of these have no equivalent in the new schema and must be preserved verbatim:
`duplicate_voided`, `paused`, `rejected`. A fourth, `deleted`, needs a timestamp the
legacy schema does not record (exception E-COL-1).

**1,939 pending deposits (₦29.5m) and 1,628 pending contributions (₦21.4m)** are a
large tail. Some are abandoned checkouts; some may be genuine payments never
reconciled. The distinction matters for the migration report but not for the
destination — both are preserved verbatim with their original status.

---

## 3. Null and completeness counts on columns that matter

| Column | Present | Absent |
|---|---|---|
| `auth.users.email` | **623** | 0 |
| `auth.users.phone` | **0** | **623** |
| `profiles.phone_number` | 609 | **13** |
| `contributions.email` | **5,576** | 0 |
| `contributions.phone` | 4,378 | 1,198 |
| `contributions.contributor_unique_code` | 2,494 | 3,082 |
| `contributions.payment_reference` | 3,936 | **1,640** |
| `contributions.line_index` | **5,576** | 0 |
| `contributions.contributor_information` | **5,576** | 0 |
| `deposits.collection_id` | 4,884 | **1,317** |
| `deposits.contributor_id` | 4,884 | **1,317** |
| `collections.collection_type` | **275** | 0 |
| `withdrawals.collection_id` | **292** | 0 |
| `withdrawals.paystack_transfer_code` | **292** | 0 |

**Zero contributions have neither an email nor a phone** — every contributor is
contactable, which is what makes ~3,353 `unclaimed` member records constructible.

**1,640 contributions have no `payment_reference`.** This is what the
`payment_reference_backfill_snapshot_20260811` table (3,324 rows) relates to. A
contribution without a provider reference cannot be traced to a deposit, so it is
preserved as-is and not reconciled.

---

## 4. Orphans and referential integrity — clean

| Check | Result |
|---|---|
| deposits → missing collection | **0** |
| contributions with null collection | **0** |
| contributions → missing collection | **0** |
| collections → missing profile | **0** |
| collections → missing auth user | **0** |
| withdrawals with null collection | **0** |
| withdrawals → missing collection | **0** |
| withdrawals → missing user | **0** |
| wallets → missing collection | **0** |
| profiles → missing auth user | **0** |

**The only attribution gap in the entire database is the 1,317 unattributed
deposits.** Nothing else dangles. This is a genuinely good result and it materially
simplifies the migration: there are no broken parent-child relationships to repair,
only one well-understood set of unattributable payments.

30 collections have no wallet row — consistent with never having taken a payment,
and harmless because wallets are a cache rather than a record.

---

## 5. Duplicates

| Check | Result |
|---|---|
| duplicate profile emails | **0** |
| duplicate phone groups (last 10 digits) | **27 groups, 66 profiles, largest 8** |
| duplicate tier names within a collection | **23 groups across 5 collections** |
| contributions marked `duplicate_voided` | 14 (₦340,500) |

Email is a reliable unique identity in legacy; phone is not. Both duplicate sets
need review rather than automatic resolution — see
[legacy-identity-inventory.md](legacy-identity-inventory.md) §3 and
[legacy-collection-model.md](legacy-collection-model.md) §4.

---

## 6. Data-quality observations that affect the migration

**Denormalised counters that disagree with their source.** `collections.total_contributions`
and `next_contributor_number`, and all six wallet columns. The new schema derives
these. The measured consequence is the **₦3.59** gap between `wallets.net_payment`
and the sum of paid contributions.

**15 phone numbers exceed 13 digits.** Malformed; need E.164 normalisation with the
original retained.

**`is_organizer` is false on all 622 profiles** despite 275 collections existing. The
flag was never maintained; organizer status must be derived from
`collections.user_id`.

**All 622 profiles share one `role` value.** The legacy `role` column carries no
information. The new permission model is rows in `role_permissions`, so nothing is
lost.

**`wallets.pending_balance` is 0.00 in all 245 rows**, and `available_balance` equals
`ledger_balance` in all 245. Two names, one number, nothing mid-settlement.

**Total unwithdrawn across the platform: ₦114,038.30.** Against ₦46.7m withdrawn
historically. Very little live balance to reconcile at cutover.

---

## 7. Sensitive data classes

Flagged for the migration, not extracted here.

| Table | Rows | Contains |
|---|---|---|
| `user_identity` | 12 | **NIN and BVN** ciphertext, hashes, last-4 |
| `payout_accounts` | 26 | encrypted account number, last-4, recipient code |
| `transfer_recipients` | 52 | **plaintext** account numbers |
| `withdrawals.destination_account` | 292 | jsonb bank details |
| `profiles` | 622 | name, email, phone, address, DOB, signup IP |
| `contributions` | 5,576 | contributor name, email, phone |
| `kyc_files` / `kyc_documents` | 97 | identity document references |
| `push_subscriptions` | 13 | browser endpoint keys — treat as secrets |
| `ambassador_profiles` | 0 | `pin_hash` — a credential |

**No value from any of these columns appears in this repository.**
