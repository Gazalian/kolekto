# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payments-foundation`  
**Last commits:**
- `558610e` feat(payments): add payment records and capture functions
- `0d032b2` feat(collections): collection creation flow redesign (pre-existing work, now committed)

**Authoritative docs** (read these before changing anything):
- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-12, session 3 (M8.5 orchestrator defects fixed)

### What was done this session

Fixed defects 1–5 from the previous report, plus three more found while testing against the real SQL:

| # | Defect | Fix | Where |
|---|---|---|---|
| 1 | Non-tier/item collections sent a `lines` array → `LINES_NOT_EXPECTED` | `buildLines()` returns `null` unless the model is `tiers` or `items`; sends only `tier_id`/`item_id` + `quantity` | `apps/web/lib/payments/orchestrator.ts` |
| 2 | A `pending` verify marked the attempt failed and released stock | No state change for pending. T1 alone moves failed/abandoned. T2 result checked properly | same |
| 3 | Idempotency key used `Date.now()` and the email | Form generates `crypto.randomUUID()` once per checkout; server checks it is a UUID; key rotates only when the server returns `restartCheckout` | `ContributeForm.tsx`, `actions.ts` |
| 4 | Reused attempt returned the access code as the checkout URL | Reused `created`/`initialized` attempts re-run `initialize` with their own reference (idempotent). Reused `failed`/`expired` → "checkout ended"; reused `captured`/`completed`/`needs_review` → "already received" | `orchestrator.ts` |
| 5 | Callback URL could silently fall back to localhost | Built from `APP_BASE_URL`; localhost only when `KOLEKTO_ENV=local`; must be `https` elsewhere; checkout refused (before any attempt is created) if missing | `orchestrator.ts` |
| 7 | **jsonb was stored as a JSON string.** `${JSON.stringify(x)}::jsonb` makes postgres.js encode the string a second time. `answers`, `lines` and the provider `payload` were affected; tier and item checkouts could never create an attempt | Pass as `::text::jsonb` | `packages/db/src/payments.ts` |
| 8 | Error-code map used names the SQL never raises (`COLLECTION_INACTIVE`, `TARGET_ALREADY_REACHED`, `STOCK_EXHAUSTED`…); the fallback showed raw DB messages with internal ids | Rebuilt the map from the codes actually raised in `20261111100100`; unmapped codes show a generic message and log the code only | `actions.ts` |
| 9 | T1 raises `UNKNOWN_PAYMENT_REFERENCE`, not `ATTEMPT_NOT_FOUND`; a refused verify was shown as "failed"; T1 errors returned `attemptId: ""` | Correct code; new `error` outcome; callback page handles it | `orchestrator.ts`, `payment/callback/*` |

Also: the callback action now accepts only a well-formed `KLK-` reference (`isPaymentReference`).

**Checks run**

- TypeScript: domain, config, db, adapters and web all pass.
- Domain unit tests: 216 of 216 pass.
- **Rollback-only probe against the local dev DB (127.0.0.1:54322).** It sends the exact SQL from `payments.ts` through create → mark initialized → T1 → T2 → T2 again, for `tiers`, `fixed` and `open_amount` collections. Each type covers success, pending and amount mismatch: 9 of 9 behave as designed. Success completes with one contribution and a repeat T2 returns the same contribution. Pending stays `initialized`. Mismatch goes to `needs_review(amount_mismatch)`. Every case ran in a transaction that was rolled back; 0 rows were left behind. Local data has only one open public collection (a tier collection), so `fixed` and `open_amount` were tested by temporarily switching that collection's model inside the rolled-back transaction. The probe script is in the session scratchpad and is not in the repo.

**Not verified**

- The orchestrator TypeScript itself has not been executed, only typechecked; the probe used the same SQL, not the TS functions.
- `items`, `per_member`, and member (managed/recurring) collections have not been run against the DB.
- No committed integration or E2E test exists yet.
- `supabase test db` (pgTAP) was not re-run; no SQL changed this session.
- The form change (checkout key) was not tried in a browser. `crypto.randomUUID()` needs a secure context: it works on `localhost` and `https`, but not over plain-HTTP LAN addresses such as testing from a phone at `http://192.168.x.x`.

**Committed, not pushed:** `ee09b40 feat(payments): wire checkout orchestrator to fake provider` on `feat/payments-foundation`. The pre-existing `layout.tsx` hydration change went in separately as `1bf9ed2`.

### Why this update

The previous report listed six defects in the first pass. Five are now fixed and checked against the real SQL. That check also found the jsonb double-encoding bug, which typecheck could not catch and which blocked every tier and item checkout.

### Still open

- **Defect 6 (unchanged): a submit now creates an attempt and holds stock, but the contributor cannot pay yet.** The form still shows the old summary and does not redirect to `checkoutUrl`, and nothing expires old attempts. Safe on a local branch; do not deploy this to staging until the redirect UI and the worker sweep exist.
- **The fake provider's checkout URL goes nowhere.** It points at `fake-provider.invalid` by design, so the "E2E with FakePaymentProvider" acceptance needs some local-only way to finish a fake checkout and land on the callback page. Check the plan (§4.3, §10 M8.5) for the intended approach before building one.
- **Possible same jsonb bug outside payments (not verified):** `packages/db/src/webhook-events.ts:93` (SES ingest) uses the same `${payloadJson}::jsonb` pattern, so SES event payloads may be stored as JSON strings. Check with `select jsonb_typeof(payload)` on that table.
- The public callback action calls `provider.verify` on every request with a valid-looking reference. That is harmless for the fake, but it needs rate limiting before the real Paystack adapter (M8.9).

### Next thing to do

**Make the fake flow usable end to end, then lock it in with tests:**

1. Form: show the fee breakdown returned in `payment.fees` (frozen at attempt creation — never recompute in the browser), then send the contributor to `checkoutUrl`.
2. A local/staging-only fake checkout step (refused in production) that finishes the payment for a chosen fake scenario and redirects to `/{community}/{collection}/payment/callback?reference=…`.
3. Worker sweep: expire `created`/`initialized` attempts after `hold_expires_at`, and verify them before giving up (D-27).
4. A committed integration test against the **itest** DB (port 55422, not the dev DB) that calls `startCheckout` + `confirmPayment` for all seven collection types and the pending, payment_failed, abandoned and amount_mismatch scenarios.

### Prompt for the next session (copy and paste)

```
Continue M8.5 on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first", and the plan's §4.3 and §10 (M8.5) in docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md.

1. ContributeForm: after submitContributionAction returns `payment`, show the fee breakdown from `payment.fees` (never recompute fees client-side), with a Pay button that sends the contributor to `payment.checkoutUrl`. Keep the existing summary content.
2. Fake checkout: FakePaymentProvider's checkoutUrl points at fake-provider.invalid. Find what the plan intends for finishing a fake checkout locally; if it says nothing, propose a local/staging-only page (refused when KOLEKTO_ENV=production) and ask me before building it.
3. Worker sweep in apps/worker: expire created/initialized attempts past hold_expires_at via app.expire_payment_attempt, verifying with the provider first (a timeout is not a failure, D-27).
4. Integration test against the itest database (port 55422, never the dev DB on 54322) that runs startCheckout + confirmPayment with FakePaymentProvider for all seven collection types plus pending, payment_failed, abandoned and amount_mismatch. Assert attempt status, contribution row, stock reservation and obligation status.
5. Check whether packages/db/src/webhook-events.ts stores SES payloads as JSON strings (same ::jsonb double-encoding bug fixed in payments.ts). Report only; do not fix without asking.
6. Run typecheck, domain tests, the new integration test and supabase test db. Report what passed and what was not run.
7. Replace the "Latest report" section of the status doc: what was done, why, what is still open, the next thing to do, and the next prompt.
Do not commit until I say so.
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

- **Worker sweep** — expires stale attempts (call `expire_payment_attempt` for attempts older than `hold_minutes`); processes outbox events
- **Fee review UI** — show fee line breakdown to contributor before confirming (data is returned, UI not yet rendered)
- **Fee line display on confirmation** — render frozen fee breakdown from attempt; must not recompute client-side
- **Integration test** — full happy path against FakePaymentProvider with a real local DB
- **E2E test** — all seven collection flows end-to-end

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
