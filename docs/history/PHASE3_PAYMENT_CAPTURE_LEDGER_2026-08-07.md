# Phase 3 — Payment Capture Ledger & Guaranteed Recovery

**Date:** 2026-08-07 · **Environment:** production (`busfgcmbndleljklrcbd`)

---

## 0. Formal statement (asked for in the brief)

> **Does the system now guarantee that no successful Paystack payment can ever
> become permanently invisible?**

**Not yet — but the reason is now a single, well-specified, un-shipped code
change rather than an architectural gap.**

Precisely:

- **The ledger exists, is populated, and is enforced.** 714 payments have a
  ledger row; 550 carry immutable capture facts totalling **₦4,176,833**. A
  captured payment **cannot** be deleted, reverted, marked failed, or have its
  amount altered — this is enforced by a database trigger and **proven by test
  below**, not asserted.
- **What is NOT yet true:** `verify-paystack-payment` does not yet *write* the
  capture fact before validation. For payments made from now until that change
  ships, capture is still *inferred* from error codes (the Phase-2 mechanism),
  exactly as before. The ledger's forward-looking guarantee is therefore
  **latent** — the structure is in place and backfilled, but the write path
  that keeps it true has not been deployed.
- **Nothing regressed.** The Payment Inbox is deliberately *hybrid*: it uses
  the ledger where capture is a recorded fact and falls back to Phase-2
  inference otherwise, so detection cannot get worse during rollout. The
  `capture_is_recorded_fact` column shows which basis is in play per payment.

So: the guarantee holds for every payment already in the ledger, and will hold
universally once §6.1 ships. I am not going to claim it holds today, because
that would be false for a payment captured in the next hour.

---

## 1. Decision: extend, do not create a new table

The brief asked to evaluate extending an existing table first. Assessed
against production data:

| Candidate | Evidence | Verdict |
|---|---|---|
| `deposits` | 6,201 rows, **newest 2026-06-16**, **zero writes in 30 days**, no writer found anywhere in either repo, no unique constraint on `payment_reference` | **Dead table.** Reviving a legacy schema and still needing new constraints |
| `payment_recovery_log` | 28,770+ rows, **many rows per reference by design** (99 for one reference during the incident) | **Wrong shape.** It is an append-only *attempt log* — an event stream *about* payments, not a record *of* a payment |
| `pending_payment_context` | **PRIMARY KEY (reference)** — already exactly one row per payment; written at initialize so a row exists *before* capture; already read by the recovery sweep and the Inbox | **Correct home** |

**Chosen: extend `pending_payment_context`.** A separate `payment_captures`
table would have created a *second* source of truth that could diverge from
the one every existing component already reads — the precise failure this
programme is trying to eliminate. The stated principle ("exactly one
authoritative record") argues for extension, not addition.

The table is **not renamed**: the RPC, both edge functions and the Express API
reference it by name, so a rename is a coordinated breaking change with no
functional benefit. `v_payment_inbox` is the semantic read surface.

**A real gap this closed:** 112 contributions in production had a
`payment_reference` with **no** `pending_payment_context` row — invisible to
any inbox built on that table, including the Phase-2 one. 109 ledger rows were
backfilled from `contributions` to close it. Going forward, capture must be
written with `INSERT … ON CONFLICT (reference) DO UPDATE` so a captured payment
gets a ledger row even when initialize never wrote one.

---

## 2. State machine

```
                    ┌───────────────┐
                    │  initialized  │  checkout started
                    └───────┬───────┘
                            ▼
                    ┌───────────────┐
                    │pending_capture│  redirected to Paystack
                    └───────┬───────┘
                            ▼
        ╔═══════════════════════════════════╗
        ║            captured               ║ ◄── MONEY EXISTS.
        ║  capture facts are IMMUTABLE here ║     Point of no return.
        ╚════┬──────────────┬───────────┬═══╝
             ▼              ▼           ▼
      ┌────────────┐ ┌─────────────┐ ┌───────────┐
      │ processing │ │needs_review │ │reconciling│
      └─────┬──────┘ └──────┬──────┘ └─────┬─────┘
            ▼               ▼              ▼
      ┌───────────┐   (admin / auto     ┌────────────┐
      │ completed │◄───  replay)  ──────│ reconciled │
      └───────────┘                     └────────────┘

   ┌────────┐   terminal ONLY when Paystack confirms no
   │ failed │   transaction exists. Unreachable from `captured`.
   └────────┘
```

**Enforced rules** (`trg_ppc_state_machine`, `ppc_state_valid`):

1. Capture facts (`captured_at`, `captured_amount`, `paystack_transaction_id`,
   `paid_at`, `currency`) are **write-once**. Any UPDATE that changes them
   after `captured_at` is set raises `IMMUTABLE_CAPTURE`.
2. A captured payment can **never** transition to `initialized`,
   `pending_capture`, or `failed` — raises `ILLEGAL_TRANSITION`. This is the
   structural guarantee that recorded money cannot be un-recorded.
3. Every other transition is checked against an explicit allow-list; anything
   else raises `ILLEGAL_TRANSITION`.
4. `state` is constrained to the nine legal values.
5. `failed` → `captured` **is** allowed: a late webhook must be able to
   correct an earlier "no transaction" conclusion.

---

## 3. Schema changes

Applied to `public.pending_payment_context` (all additive; existing columns
untouched):

*Capture facts (write-once):* `paystack_transaction_id`, `paystack_status`,
`captured_amount`, `currency`, `channel`, `paid_at`, `captured_at`,
`verified_at`, `verification_payload` (jsonb), `contributor_email`,
`organizer_id`.

*Workflow (mutable):* `state`, `failure_code`, `failure_reason`,
`failure_context` (jsonb), `retry_count`, `last_attempt_at`, `next_retry_at`,
`reconciliation_state`, `resolved_at`, `resolved_by`, `updated_at`.

*Indexes:* `idx_ppc_state`, `idx_ppc_captured_at`, `idx_ppc_collection`,
`idx_ppc_contributor_email` (admin search by contributor).

*Duplicate-credit guard:* `uq_contributions_reference_line` —
UNIQUE `(payment_reference, line_index)` WHERE not voided.

> **Correction to the Phase-2 audit.** That report said duplicate protection was
> enforced only in application code. That was wrong: a database constraint
> `uq_contributions_collection_ref_line` already existed. The new index is not
> redundant — the pre-existing one includes `collection_id`, so it would permit
> one reference to create contributions in **two different collections**. The
> new index forbids that. Both are retained.
>
> Note the key is `(payment_reference, line_index)`, **not** `payment_reference`
> alone: ticket collections legitimately create one row per ticket under a
> single reference (3 rows observed). A unique index on the reference alone
> would have broken ticket sales.

---

## 4. Evidence

### 4.1 State machine enforcement — executed against a real captured row

| Test | Result | Database response |
|---|---|---|
| Mutate `captured_amount` on a captured payment | **PASS** | `IMMUTABLE_CAPTURE: capture facts for reference 652qx3yw53 cannot be modified once recorded` |
| Captured → `failed` | **PASS** | `ILLEGAL_TRANSITION: captured payment 652qx3yw53 cannot move to failed` |
| Captured → `initialized` | **PASS** | `ILLEGAL_TRANSITION: captured payment 652qx3yw53 cannot move to initialized` |
| Set an invalid state (`banana`) | **PASS** | `ILLEGAL_TRANSITION: completed -> banana is not permitted` |
| A **legal** transition (`completed → needs_review → completed`) | **PASS** | allowed, row restored |

Post-test verification: the row's `captured_amount` is still `16320` — the
immutability guard protected real data during its own test.

### 4.2 Duplicate credit — executed

Attempting to insert a second contribution for
`kolekto-1786028435175-131541` at the same `line_index`:

```
duplicate key value violates unique constraint "uq_contributions_collection_ref_line"
```

Blocked at the database level, independent of application logic.

### 4.3 Ledger population

| State | Payments | Capture fact recorded | Captured value |
|---|---|---|---|
| completed | 528 | 528 | ₦3,608,933.81 |
| reconciled | 22 | 22 | ₦567,900.00 |
| failed (never captured) | 164 | 0 | — |
| **needs_review / P1** | **0** | — | — |

### 4.4 Continuous invariants (`v_payment_invariants`)

| Invariant | Violations |
|---|---|
| captured_without_terminal_state | **0** |
| completed_without_contribution | **0** |
| contribution_without_ledger | **0** |
| contribution_without_capture_fact | **0** |
| duplicate_active_reference_line | **0** |
| **wallet_vs_contributions_drift** | **2** |

**New finding — two wallets drift from their contributions:**

| Collection | Wallet net | Σ contributions | Drift |
|---|---|---|---|
| SIWES MALETE SPECIAL | 150,001.23 | 150,000.00 | **+₦1.23** |
| Waterfall Team | 629.94 | 630.00 | **−₦0.06** |

Total ₦1.29 across the platform — rounding-scale, not systemic, and both
wallets were last written by the 04:00 settlement cron. Not urgent, but it was
previously undetected and is now permanently monitored.

### 4.5 Idempotency (carried forward from Phase 2, still valid)

108 concurrent invocations across 6 references, rotating
`admin_reconcile` / `scheduled_recovery` / `webhook` / `frontend_callback`:
0 errors, 0 identity mismatches, 0 rows created, wallet unchanged.

---

## 5. Migration strategy (what was done, in order)

1. **Additive columns** — no locks of consequence, no behaviour change.
2. **Backfill missing ledger rows** — 109 inserted from `contributions`
   (`ON CONFLICT DO NOTHING`).
3. **Backfill state + capture facts** — derived from contributions
   (authoritative for completed) and `payment_recovery_log` context
   (`verifiedTotal`) for captured-but-unrecorded.
4. **Then** install the CHECK constraint and trigger. Order matters: the
   trigger forbids exactly the transitions the backfill has to perform, so
   enforcement must come last.
5. **Add the duplicate guard**, after verifying zero existing violations.
6. **Rebuild the views** as hybrid (ledger-first, inference-fallback).

Rollback: `payment_capture_ledger_2026-08-07_ROLLBACK.sql`. Step 1 alone
(drop trigger + constraint) disables enforcement non-destructively; the
column-drop step is commented out by default.

---

## 6. Remaining work and risks

### 6.1 (Blocking the guarantee) Write capture before validation

`verify-paystack-payment/index.ts` must, immediately after
`transaction.status === "success"` (line ~300) and **before**
`normalizePaymentRequest`:

```ts
await supabase.from("pending_payment_context").upsert({
  reference,
  collection_id: collectionId,
  captured_at: new Date().toISOString(),
  captured_amount: verifiedTotalEarly,
  paystack_transaction_id: String(transaction.id),
  paystack_status: transaction.status,
  paid_at: transaction.paid_at,
  channel: transaction.channel,
  currency: transaction.currency,
  verification_payload: transaction,
  verified_at: new Date().toISOString(),
  contributor_email: customer?.email ?? null,
  state: "captured",
}, { onConflict: "reference" });
```

and the ~17 rejection exits (16 `PaymentValidationError` codes + the amount
check at line 379) must become: set `state='needs_review'`, record
`failure_code`/`failure_reason`/`failure_context`, **return 200**, never 4xx.

This is not shipped. It is a change to the synchronous money path and belongs
in its own deployment with its own verification, not appended to a session
that already made two production deploys — that pattern is how the v34
regression happened. Until it ships, capture remains inferred for new payments
and the Phase-2 detection continues to cover them.

### 6.2 Dead-lettering is still capture-blind

`get_orphaned_payment_candidates` still permanently excludes any reference with
an `auto_dead_letter` action, including genuinely captured money. Once §6.1
lands, this should become: never dead-letter a row whose `captured_at` is set;
instead keep retrying on exponential backoff via `next_retry_at` (the column
exists and is indexed but is not yet populated or read).

### 6.3 Admin UI still points at the old classification

`controllers/admin/paymentMonitoring.js` still uses its own 7-day,
capture-blind classification. Repointing `loadPaymentMonitoringState` at
`v_payment_inbox` and dropping `LOOKBACK_DAYS` delivers the recovery dashboard
with no new backend logic. The action endpoints (retry, manual-reconcile,
retry-all, resolve, notes) already call the correct pipeline and need no change.

### 6.4 Fault injection not run

Database-unavailable-after-capture, contribution-insert failure, wallet-update
failure and server-restart-after-capture are **not** covered. They require a
staging environment with fault injection; they cannot be simulated safely
against production, and simulating them against production is how you create
the next incident. Webhook duplication, concurrent reconciliation, Paystack
retry and amount mismatch **are** covered (§4.5 and the Phase-2 suite).

### 6.5 Two edge functions remain drifted

`settle-pending-deposits` (slug `rapid-service`) and `create-collection`.
`settle-pending-deposits` moves money between pending and available balances,
so it should be reconciled before the next settlement run.

---

## Appendix — operating the ledger

```sql
-- Is any captured money not yet recorded as a contribution? (must be 0)
SELECT count(*) FROM public.v_payment_inbox WHERE priority = 'P1';

-- Continuous invariants (all should read 0)
SELECT * FROM public.v_payment_invariants ORDER BY violations DESC;

-- The inbox
SELECT reference, inbox_state, priority, money_captured, capture_is_recorded_fact,
       captured_amount, failure_reason, retry_count, contributor_email
FROM public.v_payment_inbox
WHERE inbox_state NOT IN ('completed','failed')
ORDER BY created_at DESC;

-- Admin search by reference / contributor
SELECT * FROM public.v_payment_inbox WHERE reference = $1;
SELECT * FROM public.v_payment_inbox WHERE contributor_email ILIKE $1;
```
