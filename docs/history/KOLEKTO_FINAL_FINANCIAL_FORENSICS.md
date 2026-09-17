# KOLEKTO — Final Financial Forensics (LIVE DATABASE)

**Phase:** 2.1A — live read-only forensic audit. **Nothing was modified** (SELECT-only; no writes, no migrations, no repair).
**Data source:** Supabase project `lpeeckqsltxohppheucz` ("Kolekto test") — the project the reconciliation was run against (**57 collections**). Snapshot taken 2026-07-17.
**Supersedes:** `FINANCIAL_DRIFT_ROOT_CAUSE_REPORT.md` (produced without DB access — its hypotheses are now verified/corrected below).

---

## 0. Executive Summary — ONE root cause, no money lost

The 50 drifted wallets are **not** 4–5 historical causes. They are **one active bug** firing every night:

> **`settle_pending_balances()`** — a `pg_cron` job running daily at **04:00 UTC** — recomputes every wallet's `available_balance` and `pending_balance` **from the `deposits` table. But `deposits` is empty** (0 rows): the live payment path writes `contributions`, not `deposits`. So each night this single `UPDATE wallets` sets `available_balance = 0 − withdrawn` and `pending_balance = 0` for **all 56 wallets**, leaving `net_payment` and `ledger_balance` untouched.

**Proof (all from live SQL, §3):** `deposits = 0 rows`; **all 56 wallets share the identical `updated_at = 2026-07-17 04:00:00.051052+00`** (one transaction); **all 56 have `available_balance = −withdrawn` and `pending_balance = 0`**; the function body confirms the formula.

**Impact:** 56 of 57 collections carry a corrupted `available_balance`; **₦49.93M** of genuinely-available funds shows as **−₦159,300** in the wallet cache.

**Money at risk: NONE.** The source of truth (`contributions` + `withdrawals`) is fully intact and internally consistent — **0 over-withdrawals, 0 duplicate references, 0 duplicate wallets, 0 orphans**. `net_payment` even survived (the bug doesn't touch it). Every corrupted value is **100% recoverable by recomputing from `contributions`.**

**Corrections to the previous (no-DB) report — stated plainly, not defended:**
| Prior hypothesis | Verdict | Reality |
|---|---|---|
| R1 Edge/Node fee divergence is the dominant cause | **WRONG** | `net_payment` matches canonical for ~53/57; the 3 "matches" are ±₦5–20 recompute-approximation noise, not real drift |
| R2 "settlement never refreshed / stale pending" | **WRONG mechanism** | Settlement **does** run nightly — and **actively corrupts**. `pending` isn't stale-high; it's forced to 0 |
| R3 negatives are legacy read-modify-write residue | **WRONG source** | Negatives were written **today at 04:00** by the **current** `settle_pending_balances()`, not old code |
| R4 missing wallet (non-fatal creation) | **CORRECT** | 1 collection, confirmed |
| (missed entirely) a settlement fn reading the wrong/empty table | **This is the actual root cause** | The prior report only knew `process_deposit_settlements()` and never hypothesized the empty-`deposits` bug |

---

## 1. Reconciliation & per-collection data (TASK 1)

57 collections; full row-level data in `KOLEKTO_DRIFT_CLASSIFICATION.csv`. Method: canonical `normalizeContributions → computeWalletBalances` replicated in SQL (5am-WAT/4am-UTC cutoff), compared to stored `wallets.*`.

| Metric | Value (live) |
|---|---|
| Collections (active) | 57 |
| Wallets | 56 (**1 missing**) |
| Paid contributions | 184 (100% of contributions; **0 pending/failed**) |
| Withdrawals | 24 |
| **`deposits` rows** | **0** |
| Total net raised (canonical) | **₦50,064,148.11** |
| Total expected available | **₦49,769,848.11** |
| **Total stored available** | **−₦159,300.00** |
| Total completed withdrawn | ₦294,300.00 |

## 2. Classification (TASK 2, 8)

| Category | Collections | Meaning | Stored available |
|---|---:|---|---|
| **SETTLEMENT_BUG_ZEROED** | **42** | settled funds; wallet forced to `available=0` | 0 |
| **SETTLEMENT_BUG_NEGATIVE** | **8** | had withdrawals; wallet forced to `available=−withdrawn` | negative |
| **CLEAN** | **6** | no paid contributions, or funds legitimately pending today | 0 (correct) |
| **R4_MISSING_WALLET** | **1** | collection `380e1d0e…` has no wallet row | — |

**→ 48–50 "drift" collections collapse to exactly ONE root cause (ZEROED + NEGATIVE = the settlement bug), plus 1 unrelated missing wallet.** (The reconciliation's "48" vs this "50" is a threshold detail — 2 collections have today-pending funds that net to available=0 and read as clean.)

**Drift statistics (available_balance):** max **₦30,773,000** (collection `caec6df6`, a ₦30.77M tiered pool); avg (of drifted) **₦998,583**; median **₦22,005**; p95 **₦1,600,016**; total drift **₦49,929,148**.

## 3. Hypothesis verification with real data (TASK 3)

| Claim | Verified? | Evidence |
|---|---|---|
| Edge writer stores gross (no fee deduction) | **Partly / immaterial** | `net_payment` matches canonical Node value for ~53/57 within ₦20; **not** a material drift source here |
| Node writer stores normalized | **Yes** | `refreshWallet`/`updateWalletStats` use `normalizeContributions` (code) — but they weren't the last writer; the 4am SQL cron was |
| Settlement cron exists | **Yes — and it's the culprit** | `cron.job` rows 4 & 5 both at `0 4 * * *` |
| `process_deposit_settlements()` | **Exists; a no-op here** | reads `deposits WHERE status='success' AND settlement_status='unsettled'` — `deposits` empty → loops zero rows |
| `settle_pending_balances()` (**newly discovered**) | **Exists; THE corruptor** | blanket `UPDATE wallets SET available = SUM(deposits…)−withdrawn, pending = SUM(deposits…)` — `deposits` empty ⇒ `available=−withdrawn`, `pending=0` |
| Wallet refresh failures silent | **N/A** | not the mechanism; the wallets were written, just wrongly |
| Negative wallets | **Confirmed: 8** | all `available = −withdrawn`, all written 2026-07-17 04:00:00.051 |
| Missing wallets | **Confirmed: 1** | `380e1d0e…` |
| Duplicate wallets | **None (0)** | `GROUP BY collection_id HAVING count>1` = 0 |

### The two offending functions (live definitions)

`settle_pending_balances()` — **the active corruptor** (jobid 4, `SELECT settle_pending_balances()`):
```sql
UPDATE wallets w SET
  available_balance = COALESCE((SELECT SUM(d.net_amount) FROM deposits d
      WHERE d.wallet_id=w.id AND d.status='success' AND d.paid_at < CURRENT_DATE::timestamptz),0)
                    - COALESCE(w.withdrawn,0),          -- deposits empty ⇒ 0 − withdrawn
  pending_balance   = COALESCE((SELECT SUM(d.net_amount) FROM deposits d
      WHERE d.wallet_id=w.id AND d.status='success' AND d.paid_at >= CURRENT_DATE::timestamptz),0), -- ⇒ 0
  updated_at = NOW();                                    -- blanket UPDATE: all wallets, one txn
```
`process_deposit_settlements()` — jobid 5 (via edge), a **no-op** here (loops `deposits` = none), but note it is a **read-modify-write** (`available = available + net_amount`) that would double-credit if `deposits` were populated.

**Neither touches `net_payment` or `ledger_balance`** → those stay at their last correct value, which is why 51/56 wallets show `available + pending ≠ ledger` (broken identity) and `net_payment` remains right.

## 4. Database logic inspection (TASK 4)

- **Cron (`cron.job`):** (4) `settle-pending-balances` `0 4 * * *` → `settle_pending_balances()` [**corruptor**]; (5) `settle-pending-deposits` `0 4 * * *` → edge → `process_deposit_settlements()` [no-op]; (6) `scheduled-payment-recovery` `*/5 * * * *` → edge [benign].
- **Functions:** the two above are the only wallet-writing SQL functions found (`ILIKE %settlement/deposit/wallet/refresh%` + the cron-named one).
- **Triggers/views:** no trigger writes wallet balances (the corruption is 100% attributable to the 4am cron by timestamp).
- **Architectural cause:** Kolekto has **two parallel payment data models** — `deposits` (Express `initializePayment` path) and `contributions` (Edge `initiate/verify` path). The **live system uses `contributions`; `deposits` is empty.** The settlement SQL was written for the `deposits` model. This is the Phase-1/2 "multiple write paths" finding manifesting as **live financial corruption**.

## 5. Writer attribution (TASK 5)

Every wallet's **last writer is `settle_pending_balances()`** — proven by the identical `updated_at = 2026-07-17 04:00:00.051052+00` across all 56 and the exact `available = −withdrawn, pending = 0` signature. Node writers (`refreshWallet` on withdrawal, `updateWalletStats`) and the Edge writer had written correct values earlier, but the 4am cron overwrote them. (A wallet touched by a withdrawal *after* 04:00 would temporarily show correct values until the next 04:00 run — the corruption **oscillates daily**.)

## 6. Integrity verification (TASK 6)

| Check | Result |
|---|---|
| Paid contributions without a reference | **0** |
| Duplicate `(collection_id, payment_reference, line_index)` | **0** (F3 unique index holding) |
| Duplicate wallets (per collection) | **0** |
| Duplicate withdrawal ids | **0** |
| Wallets without a collection | **0** |
| Collections without a wallet | **1** (`380e1d0e…`) |
| Withdrawn > raised (per collection) | **0** ← the money-loss gate |
| Negative available | 8 (all = −withdrawn, cache only) |
| Broken ledger identity (`avail+pending≠ledger`) | 51 (cache only) |

## 7. Is any real money at risk? (TASK 7) — explicit answers, from data

- **Has any contributor payment been lost?** **No.** 184 paid contributions intact, all with references; total ₦50.06M raised reconciles from source.
- **Has any withdrawal disappeared?** **No.** 24 withdrawals intact, no duplicates; total completed ₦294,300.
- **Has any ledger become corrupted?** **The cache (`wallets`) yes; the source ledger no.** `net_payment` is correct; `available/pending/ledger` are the corrupted (recomputable) columns.
- **Has any organizer been overpaid?** **No.** 0 collections have withdrawn > raised.
- **Has any organizer been underpaid?** **No payout was wrong**, but organizers are **shown ₦0 (or negative) available** when they have funds — a serious trust/UX failure and a *blocker to legitimate withdrawals via any UI that reads the stored column*. (The withdrawal API itself recomputes the cap via `refreshWallet`, so a withdrawal attempt would still be correctly capped — but the dashboard misleads.)
- **Has any wallet been permanently corrupted?** **No.** The corruption is a derived projection; the inputs are intact.
- **Is every discrepancy recoverable by recomputing wallets?** **Yes — 100%**, for all 56 wallets. The 1 missing wallet needs creation + recompute.

**Verdict: the money is safe; the projection is broken and self-re-breaks nightly. This is a P1 correctness/trust incident, not a loss event.**

---

*Live forensic audit, read-only. No data, schema, functions, cron, or code were modified. Continue in `KOLEKTO_FINANCIAL_HEALTH_SCORE.md` and `KOLEKTO_PHASE2_1_REPAIR_PLAN.md`.*
