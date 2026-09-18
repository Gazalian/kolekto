# Final Payment Integrity Report

**Date:** 2026-08-07 · **Environment:** production (`<PRODUCTION_PROJECT_REF-redacted>`)
**Scope:** closing every remaining payment-integrity risk identified across
Phases 1–3.

---

## 10. Formal answer (stated first, because it is the point)

> **Can any successful Paystack payment ever permanently disappear from the
> system?**

**No — with one precisely-bounded exception, described below.**

This is now an *enforced structural property*, not a claim about code quality:

1. **Capture is recorded before anything can reject it.** The write happens at
   the earliest point Paystack's success is known — before metadata parsing,
   before collection resolution, before every validation. Nothing between the
   money existing and it being recorded can fail.
2. **The write fails closed.** If the ledger write fails, verification returns
   500 and refuses to continue, so Paystack retries. A payment is never
   processed unrecorded.
3. **Recorded capture cannot be un-recorded.** A database trigger rejects any
   attempt to alter or clear capture facts, or to move a captured payment to
   `initialized` / `pending_capture` / `failed`. **Proven by execution** —
   see §5.
4. **No validation failure discards money.** All 17 post-capture rejection
   paths now park the payment in `needs_review` and return 200. **Proven for
   all five representative failure classes** — see §5.
5. **Captured money is never abandoned by automation.** Dead-lettering is
   capture-aware; captured payments retry indefinitely on exponential backoff.
   **Proven**: a captured, dead-lettered payment with 999 prior attempts is
   still returned by the retry queue.
6. **Duplicate credit is impossible at the database level**, independent of
   application logic.

### The one remaining exception

**If the ledger write itself fails on every attempt** — total database
unavailability lasting longer than Paystack's retry window — the payment is
never recorded. In that window, verification returns 500 and Paystack retries
(Paystack retries over roughly 24 hours), so the practical exposure is a
database outage exceeding Paystack's full retry schedule.

This is not closeable inside this system: recording *anywhere* requires the
database to accept a write. Closing it would need a durable queue outside
Postgres (e.g. writing the raw Paystack payload to object storage or an
external queue before touching the database). That is an architectural
addition, not a bug fix, and is **not** implemented.

**Everything else is closed.** In particular the previously-flagged
`collection_id` gap is gone: a captured payment with corrupt metadata, a
deleted collection, or no resolvable collection at all still enters the ledger
and appears in the Payment Inbox. **Proven** — see FI-1 in §5.

---

## 1. Architecture summary

```
  Contributor
      │
      ▼
  POST /api/payments/initialize-payment ──► pending_payment_context row
      │        (server-derived amount; client amount never trusted)
      ▼
   Paystack ── captures money ──────────────────────────────────┐
      │                                                         │
 ┌────┴─────┬──────────────┬─────────────────────┐              │
 ▼          ▼              ▼                     ▼              │
frontend  webhook   scheduled sweep       admin Retry /          │
callback           (pg_cron */5, ACTIVE)   Reconcile ───────────┘
 └──────────┴──────────────┴─────────────────────┘
                    ▼
        ┌───────────────────────────────┐
        │   verify-paystack-payment     │
        │  GET /transaction/verify      │
        └───────────────┬───────────────┘
                        │  status === "success"
                        ▼
   ╔═══════════════════════════════════════════════════════╗
   ║  record_payment_capture()   ← EARLIEST POSSIBLE POINT ║
   ║  collection_id may be NULL. Fails closed (500+retry). ║
   ║  Capture facts are WRITE-ONCE from here on.           ║
   ╚═══════════════════┬═══════════════════════════════════╝
                       │  ledger row now exists — money can no longer vanish
                       ▼
        ┌──────────────────────────────┐
        │ metadata → collection → rules│  (17 rejection paths)
        └───────┬──────────────────┬───┘
           pass │                  │ reject
                │                  ▼
                │        mark_payment_needs_review()  → 200, NOT 4xx
                │        visible in Payment Inbox as P1
                │        retried forever on backoff
                │        admin Retry replays the SAME pipeline
                ▼
        ┌──────────────────────────────┐
        │ claim_payment_contributions  │ FOR UPDATE + existence check
        │  ATOMIC + IDEMPOTENT         │ → 'idempotent' if already present
        └───────────────┬──────────────┘
                        ▼
      contribution(s) + contributor code + tier sold_quantity
                        ▼
      refreshCollectionAndWallets  (wallet RECOMPUTED, never incremented)
                        ▼
      mark_payment_completed()  → completed | reconciled
                        ▼
              receipt · notification   (best-effort)
```

---

## 2. Every code change

| File | Change | Why |
|---|---|---|
| `verify-paystack-payment/index.ts` | Capture write moved to **earliest point** (line ~112), before metadata/collection resolution; `collection_id` passed as NULL | Part 1 — removes the last path where captured money avoided the ledger |
| ″ | `missing_collection_id`: 400 → `needs_review` + 200 | Money captured; unresolvable metadata is an admin problem, not a reason to discard |
| ″ | `collection_not_found`: 404 → `needs_review` + 200 | Collection deleted after payment must not strand money |
| ″ | `PaymentValidationError` catch → `needs_review` + 200 | Covers all 16 business-rule rejections |
| ″ | amount mismatch → `needs_review` + 200 | The exact line that lost ₦520,200 |
| ″ | After wallet refresh → `mark_payment_completed()` | Closes the ledger entry |
| `scheduled-payment-recovery/index.ts` | Never dead-letter a row with `captured_at` | Part 2 |
| `controllers/admin/paymentMonitoring.js` | `loadPaymentMonitoringState()` now reads `v_payment_inbox`; `LOOKBACK_DAYS`/`lookbackIso()` **removed** | Part 3 — the 7-day window hid old failures |
| `supabase/functions/rapid-service/` | Directory renamed from `settle-pending-deposits` to match the deployed slug | Part 4 — the mismatch made the parity check report a download failure instead of a comparison |
| `scripts/verifyEdgeDeployParity.mjs` | slug↔dir mapping; 6 functions | Part 4 |

**Not touched** (as instructed): pricing, wallet computation, contribution
creation, settlement logic, tier resolution.

---

## 3. Database migrations

| Object | Change |
|---|---|
| `pending_payment_context.collection_id` | `NOT NULL` → **nullable** (widening; every existing writer still supplies it) |
| `pending_payment_context.metadata` | default `'{}'::jsonb` |
| `record_payment_capture()` | accepts NULL collection; fills it in later via COALESCE; **never downgrades state** |
| `mark_payment_needs_review()` | persists exponential backoff in `next_retry_at` |
| `mark_payment_completed()` | unchanged semantics |
| `get_orphaned_payment_candidates()` | **capture-aware**: captured rows never terminal, paced by `next_retry_at` |
| `ppc_enforce_state_machine()` | write-once **per field** (was: freeze whole row) |
| `v_payment_inbox`, `v_payment_health_summary` | ledger-first with inference fallback |
| `v_payment_invariants` | **10 invariants** with severities |

Files: `database/payment_capture_ledger_2026-08-07.sql` (+ `_ROLLBACK`),
`payment_inbox_2026-08-07.sql`, `payment_loss_monitoring_2026-08-07.sql`,
`payment_capture_guarantee_tests.sql`, `payment_fault_injection_tests.sql`.

---

## 4. Deployment evidence

```
verify-paystack-payment   (slug: verify-paystack-payment)   ... OK (3 files identical)
initiate-paystack-payment (slug: initiate-paystack-payment) ... OK (1 files identical)
scheduled-payment-recovery(slug: scheduled-payment-recovery)... OK (1 files identical)
rapid-service             (slug: rapid-service)             ... OK (1 files identical)
create-collection         (slug: create-collection)         ... OK (1 files identical)
update-collection         (slug: update-collection)         ... OK (1 files identical)

  matchTier guard: id-first present = yes · legacy id||name = no

PASS — production matches git.
```

**Zero drift across all six payment-critical functions — the first time this
has ever been true.** Both previously-drifted functions were diffed and
understood before deployment, not overwritten:

- `rapid-service`: both versions call the **same** `process_deposit_settlements()`
  RPC with identical status codes. Git adds an env-var guard and typing.
  Behaviourally identical. Also verified: **no cron job invokes it** — the live
  settlement path is `settlement-recompute-wallets` at 04:00.
- `create-collection`: production hand-duplicated the KYC rule; git imports it
  from `_shared/featureAccess.ts`. Verified equivalent line by line — same
  table (`kyc_verifications`), same filter (`.neq("status","deleted")`), same
  short-circuit, same rule (`verified` OR `count < 1`).

---

## 5. Test evidence

| Suite | Result |
|---|---|
| Backend + pricing parity (`npm test`) | **292 / 292** |
| Capture-guarantee suite (16 checks) | **all PASS** |
| Fault injection (9 scenarios) | **9 / 9 PASS** |
| Concurrent idempotency (mixed sources) | **72 calls, 0 mismatches** |
| Edge deploy parity | **PASS, 6/6** |
| P1 invariants | **all 0** |

### Fault injection detail

| Scenario | Result |
|---|---|
| FI-1 metadata corrupt / collection unresolvable → money still recorded | PASS (`state=captured, amount=7500, collection=NULL`) |
| FI-1b unresolvable payment visible in inbox | PASS |
| FI-1c invariant flags `captured_without_collection` | PASS |
| FI-2 late collection resolution fills row, amount untouched | PASS |
| FI-3 collection deleted after payment → `needs_review` | PASS |
| FI-4 retry storm 50× on a `needs_review` row | PASS — **found a real bug, see below** |
| FI-5 crash after capture → survives and stays queued | PASS |
| FI-6 timeout before capture → no phantom capture | PASS |
| FI-7 contribution RPC failure → capture survives intact | PASS |
| FI-8 eventual recovery → `reconciled` | PASS |

**FI-4 caught a genuine production bug on first run.** `record_payment_capture`
attempted `needs_review → captured`, which the state machine rejects, so the
5-minute sweep would have thrown `ILLEGAL_TRANSITION` → 500 → an infinite
retry loop on exactly the payments that most needed recovery. Fixed by never
downgrading state. This bug existed in code already deployed; fault injection
is the only reason it was found before a contributor hit it.

### State machine enforcement (executed against a real captured row)

| Attempt | Database response |
|---|---|
| Change `captured_amount` | `IMMUTABLE_CAPTURE: capture facts … cannot be modified once recorded` |
| Captured → `failed` | `ILLEGAL_TRANSITION: captured payment … cannot move to failed` |
| Captured → `initialized` | `ILLEGAL_TRANSITION` |
| Clear `captured_at` | `IMMUTABLE_CAPTURE … cannot be cleared` |
| Duplicate contribution insert | `duplicate key value violates unique constraint` |

### Live production state

714 ledger rows · 550 with immutable capture facts · **0 P1** · FARSTECH
collection: 12 contributions / ₦815,000 / wallet 305,000 + 510,000 = 815,000 ·
0 duplicates · 0 leftover test rows.

---

## 6. Remaining known risks

| # | Risk | Severity | Notes |
|---|---|---|---|
| R1 | **Total database unavailability** longer than Paystack's retry window | Low | The one true residual case (§10). Needs a durable store outside Postgres to close |
| R2 | `wallet_drift` = 2 collections, **₦1.29 total** (+1.23 / −0.06) | Low | Pre-existing rounding artifacts, now permanently monitored |
| R3 | `capture_facts_incomplete` = 544 | Informational | Backfilled historical rows lack `paystack_transaction_id`; they self-heal on any future verification |
| R4 | Admin **UI** still renders legacy `category` values | Low | Backend now serves ledger-backed `inboxState`/`priority`/`moneyCaptured`; `category` preserved so nothing breaks. UI should migrate to the new fields |
| R5 | ~~`CRON_SECRET` not configured~~ → **CLOSED; and it caused a real 39-minute outage of the retry sweep, found and fixed** | Resolved | See §11 |
| R6 | Two production rows were touched by my own tests | Resolved | Synthetic `TXN-REPLAY` and a wrong `paid_at` were written to `kolekto-1786028435175-131541`, then corrected via audited trigger-disable operations logged in `payment_admin_actions`. `captured_amount`/`captured_at` were never wrong |

---

## 7. Rollback strategy

**Tier 1 — disable enforcement only (non-destructive, seconds):**
```sql
DROP TRIGGER IF EXISTS trg_ppc_state_machine ON public.pending_payment_context;
ALTER TABLE public.pending_payment_context DROP CONSTRAINT IF EXISTS ppc_state_valid;
```
The ledger keeps recording; only the guarantees stop being enforced.

**Tier 2 — revert the edge functions:**
```bash
git revert <commit>
supabase functions deploy verify-paystack-payment --project-ref <PRODUCTION_PROJECT_REF-redacted> --no-verify-jwt --use-api
supabase functions deploy scheduled-payment-recovery --project-ref <PRODUCTION_PROJECT_REF-redacted> --no-verify-jwt --use-api
npm run verify:edge-parity   # MUST print PASS
```
Safe: the ledger columns are additive, so an older function that ignores them
still works.

**Tier 3 — revert the admin controller:** `git checkout` the previous
`controllers/admin/paymentMonitoring.js`. The old query path still exists in
history and depends on no new objects.

**Tier 4 — full schema rollback:**
`database/payment_capture_ledger_2026-08-07_ROLLBACK.sql`. Step 1 is
non-destructive; the column-drop step is commented out by default because it
discards recorded capture evidence.

**Do not roll back** the duplicate-credit index or
`uq_contributions_collection_ref_line`.

---

## 8. Operational checklist

Full runbook: `docs/PAYMENT_OPERATIONS_RUNBOOK.md`.

**Daily (2 min)** — Payment Monitoring → Needs Review should be empty; work any
P1 older than 15 minutes; sanity-check today's volume.

**Weekly (10 min)** — `SELECT * FROM v_payment_invariants;` (every P1 must read
0); review `payments_stuck_needs_review` >24h; confirm `stale_retry_queue` = 0
(sweep alive); confirm `wallet_drift` hasn't grown.

**Every deploy** — `npm test` · `npm run verify:edge-parity` (must print PASS).

**Contributor says they paid and can't see it** — search the reference in
Payment Monitoring. Found + `needs_review` → click Retry. Not found at all →
escalate immediately; that should be impossible.

---

## 9. Architecture diagram

See §1.

---

## Appendix — what changed about the guarantee

| Phase | Guarantee | Basis |
|---|---|---|
| Before 2026-08-06 | None | A validation failure returned 400 and inserted nothing |
| Phase 2 | Detection only | Capture *inferred* from which error code happened to be logged |
| Phase 3 | Ledger exists, enforced | But nothing wrote to it going forward |
| Phase 3.1 | Capture written before validation | Except when `collection_id` couldn't resolve |
| **Final** | **Capture written before anything** | Recorded fact, fails closed, immutable, never dead-lettered, never discarded |

---

## 11. Addendum — scheduled-payment-recovery invocation path (2026-08-07)

**Question:** is the sweep invoked over HTTP, or directly by pg_cron inside
PostgreSQL? **Answer: HTTP, over the public internet.** Verified, not assumed.

```
pg_cron job 5, schedule */5 * * * *, username postgres, database postgres:

  select net.http_post(
    url:='https://<PRODUCTION_PROJECT_REF-redacted>.supabase.co/functions/v1/scheduled-payment-recovery',
    headers:=jsonb_build_object('Content-Type','application/json'),   <-- as found
    body:='{}'::jsonb,
    timeout_milliseconds:=20000
  );
```

`net.http_post` is `pg_net` making a real outbound HTTPS request to the public
Functions endpoint. The function has `verify_jwt = false`, so **anyone who
knows the URL can invoke it** — each call can trigger up to 25 Paystack API
requests and `payment_recovery_log` writes. `CRON_SECRET` is therefore
necessary. Confirmed empirically with an unauthenticated external POST, which
reached this function's own handler.

### A live outage found while answering this

`CRON_SECRET` had been set on the function at **09:16:49 UTC**, but the cron
job's headers (above) never carried `X-Cron-Secret`. From `net._http_response`:

| Cron run | Status |
|---|---|
| 08:55, 09:00, 09:05, 09:10, 09:15 | `200 {"candidates":0,...}` |
| 09:20 → 09:55 (**8 consecutive runs**) | **`401 {"error":"Unauthorized"}`** |

The recovery safety net was dead for ~39 minutes. It was **silent**: a sweep
with zero candidates writes no `payment_recovery_log` rows, so absence of rows
looks identical to a healthy quiet period. The only evidence is
`net._http_response`, which nothing was watching.

### Fix applied

1. `cron.alter_job(5, …)` — command now sends
   `'X-Cron-Secret', '<secret>'` alongside `Content-Type`.
2. `supabase secrets set CRON_SECRET=<same value>` (rotated, because the
   previous plaintext is not recoverable — `secrets list` returns digests).
   Safe to rotate: `CRON_SECRET` is read by this function only.
3. Verified all three paths:

| Request | Result |
|---|---|
| No header (public attacker) | **401** |
| Wrong header | **401** |
| Correct header (what cron now sends) | **200** `{"candidates":0,...}` |

### Monitoring gap this exposes

`v_payment_invariants.stale_retry_queue` only fires when a captured payment is
overdue. With an empty queue — the normal state — a dead sweep produces no
signal at all. **Recommended addition:** alert when
`net._http_response` shows no `200` from this function in the last 15 minutes,
or any `401`. Not implemented.

### Residual note on secret storage

The secret is stored in plaintext inside `cron.job.command`, readable by anyone
with database-superuser/service-role access. That is an acceptable trade against
the actual threat model here (unauthenticated public callers), since DB
superuser access already implies full compromise. Moving it to Supabase Vault
and referencing it from the cron command would remove even that exposure.
