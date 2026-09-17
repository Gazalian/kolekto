# Payment Resilience Audit — 2026-08-07

**Question this audit answers:** can a future software bug permanently hide or
lose a successful Paystack payment?

**Answer as of this audit: no longer silently — but the guarantee rests on
inference, not on a recorded fact.** Closing that last gap needs one schema
change (§7.1), which is specified but not shipped.

Scope: `kolekto-be-old` (Express API), `kolekto-fe-old/supabase/functions`
(edge functions), and the production database `busfgcmbndleljklrcbd`.

---

## 1. Headline findings

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | `scheduled-payment-recovery`: git contained a **regression** — production had an attempt cap + dead-lettering that git lacked entirely, while git had a `CRON_SECRET` guard production lacked. Deploying git would have removed the cap. | **High** | **Fixed** — merged, deployed, verified |
| F2 | Two further functions drifted: `settle-pending-deposits` (deployed under slug `rapid-service`) and `create-collection`. | **High** | Detected; **not** remediated (see §7.3) |
| F3 | The admin payment view has a **7-day window** (`LOOKBACK_DAYS = 7`). Payments that go wrong and aren't noticed within a week leave the admin UI entirely. | **High** | **Fixed** — `v_payment_inbox` has no time bound |
| F4 | Nothing recorded **whether Paystack actually captured** a payment. `dead_letter` conflated real lost money with abandoned checkouts. | **High** | **Mitigated** by inference; durable fix in §7.1 |
| F5 | Dead-lettering is **terminal for automation**: after 20 attempts `auto_dead_letter` is written and `get_orphaned_payment_candidates` excludes the reference forever — including for genuinely captured money. | **High** | Open (see §7.2) |
| F6 | The candidate query has **no age or attempt bound**, so before the cap existed a single reference was retried 5,975 times over 3 weeks (and another 15,190 times per the prod header comment). | Medium | Fixed in prod by the cap; now also in git |
| F7 | Reconciliation is genuinely idempotent under concurrency — **proven**, 108 concurrent calls, zero duplicates. | — | Verified |

---

## 2. Failure matrix (Objective 1)

For each stage: what happens on failure, whether money can become invisible,
and how it is recovered. "Invisible" means *captured by Paystack and not
discoverable in the admin interface*.

| # | Stage | On failure | Money invisible? | Auto-recovery | Admin recovery | Duplicate credit possible? |
|---|---|---|---|---|---|---|
| 1 | **Initialize** (`POST /api/payments/initialize-payment` → `pricingService.normalizePaymentRequest`) | Rejected before Paystack is called; `pending_payment_context` row written only on success | **No** — no charge exists yet | n/a | n/a | No |
| 2 | **Paystack checkout** | Contributor abandons, or card declines | **No** — no capture | n/a | Visible as `failed_validation` | No |
| 3 | **Webhook delivery** (`POST /payment/webhook`) | Paystack retries on non-2xx; if it never arrives, nothing happens synchronously | **No, bounded** — the 5-min sweep is the backstop | Yes — `scheduled-payment-recovery` every 5 min | Yes — Admin Retry | No (idempotent RPC) |
| 4 | **Verification** (`verify-paystack-payment`, Paystack `/transaction/verify`) | Paystack API down → HTTP 500, retried | **No, bounded** | Yes | Yes | No |
| 5 | **Validation** (`normalizePaymentRequest` + amount check) | **HTTP 400, nothing inserted** | **THIS WAS THE HOLE** — captured money, no row, no state | Only until the 20-attempt cap, then never | Yes, but admin had to know the reference existed | No |
| 6 | **Contribution creation** (`claim_payment_contributions`) | RPC throws → 500, retried; row-level lock serialises concurrent callers | No | Yes | Yes | **No** — `FOR UPDATE` + existence check returns `idempotent` |
| 7 | **Wallet update** (`refreshCollectionAndWallets`) | Recomputed from `contributions` as source of truth on every payment, not incremented | No — self-healing | Yes, next payment or `settlement_recompute_wallets` cron (04:00) | Yes | **No** — recompute, not increment |
| 8 | **Receipt email** | `sendEmail()` returns `{success:false}` rather than throwing | No — money already recorded | Partial | Manual resend | n/a |
| 9 | **Notification / push** | Best-effort, non-fatal | No | n/a | n/a | n/a |

**Only stage 5 could make money invisible**, and it did. Stages 6–7 are
structurally safe: the persistence path is a single atomic RPC, and the wallet
is a projection recomputed from contributions rather than a mutable counter —
so a wallet can never drift from its contributions for long.

---

## 3. Where a captured payment could be discarded (Objective 2)

Every early-exit in `verify-paystack-payment/index.ts` reachable **after**
`transaction.status === "success"` (index.ts:300):

| Line | Code | Returns | Money discarded? |
|---|---|---|---|
| ~324 | collection lookup failure | 500 | No — retried |
| ~356 | `PaymentValidationError` from `normalizePaymentRequest` (16 distinct codes: `tier_sold_out`, `collection_full`, `invalid_selected_tier`, `collection_deleted`, …) | **4xx** | **Yes — until the cap, then permanently** |
| **379** | **amount mismatch** | **400** | **Yes — this is the 2026-08-06 loss** |
| ~590 | `claim_payment_contributions` RPC error | 500 | No — retried |

The 16 `PaymentValidationError` codes are the full blast radius: *any* of them,
on a captured payment, produces the same silent-loss shape. The 2026-08-06
incident used `amount_mismatch`; `tier_sold_out` and `collection_full` are the
next most likely, and both are plausible under normal operation (a tier selling
out between checkout and webhook).

`ensureCollectionIsPayable` was already hardened for this reason — it now only
hard-blocks `deleted_at` and logs `LEGACY_PAYABLE_GATE_BYPASSED` for
paused/closed/completed, precisely so a lifecycle change between charge and
verify cannot retroactively un-confirm a settled payment. **The same reasoning
has not yet been applied to the amount and capacity checks** — that is §7.1.

---

## 4. Architecture — resilient payment pipeline

```
  Contributor
      │
      ▼
┌─────────────────────┐   writes pending_payment_context (metadata of record;
│ POST /payments/     │   never trusts the client's claimed amount — the tier
│ initialize-payment  │   price is re-derived server-side by pricingService)
└─────────┬───────────┘
          ▼
      Paystack ── captures money ──────────────────────────────┐
          │                                                    │
   ┌──────┴───────┬──────────────────┐                         │
   ▼              ▼                  ▼                         │
frontend      webhook          scheduled-payment-recovery      │
callback   (Paystack retries)   (pg_cron */5, ACTIVE)          │
   │              │                  │                         │
   └──────────────┴──────────────────┘                         │
                  ▼                                            │
        ┌──────────────────────┐                               │
        │ verify-paystack-     │◄── admin Retry / Reconcile ────┘
        │ payment  (SINGLE     │    (same function, no SQL)
        │ source of truth)     │
        └──────────┬───────────┘
                   │ GET /transaction/verify  → status === "success"
                   ▼
        ┌──────────────────────┐
        │ normalizePaymentRequest│ ← MUST agree with initialize
        │  + amount check       │   (enforced by parity test)
        └──────────┬───────────┘
             ok    │    reject
                   │      └──► payment_recovery_log (durable)
                   │             └──► v_payment_inbox → needs_review / P1
                   ▼                    └──► admin retry (loops back above)
        ┌──────────────────────┐
        │ claim_payment_       │  SELECT ... FOR UPDATE on the collection,
        │ contributions (RPC)  │  then existence check on
        │  ATOMIC + IDEMPOTENT │  (collection_id, payment_reference)
        └──────────┬───────────┘  → returns {outcome:'idempotent'} if present
                   ▼
   contribution + contributor code + tier sold_quantity  (one transaction)
                   ▼
   refreshCollectionAndWallets — wallet RECOMPUTED from contributions
                   ▼
        receipt email  →  push notification   (best-effort, non-fatal)
```

Two structural properties do the heavy lifting:

1. **One persistence path.** Every route into the system — frontend callback,
   webhook, 5-minute sweep, admin retry, admin reconcile — funnels into the
   same `verify-paystack-payment` → `claim_payment_contributions` pair. There
   is no second way to create a contribution, so there is no second way to get
   idempotency wrong.
2. **The wallet is a projection, not a counter.** `refreshCollectionAndWallets`
   recomputes net/gross/pending/available from `contributions` and
   `withdrawals` on every payment. A missed or double wallet update self-heals
   on the next write, and the 04:00 `settlement_recompute_wallets` cron
   re-derives everything daily.

---

## 5. What was implemented in this audit

### 5.1 `scheduled-payment-recovery` drift (F1) — fixed and deployed

Git and production each held a fix the other lacked:

| | git (before) | production (before) |
|---|---|---|
| `MAX_SCHEDULED_ATTEMPTS` cap + `auto_dead_letter` | absent | present |
| `CRON_SECRET` caller guard | present | absent |

Git was therefore a **loaded gun**: deploying it would have silently removed
the attempt cap and re-enabled unbounded retries. The two are now reconciled
into one file (git), deployed, and byte-verified. The `CRON_SECRET` guard
remains inert until the secret is configured, so behaviour is unchanged.

The cron job itself was audited and is **active and working**:
`jobid 5, schedule */5 * * * *, active = true` — it fired correctly throughout
the incident (the failures were downstream, in verify).

### 5.2 Payment Inbox (Objectives 3, 6, 7)

`database/payment_inbox_2026-08-07.sql` — `v_payment_inbox` and
`v_payment_health_summary`, applied to production.

Every initialized payment resolves to exactly one state, **with no time
window**: `completed`, `reconciled`, `processing`, `needs_review`,
`failed_validation`, `pending_verification`, `awaiting_webhook`,
`unknown_needs_probe` — plus a `priority` (P1/P2/P3) and, critically, a
`paystack_capture_verdict` (`captured` / `not_captured` / `unknown`) that
separates real money from abandoned checkouts.

Current production state, all 608 payments back to 2026-06-25:

| State | Verdict | Payments | Value |
|---|---|---|---|
| completed | captured | 422 | ₦2,753,107 |
| failed_validation | not_captured | 164 | ₦3,873,893 (never charged) |
| reconciled | captured | 22 | ₦567,900 |
| **needs_review (P1)** | captured | **0** | **₦0** |

Zero P1, P2 and P3. Every rupee of captured money maps to a contribution.

The view exposes every field Objective 4 asks for (reference, collection,
organizer, contributor, amount charged, expected amount, tier, failure reason,
retry count, created at, current state), so the existing admin endpoints can be
repointed at it without new backend logic.

**Precision note.** An earlier version of the orphan detector keyed on the
*last* error code and produced false positives, because the terminal
`attempt_cap_exceeded` marker masks the real reason — three long-abandoned
checkouts looked identical to real losses. Both `v_payment_inbox` and
`v_orphaned_successful_payments` now key on **post-capture rejection codes**
(reachable only from the `status === "success"` branch, hence proof of
capture) and treat Paystack's own *"Transaction reference not found"* as proof
of non-capture. That reclassified all three correctly.

### 5.3 Idempotency, proven under concurrency (Objective 8)

Sequential replay proves little; the real risk is an admin clicking Retry while
the sweep fires while Paystack redelivers. `idempotency_chaos.mjs` fired
**108 concurrent invocations** across the 6 recovered references, rotating
`invocation_source` between `admin_reconcile`, `scheduled_recovery`, `webhook`
and `frontend_callback`, in 6 overlapping bursts.

```
total calls: 108
errors: 0
identity mismatches: 0
IDEMPOTENT ✅
```

Database after: **12 contributions, 12 distinct contributor codes, 0 duplicate
references, wallet unchanged (305,000 / 510,000 / 815,000), 0 rows created.**
Every call returned the *same* contribution IDs.

### 5.4 Deploy-parity gate (Objective 9)

`scripts/verifyEdgeDeployParity.mjs`, extended to 6 payment-critical functions,
plus `.github/workflows/payment-integrity.yml` running pricing parity on every
PR and deploy parity on push + every 6 hours (drift can appear with no commit).

Running it immediately found two more drifted functions (F2) — including a
slug/directory mismatch (`settle-pending-deposits` deploys as `rapid-service`)
that had been silently reporting a download failure instead of a comparison.

---

## 6. Acceptance criteria (Objective 11)

| Criterion | Status |
|---|---|
| No successful payment can become invisible | **Mitigated, not guaranteed** — see §7.1 |
| Every successful payment appears in the admin interface | **Yes** — `v_payment_inbox`, no time window |
| Every failed payment can be retried from the Admin Panel | **Yes** — endpoints already exist |
| Reconciliation never requires SQL | **Yes** — recovery ran entirely through the edge function |
| Reconciliation never requires engineering support | **Partly** — UI must be repointed at the new view (§7.4) |
| Reconciliation is fully idempotent | **Yes — proven, 108 concurrent calls** |
| Duplicate credits impossible | **Yes** — `FOR UPDATE` + existence check |
| Deployment drift automatically detected | **Yes** — script + CI |
| Automated monitoring alerts on orphaned payments | **Yes** — P1 query; wiring to a pager outstanding |
| A future bug cannot permanently hide customer money | **Not yet** — §7.1 + §7.2 |

---

## 7. Remaining risks and recommendations

### 7.1 (Highest) Record Paystack's verdict as a fact, not an inference

Today "was this captured?" is *inferred* from which error code happens to be in
`payment_recovery_log`. That works for every failure that reaches the validation
branch — but a payment captured by Paystack whose verify run dies earlier (DB
outage, timeout, an exception before validation) leaves no post-capture code and
lands in `unknown_needs_probe`. It is visible, but its status must be confirmed
by re-querying Paystack.

**Fix:** at the moment `transaction.status === "success"` is first observed,
write a durable row (`payment_status = 'captured'`, plus verified amount,
channel, `paid_at`, full Paystack payload) *before* any validation runs. Then
change the 16 `PaymentValidationError` exits and the amount-mismatch exit from
"return 4xx and discard" to "persist as `needs_review` with the mismatch
context, return 200". This is the change that converts the guarantee from
inference to fact, and it makes stage 5 of the failure matrix structurally
incapable of losing money.

### 7.2 Dead-lettering must be capture-aware

`auto_dead_letter` currently stops automatic recovery **forever**, and
`get_orphaned_payment_candidates` excludes those references permanently — for
abandoned checkouts (correct) *and* for genuinely captured money (wrong). All
six payments in the 2026-08-06 incident were dead-lettered; had nobody looked,
automation would never have revisited them.

**Fix:** never dead-letter a reference whose capture verdict is `captured`.
Instead move it to `needs_review`, keep retrying on a long backoff, and page.
Cap retries only where Paystack has definitively said the transaction does not
exist.

### 7.3 Two functions are still drifted

`settle-pending-deposits` (slug `rapid-service`) and `create-collection` both
differ between git and production. `settle-pending-deposits` moves money
between pending and available balances, so this is money-relevant and should be
diffed and reconciled before the next settlement run. `create-collection`'s
production copy still hand-duplicates the KYC rule that git has refactored into
`_shared/featureAccess.ts`. Neither was remediated here: both are outside the
payment-loss path, and after an incident the right move is one deliberate
change at a time.

### 7.4 Admin UI work not done

The backend for the Payment Inbox exists and is queryable, and the admin
endpoints (retry, manual-reconcile, retry-all, resolve, notes) already exist and
already call the correct pipeline. What is **not** done is the frontend: the
admin screens still read the 7-day, capture-blind classification in
`controllers/admin/paymentMonitoring.js`. Repointing `loadPaymentMonitoringState`
at `v_payment_inbox` — and dropping `LOOKBACK_DAYS` — is a small change that
delivers most of Objectives 3, 4 and 7, and should be the next piece of work.

### 7.5 Chaos testing partially done

Covered for real: duplicate webhook delivery, concurrent delivery from four
sources, Paystack retry, amount mismatch, stale deployment, and replay of
historical payments. **Not** covered: injected database failure, contribution
insert failure, and wallet update failure — these need a staging environment
with fault injection, since they cannot be simulated safely against production.

### 7.6 Alerting is defined but not wired

The P1 query exists and returns 0. It is not yet connected to a pager. Until it
is, detection still depends on someone running a query.

---

## Appendix — commands

```bash
npm run test:payment-parity     # tier-collision + init/verify parity (12 tests)
npm test                        # full backend suite (292 tests)
npm run verify:edge-parity      # git ↔ production byte-diff for 6 functions
```

```sql
-- Is any customer money invisible right now? (must be 0)
SELECT count(*) FROM public.v_payment_inbox WHERE priority = 'P1';

-- The inbox itself
SELECT reference, inbox_state, priority, paystack_capture_verdict,
       amount_charged, failure_reason, retry_count, contributor_email
FROM public.v_payment_inbox
WHERE inbox_state NOT IN ('completed', 'failed_validation')
ORDER BY created_at DESC;
```
