# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payment-receipts-alarms` (sessions 20–21, uncommitted; cut from `main`, which holds PR #33 merged 2026-11-14)  
**Last commits** (on `main` after the merge):

- `b99660d` Merge pull request #33 from Gazalian/feat/payments-foundation
- `92fe539` docs(payments): status after sessions 14-18
- `8f932bb` fix(itest): itest:reset waits for storage like itest:up
- `a868fc2` feat(payments): local Paystack test opt-in and sandbox runner
- `ae2c215` feat(payments): abandoned checkout waits for its hold
- `771a1a0` fix(adapters): read Paystack webhook id from data.id
- `4063739` docs(payments): correct session 12 status — PR #31 already merged
- `3668131` feat(payments): create member obligation on capture for all-members/groups
- `46b6e16` feat(domain): M8.3b resolver hardening — stock, applied, status, ceiling

**Authoritative docs** (read these before changing anything):

- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-17, session 24 (ledger settlement, withdrawals, reconciliation, reference lock, payment reminders on `feat/payment-receipts-alarms`; **uncommitted**, sessions 23 + 24 together)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**: two commits (sessions 20–22), then sessions 23 and 24 uncommitted on top. Not pushed, no PR. Nothing applied to staging or production. The local dev DB now has all seven 2026-11-17 migrations (owner ran into "Money and Reminders failing to load" on 2026-11-17; the cause was those six migrations not yet applied to the dev DB — ran `npx supabase migration up --local`, all additive, verified every new function returns rows for a real treasurer on a real collection).

Design, decisions, runbook, deployment and gaps: [`docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md`](../product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md). Owner decisions: `financial-decisions.md` §17.

### What was built (session 24), and why

| Area | What | Where |
| --- | --- | --- |
| Settlement (D-09) | Versioned immutable schedule (T+1 05:00 Lagos); one settlement row per capture with scheduled vs actual release; release only after the provider settlement is recorded; discrepancies held and audited; worker release stage every 5 min where its role may. | `20261117100000`, `20261117100100`, `apps/worker/src/settlement-release.ts` |
| Withdrawals | Request (locked balance check, hold journal, idempotent, last-4 only), owner approve / reject-with-reason, cancel, operator processing / paid / failed (failure releases hold). First withdrawal free; later refused until O-2 brackets. | `20261117100200` |
| Reads + reconciliation | Settlement summary, paged ledger (platform legs hidden), per-collection and platform reconciliation. | `20261117100300` |
| Reference lock | After any applied contribution: no switching codes on, no format change, no new tier prefix (DB-enforced, row-locked). Exact owner message in the UI. | `20261117100400`, `code-actions.ts`, `CodeSettingsPanel.tsx` |
| Payment reminders | Organiser-sent to unpaid members only: in-app + email (opt-out, community notice, pause switch honoured), 24 h cooldown, history, append-only. Worker fan-out + email template. | `20261117100500`, worker processor / rules / templates |
| Web | Money tab (settlement, withdrawals, ledger), Reminders tab, notification label. | `MoneyPanel.tsx`, `RemindersPanel.tsx`, `money-actions.ts`, `packages/db/src/collection-money.ts`, `lib/notification-display.ts` |

### Verification (session 24)

- `itest:reset` replayed all **139** migrations cleanly; full pgTAP suite as `postgres`: **62/62 files pass** (new: 57 settlement 44, 58 withdrawals 52, 59 reference lock 19, 60 reminders 33; 02/03/18/49/51 guardrails updated on the record). The session-23 failures 32/34/38 pass after the reset.
- Worker `npm test` **810/810**; web vitest **215/215**; web `tsc` clean; root `npm run typecheck` clean; eslint clean on changed web files; `npm run invariants` all seven hold.
- **Not verified:** the Money and Reminders tabs in a browser (dev DB lacks the six migrations); a two-session withdrawal race test; reminder email actually delivered (bulk caps are zero); Playwright E2E; the `security-review` skill was not run.

### Things to flag

- Nobody can withdraw until identity verification exists (`IDENTITY_VERIFICATION_REQUIRED`, DEC-04).
- Reminder emails defer and age out after 72 h while bulk email caps are zero; in-app works.
- The least-privilege worker role has no grant on `app.release_due_settlements`; release needs that grant or an operator call. Provider settlements must be recorded by operations (psql runbook in the product doc) until a settlement feed exists.
- Officers with `balance.view` can still SELECT ledger tables directly (pre-existing), exposing platform fee legs (D-28).
- Local dev DB QA officer `register-qa@example.test` from session 23 still exists.

### Still open

- Owner go-ahead to commit sessions 23 + 24, push, PR.
- Apply the six migrations to the local dev DB and browser-check Money / Reminders tabs.
- Two-session withdrawal concurrency test; Playwright E2E; security review.
- Refunds (D-31), recurring-collection reminders, settlement feed from Paystack.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms. Sessions 23 and 24 are UNCOMMITTED. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first", then docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md.

1. Ask the owner before committing. Check the diff for secrets. Suggested commits: session 23 (register), session 24 DB (six 20261117* migrations + tests 57–60 + guardrail test updates + itest.mjs), worker, web, docs.
2. Apply the six 20261117* migrations to the LOCAL dev DB only (supabase migration up --local), then browser-check the Money and Reminders tabs and the reference-lock banner at 375 px.
3. Run the security-review skill on the branch (payments, RLS, withdrawals).
4. Add a two-session concurrency test for request_withdrawal.
5. Ask the owner before pushing and opening a PR to main. Never apply to staging or production without explicit approval.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never compute money in the browser. Keep contact columns off by default in exports.
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
