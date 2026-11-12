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

**Last updated:** 2026-11-12, session 4 (M8.5 fake flow end to end + seven-flow integration test)

### What was done this session

| Area | Change | Where |
|---|---|---|
| Shared package | New `@kolekto/payments`: the orchestrator moved out of `apps/web` so the web app, the worker and the tests run the same code. It no longer reads `process.env` or opens a connection: the caller passes a `PaymentDb` executor, the environment and the app origin. | `packages/payments/src/{orchestrator,sweep,index}.ts` |
| DB callers | Every payment caller takes a `PaymentDb` first (`ownerPaymentDb` on the web; `sql.begin` in the worker; a savepoint in tests). New `listDuePaymentAttempts(db, provider, limit)` for the sweep. | `packages/db/src/payments.ts` |
| Fee review + redirect | After Continue, the form shows Contribution, Processing fee, Kolekto fee and Total to pay (all server-formatted, frozen on the attempt) and a `Pay ₦…` button that goes to `checkoutUrl`. When the community absorbs fees, only the total shows, with "… covers the payment fees". Edit returns to the form and rotates the checkout key. | `ContributeForm.tsx`, `actions.ts` (`feesAddedToTotal`) |
| Local fake checkout | `/{community}/{collection}/payment/fake-checkout?reference=` — 404 unless `KOLEKTO_ENV=local`. Buttons: Pay successfully / Card declined / Cancel payment. It tells the in-memory fake how the payment ended, then redirects to the callback path (path only, never an absolute URL, so it cannot be used as an open redirect). The fake provider is one instance per process (`globalThis`), default scenario `pending`, and `getPaymentProvider()` returns null outside local. | `payment/fake-checkout/{page,actions}.ts(x)`, `lib/payments/provider-factory.ts`, `FakePaymentProvider.checkoutFor/completeCheckout` |
| Worker sweep | Every 60 s: captured-but-not-completed → T2 again; created/initialized past hold → ask the provider: success/failed/abandoned recorded (T1, then T2 on success), pending kept until the 24 h check window then expired, "not found" expired, no answer left alone (D-27). One attempt's error never stops the run. **On only when** `KOLEKTO_ENV=local` and the role can execute the payment functions and read `payment_attempts` through forced RLS; it logs `payment_sweep_state` with the reason when off. Never fatal to the notification stages. | `packages/payments/src/sweep.ts`, `apps/worker/src/payment-sweep.ts`, `apps/worker/src/index.ts` |
| **Bug fixed: card authorization stored raw** | T1 passed the provider's `authorizationReference` (a reusable charge token) as `authorization_hash`. The DB check (`^[a-f0-9]{64}$`) rejected it, so **every successful fake payment failed to record**. Now SHA-256 hashed in one place, `providerStatement()`, used by every caller (O-12). | `packages/payments/src/orchestrator.ts` |
| **Bug fixed: contributors sent to /login** | The session middleware only treated `/{community}/{collection}` as public, so the callback page (and the new fake checkout) redirected a signed-out contributor to sign in. Added `isPublicPaymentPath` for exactly `/payment/callback` and `/payment/fake-checkout` under a collection, with tests. | `apps/web/lib/supabase/middleware.ts` (+ test) |
| Lint | Callback component no longer calls setState inside its effect (initial state derived from the reference). | `PaymentCallback.tsx` |
| Integration test | `payments-orchestrator.integration.test.ts` (11th lane file): all seven flows (fixed dues, open amount, tiered, items, ticketing, fundraiser, recurring) go checkout → pending callback → fake success → completed, asserting the frozen amounts, stock reserved → converted, obligation paid (fixed, recurring), attendee names (ticketing), contribution lines, and a repeat callback returning the same contribution. Plus declined / abandoned / amount mismatch / verify timeout, checkout-key reuse, and the sweep finishing a capture whose T2 never ran while leaving held attempts alone. Fixtures in `test/support/itest-payment-flows.ts`. | `apps/worker/test/integration/`, `itest-lane.ts` manifest, `itest-gate.test.ts` (count 10 → 11) |
| Sweep unit tests | The time-dependent branches (expire, past check window) cannot happen inside one rolled-back transaction (the hold end is frozen and `now()` does not move), so they are unit-tested with a scripted DB: 8 tests. | `packages/payments/test/sweep.test.ts` |

**Checks run**

- `tsc --build` for the whole monorepo: pass. Web `tsc --noEmit`: pass. ESLint on every changed web file: pass. Worker `esbuild` bundle: builds.
- Unit tests: domain 216/216, adapters 165/165 (4 new for the fake checkout), db 6/6, payments 8/8, worker 778/778 (includes the lane's static guards against the new file), web middleware 17/17 (2 new).
- **The new integration file's exact assertions against the local dev DB**, through a scratch shim that replaces only the gate, harness and connection (every test rolled back, 0 rows left): **10 of 10 pass**. This is how the authorization-hash bug was found.
- **Browser, signed out, on the local dev server (port 3000):** tier event "Founders Breakfast 2026" → Continue → review showed ₦15,000 + ₦225 + ₦75 = ₦15,300 → Pay → fake checkout → Pay successfully → callback "Payment Successful". The DB confirms the attempt is `completed`, with one contribution and the authorization stored as a 64-character hash. This run **committed real rows to the local dev DB** (one completed attempt and contribution, plus one abandoned `initialized` attempt from a first try, which the sweep will expire).
- Worker sweep gate against the dev DB: enabled for `local`; disabled for `staging` with `no_real_payment_provider_until_m8_9`.

**Not verified**

- **The integration lane itself has not run the new file.** The itest database (port 55422) stops at migration `20261029100100`; it has no payment tables or functions. It needs `npm run itest:reset -- --confirm-reset-kolekto-itest`, which wipes the itest stack, rotates its credentials and removes the `kolekto_itest_worker` role (recreate it with `npm run itest:worker-role`; the worker-runtime files also need `npm run itest:net-lockdown` again). That needs your approval.
- The worker loop was not started; its sweep tick was typechecked, bundled and its gate probed, but not run live.
- `supabase test db` (pgTAP) was not re-run; no SQL changed.
- No browser run of the Card declined / Cancel payment buttons, or of a fixed or managed collection (these are covered by the integration assertions, not by a browser).
- No E2E (Playwright) test in CI yet — this is part of the M8.5 acceptance.

**Committed, not pushed** on `feat/payments-foundation` (see `git log`).

### Why this update

The previous session left a checkout that created an attempt and held stock, with no way to pay or release it. This session closes that loop locally — review, pay, return, capture, and a sweep for anyone who never returns — and pins all seven collection types with a committed integration test. Running that test's assertions against the real SQL found a bug that would have failed every successful payment.

### Still open

- **Run the lane on a reset itest DB** (approval needed, see above).
- **The fake checkout is in memory.** Restarting the dev server loses open fake checkouts (the page says so). The worker's own fake knows none of the web app's checkouts, so locally the sweep expires any attempt past its 30-minute hold. A success reported later for an expired attempt goes to `needs_review` — never lost, but not automatic.
- The sweep re-reads pending attempts every minute until their 24 h window ends (it writes nothing for them). Fine at local volume; revisit with real Paystack volume.
- `listDuePaymentAttempts` filters on provider, status and `hold_expires_at`; the existing sweep index (`payment_attempts_sweep_idx`) is on `check_until`. Fine locally; check before production volume.
- Unchanged from before: possible jsonb double-encoding in `packages/db/src/webhook-events.ts:93` (SES ingest, not verified); the callback action needs rate limiting before the real Paystack adapter (M8.9).
- E2E (Playwright) for the seven flows in CI, for the M8.5 acceptance.

### Next thing to do

1. **Approve and run the itest reset**, then run the lane with `--without-smtp` and confirm the new file passes there. So far it has only been proven against the dev DB through a shim.
2. Then the Playwright E2E for the seven flows against the fake checkout page, to close M8.5's "E2E in CI" acceptance.

### Prompt for the next session (copy and paste)

```
Continue M8.5 on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

1. I approve resetting the integration-test stack. Run `npm run itest:reset -- --confirm-reset-kolekto-itest`, then `npm run itest:worker-role` (and `npm run itest:net-lockdown` if you will run the worker-runtime files). Confirm the itest DB now has public.payment_attempts and app.complete_payment_capture.
2. In apps/worker run `npm run test:integration -- --without-smtp`. Report every file's result, especially payments-orchestrator.integration.test.ts. If it fails, fix the cause (do not weaken assertions) and re-run.
3. Check whether packages/db/src/webhook-events.ts stores SES payloads as JSON strings (select jsonb_typeof(payload) on the local dev DB). Report only; do not fix without asking.
4. Propose (do not build yet) the Playwright E2E for the seven collection flows through the local fake checkout page, and how it runs in CI.
5. Replace the "Latest report" section of the status doc: what was done, why, what is still open, the next thing to do, and the next prompt.
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

- Worker sweep, fee review, local fake checkout and the seven-flow integration test: **built in session 4** (see Latest report). The integration test still has to pass on the reset itest DB.
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
