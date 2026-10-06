# LEGACY BASELINE STATUS

**Date:** 2026-09-26 · **Scope:** legacy production discovery, read-only
**Verdict on disconnecting the Supabase account: see §20. It is DO NOT DISCONNECT YET.**

> **Historical document — read with two corrections.** This is the state as at 2026-09-26
> and is deliberately preserved as written.
>
> 1. **A verified backup now exists** (taken 2026-09-27). Statements below that legacy
>    production holds "the only copy" of the data were true when written and are no longer.
>    The disconnect verdict is nonetheless **unchanged** — see
>    [PRESERVATION-GATE-STATUS.md §G](PRESERVATION-GATE-STATUS.md) for why.
> 2. **The public-schema row total has been corrected from 52,562 to 53,742.** The original
>    figure was an arithmetic error; the per-table counts were always right. See
>    [legacy-control-totals.md §1](legacy-control-totals.md).

---

## 1. Projects inspected

| Project | Inspected | Modified |
|---|---|---|
| `busfgcmbndleljklrcbd` — kolekto prod | **yes, read-only** | **no** |
| `lpeeckqsltxohppheucz` — Kolekto test | **no** — Phase 11 requires asking first | no |

## 2. Project refs

Legacy production `busfgcmbndleljklrcbd` (eu-central-1, PostgreSQL 15.8.1.094).
Legacy test `lpeeckqsltxohppheucz` (eu-north-1, PostgreSQL **17.4.1.064**).
Both in organization `Kolekto Org` (`wzkhbvbimazkabmdbawa`). New staging and new
production do not exist.

## 3. Tables inspected

**53 public tables**, all counted; 21 inspected column by column. Plus `auth` (27
tables, aggregates only), `cron` (2 jobs), `supabase_migrations` (39 versions).

## 4. Row counts

**53,742 rows** across `public`. Largest: `payment_recovery_log` 30,242 ·
`deposits` 6,201 · `contributions` 5,576 · `email_campaign_recipients` 4,710 ·
`payment_reference_backfill_snapshot_20260811` 3,324. Core: `collections` 275 ·
`profiles` 622 · `withdrawals` 292 · `wallets` 245. **13 tables are empty.**
Full table in [legacy-control-totals.md](legacy-control-totals.md).

## 5. Financial control totals

| Entity | Rows | Total |
|---|---|---|
| Deposits | 6,201 | ₦90,020,641.26 gross / ₦80,910,104.95 net |
| — successful | 4,260 | ₦60,423,653.63 |
| Contributions | 5,576 | ₦67,776,482.98 |
| — paid | 3,934 | ₦46,069,689.35 |
| Withdrawals | 292 | ₦46,682,872.80 |
| Wallet available balance | 245 | **₦114,038.30** |

**Money converts to integer kobo exactly.** No value in any of the 11 monetary
columns exceeds 2 decimal places or is negative, so `round(v*100)` is lossless and
**no rounding-policy decision is required.**

**Three reconciliations:** `wallets.net_payment` exceeds paid contributions by
**₦3.59** (the documented drift, independently reproduced); gross reconciles to
**₦0.00**; withdrawals minus wallet-withdrawn equals **₦478,460.00**, exactly the
rejected total, so consistent.

## 6. Auth and user totals

623 auth users · 622 profiles · 623 identities. **All 623 have an email. None has a
phone in `auth.users`** — phone lives in `profiles.phone_number`, present on **609**,
absent on **13**. 426 emails confirmed. 1 auth user has no profile. 0 profiles lack an
auth user.

## 7. Known anomalies

| # | Anomaly | Count |
|---|---|---|
| A1 | Unattributed successful deposits | **923 = ₦19,799,220** (1,317 rows = ₦28.9m in total) |
| A2 | `wallets.net_payment` drift | **₦3.59** |
| A3 | Duplicate phone groups | 27 groups / 66 profiles / largest 8 |
| A4 | Profiles with no phone | 13 |
| A5 | Auth user with no profile | 1 |
| A6 | Overlong phone numbers | 15 |
| A7 | `type` vs `collection_type` disagreement | 26 rows, **3 genuinely contradictory** |
| A8 | Duplicate tier names | 23 groups across **5 collections** |
| A9 | Tier entries with no `id` | **200 of 305** |
| A10 | Soft-deleted collections | 12, with no deletion timestamp |
| A11 | Contributions with no payment reference | 1,640 |
| A12 | `is_organizer` never maintained | false on all 622 |
| A13 | Withdrawal status vocabulary changed mid-Dec 2025 | 239 `approved` vs 43 `success` |

Referential integrity is otherwise **clean**: zero orphans anywhere, and every
collection has a valid organizer.

## 8. Migration destinations

Every one of the 53 tables has a destination. Operational: `auth.users`,
`profiles`→`users`, `collections`, tiers, fields, code sequences, contributors→
`members`. Historical: `legacy_contribution` (5,576), `legacy_deposit` (4,884),
`unattributed_payments` (1,317), `legacy_withdrawal` (292, to create),
`legacy_profile`, `legacy_collection`. Overflow: everything else.
Full mapping in [legacy-to-new-mapping.md](legacy-to-new-mapping.md).

## 9. Overflow candidates

~40,000 rows across 21 subsystem tables with no new-schema equivalent: ambassador
programme (6), campaigns (3), campus/students (2), email engine (8), push (2), plus
`payment_recovery_log`, `pending_payment_context`, `payment_admin_actions`,
`settlement_runs`, `wallets`, `transfer_recipients` and 3 forensic snapshots.
`migration.legacy_overflow` is designed in
[legacy-migration-exceptions.md](legacy-migration-exceptions.md) §4 — **not built.**

## 10. Missing destinations

**None.** Two destination tables do not exist yet and must be created:
`migration.legacy_withdrawal` (E-W1, F-M2 approved) and `migration.legacy_overflow`
(E-O1). One provenance column is missing: `source_project` on
`migration.import_runs` (E-P1).

## 11. Data-loss risks

| # | Risk | Severity |
|---|---|---|
| R1 | **Disconnecting the account before any data is extracted.** The migration has not run; legacy production holds the only copy of 53,742 rows | **CRITICAL** |
| R2 | `wallets` treated as opening balances — a cache that is ₦3.59 wrong | **HIGH**, mitigated by policy and a passing test |
| R3 | The 5 duplicate-tier-name collections refused by the new unique constraint | HIGH |
| R4 | 200 tier entries with no id cannot be linked to historical payments | MEDIUM |
| R5 | 12 soft-deleted collections needing an `archived_at` legacy does not record | MEDIUM |
| R6 | `payout_accounts` ciphertext unreadable without a key that has not been located | MEDIUM |
| R7 | Auth UUID not preserved — uncorrectable after the fact | **HIGH**, mitigated by design |
| R8 | 3,353 contributor identities collapsing into accounts | MEDIUM, mitigated by `unclaimed` |

## 12. Security findings

| # | Finding | Severity |
|---|---|---|
| S1 | **`anon` holds TRUNCATE on 10 tables in live production**, including `settlement_runs` and `wallets_backup_20260805`. RLS blocks INSERT/UPDATE/DELETE but **does not apply to TRUNCATE** | **HIGH** |
| S2 | `anon` holds SELECT on 49 of 53 tables | MEDIUM |
| S3 | `authenticated` holds UPDATE on `collections`, `profiles`, `campaigns`, KYC tables | MEDIUM, likely intentional |
| S4 | RLS enabled but not FORCED on 50 of 53 tables | LOW |
| S5 | Bank numbers inconsistent: `payout_accounts` encrypted, `transfer_recipients` **plaintext** | MEDIUM |

**Remediated since the historical audits** (verified this session): zero functions are
both SECURITY DEFINER and anon-executable, and none of the 8 definer views is granted
to `anon`.

**I changed none of this.** All are writes to live production and outside a read-only
mandate.

## 13. Secrets discovered — locations and types only

| # | Type | Location | Severity | Recommendation |
|---|---|---|---|---|
| 1 | Cron shared secret | `cron.job` command, jobid 5, legacy production | **HIGH** | Rotate. Readable by anyone who can select from `cron.job`; it authenticates a payment-recovery endpoint. |
| 2 | Paystack **live** secret key | `kolekto-be-old/.env`, `.env.bak.pre-email-fix`, 2 diffs in that repo's git history | **HIGH** | Rotate, scheduled with a deploy |

**No value was printed, copied, committed or placed in any artifact.** Re-verified:
no Paystack key exists anywhere in this repository's working tree or full history.

## 14. Production vs test differences

**Not established** — legacy test has not been inspected. One difference is already
known and it matters: **production runs PostgreSQL 15, test runs 17.** Test is ahead,
so it is not a faithful rehearsal surface.

## 15. Migration blockers

**Founder (7):** F-L1 community strategy · F-L2 campaigns · F-L3 type authority ·
F-L4 duplicate tiers · F-L5 withdrawal semantics · F-M1 phone-less user status ·
E-COL-1 soft-delete timestamp.
**Legal (2):** L-1 `user_identity`/KYC · L-3 bank-detail retention.
**Engineering (5):** E-W1 · E-O1 · E-P1 · E-K1 decryption key · E-ENV-1 legacy-ref guard.
**Infrastructure (2):** new staging · new production with PITR.

## 16. What is confirmed

Referential integrity is clean. Money converts to kobo exactly. Withdrawals are
already collection-level with no nulls and no orphans, so the new architecture's
collection-level model matches history. Every collection has a valid organizer and is
NGN. Contributors are decisively not users (7% overlap). The ₦19.8m and ₦3.59 figures
are both reproduced. The historical definer-function and definer-view exposures are
remediated. Total live unwithdrawn balance is only ₦114,038.30, which materially
reduces cutover risk.

## 17. Requires founder decision

F-L1 · F-L2 · F-L3 · F-L4 · F-L5 · F-M1 · E-COL-1, plus whether the ambassador,
campaign, campus and email subsystems are being rebuilt or preserved as history only.

## 18. Requires engineering decision

E-W1 · E-O1 · E-P1 · E-K1 · E-ENV-1, plus whether to capture a full structural dump
(§20 R1).

## 19. Requires legal/accounting

L-1 NIN/BVN and KYC · L-3 bank details · retention for 622 profiles and 3,353
contributor identities · whether a legacy-production snapshot may be copied into
staging for rehearsal.

---

## 20. Can we safely disconnect the current Supabase account now?

# DO NOT DISCONNECT YET

This is not a process objection. Disconnecting now would risk permanent loss of the
only copy of the data.

**The decisive reason: no data has been extracted.** This baseline documents
*structure* and *aggregates*. It contains no rows. Legacy production holds the only
copy of 53,742 records — 623 user identities, 275 collections, 5,576 contributions,
6,201 deposits, 292 withdrawals and ₦46.7 million of financial history — and **the
migration has not run.** If access to the account is lost before those rows are moved
or exported, they are gone. A baseline is not a backup.

### Exact remaining requirements before disconnection is safe

| # | Requirement | Why |
|---|---|---|
| D1 | **A full logical backup of legacy production, stored outside Git in a protected location** | The single blocking item. Without it, disconnection risks irreversible loss. |
| D2 | **A verified restore of that backup** | An untested backup is a hope, not a backup |
| D3 | **Legacy test baseline taken** | Phases 11–12; access disappears with the account |
| D4 | Full structural capture: all columns for all 53 tables, index definitions, constraint expressions, FK actions, policy definitions, function bodies, enum values | The schema **predates its own migration tracking**, so the live database is the only authoritative description. Once access ends, it cannot be recovered. |
| D5 | `storage` buckets and objects inventoried | 8 storage tables; KYC files and collection banners live there |
| D6 | `scheduled-payment-recovery` Edge Function source captured | Referenced by cron, lives outside the database |
| D7 | Decryption key for `payout_accounts` located (E-K1) | Without it 26 encrypted accounts are permanently unreadable |
| D8 | Both secrets rotated (§13) | Rotation needs access to the systems that use them |
| D9 | New staging and new production projects created | Nothing to migrate *into* otherwise |

**D1 and D2 are the ones that actually gate this.** D3–D6 are things that become
impossible rather than merely difficult once access ends.

### One further point on timing

Legacy production is **live and mutating**: two cron jobs are active, a
payment-recovery poll every five minutes and a nightly wallet recompute at 04:00 UTC,
and the latest profile is dated 2026-09-14. Every figure in this baseline is already
drifting. **This is a baseline, not the migration snapshot** — a fresh capture is
required immediately before the real migration regardless of what happens with the
account.

---

## Next step

**Connect legacy test (`lpeeckqsltxohppheucz`) for read-only discovery**, so Phases
11–13 can complete while the account is still available. The request, with what will
and will not be done, is in
[legacy-prod-vs-test.md](legacy-prod-vs-test.md).

In parallel, and not engineering work: **D1 — take and verify a full backup of legacy
production.**
