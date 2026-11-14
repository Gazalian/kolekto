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

**Last updated:** 2026-11-14, session 12 (contributor-onboarding gap closed with option 1 — obligation created at capture)

### What was done this session

| Area | Change | Where |
|---|---|---|
| CI | Run on `6f75f48` (session 11 code + docs) is green on all seven checks: invariants, secrets, typecheck + unit, migrations + pgTAP, E2E shard 1, E2E shard 2, E2E aggregate. No port-54322 flake; no rerun needed. | n/a |
| Owner decision | Option 1 (lazy obligation materialisation at capture) chosen for the "member pays before being onboarded → obligation reads unpaid" gap. `selected_members` deliberately untouched. | n/a |
| Obligation on capture | `app.complete_payment_capture` replaced. When the attempt has a `member_id`, no `obligation_id`, no `cycle_key`, and the collection (re-read at capture) is `audience_mode in ('all_members','groups')`, `amount_model = 'fixed'`, `schedule = 'one_time'`: (a) if an obligation for (collection, member, null cycle) now exists — the organiser ran "Add members" while the member was at checkout — it is judged with the existing rules: unpaid/overdue for the same amount → linked and paid; paid → `needs_review: already_paid`; changed (waived, exempt, cancelled, different amount) → `needs_review: obligation_changed`; (b) otherwise an obligation is inserted `unpaid` for exactly `attempt.contribution_kobo`, `due_at = collection.deadline_at`, `assigned_by = null`, then the contribution is inserted already pointing at it, then the obligation is updated to `paid` — so `block_manual_paid_status` checks the evidence exactly as for an assigned obligation (CASH-02 / SEC-20a). Audited as `obligation.assign_on_payment` (system actor; reference + contribution id in the payload). Contributions stay append-only: nothing is updated after insert. `sync_collection_obligations` already skips members with an obligation, so a later sync leaves the paid row alone. | `supabase/migrations/20261114100000_obligation_on_capture.sql` |
| Race handling | If "Add members" inserts the same member's obligation between T2's check and T2's insert, the insert's `on conflict do nothing` returns nothing and T2 raises `CAPTURE_RACED_ASSIGNMENT`, rolling back the whole capture. The attempt stays `captured`; the orchestrator returns `{outcome:"error"}` and the sweep re-runs T2 next pass, which then sees the obligation in the decision step. Collection row is `FOR UPDATE`, so two captures for one collection are already serialised. | same |
| CASH-02 on INSERT | `block_manual_paid_status` now also fires `BEFORE INSERT` (new trigger `obligations_block_paid_insert`). Before this an obligation could be INSERTED as `paid` — no function did, and client roles have no insert policy, but the guard did not cover it. A row cannot be born paid (the justifying contribution must reference an existing row). | same |
| pgTAP | New file, 34 tests: obligation created on capture for the exact amount and paid; contribution linked at insert; audit row; `assigned_by` null; T2 re-run idempotent; re-pay refused `ALREADY_PAID`; two in-flight attempts from one member → second parked `already_paid` with no contribution; later sync does not duplicate or unpay, and still assigns others `unpaid`; manual paid still refused; sync-during-checkout → linked to the synced obligation (no `assign_on_payment` audit); waived-during-checkout → `obligation_changed`, obligation untouched; groups audience same; selected_members unlisted member still `MEMBER_NOT_ELIGIBLE`; collection switched to selected_members mid-flight → contribution recorded, no obligation; open-amount → no obligation; INSERT as paid → `NO_MANUAL_PAID`. | `supabase/tests/53_obligation_on_capture.sql` |
| App / db callers | None needed. `complete_payment_capture`'s signature and return shape are unchanged; `obligations.assigned_by` is already nullable in `packages/db` types; the new exception code is handled by the existing `DatabaseError → {outcome:"error"}` path in `packages/payments/src/orchestrator.ts` and the sweep. | n/a |

**Found while testing (now fixed by this change):** under the old capture, a member with no obligation could have two checkouts in flight and **both completed** — a double charge with no review flag (proved by running file 53 against the itest DB without the migration: test 11 returned `completed` instead of `needs_review:already_paid`). After this change the second capture is parked for the host. Test 15 against the old code returned `unpaid` — the reported bug, reproduced.

**Verification locally:**
- `supabase test db` on files 01, 02, 03, 05, 08, 12, 13, 15, 16, 27, 52, 53: 12 files, 342 tests, all pass (local dev DB, migration applied with `supabase migration up --local`).
- File 53 run against the itest DB (no migration, inside begin/rollback): tests 3, 5, 8, 9, 11, 12, 13, 15 and later ones fail, as expected — the tests detect the gap.
- `node scripts/invariants/run-all.mjs`: all seven hold. `npm run typecheck`: clean (no TS changed).
- **Not clean locally, and not caused by this change:** the full `supabase test db` run on the local dev DB fails in 07, 14, 18, 20, 23, 34, 40, 44, 51 because that DB holds committed data from 2026-11-13 local E2E runs (7 paid obligations, 18 contributions, 72 ledger entries, existing `provider_receivable` account); those files assert global emptiness. All that data predates this migration. CI runs a fresh DB and is the authority. A clean local full run needs `npm run itest:reset -- --confirm-reset-kolekto-itest` (wipes the itest DB, rotates its role password — needs owner approval) or a dev `db:reset`.
- **Not run:** the worker integration test (`apps/worker/test/integration/payments-orchestrator.integration.test.ts`) — the itest DB refuses to run against a migration set that differs from its volume until reset. No new TS test was added; the DB function is covered by pgTAP.
- **Security review:** the `security-review` skill failed to start (`git diff origin/HEAD...` — no `origin/HEAD` in this clone); a manual pass over the migration found no issues (operator guard and revoked EXECUTE unchanged; amount from the DB-derived `attempt.contribution_kobo`, never the client; audience re-read at capture; tenancy triggers apply; audit payload has no secrets).

### Still open

- **Committed and pushed:** `3668131` on `feat/payments-foundation` (migration, pgTAP 53, this doc). **No CI run yet and no open PR:** PR #31 was merged on 2026-11-13 at 16:04 UTC (`25564583568089cab68cf0494256fe424a85af2c`), before sessions 11 and 12. Commits `6f75f48` and `3668131` are not on `main`. Opening a new PR needs the owner's go-ahead.
- **Scope left out on purpose:** open-amount / tiers / items collections on `all_members` / `groups` still record a member's payment without an obligation (no single "amount owed" to write). If the organiser later assigns that member an expected amount, it reads unpaid. Needs a product call on what "paid" means there before any change.
- **`selected_members`:** unchanged by design. Reopen only with an explicit owner decision.
- **Existing data:** none in production (payments not live). Any local/staging contribution captured before this migration with `obligation_id = null` stays as it is — this change does not backfill.
- **Sandbox matrix against a real Paystack test account:** infrastructural, outside this repo (NEW test account, public HTTPS staging URL, `whsec_`).
- **Deferred for M8.10+:** `financial_events` table + worker processing (audit §4.6); subaccount splits (PA-06); M8.7 "actual Paystack fee > fee charged" alarm; transfers, refunds, disputes.
- **Carried over** (no change): fake checkout is in memory; sweep re-reads pending attempts every minute; `listDuePaymentAttempts` is not served by `payment_attempts_sweep_idx`; callback action needs rate limiting.
- **PR shape:** a new PR is needed to get `6f75f48` and `3668131` into `main`. Owner to choose: one PR for both, or split the migration into its own PR.

### Next thing to do

1. Owner decides how to get `6f75f48` and `3668131` into `main` (new PR, one or two). Once a PR exists, bind it and check CI (pgTAP job runs file 53 on a fresh DB).
2. Arrange the Paystack sandbox infra and run the §9 matrix through the deployed route — or start M8.7 alarms, whichever the owner names.
3. Optional, when convenient: reset the local dev DB (`npm run db:reset`) so the full local pgTAP run is green again.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

1. Check CI on the latest commit (it should include 20261114100000_obligation_on_capture.sql and pgTAP file 53). If a supabase port 54322 flake recurs on an E2E shard, `gh run rerun --failed`; otherwise diagnose from logs without raising timeouts or weakening assertions.
2. Session 12 is committed and pushed (`3668131`). Do not push to PR #31: it is merged. Open a new PR only on the owner's go-ahead.
3. Then do whichever the owner names: the Paystack sandbox §9 matrix (needs a NEW test account, public HTTPS staging URL, `whsec_`), or M8.7 monitoring alarms (start with "actual Paystack fee > fee charged"). If neither is named, ask.
4. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 `COLLECTION_IMPORTED` guard. Do not change `selected_members` semantics or extend obligation-on-capture to open-amount/tiers/items without a separate owner decision. Any obligation-creation path must preserve CASH-02 / SEC-20a (`block_manual_paid_status` now guards INSERT and UPDATE: 'paid' only when a matching applied contribution exists).
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
