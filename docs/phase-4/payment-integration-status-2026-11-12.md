# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payments-foundation`  
**Last commits:**
- `9d9dc73` feat(payments): M8.9 Paystack adapter and webhook route
- `57fc62a` docs(payments): update M8.5 status report (session 9 — CI green, banner shipped)
- `a9b6606` fix(e2e): match 2026-11-founder fee labels and client-side contact guard
- `30fb66f` feat(contribute): gate the pre-payment banner on whether checkout is available
- `b075e86` fix(e2e): wizard aria-label collision and payment-flow assertion drift
- `4ea3805` fix(db): store SES payload as JSON object, not double-encoded string
- `e8b4e10` docs(payments): update M8.5 status report (session 7)

**Authoritative docs** (read these before changing anything):
- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-13, session 10 (M8.9 Paystack adapter + webhook route landed)

### What was done this session

| Area | Change | Where |
|---|---|---|
| Paystack adapter | New `PaystackPaymentProvider` implements the seam from `payment-provider.ts`. `initialize()` → POST /transaction/initialize with amount as a bigint-safe string; `verify()` → GET /transaction/verify/:reference; status mapping covers Paystack's full vocabulary (success / failed / abandoned / ongoing / processing / queued / pending → the DB's five-value set; `reversed` and anything unknown → `unrecognised` so capture routes it to `needs_review`). A 404 on verify is `not_found`, not a refusal. A null `fees` field is kept null (D-11: null ≠ zero). An init timeout is `unknown` with `safeToRetry=false` (a checkout may exist); a verify timeout is `unknown` with `safeToRetry=true` (reads cannot move money). | `packages/adapters/src/paystack-payment-provider.ts` |
| Webhook verification | Dual-header: prefers the modern `Paystack-Signature` (HMAC-SHA512 over `${t}.${rawBody}`, 300-second replay window, rotation-safe multiple-v1 handling); falls back to legacy `x-paystack-signature` while `PAYSTACK_LEGACY_WEBHOOK_FALLBACK` is not `false`. Every rejection is a value, never an exception — a thrown error would be a rejection routed through a 5xx by mistake. | same file |
| Config loader | `tryLoadPaystackConfigFromEnv()` lives inside `packages/adapters` because invariant 4 refuses `PAYSTACK_SECRET_KEY` as a string outside that package. Refuses non-`sk_test_`/`sk_live_` prefixes and non-`whsec_` prefixes at startup — a publishable key in the secret slot was the previous system's most dangerous misconfig. | same file |
| Webhook route | `apps/web/app/api/webhooks/paystack/route.ts`: POST-only (405 other methods), application/json only (415), 256 KiB cap (413), raw bytes straight to the adapter, 401 on rejection (no body-content logged), 503 when Paystack is not configured for the env. Dispatches to `confirmPayment()` from `@kolekto/payments` — the same capture path redirect and sweep call, so three triggers converge on one idempotent-by-attempt path. Outcome mapping: completed/needs_review/pending/failed/not_found → 200 (Paystack stops retrying); provider_unavailable/error → 5xx (Paystack retries, sweep covers). Transfer and unsupported events are acknowledged without acting (subsystems deferred). | `apps/web/app/api/webhooks/paystack/route.ts` |
| Factory | `provider-factory.ts` now returns `getPaystackPaymentProvider()` for staging/production, with the fake kept for local only. Paystack instance is cached on `globalThis` so the route and orchestrator share one per process; returns null when env is incomplete (so the banner reads "not available yet" rather than exposing a half-configured deploy). | `apps/web/lib/payments/paystack.ts`, `apps/web/lib/payments/provider-factory.ts` |
| Tests — adapter | 37 new tests exercise the audit §9 matrix: initialize ok/refused/5xx/timeout/echo-mismatch/unparseable; verify success/failed/abandoned/pending/reversed/not_found/5xx/null-fees; signature valid-modern, valid-bare-v1, two-v1 rotation, wrong secret, stale t, future t, malformed header, re-serialised body, missing event id; legacy fallback valid/invalid/off. All 201 adapter tests green (165 pre-existing + 36 new; one additional config-loader test). | `packages/adapters/test/paystack-payment-provider.test.ts` |
| Tests — route | 20 new vitest route tests: method gate, content-type, size, 503 unconfigured, signature rejection does NOT call `confirmPayment`, and every `ConfirmPaymentResult` outcome maps to the right status. Full `apps/web` suite: 195 tests green. | `apps/web/app/api/webhooks/paystack/route.test.ts` |
| Env | `.env.example` documents `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_API_BASE`, `PAYSTACK_LEGACY_WEBHOOK_FALLBACK` with their guardrails. | `.env.example` |

**Verification run locally:**

- `npm run typecheck` — clean across the workspace.
- `node scripts/invariants/run-all.mjs --verbose` — all seven invariants hold, including "one Paystack caller" (api.paystack.co and PAYSTACK_SECRET_KEY stay inside `packages/adapters`).
- `npm test` — 201 adapter, 195 web, 8 payments, 63 domain+validation+config tests pass. No pgTAP changes (M8.9 touches no SQL).
- `npm run lint` on the new web files — clean.

### Why this update

M8.5 shipped the fake provider with the seam ready for a real one. M8.9 fills the seam: the real adapter needs to speak Paystack's HTTP and the signature protocols, and a webhook route has to run that signing path against the exact bytes Paystack sent. Three things made the shape:

1. **Every uncertainty is a value.** `payment-provider.ts` is explicit that a timeout is NOT a failure (D-27). The adapter never throws on a transport error, a 5xx, a non-JSON body or an aborted request — each becomes a `ProviderResult` variant with a correct `safeToRetry` so a caller cannot accidentally catch too broadly and treat "we don't know" as "it failed".
2. **The route is the signing boundary.** The HMAC runs on the exact bytes the client sent. The route reads a raw `Uint8Array` and hands it to the adapter unchanged — no JSON round-trip, no header normalisation, no content-type-guided decode — because any byte change breaks the signature. The tests include a re-serialisation case that must fail: it does.
3. **Invariant 4 stays sacred.** The previous estate had five Paystack call sites across three runtimes, which is why FIN-02 was unachievable. `api.paystack.co` and `PAYSTACK_SECRET_KEY` appear only in `packages/adapters` now, enforced by the pre-build scan. The env loader lives inside the adapter package for the same reason.

### Still open

- **CI for M8.9:** not yet pushed. Run 7 was an infra flake (port 54322 in use during supabase start on shard 1); M8.9's changes are on top of session 9 commits. Push and watch the next CI run — expect green; the only risk is the vitest run picking up the new webhook test file, which is already proven locally.
- **Sandbox matrix against a real Paystack test account:** infrastructural, outside this repo. The audit §9 matrix exercises card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend-from-dashboard, reversed, `fees` field present, subaccount split, and settlement timing. The adapter is unit-tested against synthetic bodies that match the shapes in the audit; a real run swaps the bodies in with no code change.
- **Deferred for M8.10+:** the `financial_events` table + worker-based processing (audit §4.6); subaccount splits (PA-06); the "actual provider fee > fee charged" alarm (M8.7); transfers, refunds, disputes.
- **Carried over** (no change this session): the fake checkout is in memory; the sweep re-reads pending attempts every minute; `listDuePaymentAttempts` is not served by `payment_attempts_sweep_idx`; the callback action needs rate limiting.
- **PR #31 state at session start:** ready for review on green run 6. Session's new commit will push a new CI run; marking ready stays as it was.

### Next thing to do

1. Push session 10 and watch CI. If the supabase-port flake recurs, `gh run rerun --failed`; the fix is the GitHub Actions runner's own, not code.
2. Decide whether to keep session 10's commits on PR #31 or open a separate PR for M8.9. (Owner decision; "keep on #31" keeps the payments foundation as one atomic change, "separate PR" makes M8.9 reviewable on its own.)
3. Arrange the external infra for the sandbox matrix: a Paystack test account on the NEW (not legacy) project, a public staging URL (for Paystack to call back), and `whsec_` provisioned. Then run the §9 matrix through the deployed route.
4. Start M8.3b (resolver hardening) or M8.7 (monitoring alarms — especially "actual Paystack fee > fee charged"), per owner priority.

### Prompt for the next session (copy and paste)

```
Continue payments on branch feat/payments-foundation. First read docs/phase-4/payment-integration-status-2026-11-12.md, section "Latest report — read this first".

M8.9 (Paystack adapter + webhook route) is done locally and committed. Next:

1. Check CI on the latest commit of feat/payments-foundation. If the supabase port 54322 flake recurs on an E2E shard, re-run that one job (`gh run rerun --failed`) rather than editing code. If anything else fails, diagnose from the logs and fix without weakening assertions or raising timeouts.
2. Decide the PR shape: keep M8.9 on PR #31 (one atomic payments foundation), or open a second PR off main scoped to M8.9 alone. Follow the owner's preference.
3. Start M8.3b — resolver hardening — if the owner has not redirected: pure `isOpenForContributions(collection, now)` in `packages/domain/src/contribution.ts`; single-tier stock check; `amountOwed − applied`; ceiling; status mapping including `reversed`; unit tests for each.
4. At stop, replace this doc's "Latest report" section with what you built, why, what is still open, the next thing to do, and the next prompt.

Do not take money anywhere but Paystack sandbox. Never log or echo a secret or webhook key. Never remove the F5 `COLLECTION_IMPORTED` guard. For Paystack-sandbox testing, the test keys go only in `.env.local` (git-ignored); the external infra (public staging URL, Paystack test account, `whsec_`) must be arranged out of this repo.
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
