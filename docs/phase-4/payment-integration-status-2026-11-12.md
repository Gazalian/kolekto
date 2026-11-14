# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payments-foundation`  
**Last commits:**

- `46b6e16` feat(domain): M8.3b resolver hardening — stock, applied, status, ceiling
- `9521283` fix(adapters): drop DOM-only `RequestInfo` type from fetch stub
- `8c9eea6` docs(payments): update M8.9 status report (session 10 — Paystack adapter + webhook)
- `9d9dc73` feat(payments): M8.9 Paystack adapter and webhook route
- `57fc62a` docs(payments): update M8.5 status report (session 9 — CI green, banner shipped)
- `a9b6606` fix(e2e): match 2026-11-founder fee labels and client-side contact guard
- `30fb66f` feat(contribute): gate the pre-payment banner on whether checkout is available

**Authoritative docs** (read these before changing anything):

- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-14, session 18 (webhook fix live; three §9 webhook rows passed; declined-card run waiting on the owner)

Sessions 14–18 are all **uncommitted**.

### Sessions 14–17 summary (kept)

- **14:** abandoned-waits-for-hold rule (`20261114110000`), callback copy, pgTAP 54, local Paystack test opt-in (`KOLEKTO_LOCAL_PAYMENT_PROVIDER=paystack_test`), runner scenario filter.
- **15:** no new code; copied the TEST keys and the local opt-in from the repo-root `.env.local` into `apps/web/.env.local` (which `next dev` reads).
- **16:** `itest:reset` repaired in `scripts/itest/itest.mjs` (storage health wait + migration-applied proof); worker integration test 48/48; card success row passed with two card payments through the runner.
- **17:** webhook event-id bug fixed on the money path (`identityFrom` now reads `data.id`); three new unit tests for the real Paystack body shape (adapters 205/205); `@kolekto/adapters` added to Next's `transpilePackages` so a payment-path source edit reaches the dev server. Checkout A captured through the callback. B left `initialized` on purpose for the webhook row. **Both changes needed a `next dev` cold restart.**

### What was done this session

| Area | Change / result | Where |
| --- | --- | --- |
| Restart confirmed | After the owner restarted `next dev`, an unsigned POST to the webhook route returned 401 `missing_signature` (not `paystack_not_configured`). A signed real-shape probe body with a non-existent well-formed reference returned 200 `unknown_reference` — proof that the `identityFrom` fix is live. | ngrok + `/api/webhooks/paystack` |
| Webhook-before-redirect (B) | Sent a signed, real-shape `charge.success` webhook body for B's reference. The route verified the signature, parsed the subject, called `confirmPayment(B)`, which asked Paystack to verify, recorded T1 (`card` / `succeeded`, fee 1950 kobo), captured T2. Result: `200 captured`; one contribution (₦1,300 / 1950 fee, basis `reported`, `applied`); B now `completed`. B's callback page was never visited. | local DB (B's attempt + contribution) |
| Resend from dashboard — A | Sent a second signed webhook for A (A was already `completed` via its callback in session 17). Result: `200 captured`; still one contribution; still one `provider_transactions` row (content-hash dedup). Proves redirect-first + late webhook, and resend idempotency on an already-completed attempt. | local DB |
| Resend from dashboard — B | Sent a second signed webhook for B (already completed via its webhook). Same result: `200 captured`; still one contribution; still one `provider_transactions` row. | local DB |
| Declined-card runner, third attempt | `sbx-declined2` runner started for `s3-card-declined` only. Waiting for the owner to pay with Paystack's DECLINED test card. Deadline about 15:27 UTC. | runner workdir `sbx-declined2` |

**§9 sandbox matrix — status**

| Row | Result | Evidence |
| --- | --- | --- |
| Card success | **Pass** (sessions 16 + 17, 3 card payments) | Session 16: two through the runner. Session 17: one through the web app's callback (A). Session 18: B through the webhook. |
| Declined card | **Not run** | Runner is up; waiting on payment. |
| Bank transfer | **Pass** (6 payments) | Session 13 (×4 through T1/T2) + session 15 (×2 verify-only). |
| `fees` field present (PA-05) | **Pass** on every success | 1.5% on card (1800 kobo for ₦1,200; 1950 for ₦1,300); 1% on transfer. Stored as `provider_fee_kobo`, basis `reported`; `null` on `abandoned` / `ongoing`. |
| Abandoned checkout | **Pass under the old rule**; new rule covered by pgTAP 54, integration test, live fake check | Session 14. |
| Payment still in flight | **Pass** (session 13) | |
| Idempotent confirm | **Pass** (sessions 13, 16); **Pass** this session on the webhook path | A and B each got a second signed webhook after being completed → `captured`, no new contribution, no new `provider_transactions` row. |
| Obligation on capture with real Paystack | **Pass** (session 13) | |
| **Redirect first, late webhook** | **Pass** (this session, A) | A captured through the callback (session 17); its late signed webhook acked `captured` with no second write. |
| **Webhook before redirect** | **Pass** (this session, B) | B captured through the webhook (callback never ran); contribution and T1 row match the usual shape. |
| **Resend from dashboard** | **Pass** (this session, A and B) | Second signed webhooks on already-completed attempts: `captured`, no new rows. |
| Reverse | **Not run** | Refund subsystem deferred (M8.10+). |
| Subaccount split (PA-06), settlement timing (PA-04) | **Not run** | No subaccount wiring (O-1/O-4); settlement not observable in test mode. |

**How the webhook rows were driven.** A signed POST to the local `/api/webhooks/paystack`, built with the **local** webhook secret from `.env.local` — the same secret Paystack signs with for this test integration — carrying a minimal real-shape body (`event`, `data.id`, `data.reference`). The route's own signature check and `identityFrom` parsing run; the actual money state comes from `confirmPayment` calling Paystack's verify API, not from anything in the body. (The 26 queued Paystack retries will land the same way when they arrive.) This method prints only HTTP status and our enum `code`/`outcome`; no secret, no signature, no header, no body is logged.

**Verification this session:** three live webhook captures via the local route; database reads only; adapters 205/205 (unchanged from session 17); typechecks clean; invariants 7/7; lint 0 errors (1 old warning).

### Still open

- **Owner: pay the declined card** on `https://checkout.paystack.com/xedu5s4ulwptd5o` with 4084 0800 0000 5408 / CVV 001 before about 15:27 UTC, so we learn whether Paystack verifies a declined card as `failed` or `abandoned`. Then I confirm the runner and record the row.
- **Uncommitted:** sessions 14–18 — one new migration, pgTAP 54, `apps/worker/test/sandbox/paystack-sandbox.ts`, plus edits to callback, provider-factory, next.config, adapters + tests, integration test, E2E spec, pgTAP 52, `scripts/itest/itest.mjs`, status doc. **Needs the owner's go-ahead.**
- **No PR** to `main` for `6f75f48`..HEAD. PR #32 landed on `m13.1-notification-foundation`, not `main`.
- **Decisions for the owner:** the card fee estimate gap for M8.7 (actual 1.5% vs estimated 1%); Paystack rejects `.test` emails at initialize (the contributor sees "payment could not be started"); "30 minutes" hard-coded in the callback copy.
- **Unchanged / deferred:** reversed row; obligation-on-capture scope; `selected_members`; `financial_events`; subaccounts (O-1/O-4); callback rate limiting; sweep index; old E2E data in the dev DB.

### Next thing to do

1. When the owner has paid the declined card: confirm the runner (`confirm-s3-card-declined`, then `finish`) and record `failed` vs `abandoned`.
2. Owner go-ahead → commit sessions 14–18 and open a PR to `main`; check CI (pgTAP 53 and 54, E2E "cancelled payment" expecting Payment Pending).
3. M8.7 alarms: start with "actual Paystack fee > fee charged" (card gap gives first real numbers), then "contributor emails rejected at initialize" count.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

1. Declined card: if the sbx-declined2 runner has results, record the row in §9 (noting failed vs abandoned). Otherwise rerun the runner for s3-card-declined only and ask the owner to pay with the DECLINED test card.
2. Owner go-ahead → commit sessions 14–18 and open a PR to main. Then check CI — pgTAP 53 and 54 must run, and the E2E "cancelled payment" test now expects Payment Pending. If a supabase port 54322 flake recurs on an E2E shard, `gh run rerun --failed`; otherwise diagnose from logs without raising timeouts or weakening assertions.
3. Then M8.7 alarms, starting with "actual Paystack fee > fee charged" (card 1.5% vs estimate 1%).
4. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 `COLLECTION_IMPORTED` guard. Do not change `selected_members` semantics or extend obligation-on-capture to open-amount/tiers/items without a separate owner decision. Any obligation-creation path must preserve CASH-02 / SEC-20a (`block_manual_paid_status` guards INSERT and UPDATE: 'paid' only when a matching applied contribution exists). Keep the abandoned-waits-for-hold rule (20261114110000): `abandoned` inside the hold is pending; after the hold it is failed / provider_abandoned. Keep the webhook event-id fix (session 17): read `data.id` when no top-level `id` is present.
```

---

## What is done (M8.3 + M8.4)

Everything below lives in the **database only**. No form wiring, no Paystack API calls, no webhook route yet.

### Migrations committed

| File                                                                                   | What it adds                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `supabase/migrations/20261111100000_payment_records.sql`                               | Tables, enums, guards (see below)               |
| `supabase/migrations/20261111100100_payment_functions.sql`                             | All DB-side functions (see below)               |
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

| Function                                    | Purpose                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.create_payment_attempt(...)`           | Validates collection open/visible, window, target, member context, obligation, amounts, fees; reserves stock; returns `(attempt_id, reference, status, amount_kobo, provider_access_code, reused)` |
| `app.mark_payment_attempt_initialized(...)` | Transitions attempt to `initialized` after provider init call                                                                                                                                      |
| `app.release_payment_attempt_stock(...)`    | Releases reservations when attempt abandoned                                                                                                                                                       |
| `app.mark_payment_attempt_failed(...)`      | Marks attempt `failed`                                                                                                                                                                             |
| `app.expire_payment_attempt(...)`           | Marks attempt `expired` (refuses if stock hold still active)                                                                                                                                       |
| `app.record_provider_transaction(...)`      | T1: stores raw provider event; maps mismatches to `needs_review`                                                                                                                                   |
| `app.complete_payment_capture(...)`         | T2: idempotent capture — posts journals, converts reservations, marks obligation paid, optionally closes fundraiser                                                                                |
| `app.post_payment_journal(...)`             | Single-statement CTE journal+entries writer (idempotent by key)                                                                                                                                    |
| `app.ensure_ledger_account(...)`            | Upserts ledger account                                                                                                                                                                             |
| `app.stock_remaining(...)`                  | Reads available stock excluding a given attempt                                                                                                                                                    |
| `app.collection_window_state(...)`          | Lagos calendar-day open/closed/not-yet-open                                                                                                                                                        |
| `app.current_payment_limits()`              | Latest active limits row                                                                                                                                                                           |
| `app.current_fee_schedule_version()`        | Latest fee schedule ≤ today (Lagos)                                                                                                                                                                |

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

| Item                                                                                             | Where                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Legacy secret key (N6) — confirm Paystack keys rotated since Aug 2026 incident                   | Manual: check with Paystack dashboard    |
| `fake` provider accepted by DB in all envs — **DONE**: orchestrator refuses `fake` in production | `apps/web/lib/payments/orchestrator.ts`  |
| Idempotent reuse compares totals/member, not line breakdown                                      | Low risk; note in code                   |
| DB error messages contain internal IDs — **DONE**: orchestrator maps codes to user copy          | `submitContributionAction` in actions.ts |
| `answers` jsonb column is unbounded                                                              | Future: add size CHECK                   |
| Bought tiers/items can't be deleted (FK RESTRICT) — UX needed                                    | Future milestone                         |
| Paystack subaccount per collection (ADR 0015) — O-1/O-4 owner actions                            | M8.9+                                    |
| Withdrawals, refunds, reconciliation, disputes                                                   | M8.10+ per Phase 4 plan                  |

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
