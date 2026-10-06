# Legacy financial inventory

**Source:** `busfgcmbndleljklrcbd`, verified 2026-09-26. All figures in
[legacy-control-totals.md](legacy-control-totals.md).

**Semantics were inferred from schema, functions, triggers and aggregates — not
from table names.** Two names in particular do not mean what they say, and both
are called out below.

---

## 1. The financial tables, by what they actually represent

| Table | Rows | Represents | Intent / attempt / payment / settlement / withdrawal / operational |
|---|---|---|---|
| `pending_payment_context` | 797 | A checkout in flight, with retry and reconciliation state | **intent + attempt** |
| `deposits` | 6,201 | One Paystack transaction: reference, access code, authorization URL, channel, paid/settled timestamps, net amount | **attempt + provider transaction + settlement, in one row** |
| `contributions` | 5,576 | Money applied to a collection for one contributor, with `line_index` | **successful payment, the unit of application** |
| `wallets` | 245 | Six mutable per-collection numbers, rebuilt nightly | **cache. Not a record of anything.** |
| `withdrawals` | 292 | An organizer taking money out of one collection | **withdrawal + payout combined** |
| `payout_accounts` | 26 | Encrypted bank destination per user | operational |
| `transfer_recipients` | 52 | **Plaintext** bank details per user | operational |
| `settlement_runs` | 56 | Audit of the nightly recompute | operational |
| `payment_recovery_log` | 30,242 | Every recovery attempt, 5-minutely | operational |
| `payment_admin_actions` | 220 | Staff interventions on payments | operational audit |
| `payment_reference_backfill_snapshot_20260811` | 3,324 | Pre-backfill state | forensic |
| `duplicate_void_snapshot_20260812` | 12 | Pre-void state | forensic |
| `wallets_backup_20260805` | 240 | Wallet balances at the incident | forensic |

### Two names that mislead

**`deposits` is not a deposit ledger.** It is the provider transaction record —
the closest legacy analogue to the new `payment_attempts` *plus*
`provider_transactions` *plus* settlement fields. It carries `settlement_status`,
`settled_at` and `net_amount` alongside `access_code` and `authorization_url`. The
new architecture splits these deliberately, because merging "what we asked for" with
"what the provider said" is what makes an amount mismatch unanswerable.

**`wallets.ledger_balance` is not a ledger.** There are no entries behind it. It is
a derived figure, equal to `available_balance` in every one of the 245 rows, and
rebuilt nightly from scratch. The identifier is the most misleading name in the
legacy schema.

---

## 2. Money representation

All monetary columns are **`numeric`**, holding **naira**. There is no integer-kobo
domain.

**The conversion is exact.** Across all 11 monetary columns in the database:

| Check | Result |
|---|---|
| values with more than 2 decimal places | **0** |
| negative values | **0** |
| null values | 0 |

So `round(v * 100)::bigint` converts every historical amount to integer kobo with
no loss and **no rounding-policy decision to make**. This is a materially good
result: it removes what would otherwise have been a founder decision about
historical money.

44 rows do carry sub-naira precision (e.g. `107.10`, `46069689.35`) — fine at two
decimal places, and exactly representable in kobo.

`currency` is `NGN` on all 275 collections. No multi-currency problem exists.

---

## 3. Fee handling

Legacy has **no fee schedule table and no fee versioning.** Fees are implied by the
difference between columns:

- `deposits.amount` − `deposits.net_amount` = the fee taken on that transaction.
  Across successful deposits: 60,423,653.63 − 54,819,041.09 = **₦5,604,612.54**.
- `contributions.gross_amount` − `contributions.amount` = the fee the contributor
  bore, where they bore it.
- `wallets.fee_breakdown` is a jsonb blob per collection.

`collections.fee_bearer` is `contributor` on 204 collections and `organizer` on 71.
It maps cleanly onto the new `fee_mode` enum (`contributor_pays` /
`community_absorbs`).

**Because there is no schedule version anywhere, a historical fee cannot be
recomputed — only read.** This is exactly the property the new architecture fixes
(D-13: every money row stores its `fee_schedule_version`), and it is the reason
legacy fee figures must be preserved as recorded values rather than derived.

---

## 4. The three reconciliations this baseline computed

| Comparison | Result | Meaning |
|---|---|---|
| `wallets.net_payment` vs paid `contributions.amount` | **₦3.59** | The documented drift, independently reproduced |
| `wallets.gross_payment` vs paid `contributions.gross_amount` | **₦0.00** | Gross reconciles exactly |
| `withdrawals.amount` vs `wallets.withdrawn` | **₦478,460.00** | Exactly the `rejected` total — consistent, not drift |

**The ₦3.59 is the single most useful number in this document.** It is small enough
to look like nothing and it is unexplainable, which is precisely why the wallet
cache must never become an opening balance. Its own root-cause report attributes
this class of gap to floating-point arithmetic in the legacy fee engine; this
baseline confirms the gap still exists today.

That gross reconciles to zero while net is out by ₦3.59 is itself informative: the
error is introduced by fee arithmetic, not by the recording of payments.

---

## 5. Attribution: the ₦19.8m matter, reproduced

| Figure | Value |
|---|---|
| deposits with no `collection_id` | **1,317** |
| their total | **₦28,910,087.00** |
| of those, `status='success'` | **923** |
| their total | **₦19,799,220.00** |

This independently reproduces both documented figures — "approximately ₦19.8m" and
"923 unattributed rows". All 1,317 also have a null `contributor_id`.

There is a legacy view, `v_orphaned_successful_payments`, and a definer function,
`get_orphaned_payment_candidates`, so the legacy team tracked this actively.

**Destination: `migration.unattributed_payments`**, which already exists, is
append-only, and **has no `collection_id` column at all.** The absence of the column
is what makes a future well-meaning backfill impossible. All 1,317 are preserved —
not only the 923 successful ones.

Referential integrity is otherwise clean: zero orphaned collection references
anywhere in `deposits`, `contributions`, `withdrawals` or `wallets`.

---

## 6. The legacy payment state machine

`pending_payment_context` (797 rows) is the closest legacy analogue to the new
`payment_attempts`. Its columns are unusually good for a legacy table: `state`,
`failure_code`, `failure_reason`, `failure_context` jsonb, `retry_count`,
`last_attempt_at`, `next_retry_at`, `reconciliation_state`, `resolved_at`,
`resolved_by`, `verification_payload` jsonb, `captured_amount`, `captured_at`,
`verified_at`.

Observed states: `initialized`, `completed`, `failed`, `reconciled`.
Reconciliation states: `null`, `recovered`.

The new architecture's state machines note that `reconciling`/`reconciled` were
dropped deliberately — reconciliation is a *verdict about* a payment, not a *state
of* one. Legacy conflates them, and `reconciled` is one of its four states.

**Preserve as history, populate nothing.** The new `payment_attempts` table must not
be seeded from these rows: an attempt is a live object with an amount lock, and a
historical attempt has nothing to lock.

---

## 7. Settlement

Legacy settlement is a **clock comparison plus a nightly rebuild**:

- `settlement_cutoff()` — anon-executable, returns the cutoff
- `settle_pending_balances()`, `process_deposit_settlements()`
- `settlement_recompute_wallets('cron')` — **all 245 wallets, nightly at 04:00 UTC**
- `settlement_runs` (56 rows) records each run with `drift_after` and
  `overwithdrawn_after` counters

`wallets.pending_balance` is **0.00 in all 245 rows**, and `available_balance`
equals `ledger_balance` in all 245. So at this moment nothing is pending and the
two "balances" are the same number under two names.

Total unwithdrawn across the entire platform: **₦114,038.30.** Of ₦46.7m withdrawn
historically, almost everything has already been taken out. That materially reduces
cutover risk — there is very little live balance to reconcile at switchover.

The new architecture replaces all of this with a posted `balance_release` journal
(D-09c), which is why none of these figures may become opening balances.
