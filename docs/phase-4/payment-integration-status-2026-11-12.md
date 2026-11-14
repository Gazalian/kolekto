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

**Last updated:** 2026-11-13, session 11 (M8.3b resolver hardening; contributor onboarding flag; CI stays green)

### What was done this session

| Area | Change | Where |
|---|---|---|
| CI | Run 7 (session-10 code) failed on all three E2E jobs + typecheck: root cause was a DOM-only `RequestInfo` type in the Paystack adapter test's fetch stub, invisible to local incremental builds but fatal to CI's clean build. Replaced with `string \| URL \| Request` (what Node's fetch accepts without the DOM lib). Run 9 landed all seven checks green on commit `9521283`: invariants (9s), secrets (28s), typecheck (1m1s), pgTAP (3m7s), shard 1 (11m14s), shard 2 (6m9s), aggregate (3s). | `packages/adapters/test/paystack-payment-provider.test.ts` |
| M8.3b: ceiling | Added `MAX_PAYMENT_KOBO = 500_000_000n` (₦5,000,000, audit §14.5) and `assertWithinCeiling()`, applied AFTER model-specific resolution so every model — fixed/open/tiered/basketed/items/per-member — is bounded identically. The DB's `payment_limits.max_payment_kobo` row stays authoritative; this is a pre-DB refusal so the UI never accepts what the DB would reject. | `packages/domain/src/contribution.ts` |
| M8.3b: single-tier stock | The basket path already refuses `quantity > quantityLimit`; the single-tier "choose one" path (quantity = 1) now also refuses a tier with `quantityLimit = 0` as "sold out". Without it, a plain-tier collection could sell past its limit from the public page, bypassing the stock lock the basket path and the DB both enforce. | same |
| M8.3b: `amountOwed = expected − waived − applied` | `ContributionObligation` gains an optional `appliedKobo` field (absent reads as zero, backward-compatible). The resolver now subtracts applied contributions so a repeat visit does not offer the full amount again — matters the moment installments land (O-7, O-13), and matters sooner as a safety net for the audit §4.6 reconciliation gap (capture failing to flip obligation status). Negative applied is refused as MISCONFIGURED. | same |
| M8.3b: status mapping | `in_installments` now raises `INSTALLMENTS_NOT_SUPPORTED` with a clear user message rather than falling through (D-19). `overdue` is accepted — a late payment is still accepted; the window check is separate. `unpaid`, `paid`, `exempt`, `cancelled` behave as before. Added `INSTALLMENTS_NOT_SUPPORTED` and `PAYMENT_ABOVE_CEILING` to `ContributionErrorCode` (both already referenced by `CHECKOUT_ERROR_MESSAGES` in `actions.ts`). | same |
| M8.3b: tests | 19 new tests cover each addition at its boundary: single-tier sold-out, tier still has stock, applied-subtract, applied-zero default, applied-meets-balance → NOTHING_OWED, negative applied → MISCONFIGURED, each obligation status (unpaid, overdue, in_installments, exempt, cancelled, paid), ceiling exactly-at, fixed above, open-amount above, tiered basket SUM above, items order SUM above, obligation remaining above. 235 domain tests green (216 + 19 new). | `packages/domain/test/contribution.test.ts` |
| Pure window check | Already exists in `packages/domain/src/contribution-window.ts` as `isOpenForContributions(opensOn, closesOn, now)` with the correct date-string signature; built in a prior session. The resolver does not duplicate it — a redundant Date-based variant written this session was removed before commit. | n/a |

**Verification locally:** `npm run typecheck` clean, `node scripts/invariants/run-all.mjs` all seven ok, 235 domain + 195 web tests pass.

### Flagged — contributor onboarding scenario (needs product scope before coding)

The user described a scenario that this session investigated but did not fix. The investigation is documented here so the next session can act on a clear option set rather than re-trace it.

**Scenario.** A community member who has NOT been added to a specific collection's roll makes a payment and the system counts it. Later the organiser adds that member to the roll — the payment should still be reflected as paid.

**Current behaviour, per audience mode** (`supabase/migrations/20260920150000_collection_audience.sql`, `20260922100000_member_context_reference.sql`, `20261111100100_payment_functions.sql`):

- `public` — anyone with the link can pay. No obligation; no "paid" state against a roll.
- `all_members` / `groups` — `resolve_collection_audience` INCLUDES every eligible community member, obligation or not. `find_collection_member` finds them; `create_payment_attempt` accepts them; the fixed-amount path falls back to `collection.fixed_amount_kobo` when there is no obligation. **The payment goes through**, but `complete_payment_capture` only `update obligations set status='paid'` when `attempt.obligation_id` is non-null, and the contribution is written with `obligation_id = null`. If the organiser later runs `sync_collection_obligations` (the "Assign" / "Add members" action), it inserts a fresh obligation row with the default `status='unpaid'`. The contributor has paid; the obligation reads unpaid. **This is the correctness gap the user is describing.**
- `selected_members` — `resolve_collection_audience` ONLY returns members with an existing obligation row. `find_collection_member` cannot find a community member who is not on the selected list, so they cannot pay at all. "Selected" and "obligated" are the same act, by design.

**Options for a fix** (owner picks scope; all three are substantial migrations):

1. **Lazy obligation materialisation at capture time.** In `complete_payment_capture`, if `attempt.member_id is not null` and `attempt.obligation_id is null`, create an obligation for that member with `status='paid'` and link the contribution to it. Audit-log the creation with a distinct action. Needs a new path through the `block_manual_paid_status` trigger — the trigger allows 'paid' only when a matching captured contribution exists; this flow has the contribution in the same transaction. Tested by pgTAP. Only applicable to `all_members` / `groups`.
2. **Reconcile on sync.** In `sync_collection_obligations`, when inserting a new obligation, check for a matching completed contribution (same collection, member, cycle) and set `status='paid'` + backlink the contribution row's `obligation_id`. Simpler to write, but silently mutates an append-only column on contributions, which weakens the ledger discipline the rest of the schema upholds.
3. **No obligation at all for these audiences.** Treat `all_members` / `groups` as "contribution-is-the-evidence" — the Members view reads paid state by joining `contributions ⨝ members`, never from `obligations.status`. Removes a lot of code but is a wide-reaching product/UX change (the "Assign" flow disappears for these audiences).

**Recommendation for the owner.** Option 1 — lazy materialisation at capture — matches the user's stated semantics most directly ("the system just counts it as paid even after they are onboarded"), preserves the append-only ledger, and leaves `selected_members` semantics intact. Roughly a half-day of migration + pgTAP + tests. Do not touch `selected_members` without a separate explicit decision — the current "hand-picked only" rule is intentional.

### Still open

- **CI for session 11:** M8.3b not yet pushed. Expect clean — the change is domain-only, pure TypeScript, new test file, no SQL or route touched.
- **Contributor onboarding fix:** the three options above; needs an owner call before coding. The pgTAP suite will need new tests for whichever path is chosen.
- **Sandbox matrix against a real Paystack test account:** infrastructural, outside this repo. The adapter is unit-tested against synthetic bodies that match the shapes in the audit; a real run swaps the bodies in with no code change.
- **Deferred for M8.10+:** `financial_events` table + worker-based processing (audit §4.6); subaccount splits (PA-06); "actual Paystack fee > fee charged" alarm (M8.7); transfers, refunds, disputes.
- **Carried over** (no change): fake checkout is in memory; sweep re-reads pending attempts every minute; `listDuePaymentAttempts` is not served by `payment_attempts_sweep_idx`; callback action needs rate limiting.
- **PR shape:** kept on PR #31 — the four new commits (banner, M8.9 adapter+route, typecheck fix, M8.3b) are all payments-foundation work. If the owner prefers a split, M8.9 and M8.3b can each move to their own PR off a short-lived branch.

### Next thing to do

1. Push session 11 and watch CI.
2. Decide the contributor-onboarding option (1, 2, or 3 above) and implement the chosen one, including pgTAP tests. Only `all_members` / `groups` are in scope unless `selected_members` is explicitly reopened.
3. Arrange the external infra for the Paystack sandbox matrix: a NEW test account, a public HTTPS staging URL, and `whsec_` provisioned. Run the §9 matrix through the deployed route.
4. Start M8.7 (monitoring alarms — especially "actual Paystack fee > fee charged") when the owner is ready.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

1. Check CI on the latest commit. If a supabase port 54322 flake recurs on an E2E shard, `gh run rerun --failed`; otherwise diagnose from logs without raising timeouts or weakening assertions.
2. The "Flagged — contributor onboarding scenario" section of the status doc lists three options for the "community member pays before being onboarded → obligation reads unpaid" gap. Say which option to take (1 = lazy materialisation at capture; 2 = reconcile on sync; 3 = no obligation for all_members/groups). Then implement it: SQL migration, `apps/web` and `packages/db` callers as needed, and pgTAP tests. Do not touch selected_members semantics without a separate decision.
3. If an owner redirect names something else — sandbox matrix, M8.7 alarms, something new — do that instead.
4. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 `COLLECTION_IMPORTED` guard. Any obligation-creation path added must preserve CASH-02 / SEC-20a (the `block_manual_paid_status` trigger allows 'paid' only when a matching captured contribution exists).
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
