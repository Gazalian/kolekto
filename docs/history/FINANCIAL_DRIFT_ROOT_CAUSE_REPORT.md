# Kolekto — Financial Drift Root-Cause Investigation

**Role:** Internal Financial Auditor / Fintech + PostgreSQL/Supabase Architect.
**Phase:** investigation only. **No production data, code, migrations, or repair scripts were touched.**
**Input:** Phase 2.0 reconciliation result — *57 collections checked, 48 with balance drift, 1 with no wallet row* — plus the example discrepancies supplied.

---

## ⚠️ Scope & integrity note (read first)

I do **not** have access to your production database, and I did not run the reconciliation myself (Phase 2.0 was explicit that the tool needs credentials I don't have). **I have therefore NOT invented the 48 specific collections, owners, or balances** — doing so in a financial audit would be worse than useless.

What this report contains is **code-level forensics**: using the actual source, I explain *why each drift pattern in your examples occurs*, which code path produces it, and — most importantly — whether any real money is at risk. To turn this into the per-collection ledger (TASK 1) I provide **read-only SQL** you (or I, given DB access) run to populate `FINANCIAL_DRIFT_CLASSIFICATION.csv`. Every root cause below carries a **confidence level** and the **evidence** it rests on.

---

## 0. Executive Summary

**The headline: this is almost certainly a *projection/cache* problem, not lost money.** `wallets.*` is a **cached projection**; the source of truth is `contributions` + `withdrawals`. The reconciliation "expected" is computed **from that source**. So "stored ≠ expected" means *the cache disagrees with the source rows that still exist* — the contributor payments and withdrawals are intact; the wallet snapshot is stale or was written by a different formula.

**The 48 drifts almost certainly collapse to a small number of systematic root causes**, three of which are proven from the code:

| # | Root cause | Mechanism (proven) | Likely bucket | Money at risk? | Confidence |
|---|-----------|--------------------|---------------|----------------|------------|
| **R1** | **Edge vs Node "net" formula divergence (organizer-borne)** | The live Edge writer sums `contribution.amount` raw; Node writers + the reconcile tool run `normalizeContributions`, which **deducts fees for organizer-borne**. Drift = the fees. | fee-sized drifts | **No** (withdrawal path re-normalizes) | **High** |
| **R2** | **Settlement staleness (pending→available never rolled)** | Between payments, nothing recomputes the T+1 cutoff; a payment "pending" when the wallet was last written should now be "available". Reconcile uses *today's* cutoff. | `stored available=0, expected>0` | **No** | **High** |
| **R3** | **Legacy read-modify-write residue (negative balances)** | Current `computeWalletBalances` **floors available at 0**; a stored **negative** value could only come from the pre-B-2 `wallet += delta` code, the SQL settlement, or a manual edit. | `stored=-17,500, expected=0` | **No** (source nets to 0) | **High** |
| **R4** | **Missing / duplicate wallet row** | Wallet creation is **non-fatal** and there is **no lazy/backfill creation**; refresh **early-returns** if no wallet. | `1 collection, no wallet` (+ any multi-wallet) | **No** (source intact) | **High** |
| **R5** | **Reconcile applies *current* fee rates to *historical* grosses** | `normalizeContributions` uses today's `calculateFees`; if fee policy ever changed, expected ≠ the net actually recorded historically. | small fee diffs (overlaps R1) | **No** (semantic, not loss) | **Medium** |

**Answer to the critical question (TASK 10):** on the evidence, **no contributor payment is lost, no withdrawal is missing, and the underlying source ledger is not corrupted** by these drifts. The drift is between the **cache** and the **source**, and/or between **two formulas for the same number**. The one thing to *verify with data* (not assume) is R3 negatives and any `OVER_WITHDRAWN`/`AVAILABLE_EXCEEDS_RAISED` consistency flags — those are the only patterns that *could* indicate a real problem, and the tool reports them separately.

**Do not repair yet.** The safe path is: confirm the buckets with the SQL below → decide the *canonical* net formula (R1 is really "which of the two implementations is right?") → **a single idempotent recompute** (`refreshWallet` for every collection) fixes R1/R2/R3 at once because it rewrites the cache from source. R4 needs wallet backfill. See `FINANCIAL_REPAIR_PLAN.md`.

---

## TASK 5 — Wallet refresh mechanism (the core of the story)

**When/who/what refreshes a wallet:**

| Trigger | Code | Formula | Notes |
|---------|------|---------|-------|
| Payment verified (LIVE) | Edge `verify-paystack-payment` → `_shared2.ts:40 refreshCollectionAndWallets` | **Σ `amount` raw** ([_shared2.ts:57](supabase/functions/verify-paystack-payment/_shared2.ts#L57)) | **No `normalizeContributions`** |
| Payment verified/webhook (Express deposits path) | `deposit.js:242 updateWalletStats` | `normalizeContributions` → `computeWalletBalances` ([deposit.js:299](../kolekto-be-old/controllers/deposit.js#L299)) | normalizes |
| Daily T+1 | `jobs/paymentSettlement.js runDailySettlement` | `normalizeContributions` → `computeWalletBalances` | **only if `RUN_SETTLEMENT_CRON=true`** on a replica |
| Daily T+1 (edge/SQL) | `settle-pending-deposits` → `process_deposit_settlements()` | **DB-resident SQL — not in the repo** | formula unknown until dumped |
| Withdrawal request/approve | `withdrawal.js:36 refreshWallet` | `normalizeContributions` → `computeWalletBalances` ([withdrawal.js:54](../kolekto-be-old/controllers/withdrawal.js#L54)) | normalizes |

**Can a refresh silently fail? YES** — this is a key finding:
- `updateWalletStats` **returns early and only `console.warn`s** if the wallet row is missing ([deposit.js:262-268](../kolekto-be-old/controllers/deposit.js#L262)) or a source fetch errors ([:291-297](../kolekto-be-old/controllers/deposit.js#L291)) — **no throw, no retry, no alert.** A payment can be marked `paid` while the wallet write is skipped.
- The Edge writer logs errors but does not retry.
- **No refresh has a retry.** A transient DB error at refresh time leaves the cache stale until the *next* event happens to refresh it.

**Consequence:** wallets drift whenever (a) the last writer used a different formula than reconcile (R1), (b) enough time passed to reclassify pending→available with no new event (R2), or (c) a refresh silently no-op'd (contributes to R2/R4).

---

## TASK 6 — Settlement

- **Two (maybe three) executors, possibly none reliably running:** the Node cron only schedules when `RUN_SETTLEMENT_CRON=true` ([paymentSettlement.js:142](../kolekto-be-old/jobs/paymentSettlement.js#L142)); the `settle-pending-deposits` edge calls **`process_deposit_settlements()`**, a **DB function not present in the repo** (verify its body and schedule via `pg_cron`).
- **Settlement is time-based, not event-based:** `pending vs available` is purely `created_at < getSettlementCutoff()` (4am UTC). Nothing "moves money"; a recompute just reclassifies. **If no executor runs, a payment that has aged past the cutoff still shows as `pending`/`available=0` in the cache** until the next payment/withdrawal triggers a refresh. Reconcile, computing with *today's* cutoff, correctly shows it as available → **R2 drift**.
- **Timezone:** `getSettlementCutoff` uses UTC hours (4am UTC = 5am WAT) — internally consistent; the Node and Deno copies use the same rule (verified). No timezone bug found, but the SQL function's cutoff must be confirmed to match.
- **Whether it settled twice / incorrectly:** all Node recomputes are **idempotent** (full recompute from source), so double execution is harmless. The SQL function's idempotency is **unverified** (not in repo).

**To find R2 collections:** those whose stored `pending_balance > 0` while all their paid contributions are now older than the cutoff (see SQL §A3).

---

## TASK 7 — Withdrawals & negative balances

- **Negative stored `available_balance` (e.g. −17,500) cannot be produced by current code:** `computeWalletBalances` floors available at `Math.max(0, …)` ([financial.js:230](../kolekto-be-old/utils/financial.js#L230)). Therefore a stored negative is a **residue** of: (a) the **pre-B-2 read-modify-write** wallet updater (the B-2 comment at [deposit.js:217-228](../kolekto-be-old/controllers/deposit.js#L217) documents that the old code did `wallet += delta` and could go wrong), (b) the SQL settlement function, or (c) a manual DB edit. With `expected=0`, the source says the balance is 0 → **the negative is stale cache, not a real debt.** Confidence: **High** it is legacy; the exact author needs the wallet row's `updated_at` + audit (SQL §A4).
- **Concurrency race (TOCTOU):** the audited withdrawal race *could* over-*reserve*, but note the withdrawal cap itself is evaluated via `refreshWallet` (normalized, correct) at request time ([withdrawal.js:54](../kolekto-be-old/controllers/withdrawal.js#L54)) and again at approve ([withdrawal.js:879](../kolekto-be-old/controllers/withdrawal.js#L879)). No evidence yet that the race *caused* any current drift; it is a latent risk (guarded by G2, unapplied).

---

## TASK 8 — Fee discrepancies (R1, the systematic one)

**This is the most important code finding and the likely largest bucket.**

For **organizer-borne** collections:
- At verify, `contribution.amount` is stored as `deriveNetContribution(gross, type, "organizer")` = **gross** (organizer net == gross; [financial.js:124-125](../kolekto-be-old/utils/financial.js#L124)). So `amount = gross_amount = e.g. 5000`.
- **Edge wallet writer** ([_shared2.ts:57](supabase/functions/verify-paystack-payment/_shared2.ts#L57)): `net_payment = Σ amount = 5000`. **No fee deduction.**
- **Node writers + reconcile** (`normalizeContributions`, [financial.js:254-269](../kolekto-be-old/utils/financial.js#L254)): recompute `net = gross − totalFees = 4900`. **Fees deducted.**

⇒ For every organizer-borne collection **last written by the Edge (the live path)**, `stored.net_payment` (and available/ledger) exceed `expected` by exactly the platform+gateway fees. For **contributor-borne** collections the two agree (both land on the same net), so this cause is **organizer-specific** — a clean, testable prediction (SQL §A2).

**Which is "correct"?** The organizer's true take-home is `gross − fees` (Paystack/platform keep the fees). So **Node/reconcile (4900) is the economically correct figure; the Edge (5000) over-states** the displayed balance. Three of four implementations (Node, cron, withdrawal) already do it the correct way; **the live Edge writer is the outlier.**

**Is money at risk from R1? No.** The **withdrawal gate re-normalizes** (`refreshWallet`, 4900) at request and approval time, so an organizer cannot actually withdraw the inflated fee amount. R1 is a **display/projection inconsistency**, not a payout hole. (Verify by picking one organizer-borne collection and comparing `wallets.net_payment` to the §A2 recompute.)

**R5 caveat:** `normalizeContributions` applies **today's** fee rates to **historical** gross amounts. If the platform/gateway rates or the ₦2,000 cap ever changed, `expected` for old contributions is *counterfactual* (today's rate on an old payment), which can create additional small fee-sized diffs that are neither the cache's fault nor the source's. Confirm by checking whether fee constants have changed over the data's lifetime.

---

## TASK 9 — Missing wallet row (R4)

- Wallet creation at collection-create is **best-effort/non-fatal**: the Edge `create-collection` upserts with `ignoreDuplicates` and only warns on error; the Phase-1 `CollectionService.createWalletIfAbsent` returns the error without failing the create. So a collection can exist **without** a wallet if that insert ever failed (or if the collection predates wallet creation).
- **Nothing lazily creates the wallet later:** `updateWalletStats` and `refreshWallet` **early-return if the wallet is missing** — they never create it. So a missing wallet stays missing forever, and its balances read as absent → the "1 collection, no wallet" case, and `NO_WALLET` in the consistency checks.
- **No money implication:** the contributions still exist; the wallet just needs backfilling (create row + one recompute).

---

## TASK 4 — Which code path last touched each wallet

You cannot attribute a specific wallet to a specific writer from code alone — you need the row's `updated_at` and the surrounding logs. But the **candidate set is fully enumerated** (TASK 5 table). The practical attribution heuristic (encode into the CSV, SQL §A5):

| Observed pattern | Most likely last writer | Root cause |
|------------------|-------------------------|-----------|
| `net_payment` = Σ amount (raw), organizer-borne, > expected by fees | **Edge** `refreshCollectionAndWallets` | R1 |
| `pending>0` but all paid contributions now past cutoff; available=0 | last edge/Node refresh **before** cutoff, no re-run | R2 |
| `available < 0` | **legacy** read-modify-write / SQL / manual | R3 |
| no wallet row | never created (non-fatal) | R4 |
| stored == expected | Node path (cron/withdrawal) ran recently | none |

---

## TASK 1 — Per-collection data (populate with read-only SQL)

These queries produce every column TASK 1 asks for, **without modifying anything.** Run in the Supabase SQL editor (read-only) or feed `scripts/reconcileFinancials.js` (which already computes expected-vs-stored). Fill `FINANCIAL_DRIFT_CLASSIFICATION.csv` from the output.

**§A1 — per-collection fact sheet:**
```sql
SELECT c.id, c.collection_type, c.status, c.user_id AS owner, c.created_at,
       COUNT(*) FILTER (WHERE ct.status='paid')                   AS paid_count,
       COALESCE(SUM(ct.amount) FILTER (WHERE ct.status='paid'),0) AS sum_paid_amount,
       COALESCE(SUM(ct.gross_amount) FILTER (WHERE ct.status='paid'),0) AS sum_gross,
       w.net_payment, w.available_balance, w.pending_balance, w.ledger_balance, w.withdrawn
  FROM collections c
  LEFT JOIN contributions ct ON ct.collection_id = c.id
  LEFT JOIN wallets w        ON w.collection_id = c.id
 WHERE c.status <> 'deleted'
 GROUP BY c.id, c.collection_type, c.status, c.user_id, c.created_at,
          w.net_payment, w.available_balance, w.pending_balance, w.ledger_balance, w.withdrawn
 ORDER BY c.created_at;
```

**§A2 — R1 detector (organizer-borne fee divergence):** compare raw-sum vs fee-deducted net.
```sql
SELECT c.id, c.fee_bearer,
       SUM(ct.amount)                                   AS edge_style_net,   -- raw
       SUM(ct.gross_amount) - SUM(                                            -- node-style (approx, uncapped)
            LEAST(ct.gross_amount * CASE WHEN c.collection_type='fundraising' THEN 0.01 ELSE 0.005 END, 2000)
          + LEAST(ct.gross_amount * 0.015, 2000)) AS node_style_net,
       w.net_payment AS stored_net
  FROM collections c
  JOIN contributions ct ON ct.collection_id=c.id AND ct.status='paid'
  LEFT JOIN wallets w ON w.collection_id=c.id
 WHERE c.fee_bearer='organizer'
 GROUP BY c.id, c.fee_bearer, w.net_payment;
-- If stored_net ≈ edge_style_net (not node_style_net), this collection is R1.
```

**§A3 — R2 detector (settlement staleness):** stored pending but everything has aged out.
```sql
SELECT c.id, w.pending_balance,
       MAX(ct.created_at) AS last_paid_at
  FROM collections c JOIN wallets w ON w.collection_id=c.id
  JOIN contributions ct ON ct.collection_id=c.id AND ct.status='paid'
 GROUP BY c.id, w.pending_balance
HAVING w.pending_balance > 0
   AND MAX(ct.created_at) < (date_trunc('day', now() at time zone 'UTC') + interval '4 hours');
```

**§A4 — R3 detector (impossible negatives):**
```sql
SELECT collection_id, available_balance, ledger_balance, updated_at
  FROM wallets WHERE available_balance < 0 OR ledger_balance < 0 OR pending_balance < 0;
```

**§A5 — R4 detector (missing / duplicate wallets):**
```sql
-- missing:
SELECT c.id FROM collections c LEFT JOIN wallets w ON w.collection_id=c.id
 WHERE w.id IS NULL AND c.status <> 'deleted';
-- duplicate:
SELECT collection_id, COUNT(*) FROM wallets GROUP BY 1 HAVING COUNT(*) > 1;
```

**§A6 — the "is money missing?" cross-check (source integrity):** confirm every paid contribution has a Paystack reference and every completed withdrawal is accounted — the tests that would reveal *real* loss:
```sql
-- paid but no reference (orphan/suspect):
SELECT id, collection_id, amount FROM contributions
 WHERE status='paid' AND (payment_reference IS NULL OR trim(payment_reference)='');
-- withdrawn more than ever raised (would be real trouble — expect ZERO rows):
SELECT c.id, SUM(w.amount) FILTER (WHERE w.status IN ('approved','completed','successful','success')) AS withdrawn,
             SUM(ct.amount) FILTER (WHERE ct.status='paid') AS raised
  FROM collections c
  LEFT JOIN withdrawals w ON w.collection_id=c.id
  LEFT JOIN contributions ct ON ct.collection_id=c.id
 GROUP BY c.id
HAVING COALESCE(SUM(w.amount) FILTER (WHERE w.status IN ('approved','completed','successful','success')),0)
     > COALESCE(SUM(ct.amount) FILTER (WHERE ct.status='paid'),0) + 1;
```
If §A6 returns rows, escalate — that is the only signature of a *real* inconsistency. On the current evidence it should return **zero**.

---

## TASK 2 & 3 — Classification framework

Every drifted collection maps to exactly one **primary** root cause using the detectors above (R1→§A2, R2→§A3, R3→§A4, R4→§A5), defaulting to `HISTORICAL_FEE_POLICY` (R5) for residual fee-sized diffs and `UNKNOWN` only if none fit. The expectation, from the code, is that **48 ≈ R1 + R2 + a few R3 + 1 R4**, i.e. the "48 problems" reduce to **~4 root causes** — the goal TASK 3 sets. Populate `FINANCIAL_DRIFT_CLASSIFICATION.csv` and the true histogram falls out.

---

## TASK 10 — Is any money actually missing? (explicit answers)

- **Is any contributor payment actually lost?** — **No evidence of loss.** "Expected" is computed *from* the paid `contributions`; a non-zero expected means the payment rows exist. Confirm with §A6 (should be zero orphans of concern).
- **Is any withdrawal missing?** — **No.** Withdrawals are the source for the `withdrawn` figure; drift there is cache staleness. §A6 confirms none exceed raised.
- **Is any ledger incorrect?** — **The cache is incorrect; the source ledger is not** (pending R3/§A6 confirmation). R1 is a formula disagreement, R2/R3/R4 are staleness/residue/absence. The fix is a **recompute**, not a reconstruction.

**One-line verdict:** *the drift is a stale/inconsistent projection, safely rebuildable from intact source data — no reconstruction of lost money is required. Confirm R3 negatives and §A6 before acting.*

---

*Investigation only. No production data, code, migrations, or repair scripts were modified. Continue in `FINANCIAL_REPAIR_PLAN.md` / `FINANCIAL_RISK_ASSESSMENT.md`.*
