# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payments-foundation`  
**Last commits:**
- `30fb66f` feat(contribute): gate the pre-payment banner on whether checkout is available
- `b075e86` fix(e2e): wizard aria-label collision and payment-flow assertion drift
- `4ea3805` fix(db): store SES payload as JSON object, not double-encoded string
- `e8b4e10` docs(payments): update M8.5 status report (session 7)
- `925888c` fix(worker): use esbuild JS API in guard test for cross-platform compat
- `28e7469` ci: fix invariants and gitleaks false positive
- `f8710db` docs(payments): update M8.5 status report (sessions 5–6)

**Authoritative docs** (read these before changing anything):
- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-13, session 9 (CI run 6 green, PR #31 ready, banner shipped)

### What was done this session

| Area | Change | Where |
|---|---|---|
| SES payload fix | `${payloadJson}::jsonb` → `${payloadJson}::text::jsonb` so postgres.js with `prepare:false` stores a proper JSON object instead of a double-encoded JSON string. pgTAP 43 adds `jsonb_typeof(payload) = 'object'` (plan 39→40). | `packages/db/src/webhook-events.ts:93`, `supabase/tests/43_…_processing_state.sql` |
| E2E fix: progress bar | Removed `aria-label={entry.label}` from wizard progress `<li>` elements. The labels ("Items", "Fees"…) collided with form field labels, so `getByLabel("Item")` hit the progress indicator. `aria-current` already conveys step progress. | `NewCollectionForm.tsx:697` |
| E2E fix: fee schedule version | Estimate banner assertion bumped `2026-09-founder` → `2026-11-founder`. | `collection-creation.spec.ts:162` |
| E2E fix: fee labels + numbers | FeeEstimate was reskinned when SCHEDULE_2026_11_FOUNDER landed: labels are "Processing fee" + "Kolekto fee" (not the old "Estimated …" phrasings) and the rates are 1.5% + 0.5% (not 1.5% + 1.5%). On ₦20,000 that is ₦300 + ₦100 = ₦400; absorbing nets ₦19,600, passing on charges ₦20,400; the compounding counter-example moves to ₦20,408 (20,000 / 0.98). | `collection-creation.spec.ts:168-184` |
| E2E fix: validation msg | `"email address or a phone number"` → `"email address and phone number"` to match the updated `CONTACT_REQUIRED` message. | `collections.spec.ts:156` (first attempt) |
| E2E fix: client-side contact guard | The three contact fields carry HTML5 `required`, so Continue with empty fields triggers the browser's own form validation and nothing reaches the server. The assertion now checks that the browser focused the first invalid field (Full name) instead of expecting the server's `CONTACT_REQUIRED` copy, which can only fire on a bypass. The server-side message in `actions.ts` stays as defense-in-depth. | `collections.spec.ts:154-161` |
| E2E fix: payment heading | `"Ready to continue to payment"` → `getByRole("heading", { name: "Review and pay, Ada Obi" })`. The fake provider is available in CI (`KOLEKTO_ENV=local`), so the contributor reaches the payment review step. | `contributor.spec.ts:467` |
| Contributor banner shipped | Added `isPaymentEnabled()` to `provider-factory.ts` (thin wrapper over `getPaymentProvider`). Threaded a `paymentEnabled` boolean from the public page through `CollectionView` into `ContributeForm`. The banner now reads:<br>· on: "Fill in your details and you'll be able to review your total and pay securely online."<br>· off: "Online payment isn't available for this collection yet. You can fill in your details now — {organiser} will let you know how to pay."<br>Default is `false`, so preview mode and any caller that cannot promise online payment renders the safer copy. | `apps/web/lib/payments/provider-factory.ts`, `apps/web/app/[communitySlug]/[collectionSlug]/page.tsx`, `CollectionView.tsx`, `ContributeForm.tsx:758-768` |
| PR #31 | Marked **ready for review**. | https://github.com/Gazalian/kolekto/pull/31 |

**CI runs (cumulative):**

- **Runs 1–3:** invariants, gitleaks, esbuild failures — fixed in session 7.
- **Run 4:** invariants ✓, secrets ✓, typecheck+unit ✓, migrations+pgTAP ✓, E2E ✗ (progress bar / fee schedule / validation wording / payment heading).
- **Run 5:** session 8 fixes pushed; shard 2 green (6m39s), shard 1 ✗ on two more drifted assertions — `Estimated payment processing fee` label (old 1.5%/1.5% schedule) and server-side `email address and phone number` (blocked by client-side `required`).
- **Run 6: all seven checks green.** invariants (6s), secrets (35s), typecheck+unit (43s), migrations+pgTAP (3m20s), browser e2e shard 1 (13m8s), shard 2 (5m49s), browser e2e aggregate (4s).

### Why this update

Session 8 pushed what we thought were the four E2E fixes; run 5 then surfaced two more that had drifted when SCHEDULE_2026_11_FOUNDER landed and when `required` was added to the contact fields. The fee-estimate test still asserted the 2026-09 numbers (1.5% × 1.5%, ₦600 total, ₦19,400 / ₦20,600) under the old label names ("Estimated payment processing fee" / "Estimated Kolekto service fee"); the contact-required test still expected a server-side error message that the browser now short-circuits. Both are assertion drift, not behaviour drift, and the new assertions keep the same intent (two fees shown separately on the organiser's screen; a contributor with no contact details cannot submit).

The banner implementation follows the session 8 proposal. The gate is a server-side boolean because the form cannot derive it — `payment` state only exists after the server action responds, by which point the contributor has already filled in their details. `isPaymentEnabled()` is a thin convenience over `getPaymentProvider()` so render paths don't have to build the full `PaymentContext` just to decide what to say up front.

### Still open

- **M8.5 acceptance complete:** PR #31 is ready, CI is green on every job, and the seven-flow fake-checkout E2E (`payments.spec.ts`) passes under `KOLEKTO_ENV=local` in CI.
- Carried over (no change): the fake checkout is in memory; the sweep re-reads pending attempts every minute; `listDuePaymentAttempts` is not served by `payment_attempts_sweep_idx`; the callback action needs rate limiting before the real Paystack adapter (M8.9).

### Next thing to do

1. Review and merge PR #31, or wait for the owner review.
2. Start **M8.9 — Paystack adapter + sandbox**: `packages/adapters/src/paystack-payment-provider.ts` (initialize, verify), `apps/web/app/api/webhooks/paystack/route.ts` with dual-header signature verification, sandbox test matrix (card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend from dashboard, reversed, `fees` field present, subaccount split). Paystack test keys go in `.env.local` only.
3. Alongside M8.9 (or before), decide whether to run M8.3b (resolver hardening) and whether to add the sweep-idx hint on `listDuePaymentAttempts`.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

M8.5 is done and PR #31 is ready for review with CI green. Start M8.9 — the Paystack adapter and sandbox test matrix. Steps:

1. Confirm PR #31 is still green and not yet merged; if merged, rebase feat/payments-foundation onto main.
2. Build `packages/adapters/src/paystack-payment-provider.ts`: implement `initialize()` and `verify()` against the Paystack REST API, matching the `PaymentProvider` interface used by the fake adapter. Keep the shape of `ProviderResult` the orchestrator already handles.
3. Build `apps/web/app/api/webhooks/paystack/route.ts`: dual-header signature verification (`Paystack-Signature` HMAC + `whsec_`), raw body read, idempotent `recordProviderTransaction` + `completePaymentCapture` flow matching the fake path.
4. Update `provider-factory.ts` to pick Paystack when `KOLEKTO_ENV` is staging/production and the env has valid keys; keep the fake as the local provider.
5. Add a Paystack sandbox E2E (or a dedicated integration test) covering the test matrix: card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend from dashboard, reversed, `fees` field present, subaccount split.
6. No Paystack keys are committed. Document the env layout in `.env.example`.
7. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 `COLLECTION_IMPORTED` guard. Read the two migration files and `apps/web/lib/payments/orchestrator.ts` before writing the adapter.
```

---

## What is done (M8.3 + M8.4)

Everything below lives in the **database only**. No form wiring, no Paystack API calls, no webhook route yet.

### Migrations committed

| File | What it adds |
|---|---|
| `supabase/migrations/20261111100000_payment_records.sql` | Tables, enums, guards (see below) |
| `supabase/migrations/20261111100100_payment_functions.sql` | All DB-side functions (see below) |
| `supabase/migrations/20261110100000_update_collection_allows_draft_missing_amount.sql` | Allow draft collections without a target amount |

### Tables added (`_payment_records` migration)

- **`payment_limits`** — append-only config: `max_payment_kobo` ₦5,000,000 (500 000 000 kobo), `hold_minutes` 30, `check_window_hours` 24. Version `2026-11-launch`. Truncate-guarded.
- **`fee_schedules`** — versioned fee config. Gained `provider_cost_rate_bps` + `max_provider_cost_kobo`. Row `2026-11-founder`: platform 150 bps, gateway 0 (shown), Kolekto internal 100 bps capped ₦2 000.
- **`collections`** — gained `close_when_target_reached boolean default false` (must have target if true).
- **`contribution_intents`** — idempotency key per (collection, key). Stores contributor name, email (required), phone (required).
- **`payment_attempts`** — one live attempt per obligation (partial unique index). Reference `KLK-[26 chars]`. Frozen fee columns with arithmetic CHECKs. Status: `created → initialized → captured/failed/expired/needs_review → completed`.
- **`payment_attempt_lines`** — line breakdown per attempt.
- **`stock_reservations`** — holds tier/item stock during checkout. Status: `reserved → converted/released`.
- **`provider_transactions`** — append-only raw provider events. Unique on `(attempt_id, content_hash)`. Deny-all RLS (operator-session only).
- **`contributions`** — one per captured attempt. Unique on `attempt_id`.
- **`contribution_lines`** — per-tier/item contribution breakdown.

### Functions added (`_payment_functions` migration)

All functions use the operator-session idiom: `SECURITY DEFINER`, `set search_path = ''`, EXECUTE revoked from public/anon/authenticated, inner guard rejects non-operator calls.

| Function | Purpose |
|---|---|
| `app.create_payment_attempt(...)` | Validates collection open/visible, window, target, member context, obligation, amounts, fees; reserves stock; returns `(attempt_id, reference, status, amount_kobo, provider_access_code, reused)` |
| `app.mark_payment_attempt_initialized(...)` | Transitions attempt to `initialized` after provider init call |
| `app.release_payment_attempt_stock(...)` | Releases reservations when attempt abandoned |
| `app.mark_payment_attempt_failed(...)` | Marks attempt `failed` |
| `app.expire_payment_attempt(...)` | Marks attempt `expired` (refuses if stock hold still active) |
| `app.record_provider_transaction(...)` | T1: stores raw provider event; maps mismatches to `needs_review` |
| `app.complete_payment_capture(...)` | T2: idempotent capture — posts journals, converts reservations, marks obligation paid, optionally closes fundraiser |
| `app.post_payment_journal(...)` | Single-statement CTE journal+entries writer (idempotent by key) |
| `app.ensure_ledger_account(...)` | Upserts ledger account |
| `app.stock_remaining(...)` | Reads available stock excluding a given attempt |
| `app.collection_window_state(...)` | Lagos calendar-day open/closed/not-yet-open |
| `app.current_payment_limits()` | Latest active limits row |
| `app.current_fee_schedule_version()` | Latest fee schedule ≤ today (Lagos) |

### Fee model (decisions taken — D-11 through D-16, D-28)

- Kolekto shows: **1.5% processing + 0.5% platform** (both uncapped, payer-facing)
- Internal provider cost: **1% capped ₦2 000** (not shown to payer)
- Actual provider fee is authoritative over estimate (D-11); fee breakdown frozen on attempt creation (D-16)
- Error codes: the authoritative list is every `raise exception 'CODE:` in `20261111100100_payment_functions.sql` (e.g. `COLLECTION_NOT_ACTIVE`, `COLLECTION_NOT_YET_OPEN`, `COLLECTION_WINDOW_CLOSED`, `TARGET_REACHED`, `MEMBER_NOT_ELIGIBLE`, `SOLD_OUT`, `CHECKOUT_KEY_REUSED`, `UNKNOWN_PAYMENT_REFERENCE`). The contributor-facing copy is `CHECKOUT_ERROR_MESSAGES` in `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`. An earlier version of this list named codes the SQL never raises; grep the migration rather than trusting a copy.

### Security properties verified

- Operator-session guard: stray `SET ROLE authenticated` before calling any function → `FORBIDDEN`
- RLS enabled + forced on all payment tables
- `provider_transactions` deny-all RLS (officer select via `transaction.view` permission on other tables)
- Idempotency: unique index on `(collection_id, checkout_idempotency_key)` for intents; unique reference per attempt; content-hash dedup on provider events
- Imported-collection guard: `create_payment_attempt` refuses with `COLLECTION_IMPORTED`
- `complete_payment_capture` idempotent: second call with same attempt returns `already_paid` → `needs_review` (does not double-post)
- `block_manual_paid_status` trigger: `paid` status on obligation only allowed if a matching captured contribution exists

### Tests (pgTAP)

- `supabase/tests/52_payments.sql` — 76 tests, all green (plan(76); 76/76 pass)
- Updated: `01_rls_coverage.sql`, `02_grant_matrix.sql`, `03_money_invariants.sql`, `18_fee_configuration.sql`, `27_truncate_guards.sql`

### Contributor contact fields (committed earlier)

- `packages/validation/src/contribution.ts` — `contributorContactSchema` (name, email, phone all required)
- `apps/web/app/[communitySlug]/[collectionSlug]/ContributeForm.tsx` — Email + Phone fields added, both required, with hints

---

## What is NOT done yet

### M8.5 — Orchestrator + form wiring (IN PROGRESS)

#### Done (2026-11-12, session 2)

- **`packages/domain/src/payment-reference.ts`** — `KLK-` + 26 chars Crockford base32 from 128-bit random. `generatePaymentReference()` + `isPaymentReference()`. 7 tests pass.
- **`packages/db/src/payments.ts`** — typed callers for all payment DB functions via `withOwnerConnection`: `createPaymentAttempt`, `markPaymentAttemptInitialized`, `markPaymentAttemptFailed`, `expirePaymentAttempt`, `recordProviderTransaction`, `completePaymentCapture`. bigint values passed as strings with `::bigint` cast.
- **`apps/web/lib/payments/orchestrator.ts`** — `startCheckout()` (validates env, calculates fees, creates attempt, initializes provider, marks initialized/failed) and `confirmPayment()` (verifies with provider, T1 record_provider_transaction, T2 complete_payment_capture). Handles all ProviderResult outcomes. Refuses `fake` provider in production.
- **`apps/web/lib/payments/provider-factory.ts`** — returns `FakePaymentProvider` with `defaultScenario: "success"`. M8.9 replaces this with env-based Paystack selection.
- **`submitContributionAction`** wired — after existing validation (collection status, member context, contact, answers, tier/item resolution, attendee names), calls `startCheckout`. Returns `payment.checkoutUrl`, `payment.reference`, `payment.fees` (formatted naira strings). DB error codes mapped to user-facing messages.
- **Callback page** — `apps/web/app/[communitySlug]/[collectionSlug]/payment/callback/page.tsx` + `PaymentCallback.tsx` + `actions.ts`. Reads `?reference=` from redirect, calls `confirmPayment`, shows result.
- **TypeScript compiles clean** across domain, db, adapters, and web packages.

#### Still needed for M8.5 acceptance

- Worker sweep, fee review, local fake checkout and the seven-flow integration test: **built in session 4**. The integration test passes on the reset itest DB (session 5, 10/10).
- **E2E test** — all seven collection flows end-to-end, in CI

**Acceptance for M8.5:** full happy path + all seven collection flows work against `FakePaymentProvider`; E2E passes in CI.

### M8.9 — Paystack adapter + sandbox (after M8.5)

- `packages/adapters/src/paystack-payment-provider.ts` — real Paystack calls (initialize, verify)
- `apps/web/app/api/webhooks/paystack/route.ts` — webhook handler with dual-header signature verification (`Paystack-Signature` + `whsec_`)
- Sandbox test matrix: card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend from dashboard, reversed, `fees` field present, subaccount split
- **Paystack test keys needed** — stored in `.env.local` (never committed); `whsec_` for webhook verification

### M8.3b — Resolver hardening (can run alongside M8.5)

- Pure window check in `packages/domain/src/contribution.ts`
- Single-tier stock check
- `amountOwed − applied` calculation
- Ceiling check
- Status mapping including `reversed`
- Unit tests for the above

### Still open / deferred

| Item | Where |
|---|---|
| Legacy secret key (N6) — confirm Paystack keys rotated since Aug 2026 incident | Manual: check with Paystack dashboard |
| `fake` provider accepted by DB in all envs — **DONE**: orchestrator refuses `fake` in production | `apps/web/lib/payments/orchestrator.ts` |
| Idempotent reuse compares totals/member, not line breakdown | Low risk; note in code |
| DB error messages contain internal IDs — **DONE**: orchestrator maps codes to user copy | `submitContributionAction` in actions.ts |
| `answers` jsonb column is unbounded | Future: add size CHECK |
| Bought tiers/items can't be deleted (FK RESTRICT) — UX needed | Future milestone |
| Paystack subaccount per collection (ADR 0015) — O-1/O-4 owner actions | M8.9+ |
| Withdrawals, refunds, reconciliation, disputes | M8.10+ per Phase 4 plan |

---

## Key invariants the new code must respect

1. **Integer kobo everywhere.** `app.kobo` bigint domain. Never floats, never rounding without confirming the existing rule.
2. **Never multiply fee rates in SQL.** All rate arithmetic is in `packages/domain/src/fees.ts` (D-12). DB only stores pre-computed kobo amounts.
3. **Fee breakdown frozen at attempt creation** (D-16). Never recompute from live schedule after attempt exists.
4. **Actual provider fee authoritative** (D-11). Record the real `fees` field from Paystack verify response; don't use the estimate for the final journal.
5. **Operator-session for all money writes.** Use `withOwnerConnection` from `packages/db/src/client.ts`. Never call money functions from a Supabase client with `anon`/`authenticated` role.
6. **F5 — no collection takes money in both systems.** The `is_imported` flag blocks `create_payment_attempt`. Do not remove this guard.
7. **D-29 — Lagos calendar day.** Collection windows use Africa/Lagos timezone for start/end. `collection_window_state` handles this; don't reimplement it in TypeScript.
8. **D-30 — close on target.** `close_when_target_reached` is handled by `complete_payment_capture`; no extra check needed in the orchestrator.

---

## How to continue in a new session

1. Read [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) §4 (architecture), §5 (per-type blueprints), §10 (roadmap), §14 (decisions taken 2026-11-11).
2. Read [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — especially the "Built on 2026-11-11" section at the bottom.
3. Read the two migration files:
   - `supabase/migrations/20261111100000_payment_records.sql`
   - `supabase/migrations/20261111100100_payment_functions.sql`
4. The next thing to build is **M8.5 — the orchestrator layer** described above.
5. Branch is `feat/payments-foundation`. Docker + Supabase local stack needed to test; `supabase test db` for pgTAP.
