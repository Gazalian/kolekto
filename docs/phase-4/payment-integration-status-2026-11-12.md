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

**Last updated:** 2026-11-16, session 22 (callback bug fix + UI polish + worker started + email investigation on `feat/payment-receipts-alarms`; **uncommitted**)

### Where the work stands

`main` holds sessions 14–19 (PR #33, merged 2026-11-14). Sessions 20–22 work on branch **`feat/payment-receipts-alarms`** (cut from `origin/main`). Nothing is committed or pushed yet. The new migration `20261116100000` is applied on both the **itest** stack (all 131 migrations, pgTAP 57/57 files green) and the **local dev DB**. The receipt page, receipt PDF and callback receipt are browser-verified on the local dev DB.

**Session 22 added:** Callback bug fix (Paystack double-reference), callback + receipt UI redesign, worker started (11 emails sent to Mailpit), and two open bugs found — receipt rate-limited and missing checkout link in "payment started" email. See details below.

### What was built (sessions 20–21), and why

| Area | What | Why | Where |
| --- | --- | --- | --- |
| Payment events → audit → queue | New trigger `payment_attempts_audit_transition` writes `payment.initialized` (created → initialized) and `payment.failed` (initialized → failed / expired). `payment.captured` and `payment.needs_review` were already audited by T2. All four joined the notification trigger's `c_watched` (not suppressible). An attempt that never reached a checkout (refused / unanswered initialize) produces no event. | Plan §4.7 step 8: receipts go through the notification outbox, never an HTTP hop (legacy L2/L7). A trigger avoids re-creating the large payment functions. | `supabase/migrations/20261116100000_payment_notifications_receipt_fee_alarm.sql` |
| Policy | The four payment events are **essential** (transaction message about the recipient's own payment, sent to the address they typed for it). The `payment` category (targeted "you still owe" reminders) is **unchanged and still blocked** until payment attribution is approved (M13.3 R0 decision 7). Same rows added to the SQL map `app.communication_category_for_event`. New email fan-out kind `payer`. | Receipts must always send; they are not reminders. | `apps/worker/src/communication-policy.ts`, migration §1c |
| Worker: payer emails | `notification-payment.ts`: for each payment event, one notification event (payload: names, slugs, KLK reference, amounts as kobo digit strings, payer name — never the address) and **one** email delivery to the payer's address (`unverified_supplied`, `transactional`, `essential`, dedupe `receipt:` / `payment_started:` / `payment_review:` / `payment_failed:` + attempt id). Facts come from new SECURITY DEFINER `app.payment_notification_context(uuid)`; feature-detected, so a worker without the grant records the event and writes no email row. Invalid address → `skipped / invalid_recipient_address`. | Payer gets: "payment started", the receipt, "received, under review", "not completed". | `apps/worker/src/notification-payment.ts`, `notification-processor.ts` (branch before the member path) |
| Email templates | Four payer templates (HTML + text, all values escaped, naira from integer kobo). Receipt lists contribution, processing fee, Kolekto fee (only when the contributor paid fees), total, date, channel, reference, and links to the receipt page. "Failed" never claims money was taken; "started" says no money is taken unless completed. | | `apps/worker/src/notification-email-templates.ts` |
| Receipt read | `app.payment_receipt(reference)` → jsonb for **completed** payments only; email masked (`a***@domain`), phone never returned; lines by tier/item name. Server connection only (revoked from anon/authenticated + session guard). | The KLK reference (128 random bits) is the bearer secret; the payer holds it via the Paystack redirect and the receipt email. | migration §3, `packages/db/src/payments.ts` `getPaymentReceipt` |
| Callback page | On `completed` shows the receipt inline with **Download receipt (PDF)**. On `pending` polls every 3 s up to ~60 s (plan §5.9), then "not confirmed yet — we will email your receipt; do not pay again". Heading texts unchanged so existing E2E stays valid. | Owner request: the page loads the receipt after a successful Paystack payment. | `apps/web/app/[communitySlug]/[collectionSlug]/payment/callback/*` |
| Receipt page + PDF | `/{community}/{collection}/payment/receipt?reference=KLK-…` (DB read only, never calls Paystack; 404 unless completed and the slugs are the payment's own; `noindex`). PDF at `…/payment/receipt/pdf?reference=…` (pdf-lib + embedded DejaVu, `Cache-Control: private, no-store`). One formatter (`receipt-format.ts`) feeds page, PDF and tests, so they cannot disagree. | | `apps/web/app/[communitySlug]/[collectionSlug]/payment/receipt/*`, `apps/web/lib/payments/receipt*.ts`, `apps/web/lib/pdf/receipt.ts` (`drawable`/`loadFont` now exported from `report.ts`) |
| Middleware: public receipt | Added `receipt` to `PUBLIC_PAYMENT_PAGES` and the 5-segment `receipt/pdf` path to `isPublicPaymentPath`. Without this the receipt and PDF redirected to login — wrong, because the contributor has no account; the KLK reference is the bearer secret. | Session 21 fix: a contributor following the receipt email link or the callback "Download PDF" was bounced to login. | `apps/web/lib/supabase/middleware.ts`, `middleware.test.ts` |
| **M8.7 alarm 1** | `app.payment_fee_alarms(since)` over **real contributions** with `provider_fee_basis = 'reported'`: `provider_fee_exceeds_fee_charged` (reported fee > total fees Kolekto charged — a loss, **critical**) and `provider_fee_exceeds_estimate` (reported fee > attempt's internal 1% estimate — the sandbox's 1.5% card, **warning**), with `overrun_kobo`. Estimated fees never alarm. Worker checks every 15 min over a 24 h window and logs one `{"msg":"payment_fee_alarm",…}` line per alarm kind (counts and kobo totals only; no reference/name/email). Runs only where the role may execute the function. | Alarm on actual money, not on estimates. On today's D-28 schedule (2% charged), a 1.5% card fee fires the **warning** only; a **critical** needs a provider fee above 2%. | migration §4, `apps/worker/src/payment-fee-alarm.ts`, `apps/worker/src/index.ts` |
| itest | `app.payment_notification_context(uuid)` added to the itest worker role's grants. | Mirrors the production grant the worker needs. | `scripts/itest/itest.mjs` |

### Verification (sessions 20–21)

- Typecheck: `tsc --build` (all packages + web + worker) clean; `apps/web` `tsc --noEmit` clean.
- Worker unit: **794/794** (new `notification-payment.test.ts`: policy, dedupe, payload never carries the address, templates, fee-alarm summary). Policy/rules/parity tests updated for the four new events.
- Web unit (vitest): **201/201** (new `receipt-format.test.ts` + new middleware receipt/PDF assertions). Payments 8/8, db 6/6.
- Invariants **7/7** (watched list = worker list). Lint 0 errors (1 old warning).
- **itest:** `itest:reset` replayed all 131 migrations; **pgTAP 57/57 files** green including new **55** (25 assertions: audits + queue, no event for a never-initialized attempt, essential map, receipt redaction/state, notification context, fee alarms by kind and overrun, no client EXECUTE) and 52–54 unchanged. Worker integration lane (no SMTP) **49/49**, including a new case: real checkout → capture → audit rows → `processNotificationMessage` twice → exactly two pending payer emails with the right dedupe keys, no address in the payload, receipt link rendered, `payment_receipt` readable.
- **Local dev DB:** migration `20261116100000` applied. **Browser verified** on `localhost:3001`:
  - Receipt page (`/the-big-one/open-test/payment/receipt?reference=KLK-…`): renders with all fields (reference, date, payer, masked email, channel, item lines, fee breakdown, total, download link). Wrong-collection slug returns 404.
  - Receipt PDF (`/…/payment/receipt/pdf?reference=…`): HTTP 200, `application/pdf`, 20 KB, starts with `%PDF-1.7`.
  - Callback page (`/…/payment/callback?reference=…`): polls, then shows "Payment Successful" with the full receipt inline and the PDF download link. Zero console errors.
  - Invalid/bad reference: 404 on both receipt page and PDF.
- E2E spec updated (`tests/e2e/payments.spec.ts`: receipt reference visible, PDF link returns `application/pdf` starting `%PDF-`) but **not run**.

**Not verified yet:** Playwright E2E; a real email send (SMTP / Mailpit lane); the worker-role (least-privilege) path end to end — the integration case runs on the owner connection; the itest grant is in place but not exercised by a test.

### Declined card §9 row

Runner `sbx-declined3` timed out at ~09:49 UTC without payment; it rolled back. The row remains **open and optional**. To fill it: rerun `paystack-sandbox.ts` for `s3-card-declined` only, pay with the DECLINED card 4084 0800 0000 5408 / CVV 001, and record whether Paystack verifies it as `failed` or `abandoned`.

### Things to flag (decisions / risks)

- **Initiation email can be aimed at any address.** Anyone can start a checkout with someone else's email; if Paystack initializes it, that address gets one "payment started" email per checkout. The per-address send limit (L1 in `reserve_email_attempt`) and the suppression list still apply. If this is unwanted, drop `payment.initialized` from the watched list (one line in the trigger + worker list).
- **Payment emails are classified essential.** This is a classification choice made in this session for the payer's own transaction messages; it does not unblock "you still owe" reminders. Worth a line in the decision register.
- **Callback polling** makes up to 20 verify calls per page load while pending. Callback rate limiting is still open.
- **Production grant:** the worker role needs `grant execute on function app.payment_notification_context(uuid) to <worker role>`; the fee alarm needs an owner-equivalent role (like the payment sweep). Without them the worker logs `payment_fee_alarm_state enabled:false` and writes no payment email rows.

### Still open

- Commit + PR for `feat/payment-receipts-alarms` (owner go-ahead).
- Playwright E2E run and SMTP integration lane (`--with-smtp`) for a receipt email in Mailpit.
- Declined-card §9 row (optional, see above).
- M8.7: remaining alarms (`needs_review` depth, unprocessed events age, stuck `created`, ledger imbalance, "contributor emails rejected at initialize").
- "30 minutes" still hard-coded in the callback copy (`payment_limits.hold_minutes`).
- Unchanged / deferred: `financial_events` table writer (webhook body persisted before ack, plan §4.6), reversed row, subaccounts (O-1/O-4), refunds, callback rate limiting, sweep index, old E2E data in the local DB, obligation-on-capture scope, `selected_members`.

### Session 22 changes

| Area | What | Why | Where |
| --- | --- | --- | --- |
| Callback bug fix | Removed `?reference=` from the callback URL the orchestrator sends to Paystack during `initialize()`. Paystack adds `?trxref=REF&reference=REF` on redirect automatically; the extra param produced duplicate `reference` keys, which Next.js returns as `string[]`, failing `verifyPaymentAction`. Added array-safe handling in `page.tsx` as defense-in-depth. Updated fake-checkout to add `trxref`/`reference` params on redirect. | Root cause of "This payment could not be found" after Paystack checkout. | `packages/payments/src/orchestrator.ts` (line 183), `apps/web/app/[…]/payment/callback/page.tsx`, `apps/web/app/[…]/payment/fake-checkout/actions.ts` |
| Callback + receipt UI redesign | Rewrote `PaymentCallback.tsx`: card layout, status icons (spinner, check, warning, error, clock), design tokens, "Secured by Kolekto" footer. Polished `ReceiptView.tsx`: check badge, download icon, tabular-nums. Updated `receipt/page.tsx` wrapper to match. | Owner request: "make it look nice." | `apps/web/app/[…]/payment/callback/PaymentCallback.tsx`, `apps/web/app/[…]/payment/ReceiptView.tsx`, `apps/web/app/[…]/payment/receipt/page.tsx` |
| Worker started | Worker `.env.local` already existed. Built and started the worker; it drained 17 queued messages (old ones skipped, payment events processed) and sent 11 emails to Mailpit (receipts, "payment started", "payment not completed", collection announcements). | Emails were not sending because the worker process was not running. | `apps/worker/` (no code changes, just ran it) |

### Bugs found (session 22, NOT yet fixed)

1. **Receipt email rate-limited (L1).** The per-address rate limit L1 = 3/address/24h in `app.reserve_email_attempt` (migration `20261013200000`) does not exempt `communication_category = 'essential'`. When a user makes two payments, the receipt for the second one is skipped (`recipient_rate_limited`). Confirmed in DB: delivery for `payment.captured` to `gazalsa@dkd.com` has `status = 'skipped', error_code = 'recipient_rate_limited'`. **Fix:** new migration to skip the L1 address check when `v_delivery.communication_category = 'essential'` in `app.reserve_email_attempt`.

2. **No checkout link in "payment started" email.** The `payment.initialized` template in `notification-email-templates.ts` has no CTA link (unlike receipt → receipt page, failed → collection page). The user wants the Paystack checkout URL attached. **Fix:** (a) add `authorization_url` to `app.payment_notification_context` DB function (new migration), (b) add to `PaymentContextRow` and `buildPaymentPayload` in `notification-payment.ts`, (c) add a CTA link in the `payment.initialized` case of `renderPaymentEmail`. The URL is already stored on `payment_attempts.provider_meta->>'authorization_url'` (or similar — check the column).

### Next thing to do

1. **Fix the two email bugs above** (rate limit exemption + checkout link).
2. Run tests (worker unit, web unit, pgTAP) to confirm the fixes.
3. Commit atomically and open a PR to `main`.
4. Run the Playwright payments spec and the SMTP integration lane.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payment-receipts-alarms (sessions 20–22 work is UNCOMMITTED). First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

Two email bugs to fix:

1. Receipt email rate-limited: app.reserve_email_attempt (migration 20261013200000) skips payment receipts via L1 (3/address/24h) even though they are communication_category = 'essential'. Write a new migration that makes reserve_email_attempt skip the L1 address check when the delivery's communication_category = 'essential'. The existing function is in 20261013200000 and was updated in 20261109100200_m13_3_send_time_recheck.sql. Update worker tests if needed.

2. "Payment started" email has no checkout link: the payment.initialized template in apps/worker/src/notification-email-templates.ts (line ~502) sets no link. Add the Paystack authorization_url as a CTA. This requires: (a) adding authorization_url to app.payment_notification_context (new migration or extend 20261116100000); (b) adding it to PaymentContextRow and buildPaymentPayload in notification-payment.ts; (c) adding a CTA link in the payment.initialized case of renderPaymentEmail. Check payment_attempts for the column name that stores the Paystack authorization URL.

After fixing both:
3. Build the worker (npm run build in apps/worker), start it, make a test payment on the local Paystack sandbox, and confirm both the "payment started" email (with checkout link) and the receipt email arrive in Mailpit (http://127.0.0.1:54324).
4. Run worker unit tests (794+), web unit tests (201+), pgTAP, typecheck.
5. Ask the owner before committing. Then commit atomically and open a PR to main.
6. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 COLLECTION_IMPORTED guard. Do not change selected_members semantics or extend obligation-on-capture to open-amount/tiers/items without a separate owner decision. Any obligation-creation path must preserve CASH-02 / SEC-20a (block_manual_paid_status guards INSERT and UPDATE: 'paid' only when a matching applied contribution exists). Keep the abandoned-waits-for-hold rule (20261114110000). Keep the webhook event-id fix (771a1a0). Keep payment emails essential and the payment (reminder) category blocked unless the owner decides otherwise.
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
