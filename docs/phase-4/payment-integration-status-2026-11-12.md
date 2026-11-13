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

**Last updated:** 2026-11-12, session 6 (stale E2E assertions updated, payments E2E built and run locally)

### What was done this session

| Area | Change | Where |
|---|---|---|
| Shared review check | New `expectPaymentReview(page, { contributorName, contribution })`: the heading "Review and pay, {name}", the Contribution row equals the resolved amount, and either Contribution + Processing fee + Kolekto fee = Total to pay (fees above zero) or, when the community covers the fees, Total = Contribution and "… covers the payment fees". Ends by checking the only way on is an enabled `Pay {total}` button and no "Payment Successful" anywhere — the old "Nothing has been charged" guarantee, now stated against the real screen. | `tests/e2e/helpers/payments.ts` |
| Stale assertions updated | The five listed assertions now use `expectPaymentReview`. Also found and updated: three clicks on "Back to the form" in `collection-types.spec.ts` (the button is "Edit" when a payment is offered) and `contributor.spec.ts`'s "Ready to continue to payment", which `5c42527` also removed. No check was dropped: each spec still asserts the amount, and now also the fee arithmetic and the Pay button. | `collection-types.spec.ts` (fundraiser, items), `collections.spec.ts` (managed fixed), `contributor.spec.ts` (managed fixed) |
| Payments E2E | `tests/e2e/payments.spec.ts`, 9 tests. Seven flows (fixed, open, tiered, items, ticketing, fundraiser, recurring), each signed out: public page → order (member lookup for fixed and recurring) → Continue → review → `Pay ₦…` → fake checkout → "Pay successfully" → callback "Payment Successful". The DB is checked before paying (attempt `initialized`, frozen contribution/total/fees equal what the page showed, fee bearer, obligation, stock `reserved`, no contribution) and after (attempt `completed`, exactly one contribution with the frozen amounts and member, line count, stock `converted`, obligation `paid`, attendee names). A reload of the callback still shows success with the same single contribution. Plus "Card declined" and "Cancel payment" on the items flow: callback "Payment Failed", attempt `failed`, no contribution, stock `released`. | `tests/e2e/payments.spec.ts` |
| Seeding | `seedPaymentFlow(name)` runs the integration lane's own `seedPaymentCommunity` / `seedFlow` (imported, not copied) in a transaction that commits, over the local superuser connection. It refuses any non-loopback database. Every seed is a new community with `e2e-pay-…` slugs; no teardown. | `tests/e2e/helpers/payments.ts` |
| CI | **No change.** The existing `e2e` job already has `KOLEKTO_ENV=local`, `next start` (one process, so the in-memory fake is shared), the DB URL and two shards; Playwright picks up the new file. | `.github/workflows/ci.yml` (unchanged) |
| SES payload | **Not touched.** The prompt left "fix it / leave it" unanswered, so nothing was changed. | `packages/db/src/webhook-events.ts:93` |

**Local runs of `payments.spec.ts`** (`--retries=0`; the CI config uses `retries: 1`)

| Run | Result |
|---|---|
| 1 | Did not start: Playwright's `webServer` (`next build && next start`) exceeded its 180 s limit on this machine. I then built `apps/web` separately (`NEXT_DIST_DIR=.next-e2e`) and started it on 3010 so Playwright reused it. |
| 2 (cold server) | 6/9 pass. fixed (60 s test timeout), open and recurring failed. |
| 3 (only those three) | 3/3 pass. |
| 4 (full spec, warm) | 8/9 pass. items failed (it passed in run 2). |

**Every one of the 9 tests has passed at least once; no single local run was 9/9.** Every failure had the same shape: a server action (`submitContributionAction` on Continue, and in one case `confirmMemberAction` on "Yes, this is me", which is not payment code) stayed pending for more than 30 s. The trace shows that POST never answered while every other request finished in under a second, there was no error banner, and the server log was empty. This is the documented QA-ENV-01 stall (`docs/product/QA-ENV-01-BROWSER-E2E-BLOCKER.md`: intermittent server-action stalls on this machine, every dependency healthy). Timeouts were **not** raised to hide it. CI is the authority.

**Checks run**

- `tsc --noEmit` (temporary config on `tsconfig.base.json`) over `payments.spec.ts`, `helpers/payments.ts` and the three edited specs: clean. `tests/e2e` has no ESLint config, so lint does not apply there.
- `next build` of `apps/web`: passes.
- Payments spec: as in the table above.

**Not verified**

- **The three edited existing specs were not run.** They sign up through OTP and the wizard, which is the flow QA-ENV-01 stalls. They type-check, and their review assertions use the same helper the payments spec proved, but the first green run will be in CI.
- No CI run yet (nothing pushed).
- Local runs **committed rows to the local dev DB**: 21 `e2e-pay-…` communities with their collections, attempts and contributions. They are test data on the local stack only.

**Nothing committed.** Uncommitted from session 5: the M13.3 integration test fix and the status doc. New this session: `tests/e2e/payments.spec.ts`, `tests/e2e/helpers/payments.ts`, and edits to `collection-types.spec.ts`, `collections.spec.ts`, `contributor.spec.ts`.

### Why this update

M8.5's acceptance is "all seven collection flows work against the fake provider; E2E passes in CI". The flows were proven at the database level in session 5. This session drives them through a real browser and the real fake checkout page, and repairs the existing suite that `5c42527` would otherwise have turned red.

### Still open

- **CI evidence for M8.5:** push the branch and get the `browser e2e` job green (both shards), including the edited specs.
- **Stale contributor banner (found, not fixed):** under the form, `ContributeForm.tsx:758` still says "Online payment for this collection is not open yet. You can check your details now; … will confirm how to pay." This now shows even when the form leads to Pay. It needs product copy for the payment-on and payment-off cases. Not asked for, so not changed.
- **SES payload stored as a JSON string** (`webhook-events.ts:93`) — still needs your decision.
- **Local E2E harness:** `webServer.timeout` (180 s) is shorter than `next build` on this machine. Not changed; build and start separately as above.
- Carried over: the fake checkout is in memory; the sweep re-reads pending attempts every minute; `listDuePaymentAttempts` is not served by `payment_attempts_sweep_idx`; the callback action needs rate limiting before the real Paystack adapter (M8.9).

### Next thing to do

1. Review this session's changes and commit (with session 5's).
2. Push and read the `browser e2e` result for both shards. If something fails there, fix the cause, not the timeout.
3. Decide on the SES payload fix and the contributor banner copy.
4. Then M8.5 can be closed and M8.9 (Paystack adapter) started.

### Prompt for the next session (copy and paste)

```
Continue M8.5 on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

1. Commit the uncommitted work from sessions 5 and 6 (M13.3 integration test fix, payments E2E spec and helper, the three updated E2E specs, status doc) in sensible commits. Show me the messages first.
2. Push the branch and open a draft PR to main. Read the `browser e2e` result for both shards and the other CI jobs. If anything fails, find the cause from the logs and artifacts and fix it. Do not raise timeouts or weaken assertions.
3. SES payload: [say "fix it" or "leave it"]. If fixing, change packages/db/src/webhook-events.ts:93 to `::text::jsonb` and add a test that asserts jsonb_typeof(payload) = 'object'.
4. Contributor banner: propose copy for ContributeForm.tsx:758 for when online payment is on and when it is off. Do not change it yet.
5. Replace the "Latest report" section of the status doc: what was done, why, what is still open, the next thing to do, and the next prompt.
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
