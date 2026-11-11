# Paystack integration — audit, architecture and implementation plan

**Date:** 2026-11-10
**Branch read:** `feat/collection-creation-redesign` (uncommitted work present; nothing here depends on it)
**Status:** Audit and plan only. **No code, schema, migration, test or configuration
file was changed.** This document is the only file added.
**Builds on, does not replace:**
[financial decisions](financial-decisions.md) (the decision register — still authoritative) ·
[Phase 4 implementation plan](phase-4-implementation-plan.md) ·
[provider assumptions](provider-assumptions.md) ·
[pre-integration readiness](pre-integration-readiness-2026-11-10.md) ·
[state machines](../history/2026-09-22-phase4-state-machines.md) ·
[money architecture](../history/2026-09-22-phase4-money-architecture.md) ·
[reconciliation design](../history/2026-09-22-phase4-reconciliation-design.md) ·
ADRs [0003](../adr/0003-integer-kobo.md), [0010](../adr/0010-tiers-are-rows.md),
[0012](../adr/0012-collections-stop-at-the-money-boundary.md),
[0013](../adr/0013-collection-types-are-configuration-not-a-type-column.md),
[0015](../adr/0015-subaccount-custody-and-collection-level-ownership.md)

**What was read.** The new repository (`kolekto`): schema migrations, domain package,
adapters package, web server actions, worker, Phase 4 docs and ADRs. The legacy
backend (`kolekto-be-old`): payment routes, controllers, services, repositories, fee
engine, SQL hardening scripts. The legacy frontend (`kolekto-fe-old`): the
`verify-paystack-payment` edge function, its shared helpers and the payment callback
page. Paystack's live documentation (webhooks, verify, Transaction API, NG pricing)
read on 2026-11-10.

> **Update 2026-11-11.** The owner answered the fee model (F7/N3), the date-only
> opening/closing window (N4) and the fundraiser target option (O-15). Those answers,
> and recommendations for every decision still open, are in
> [§14](#14-update-2026-11-11--decisions-taken-and-recommendations). Where §14
> disagrees with an earlier section, §14 wins.

**What was not touched.** No database was queried (local, staging or legacy
production). No Paystack API was called. No secret value was read or printed; the
legacy `.env` files were not opened. The legacy repositories were read only.

---

## Contents

0. [Executive summary](#0-executive-summary)
1. [Deliverable 1 — Reconnaissance of the new codebase](#1-deliverable-1--reconnaissance-of-the-new-codebase)
2. [Deliverable 2 — Audit of the live (legacy) payment implementation](#2-deliverable-2--audit-of-the-live-legacy-payment-implementation)
3. [Deliverable 3 — Collection type inventory](#3-deliverable-3--collection-type-inventory)
4. [Deliverable 4 — Unified payment architecture](#4-deliverable-4--unified-payment-architecture)
5. [Deliverable 5 — Per-type integration blueprints](#5-deliverable-5--per-type-integration-blueprints)
6. [Deliverable 6 — Fee specification](#6-deliverable-6--fee-specification)
7. [Deliverable 7 — Security and financial integrity report](#7-deliverable-7--security-and-financial-integrity-report)
8. [Deliverable 8 — Database migration plan](#8-deliverable-8--database-migration-plan)
9. [Deliverable 9 — Testing strategy](#9-deliverable-9--testing-strategy)
10. [Deliverable 10 — Implementation roadmap](#10-deliverable-10--implementation-roadmap)
11. [Deliverable 11 — Risk register](#11-deliverable-11--risk-register)
12. [Required architectural decisions (Q1–Q16)](#12-required-architectural-decisions-q1q16)
13. [Decisions needed before implementation](#13-decisions-needed-before-implementation)

---

## 0. Executive summary

**Where the new system stands.** The financial *record* layer exists and is tested:
integer-kobo money (`packages/domain/src/money.ts`), one fee engine
(`packages/domain/src/fees.ts`), versioned append-only fee schedules, a balanced
append-only double-entry ledger with mandatory collection attribution, a
provider-event store unique on `(provider, provider_event_id)`, an append-only
processing-attempts table, server-side amount resolution for every collection type
(`packages/domain/src/contribution.ts`), and a provider seam with a fake
(`packages/adapters/src/payment-provider.ts`, `fake-payment-provider.ts`). The
*movement* layer does not exist: no `payment_attempts`, `provider_transactions`,
`contributions`, no ledger writer, no Paystack adapter, no webhook route, no sweep.
`submitContributionAction` stores nothing by design (ADR 0012).

**Where the live system stands.** An Express backend initialises payments
(`services/paymentService.js` + `services/pricingService.js`), persists a
`pending_payment_context` row before calling Paystack, and verifies through a
Supabase edge function (`verify-paystack-payment`) which records the capture early
and claims contributions through an atomic RPC (`claim_payment_contributions`) that
locks the collection row. Money is JavaScript floats; balances are recomputed from
contributions against current fee constants. It is substantially hardened after the
August 2026 incidents, but carries several live weaknesses (§2.4).

**Recommendation in one line.** Build one payment orchestrator for all seven
collection types, with the type-specific part confined to the existing pure resolver
plus a database function that re-derives the amount from rows, locks stock and
freezes the fee breakdown onto a payment attempt; make capture a single
`SECURITY DEFINER` transaction keyed by unique indexes; and treat redirect, webhook
and sweep as three triggers that all converge on `verify()`.

### Findings that change the plan — read these first

| # | Finding | Severity | Detail |
|---|---|---|---|
| **N1** | **Paystack's webhook signature scheme has changed.** The docs now describe a `Paystack-Signature` header (`t=<unix>,v1=<kid>:<hex>`), HMAC-SHA512 over `t + "." + rawBody` keyed with a dedicated `whsec_` signing secret, a 300-second replay window, and multiple `v1` values during rotation. The old `x-paystack-signature` (HMAC of the raw body with the secret key, no timestamp) is still sent while a secret key exists. `provider-assumptions.md` PA-01 records only the old scheme. | High (design) | §4.6, §7 |
| **N2** | **The modelled provider fee does not match Paystack's published NG pricing.** Paystack charges **1.5% + ₦100** (₦100 waived under ₦2,500), capped at ₦2,000, **on the amount actually charged**; international cards **3.9% + ₦100, uncapped**; pay-with-transfer/DVA **1% capped ₦300**. `SCHEDULE_2026_09_FOUNDER` models 1.5% of the contribution, capped ₦2,000, no flat fee. Under `contributor_pays` the contributor is under-charged by roughly ₦100–₦105 per mid-sized payment and Kolekto's fee income absorbs it; under `community_absorbs` the organiser's previewed net is overstated until the actual fee posts. D-11 already makes the actual fee authoritative, so the ledger stays correct — **the commercial outcome does not**. | High (financial) | §6.4 |
| **N3** | **The new fee policy differs from what production charges today.** Live: platform 0.5% (1% fundraising), cap ₦2,000, gateway 1.5% cap ₦2,000, fundraisers always contributor-pays. New (D-10, CLOSED 2026-09-24): platform 1.5% everywhere, cap ₦5,000, bearer chosen per collection, default `community_absorbs`. This is a recorded founder decision, not a silent change, but it is a price change for every migrating organiser and needs explicit reconfirmation and organiser communication before launch. | High (commercial) | §6.2 |
| **N4** | **Collection opening/closing dates are not enforced server-side at contribution time.** `submitContributionAction` (`apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`) checks only `status === 'active'`; `starts_at` / `deadline_at` are display-only. Once this action starts creating payment attempts, a contributor could pay after a deadline or before sales open. | Medium | §5, §8 |
| **N5** | **Paystack transaction statuses include `reversed`, `ongoing`, `processing`, `queued`.** The seam maps only `pending/succeeded/failed/abandoned/unrecognised`. A `reversed` transaction (refund or chargeback) would land in `unrecognised → needs_review`, which is safe but loses meaning. Paystack also sends webhooks **only for successful charges**, so abandonment and failure are learned only by verification or sweep. | Medium | §4.7 |
| **N6** | **The legacy live secret key exposure is still unconfirmed as rotated** (carried from M8.1/M8.2 and today's readiness scan). | High (live) | §7.3 |
| **N7** | **Live legacy vulnerabilities** worth reporting to whoever owns the legacy system: the verify edge function accepts `overrideCollectionId` / `overrideSelectedTierId` from any anon-key caller; `GET /api/payments/verify` returns payer name/email/phone for any reference and re-sends the receipt email on every call; references come from `Math.random`; the client chooses `callback_url`; tier matching still falls back to display names in two places. None are reproduced in the new design. | Medium–High (live) | §2.4 |

Everything else already identified by the readiness scan (stock never decremented,
no open-amount ceiling, `amountOwed` ignores money received, no `paid` exemption,
per-process rate limiting, webhook route placement) is carried into the plan
unchanged.

---

## 1. Deliverable 1 — Reconnaissance of the new codebase

### 1.1 Architecture

| Layer | What it is | Evidence |
|---|---|---|
| Repo | npm-workspaces monorepo, Turborepo, one deployable (ADR 0001) | `package.json`, `AGENTS.md` |
| Web | Next.js (version with breaking changes — read `node_modules/next/dist/docs` before writing code), App Router, server actions | `apps/web` |
| Worker | Long-running Node process; today runs the notification pipeline (claims, backoff, dead-letter, rate limits) | `apps/worker/src/*` |
| Domain | Pure, dependency-free: `money`, `fees`, `settlement`, `contribution`, `reference`, `amount-input`, `report`, `csv` | `packages/domain/src` |
| Adapters | Provider seams + fakes: email (SES, Mailpit, fake), SES/SNS webhook, payment provider (contract + fake), settlement provider (contract, throws) | `packages/adapters/src` |
| DB access | `packages/db`: public reads, `write.ts` (application writes to `app.*` functions over a direct connection, ADR 0011), `webhook-events.ts` (persist-before-acknowledge for SES), retry helper | `packages/db/src` |
| Database | Supabase Postgres, system of record (ADR 0002); **no edge functions** (ADR 0005); 126 migrations; RLS enabled **and forced** on every table; every write an `app.*` `SECURITY DEFINER` function calling `require_permission` | `supabase/migrations` |
| Config | Strict env parsing; refuses to let non-production point at the production project ref | `packages/config/src/env.ts` |
| Invariants | Source-tree gates (no float money, no Paystack call site outside `packages/adapters`, etc.) | `scripts/invariants/run-all.mjs` |

### 1.2 Authentication and authorization

- Officers authenticate with Supabase Auth; permissions are rows (`role_permissions`), checked in SQL by `app.require_permission` / `app.has_permission`. `requires_second_approver` already exists for `refund.initiate`, `withdrawal_account.change`, `collection.change_amount`.
- **Contributors are anonymous.** A managed collection identifies the member through `findMemberAction` → an **httpOnly HMAC-signed cookie** holding the member id (`apps/web/lib/contributor-session.ts`); the id never travels through the page. Eligibility is re-checked in the DB on every call (`getCollectionMemberContext`).
- Member lookup is throttled per process (`apps/web/lib/lookup-throttle.ts`) — not durable.

### 1.3 Database objects relevant to payments

**Collections (exist):** `collections` (`participation_mode`, `audience_mode`, `amount_model`, `payment_plan`, `schedule`, `status`, `visibility`, `fixed_amount_kobo`, `min_amount_kobo`, `max_amount_kobo`, `target_amount_kobo`, `suggested_amounts_kobo bigint[]`, `fee_mode`, `allow_anonymous`, `starts_at`, `deadline_at`, `event_starts_at/ends_at`, `venue`, `collect_attendee_details`, `category`), `collection_tiers` (`price_kobo`, `quantity_limit` (>0), `per_order_limit`, `hidden`, `UNIQUE(collection_id, name)`), `collection_items` (`price_kobo`, `quantity_available` (≥0), `max_per_order`, `hidden`, unique lower(name)), `collection_recurrences`, `collection_cycles` (unique `(collection_id, cycle_key)`), `obligations` (unique `(collection_id, member_id, cycle_key)`; `status` enum incl. `paid`; `app.block_manual_paid_status` refuses every write of `paid`), contributor-reference counters and `app.build_contributor_reference`, collection fields/answers schema, event check-ins.

**Financial foundation (exist, empty except reference data):**

| Object | Migration | Notes |
|---|---|---|
| `fee_schedules`, `fee_schedule_category_rates`, `withdrawal_fee_schedules`, `withdrawal_fee_brackets` | `20260924100000_fee_schedules.sql` | append-only by trigger; one row `2026-09-founder` |
| `ledger_accounts`, `ledger_journals` (`idempotency_key` unique, `reverses_journal_id`, collection attribution `CHECK`), `ledger_entries` (amount > 0, NGN only) | `20260924110000_ledger.sql` | deferred balance trigger; no UPDATE/DELETE |
| `ledger_account_codes` (12 codes: `provider_receivable`, `platform_fee_income`, `provider_fee_expense`, `vat_payable`, `suspense`, `collection_pending`, `collection_available`, `collection_on_hold`, `collection_withdrawing`, `collection_withdrawn`, `collection_refund_reserve`, `collection_chargeback`) | `20260924130000_…` | scope/type guards |
| `financial_events` (unique `(provider, provider_event_id)`, immutable), `financial_operation_claims` (unique `(scope, key)`) | `20260924120000_financial_idempotency.sql` | no writer yet |
| `financial_event_processing_attempts` + `v_financial_event_processing` | `20260924160000_…` | E1 resolved as the append-only sibling table |
| `v_ledger_account_balances`, `v_collection_position`, `v_ledger_imbalances` | `20260924140000_…` | `security_invoker` |

**Do not exist:** `contribution_intents`, `payment_attempts`, `provider_transactions`, `contributions`, `contribution_lines`, `tickets`, stock reservations, `balance_releases`, withdrawals/payouts, refunds, reconciliation tables. No function can write a journal.

### 1.4 Payment-related code paths today

```
Contributor opens /{community}/{collection}
  page.tsx → getPublicCollection (app.get_public_collection: status in active/paused/closed,
             visibility public/unlisted, community active)
  ContributeForm.tsx → (managed) findMemberAction → signed cookie → confirmMemberAction
  submit → submitContributionAction(actions.ts)
        ├ status must be 'active'                     (dates NOT checked — N4)
        ├ member from cookie, re-checked in DB
        ├ contact + custom answers validated (zod)
        ├ tiers/items loaded from DB by collection id
        ├ resolveContributionAmount(config, selection)  ← authoritative amount, by id
        └ returns a summary; NOTHING stored; "payment is not open" (ADR 0012)
```

Fee display: `FeeConfigurator.tsx` (organiser preview) is the only caller of
`calculateFees`. The contributor never sees a fee (readiness §2.4).

### 1.5 Environment variables

Declared in `.env.example`, read by nothing yet: `PAYSTACK_SECRET_KEY`,
`PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_CALLBACK_URL`,
`SENTRY_DSN`. With N1, `PAYSTACK_WEBHOOK_SECRET` now has a precise meaning: the
`whsec_…` webhook signing secret, distinct from the API secret key. Rules from the
Phase 4 plan §9 stand (test keys only in local and staging; production values only in
the host's secret store; never a legacy value).

### 1.6 Background jobs, triggers and webhooks

- Worker: notification pipeline only. No financial job.
- Webhooks: SES/SNS receiver with persist-before-acknowledge (`packages/db/src/webhook-events.ts`). `middleware.ts` excludes `/api/webhooks/` from auth redirects.
- Triggers: append-only guards, tenancy-consistency guards, `block_manual_paid_status`, contributor-reference assignment, `set_updated_at`.

---

## 2. Deliverable 2 — Audit of the live (legacy) payment implementation

### 2.1 End-to-end lifecycle, as built

```
ContributeFlow.tsx
  POST /api/payments/initialize-payment  { email, callback_url, metadata:{collectionId, contributionAmount,
                                           totalPayable, selectedTierId, ticketSelections, contact, formData} }
  └ controllers/deposit.js#initializePayment (NEW format) → services/paymentService.js#initialize
       ├ repo.getCollectionById, repo.getPaidContributionsForTierCapacity
       ├ pricingService.normalizePaymentRequest   (amount derived server-side, ±₦1 client check)
       ├ reference = `kolekto-${Date.now()}-${Math.floor(Math.random()*1e6)}`
       ├ insert pending_payment_context (retry once; abort checkout if both fail)  ← fail-closed
       ├ Paystack POST /transaction/initialize { amount: Math.round(totalPayable*100), reference,
       │                                         callback_url (client-supplied), metadata }
       └ init email (fire and forget)
Paystack checkout → redirect to /payment/verify?reference=…
  paymentCallback.tsx → supabase.functions.invoke('verify-paystack-payment', {reference})
     (localStorage lock to avoid duplicate calls from the same browser)
  verify-paystack-payment (Deno edge fn)
       ├ GET /transaction/verify/:reference
       ├ if success: record_payment_capture(...) EARLY — before metadata/collection resolution
       ├ metadata ← pending_payment_context, else Paystack metadata (object or JSON string),
       │            else deterministic recovery (email+amount+recency), else overrideCollectionId
       ├ normalizePaymentRequest again; amount check |verified − totalPayable| ≤ ₦0.01 (₦1.00 open-amount)
       ├ claim_payment_contributions(collection, reference, rows)   ← atomic RPC
       ├ refreshCollectionAndWallets (recompute from contributions)
       └ send receipt via backend /api/payments/send-receipt
Paystack webhook → POST /api/payments/webhook (express.raw, mounted before express.json)
  controllers/deposit.js#handleWebhook
       ├ JSON.parse, then HMAC-SHA512(raw body, secret key) vs x-paystack-signature
       ├ charge.success only; if a paid contribution exists for the reference → 200
       └ else invoke the same edge function (service-role key); 500 on failure so Paystack retries
scheduled-payment-recovery (edge fn) + jobs/paymentSettlement.js (5am WAT recompute)
```

### 2.2 Security mechanisms that work and should be **retained** (re-implemented, not copied)

| Mechanism | Where | Keep because | New-system form |
|---|---|---|---|
| Amount derived server-side from the collection row; client amount only compared, never used | `pricingService.normalizePaymentRequest` | stops amount tampering | `resolveContributionAmount` + DB re-derivation (§4.3) |
| "Impossible-state" guard: reject if client's belief differs from server's by > tolerance | `pricingService.js` tier/ticket branches | surfaces stale pages instead of charging a surprise amount | keep, with **zero** tolerance in kobo (amounts are integers now) |
| Fail-closed: persist local context **before** calling Paystack | `paymentService.persistPendingContextWithRetry` | a payment can never exist at Paystack without a local row | `payment_attempts` row in `created` before `initialize()` |
| Record the capture **before** any validation that might fail | `record_payment_capture` early call in verify edge fn | money is never invisible because of a downstream bug | attempt → `captured` + `provider_transactions` row before contribution claim |
| Atomic claim under a lock, idempotent by reference | `database/h1_atomic_payment_verification.sql` | the duplicate-verify race was real | `app.capture_payment` with unique indexes + row locks |
| Raw-body webhook route mounted before JSON parsing; refuse if body is not a Buffer | `app.js:135-158`, `deposit.js:710` | signature over re-serialised JSON never matches | Next.js route handler reads `request.arrayBuffer()` |
| Webhook is a trigger to verify, never evidence | `handleWebhook` → edge fn re-verifies | signed body is what was sent, not what is true | seam's `parseWebhookSubject` → `verify()` |
| Return 5xx on processing failure so Paystack retries | `handleWebhook` | relies on provider retry | **changed**: persist then 200; our own worker retries (§4.6) |
| `needs_review` for captured-but-invalid payments, visible queue | `mark_payment_needs_review`, `payment_inbox` | money parked, not lost | `payment_attempts.status = 'needs_review'` |
| Explicit `REVOKE EXECUTE … FROM anon, authenticated` on money RPCs | `h1_…sql:250-257` | Supabase default privileges grant EXECUTE | already an invariant in the new repo (M8.1 finding 2) |
| Tier-by-id matching (incident 2026-08-06) | `pricingService.matchTier` | the incident | ADR 0010 — **id only, no name fallback** |
| Unique `(collection_id, payment_reference, line_index)` on contributions | `h1`, `payment_capture_ledger` | multi-line orders without duplicates | `contribution_lines` unique `(contribution_id, line_no)` + one contribution per attempt |

### 2.3 Fee logic in production

`utils/fpe/constants.js` (vendored from `kolekto-shared-financial`):

| Component | Rate | Cap |
|---|---|---|
| Platform fee | 1% fundraising; 0.5% fixed/tiered/ticket/open_pool/default | ₦2,000 |
| Gateway fee (modelled) | 1.5% all types | ₦2,000 |
| Fee base | contribution amount (not the payable) | — |
| Bearer | collection's `fee_bearer` (`organizer` default); **fundraising forced to `contributor`** | — |
| Rounding | `Number(x.toFixed(2))` on IEEE doubles | — |
| Settlement | T+1 at 04:00 UTC (05:00 WAT); available = settled net − completed withdrawals | — |
| Persistence | `contributions.amount` (net to host when organiser-absorbed, base when contributor-pays) and `gross_amount`; **no fee snapshot**; wallets recomputed from current constants | — |

Historical fixes found: B-2 wallet double credit (read-modify-write → recompute);
tier-name collision (2026-08-06); unattributed deposits (pending context, D-1
metadata-as-string fix); capacity race on duplicate verify (H1). See
`docs/history/incident_2026-08-06_tiered-payment-amount-regression.md` and
`FINAL_PAYMENT_INTEGRITY_REPORT_2026-08-07.md`.

### 2.4 Weaknesses in the live system — **document, do not reproduce**

| # | Weakness | Where | Exploit / failure | Financial consequence | New-system answer |
|---|---|---|---|---|---|
| L1 | Recovery overrides accepted from any caller of the verify edge fn (anon key is public in the SPA; CORS `*`) | `verify-paystack-payment/index.ts:46-51`, `_shared/cors.ts` | For a captured payment whose metadata is missing, anyone holding the reference can attribute it to any collection, or pick a same-priced tier | Misattributed money credited to the wrong organiser | Overrides do not exist. Resolution of `needs_review` is an officer/staff `app.*` function with a permission and an audit row. |
| L2 | `GET /api/payments/verify?reference=` is unauthenticated, returns payer name/email/phone, and re-sends the receipt email on **every** call | `controllers/deposit.js:562-689` | Reference enumeration → PII; email flooding of a payer | Privacy breach; reputational | Receipt page shows a redacted summary to the holder of an unguessable reference; receipt email is an idempotent outbox row per contribution. |
| L3 | Predictable references: `Date.now()` + `Math.random()*1e6` | `services/paymentService.js:generateReference` | Guessing references (fuels L1/L2); same-millisecond collision is possible | Wrong-payment association on collision | 128-bit CSPRNG reference, unique index (§4.4). |
| L4 | Client-supplied `callback_url` passed to Paystack | `paymentService.initialize`, `ContributeFlow.tsx:704` | Post-payment redirect to an attacker page that imitates a receipt (phishing) | Indirect | Callback URL built server-side from config + reference; never from input. |
| L5 | Legacy initialize branch still reachable; `validateContributionAmount` default case accepts any amount for an unknown type and matches tiers by name | `deposit.js:139-241, 433-548` | Crafted legacy-format body | Under-payment on an unknown type | Single entry point; unknown amount model is a hard error. |
| L6 | Signature compare falls back to non-constant `hash === signature`; body parsed before signature check | `deposit.js:738-744, 787-797` | Timing side channel (low); parser exposure on unauthenticated input | Low | Constant-time compare only; authenticate before parse. |
| L7 | `/api/payments/send-receipt` secret is optional, compared non-constant-time | `deposit.js:921-929` | If `INTERNAL_NOTIFY_SECRET` unset: an open relay sending "payment received" emails with arbitrary content from Kolekto's domain | Phishing from a trusted sender | No internal HTTP hop; receipts go through the notification outbox. |
| L8 | Webhook dedupe is read-then-act (`contributions` lookup) and nothing about the event is persisted | `handleWebhook:816-840` | Concurrent deliveries both proceed (saved only by H1's lock downstream) | None today because H1 holds; fragile | Event persisted first; unique `(provider, provider_event_id)`. |
| L9 | Capacity enforced only at capture time — after the money is taken | `h1 … capacity_exceeded` | Two contributors buy the last ticket; second is charged and parked | Money held without a ticket; manual refund | Reserve stock at attempt creation (§4.5). |
| L10 | Tier name fallback survives in `matchTier` and in the SQL claim (`COALESCE(tier_id, tier_name)`, `t->>'name' = key`) | `pricingService.js`, `h1 … :171, :196` | Missing id → resolves by name; duplicate names exist in 5 prod collections | Wrong tier/stock | ADR 0010: id only; unknown → `needs_review`. |
| L11 | Float money, `toFixed` rounding; balances recomputed with current constants | `utils/fpe/*`, `jobs/paymentSettlement.js` | Kobo drift (₦3.59 measured); a rate change restates history | Drift | Kobo bigint; frozen fee snapshot; ledger. |
| L12 | Open-amount verify tolerance ₦1.00 when metadata lacked the amount (amount reverse-engineered from Paystack total) | `verify-paystack-payment/index.ts:561-571` | Amount inferred from what was charged | Small misstatement | Attempt is the amount lock; verified amount must equal it exactly. |
| L13 | No upper bound on open amounts; no deadline/start check in pricing | `pricingService.js` | Very large or late payments | Uncapped exposure | Platform ceiling + window check (§5). |
| L14 | Legacy live Paystack secret recoverable from `kolekto-be-old` git history | Phase 4 plan §16 | Anyone with a clone can call Paystack as Kolekto | Full account compromise | Rotate (owner action). New system never uses legacy keys (D-22). |

L1, L2, L7 and L14 are **live production issues in the legacy system**. Fixing them is
outside this assignment and touches production; they are reported here so the owner
can decide.

### 2.5 Old vs new — architectural differences

| Concern | Legacy | New (built or planned) |
|---|---|---|
| Money type | float naira | `bigint` kobo, branded `Kobo` |
| Collection type | `collection_type` string, tiers in JSONB | axes + rows (ADR 0013, 0010) |
| Amount authority | pricingService (Node) + same logic duplicated in Deno | one pure resolver + DB re-derivation |
| Fees | constants recomputed on read | versioned schedule frozen on attempt |
| Balance | mutable `wallets` recomputed | ledger views |
| Payment record | `pending_payment_context` + `contributions` with status strings | attempt / provider transaction / contribution / journal, enums + CAS |
| Webhook | Express → edge fn, 5xx for retry | persist-before-ack → worker → verify |
| Writers | Express, Deno edge fns, admin panel, SQL | `app.*` SECURITY DEFINER only |
| Attribution | metadata, with recovery heuristics | attempt row created server-side before Paystack; heuristics forbidden |

---

## 3. Deliverable 3 — Collection type inventory

ADR 0013: there is no type column. A "type" is a creation-flow preset
(`apps/web/app/c/[slug]/collections/new/flows.ts`, `FLOWS`) over four axes. The
**payment-relevant** identity of a collection is `amount_model` × `participation_mode`
(and its `audience_mode`) × `schedule` × `payment_plan`, plus the presence of
stock-bearing rows.

### 3.1 New system — the seven flows (+ one amount model with no flow)

| Flow key | Title | category | participation | amount_model | schedule | timing shape |
|---|---|---|---|---|---|---|
| `fixed` | Fixed contribution | dues | managed | fixed | one_time | closing_date |
| `open` | Open contribution | contribution | open | open_amount | one_time | closing_date |
| `tiered` | Packages | contribution | open | tiers | one_time | closing_date |
| `items` | Items / orders | items | open | items | one_time | order_window |
| `ticketing` | Event tickets | event | open | tiers | one_time | sales_window |
| `fundraiser` | Fundraiser | fundraiser | open | open_amount | one_time | campaign_end |
| `recurring` | Recurring dues | dues | managed | fixed | recurring | none |
| *(no flow)* | per-member amounts | — | managed | per_member | one_time | — |

`per_member` exists in the enum and the resolver; `flowKeyFor` maps it to the
`fixed` flow for editing (`flows.test.ts:230`). No creation flow produces it.

### 3.2 Classification matrix (payment view)

| Type | Pricing model (authority) | Custom amount | Predefined amounts | Multiple tiers/lines | Multiple payments per contributor | Target | Min / Max | Closing date | Recurring | Contributor info | Anonymous | Stock | Special payment rules |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Fixed (managed) | `fixed_amount_kobo`, or the member's obligation `expected − waived` | No | No | No | One per obligation (once `paid`, `NOTHING_OWED`) | No | n/a | `deadline_at` | No | Identification via cookie + contact + custom fields | No (member known) | No | obligation-driven; must apply the payment to the obligation |
| Fixed (open audience) | `fixed_amount_kobo` | No | No | No | Unlimited | No | n/a | `deadline_at` | No | contact + fields | `allow_anonymous` | No | none |
| Open contribution | contributor amount within `min/max` | Yes | `suggested_amounts_kobo` (≤6) — suggestions only | No | Unlimited | optional `target_amount_kobo` (display) | collection min/max; **no platform max yet** | `deadline_at` | No | contact + fields | `allow_anonymous` | No | ceiling needed |
| Fundraiser | as open contribution | Yes | Yes (goal step) | No | Unlimited | `target_amount_kobo` | as above | campaign end | No | as above | typically yes | No | target is **not** a cap unless founder decides; legacy forced contributor-pays |
| Tiered (packages) | `collection_tiers.price_kobo` by **id** | No | tiers | One tier (×1) | Unlimited | No | n/a | `deadline_at` | No | contact + fields | `allow_anonymous` | `quantity_limit` (optional) | id-only; hidden tiers not purchasable |
| Ticketing | tiers by id × quantity, basket | No | tiers | Yes, basket with `per_order_limit` | Unlimited | No | n/a | sales window (`starts_at`/`deadline_at`); event date separate | No | contact + fields + **one attendee name per ticket** if `collect_attendee_details` | as configured | `quantity_limit` per tier | oversell prevention, tickets issued per unit |
| Items | `collection_items.price_kobo` by id × quantity, basket | No | items | Yes | Unlimited | No | n/a | order window | No | contact + fields | as configured | `quantity_available`, `max_per_order` | oversell prevention |
| Recurring (managed) | obligation for the open cycle | No | No | No | One per member per cycle | No | n/a | none (cycle `due_at`) | Yes — cycles opened deliberately | identification | No | No | payment must name the **cycle**; paying one cycle never settles another; overpayment roll-forward is O-11 |
| per_member | obligation amount | No | No | No | One per obligation | No | n/a | `deadline_at` | No | identification | No | No | as fixed-managed |

**Installments** (`payment_plan = installments_allowed`) exist as an axis but partial
payment is DEFERRED (D-19, O-7, O-13). Until those close, the orchestrator must
**refuse** any amount on an obligation other than the full amount owed, and
`in_installments` must not be written.

### 3.3 Legacy types and their mapping

| Legacy `collection_type` | New equivalent | Notable legacy rules |
|---|---|---|
| `fixed` | fixed (open or managed) | `max_contributions` collection-wide cap (no new equivalent) |
| `tiered` | tiers (single choice) | JSONB tiers, name fallback, capacity from paid rows |
| `ticket` (`ticket_mode` flat) | tiers with one tier, or fixed + quantity | `allow_multiple_quantity` |
| `ticket` (`ticket_mode` tiered) | ticketing | basket, per-tier capacity at capture |
| `fundraising` | fundraiser | platform 1%, fees forced on contributor |
| `open_pool` | open contribution | minimum only |

Legacy `max_contributions` has no counterpart in the new schema. If any migrating
organiser relies on it, it needs a founder decision (it is a collection-wide stock).

### 3.4 Why one payment service is safe for all of them

Every type differs only in **how the base amount and the purchased units are
determined**. After that point — fee calculation, attempt creation, provider call,
verification, capture, ledger, receipt — the lifecycle is identical. The type-specific
part is already isolated in `resolveContributionAmount` (pure, unit-tested per model)
and will be mirrored by the DB function that re-derives the amount and locks stock.
The remaining type-specific post-capture effects are table-driven: *if the attempt has
an obligation → apply it; if it has ticket lines → issue tickets; if it has stock
reservations → convert them.* None needs a separate Paystack integration.

---

## 4. Deliverable 4 — Unified payment architecture

### 4.1 Components and where they live

| Component (brief's name) | Responsibility | Lives in |
|---|---|---|
| Payment Orchestrator | `startCheckout()`: validate → resolve → fee → create attempt → initialize → return URL. `confirmPayment(reference, trigger)`: verify → capture. | `apps/web/lib/payments/` (server-only) calling `packages/db/src/payments.ts` |
| Collection Payment Strategy | amount/units by type | `packages/domain/src/contribution.ts` (exists) + `app.create_payment_attempt` (DB re-derivation, stock lock) |
| Pricing and Fee Engine | breakdown, schedule version | `packages/domain/src/fees.ts` (exists); `fee_schedules` row is the record |
| Paystack Gateway Service | HTTP, mapping, signatures | `packages/adapters/src/paystack-payment-provider.ts` (new) implementing `PaymentProvider` |
| Transaction Reference Generator | unguessable, Paystack-safe | `packages/domain/src/payment-reference.ts` (new, pure, takes random bytes) |
| Payment Verification Service | `verify()` + compare against the attempt | orchestrator + `app.capture_payment` |
| Webhook Handler | authenticate raw bytes, persist, 200 | `apps/web/app/api/webhooks/paystack/route.ts` (new) |
| Idempotency Service | unique indexes, CAS transitions, `financial_operation_claims` | database |
| Financial Ledger Service | capture + fee journals | `app.post_capture_journals` (inside `app.capture_payment`) |
| Contribution Recording Service | contribution, lines, tickets, obligation | `app.capture_payment` |
| Reconciliation Service | sweep + boundaries ②③ | worker job + `reconciliation_*` tables |
| Payment Audit Logger | who/what/when | `audit_logs` (append-only, exists) + `financial_event_processing_attempts` |

Constraints honoured: no edge functions (ADR 0005); every write via an `app.*`
function over the direct connection (ADR 0011); `api.paystack.co` only in
`packages/adapters` (invariant); the domain stays pure.

### 4.2 Data model (one payment, five entities)

```
contribution_intent ─1:1─ payment_attempt ─1:n─ provider_transaction (append-only; latest wins)
                              │
                              └─1:1─ contribution ─1:n─ contribution_line ─1:n─ ticket
                                          │
                                          └─ ledger_journals (capture, fee)  idempotency_key = 'capture:'||attempt_id
```

`contribution_intents` holds what the contributor chose (lines, contact, answers,
attendee names, member/obligation/cycle) — PII, officer-readable only.
`payment_attempts` is the amount lock: reference, `amount_kobo` (= total charged),
frozen fee breakdown, schedule version, bearer, collection/community/tier ids,
expiry, status. One intent has at most one live attempt; a retry after
expiry/failure creates a new intent+attempt.

### 4.3 Initialization flow (all types)

```
submitContributionAction (server action, unauthenticated contributor)
 1  rate limit (durable, per IP + per collection)                       → 429
 2  load collection; status = active; now() within [starts_at, deadline_at)   (N4)
 3  member from signed cookie (managed), re-checked in DB
 4  validate contact, answers, attendee names (existing code)
 5  resolveContributionAmount(config-from-DB, selection)               (pure, existing)
 6  calculateFees({amount, category, bearer: collection.fee_mode, schedule: current})
 7  if client sent an expected total and it ≠ server total → 409 "refresh"   (impossible-state guard)
 8  app.create_payment_attempt(…)   ONE transaction:
      - re-read collection FOR SHARE; re-check status/window
      - re-derive base amount from tier/item/obligation rows BY ID; assert = step 5
      - assert fee breakdown arithmetic and schedule version exist/effective
      - lock tier/item rows FOR UPDATE; check remaining = limit − sold − active reservations ≥ qty
      - insert stock_reservations (expires_at = attempt expiry)
      - insert contribution_intent + payment_attempt(status='created', reference)
      - enforce one live attempt per (intent idempotency key)
 9  provider.initialize({reference, amount: totalPayable, currency:'NGN',
                         callbackUrl: server-built, email, metadata:{attempt_id, collection_id}, subaccount})
      ok        → app.mark_attempt_initialized(attempt, access_code)   created → initialized
      refused   → app.mark_attempt_failed(attempt, code)               created → failed; release stock
      unknown   → leave `created`; the sweep verifies by reference later (never re-init blindly)
10  return checkout URL (redirect) — the page shows the server's breakdown before redirect
```

Step 8 is where concurrency is decided; steps 1–7 are cheap refusals. If step 9's
provider call succeeds but step 9's DB update fails, the attempt stays `created` and
the sweep resolves it from Paystack — the reference is ours, so nothing is lost.

**Idempotent initialization.** The client generates a random
`checkout_idempotency_key` per form submission (hidden field, not trusted for
anything else). `contribution_intents` is unique on
`(collection_id, checkout_idempotency_key)`. A double-click returns the same attempt
and the same checkout URL (Paystack initialize is idempotent on our reference per the
seam contract). A deliberate second contribution gets a new key and is allowed. This
never blocks legitimate repeat contributions.

### 4.4 Reference format

`KLK-` + 26 characters of Crockford base32 from 16 bytes of `crypto.randomBytes` (128
bits). Matches Paystack's allowed set (`-`, `.`, `=`, alphanumeric). Unique index on
`payment_attempts.reference`. Distinct from the human contributor reference
(`BIO26-0042`), which stays a receipt label and is never a payment identifier.

### 4.5 Stock reservation (tickets, items, quantity-limited tiers)

- `stock_reservations(id, attempt_id, tier_id|item_id, quantity, status reserved|converted|released, expires_at)`.
- Remaining = `quantity_limit − Σ converted − Σ reserved and not expired`. Computed under `FOR UPDATE` on the tier/item row at attempt creation and again at capture.
- Reservation TTL = attempt expiry (proposal: 30 minutes; Paystack checkout can sit open longer, so this is a founder trade-off — **O-14**).
- Abandon/fail/expire → `released`. Capture → `converted`.
- **Late capture after release** (contributor paid after expiry): if stock still available → convert; else the attempt goes to `needs_review` with `stock_exhausted`. Money is recorded, never refused. Resolution needs refunds (DEFERRED) — so until refunds exist, the reservation TTL should be long enough that this is rare, and the sweep should verify before releasing.

### 4.6 Webhook processing

```
POST /api/webhooks/paystack   (Next.js route handler, excluded from auth middleware)
 1  body = new Uint8Array(await request.arrayBuffer())     — raw bytes, never re-serialised
 2  provider.authenticateWebhook(body, headers):
       prefer  Paystack-Signature:  |now − t| ≤ 300s; HMAC-SHA512(whsec, t + "." + body);
                                    constant-time compare against EVERY v1; accept any match
       else    x-paystack-signature: HMAC-SHA512(secret key, body), constant time
               (accepted only while PAYSTACK_WEBHOOK_SECRET is unset — config flag, logged)
       fail → 401, nothing stored
 3  parse; identity = (provider, provider_event_id)       — see PA-03 below
 4  insert financial_events ON CONFLICT DO NOTHING        — persist before acknowledging
 5  200 within ~1s (Paystack: respond within 5s, 30s timeout in test)
Worker (financial-event processor, same claim/backoff shape as notifications):
 6  claim next unprocessed event; subject = parseWebhookSubject
 7  transaction → orchestrator.confirmPayment(reference, 'webhook')
    transfer / refund / dispute → recorded, `ignored` until those subsystems exist
 8  append financial_event_processing_attempts row (succeeded | failed | unknown | ignored, next_retry_at)
```

**Dedupe key.** PA-03 says events have ids (the Webhook Events API lists/resends
them by id), but whether the id is present **in the delivered payload** is
UNVERIFIED. If it is not, the identity becomes
`(event_type, data.id, data.reference)` for charges — still unique per logical
event, and capture is idempotent on the attempt regardless. Resends are explicitly
non-idempotent per Paystack's docs, so this layer must hold either way.

**Optional hardening:** source-IP allowlist (52.31.139.75, 52.49.173.169,
52.214.14.220, per docs) at the edge as defence in depth, never instead of the
signature.

### 4.7 Verification and capture (one function for all three triggers)

Triggers: redirect callback page, webhook worker, sweep. All call:

```
confirmPayment(reference, trigger):
  attempt = load by reference (unknown reference → record as orphan event; never create money)
  if attempt.status in (completed) → return stored outcome          (idempotent read)
  r = provider.verify(reference)
  unknown   → return 'pending' (caller retries; webhook path logs attempt 'unknown')
  not_found → if attempt older than TTL → expire; else pending
  ok:
    map status: success→succeeded; failed→failed; abandoned→abandoned;
                ongoing/pending/processing/queued→pending; reversed→reversed (NEW);
                other→unrecognised
    succeeded → app.capture_payment(attempt_id, provider tx snapshot)
    failed/abandoned → app.mark_attempt_failed(attempt_id) (allowed only from created/initialized)
    reversed → needs_review (refund/chargeback subsystem deferred)
```

`app.capture_payment` — **one database transaction**:

1. Lock the attempt row `FOR UPDATE`. If `completed` → return existing contribution (idempotent).
2. Insert `provider_transactions` (unique `(provider, provider_transaction_id)`; store id as `text` — Paystack ids are unsigned 64-bit).
3. Validate: reference equal; currency `NGN` (else `needs_review`, never convert — PA-15); `amount == attempt.amount_kobo` exactly (else `needs_review: amount_mismatch` — money is recorded, not rejected); attempt's collection still exists.
4. CAS attempt → `captured` (from `created|initialized|failed|expired`); a `needs_review` attempt stays there with the new evidence attached.
5. CAS attempt `captured → processing`, then insert `contributions` (unique `attempt_id`), `contribution_lines`, `tickets` (one per unit, with attendee names), convert reservations (re-check stock if expired → `needs_review`).
6. Obligation: if present, set `paid` via the exempted capture role (readiness §2.2) when `amount == owed`; otherwise `needs_review`.
7. Post journals (idempotency keys `capture:<attempt>`, `fee:<attempt>`):
   - capture: Dr `provider_receivable` total charged / Cr `collection_pending` contribution amount (contributor-pays) or net (absorbs) / Cr `platform_fee_income` / Cr `provider_fee_expense` offsets — exact postings per the money-architecture doc §9, using `authoritativeProviderFee` (actual if `fees` present on verify, else estimate; record which).
8. Insert notification outbox rows: contributor receipt (dedupe key `receipt:<contribution>`), organiser alert.
9. Attempt → `completed`. Audit row.

**Transaction boundaries.** Steps 1–4 commit as transaction T1: the provider's
statement and the fact that money was taken are durable before any validation that
might fail. Steps 5–9 commit as transaction T2: the contribution, lines, tickets,
reservation conversion, obligation update, journals and outbox rows commit together
or not at all. If T2 fails, the attempt stays `captured` (or moves to `needs_review`
with a reason), a `financial_event_processing_attempts` row records the failure, and
the worker retries T2. This keeps the legacy "record the capture early" property
while the financial effect itself stays atomic and exactly-once.

### 4.8 Payment state machine

Adopt the existing machine (state-machines doc §1) with three additions:

| State | Money known? | Notes |
|---|---|---|
| `created` | no | row exists, provider not yet acknowledged |
| `initialized` | no | checkout URL issued |
| `failed` | no | provider said failed/abandoned/refused. **Not terminal**: a late `success` moves it to `captured` |
| `expired` | no | sweep gave up; also not terminal |
| `captured` | yes | provider confirmed money; recorded before validation |
| `processing` | yes | claim in progress |
| `needs_review` | yes | parked, visible, retried |
| `completed` | yes | contribution + journals exist. Terminal for the attempt |

Additions: (a) `reversed` provider status routes to `needs_review` with reason
`provider_reversed`; (b) reservation status follows the attempt; (c) the browser
redirect can only **trigger** `confirmPayment` — it has no transition of its own.

Forbidden (enforced by a `BEFORE UPDATE` trigger with a transition table, pgTAP-tested):
any transition out of `completed` except → `needs_review` by an operator; any move from
a money-known state back to a money-unknown state; `failed` overwriting `captured`;
anything that deletes an attempt. Refunds and chargebacks act on the **contribution**
(`applied → part_refunded/refunded/reversed`) via new journals, never by editing the
attempt.

### 4.9 Sweep and reconciliation

- **Sweep (worker, every few minutes):** attempts in `created/initialized` older than N minutes → `verify()`; older than TTL with `abandoned`/`not_found` → `expired`, release stock. Attempts in `captured/needs_review` with retryable reasons → retry capture with backoff. Because Paystack only webhooks successes (N5), this is the only path that learns about abandonment.
- **Reconciliation:** boundary ③ (contributions ↔ ledger, zero tolerance) now; boundary ② (provider transactions ↔ attempts) after sandbox, using `GET /transaction` listing and the Webhook Events API to find successes with no local event. Reconciler never writes financial truth (existing design).

---

## 5. Deliverable 5 — Per-type integration blueprints

Common to every type (not repeated below): steps 1–10 of §4.3, capture per §4.7,
receipt via outbox, page states per §5.9.

### 5.1 Fixed — managed (dues) and per_member

- **A. Journey.** Open link → "Find yourself" → confirm identity → see amount owed (after waivers) and fee line → enter contact if missing → Pay → Paystack → return → "Payment confirmed" (or "We're confirming your payment").
- **B. Backend.** Cookie → `getCollectionMemberContext` → obligation (`expected − waived − applied`) → resolver (`fixed`/`per_member` with obligation) → attempt carries `obligation_id`, `member_id`, `cycle_key`. Capture marks obligation `paid` when the contribution equals amount owed.
- **C. Pricing.** Base = amount owed. Fees on base by `fee_mode`.
- **D. DB.** intent(member_id, obligation_id), attempt, contribution(obligation_id), obligation status, journals.
- **E. Controls.** Member id only from the signed cookie; obligation re-read inside `create_payment_attempt` and `capture_payment` (status still payable, amount unchanged); **one live attempt per obligation** (partial unique index on `payment_attempts(obligation_id) where status in ('created','initialized')`), so two tabs cannot pay twice.
- **F. Failures.** Obligation waived/exempted between initialize and capture → capture records money, attempt `needs_review: obligation_changed` (overpayment is a visible state, D-18). Paid twice from two devices despite the index (e.g. after expiry) → second is `needs_review: already_paid`.
- **G. Edge cases.** Officer changes `fixed_amount_kobo` (blocked after publish — ADR 0012). Member archived mid-checkout. Waiver making owed 0 → `NOTHING_OWED` before Paystack.
- **H. Tests.** resolver vectors (exists); pgTAP: only capture role can set `paid`; concurrency: two attempts for one obligation; E2E: pay → obligation shows paid.
- **I. Frontend.** Show "already paid" state from obligation; disable pay while an attempt is live and show "resume payment".

### 5.2 Recurring (managed)

As 5.1, plus: attempt names `cycle_key`; resolver loads the obligation **for the open cycle the member chose**; payment never applies to another cycle (O-11 roll-forward stays undecided → overpayment is `needs_review`). Cycle closed between initialize and capture → money recorded, `needs_review: cycle_closed`. Stored-card auto-charging is O-12 and **not built**: `authorizationReference` is stored hashed, never charged.

### 5.3 Fixed — open audience

Base = `fixed_amount_kobo`; client amount ignored (resolver already). Unlimited repeat
contributions. Controls: window check; ceiling irrelevant. Tests: tampered amount is
ignored, not rejected.

### 5.4 Open contribution and fundraiser

- **Pricing.** Base = parsed `fromNaira` input; `min ≤ base ≤ min(max, PLATFORM_MAX)`. `PLATFORM_MAX` is a founder number (readiness §2.5), enforced in the resolver **and** a `CHECK` on `payment_attempts.amount_kobo` (also bounded below `bigint` and Paystack limits).
- **Target.** `target_amount_kobo` is display-only today. Decide (**O-15**) whether reaching it closes the collection; default recommendation: it does not (over-funding is normal for appeals), and progress is computed from the ledger view, never a stored total.
- **Bearer.** Legacy forced fundraiser fees onto contributors. New D-15 lets the organiser choose with default `community_absorbs`. Migrating fundraisers change behaviour — part of N3.
- **Anonymous.** `allow_anonymous` controls display of the name; email is still required by Paystack. Store contact in the intent (officer-readable), show "Anonymous" publicly.
- **Concurrency.** No stock; totals are ledger sums, so concurrent captures cannot corrupt them.
- **Tests.** min/max/ceiling boundaries; `1.005k` parsing (fixed in readiness F-1); 20-digit input refused; tampered suggested amount irrelevant.

### 5.5 Tiered (packages)

- **Pricing.** `tierId` → `collection_tiers` row **by id**, same collection, not `hidden`, price > 0. Quantity 1.
- **Controls.** No name ever reaches matching (ADR 0010). Fix the resolver gap: the single-`tierId` path skips `quantityLimit` (readiness §2.3) — once stock can be exhausted, route single selection through the basket path or apply the same check. Attempt stores `tier_id` (FK, NOT NULL for tiered).
- **Regression test (mandatory).** Two tiers with names differing only by suffix and different prices (the 2026-08-06 case) plus same-price tiers: selecting each id charges its own price at initialize **and** capture records the same tier id. Also assert the DB refuses duplicate names (exists).

### 5.6 Ticketing

- **Pricing.** Basket of `(tierId, qty)`, each line priced by id; `per_order_limit`; stock reservation per line.
- **Attendees.** One name per unit when `collect_attendee_details` (count checked against the server-resolved quantity — exists). Stored in the intent; tickets issued per unit at capture, each with its own code.
- **Window.** Sales window = `starts_at`/`deadline_at`; event date is separate. Refuse after `deadline_at` even if the event hasn't happened.
- **Overselling.** Reservation under row lock (§4.5). Concurrency test: N parallel attempts for the last K tickets → exactly K reservations.
- **Check-in.** Existing `event_check_ins` must reference `tickets`, which only exist after capture.

### 5.7 Items

As ticketing with `collection_items`: `quantity_available`, `max_per_order`, basket,
reservation, `contribution_lines` per item. Decide whether `quantity_available` is a
live counter or a capacity (readiness §2.3) — recommendation: keep it as capacity and
derive remaining from reservations + converted lines, so there is no mutable counter
to drift.

### 5.8 Installments (all types with `installments_allowed`)

DEFERRED (D-19). Orchestrator refuses partial amounts. Blueprint lives in the money
architecture §13 and waits for O-7/O-13.

### 5.9 Frontend states (every type)

| State | When | UI |
|---|---|---|
| Review | after server resolution | lines, contribution, each fee, total charged, bearer wording; "Pay ₦X" |
| Submitting | action in flight | button disabled, spinner; same idempotency key on retry |
| Redirecting | URL received | "Taking you to Paystack" |
| Confirming | callback page, `confirmPayment` returns pending | poll every 2–3 s up to ~60 s, then "We'll email your receipt when it's confirmed"; never "failed" on a timeout |
| Confirmed | attempt `completed` | receipt (redacted for non-owners), contributor reference, ticket codes |
| Under review | `needs_review` | "Payment received; we're checking it — reference KLK-…"; no retry button |
| Failed/abandoned | provider failed | "No money was taken"; "Try again" creates a new attempt |
| Sold out / closed / changed | refusals | specific message, refresh prompt |

The callback page is never evidence: it shows what the server says about the
reference.

---

## 6. Deliverable 6 — Fee specification

### 6.1 Current rule set (new system, D-10…D-17)

| Item | Rule |
|---|---|
| Base | the contribution amount (sum of lines), never the payable |
| Platform fee | 150 bps, all categories, cap ₦5,000 (500,000 kobo) |
| Provider fee (model) | 150 bps of base, cap ₦2,000 — **an estimate** (D-11) |
| VAT | 0 bps on the platform fee, explicit |
| Rounding | half away from zero, once per component, on integer kobo (`money.ts`) |
| Bearer | `fee_mode` frozen on the attempt: `contributor_pays` → total = base + fees, collection credited base; `community_absorbs` → total = base, collection credited base − fees |
| Snapshot | attempt stores contribution, platform, estimated provider, VAT, total fees, total payable, net, bearer, schedule version; `actual_provider_fee_kobo` added at capture from `verify.fees` |
| Authority | ledger posts `authoritativeProviderFee` (actual if reported) |

### 6.2 What production charges today (N3)

0.5% (1% fundraising) platform, cap ₦2,000; 1.5% gateway model, cap ₦2,000;
fundraising always contributor-pays. **Switching an organiser to the new system
roughly triples the platform fee on small and mid payments** (₦10,000: ₦50 → ₦150)
and raises the cap. D-10 is a recorded founder decision; this document does not change
it. It asks for explicit reconfirmation and an organiser-communication plan before any
collection takes money on the new system.

### 6.3 Worked examples (founder schedule)

Computed with `calculateFees` semantics; to be pinned as golden vectors (some already
are in `packages/domain/test/fees.test.ts` — extend, don't duplicate).

| Base (₦) | Platform (₦) | Modelled provider (₦) | Contributor pays: total | Absorbs: collection net |
|---|---|---|---|---|
| 100.00 | 1.50 | 1.50 | 103.00 | 97.00 |
| 2,000.00 | 30.00 | 30.00 | 2,060.00 | 1,940.00 |
| 10,000.00 | 150.00 | 150.00 | 10,300.00 | 9,700.00 |
| 100,000.00 | 1,500.00 | 1,500.00 | 103,000.00 | 97,000.00 |
| 133,333.33 | 2,000.00 | 2,000.00 (cap reached by rounding) | 137,333.33 | 129,333.33 |
| 200,000.00 | 3,000.00 | 2,000.00 (cap) | 205,000.00 | 195,000.00 |
| 333,333.33 | 5,000.00 (cap reached by rounding) | 2,000.00 | 340,333.33 | 326,333.33 |
| 1,000,000.00 | 5,000.00 (cap) | 2,000.00 | 1,007,000.00 | 993,000.00 |

Required vectors also at: 1 kobo; ₦0.01 below/above each cap threshold; the platform
max; `bigint` overflow refusal.

### 6.4 Provider-fee model vs Paystack's published pricing (N2)

Paystack NG (pricing page, 2026-11-10):

| Channel | Fee |
|---|---|
| Local card, USSD, bank | 1.5% + ₦100, ₦100 waived under ₦2,500, capped ₦2,000 |
| International card | 3.9% + ₦100, **no cap** |
| Pay with transfer / DVA | 1%, capped ₦300 |
| Transfers out | ₦10 / ₦25 / ₦50 by band (≤₦5k / ≤₦50k / >₦50k) |

Paystack charges on the **amount charged** (which, under `contributor_pays`, already
includes Kolekto's fees). Effects at ₦10,000 base, local card:

| | Contributor pays | Community absorbs |
|---|---|---|
| Charged | ₦10,300 | ₦10,000 |
| Modelled provider fee | ₦150 | ₦150 |
| Actual Paystack fee | 1.5% × 10,300 + 100 = **₦254.50** | 1.5% × 10,000 + 100 = **₦250** |
| Variance | ₦104.50 | ₦100 |
| Who loses it, as currently specified | Kolekto (collection was promised ₦10,000; platform income covers the gap) | the organiser (net provisional ₦9,700 → actual ₦9,600) unless Kolekto absorbs |

International card at ₦100,000 contributor-pays: actual ≈ 3.9% × 103,000 + 100 =
₦4,117 vs modelled ₦1,500.

**Options (founder decision F7 — not decided here):**

1. **New schedule version with an exact local-card model:** `gatewayRate 150 bps + flat ₦100 above ₦2,500 charged, cap ₦2,000`, computed on the gross for `contributor_pays` by solving `T − fee(T) = base + platform` (closed form when uncapped, `T = ceil((base + platform + 100) / 0.985)`), then verifying the cap branch. Requires `FeeSchedule` to gain a flat component and threshold — a new version, never an edit.
2. **Restrict channels** at initialize (`channels: ["card","bank","ussd","bank_transfer"]`) and decide whether to refuse or surcharge international cards (BIN country known only after the fact — so model as `needs_review`/absorb policy).
3. **Keep the 1.5% estimate** and define in writing that Kolekto absorbs the variance under `contributor_pays` and the organiser bears it under `community_absorbs`. Cheapest to build; makes the contributor-facing total visibly "wrong" versus Paystack's own receipt.

Whichever is chosen, the existing guarantees hold: estimate and actual are both
stored, the ledger uses the actual, the variance is a reconciliation input.

### 6.5 Other fee rules

- **Failed/abandoned/expired:** no fee, no journal.
- **Refunds:** DEFERRED; 3% refund charge with OPEN bearer (F1) and base (F2); PA-13 unknown. Original fee snapshot is never edited; a refund is a new row with its own fee lines.
- **Subaccount split:** with D-01, initialize passes `subaccount` and `bearer` (`account` | `subaccount`). Whether Paystack's split fee treatment matches the model is PA-06 (UNVERIFIED). `transaction_charge` can pin Kolekto's share per transaction; recommend setting it to platform fee + modelled/actual-provider policy explicitly rather than relying on a subaccount percentage.
- **Withdrawal fee:** brackets OPEN (O-2); Paystack transfer cost (₦10/25/50) is a separate expense line.

---

## 7. Deliverable 7 — Security and financial integrity report

### 7.1 Threats → controls (new system)

| Threat | Control | Test |
|---|---|---|
| Amount manipulation | server resolution by id + DB re-derivation; client total only compared | tampered amount/tier/qty/line ids |
| Tier/item substitution, cross-collection ids | DB function requires tier/item belongs to the attempt's collection; FK + tenancy trigger | foreign tier id |
| Reference substitution (pay cheap, confirm expensive) | capture loads attempt **by reference** and compares `verify.amount == attempt.amount_kobo` and reference equality | verify returns different amount |
| Forged callback / success page | callback only triggers `verify()` | call callback with fabricated reference |
| Webhook spoofing | `Paystack-Signature` (whsec, timestamp) or legacy header, constant-time; 401 before parse | bad/missing/old-`t` signatures |
| Webhook replay | 300 s window + unique event identity + idempotent capture | replay same body after 10 min; resend same event |
| Race: webhook ∥ redirect ∥ sweep | attempt row `FOR UPDATE`, CAS transitions, unique `contributions.attempt_id`, unique journal keys | parallel `confirmPayment` ×N |
| Oversell | reservations under row lock | parallel last-ticket |
| Contributor marks own payment successful | no client-callable write; all writes `app.*` definer with fixed `search_path`; anon has no EXECUTE | grant matrix + `PUBLIC` EXECUTE invariant |
| RLS bypass | RLS forced; intents/attempts officer-readable only via `has_permission(community_id,…)`; contributor PII never in public reads | RLS pgTAP per new table |
| Privileged role misuse | capture function runs as a restricted owner role, the only role exempted from `block_manual_paid_status` | pgTAP: other roles cannot set `paid` |
| Initialization abuse (provider-side spam) | durable rate limit (DB-backed, like notification limits) per IP/collection; CAPTCHA only if abuse observed | burst test |
| Open redirect | callback built server-side | supply `callback_url` → ignored |
| Metadata trust | metadata carries `attempt_id` only for humans; resolution is by reference | verify with altered metadata |
| PII in logs | log reference + attempt id; never raw payload, email, phone; payload only in `financial_events.payload` (no client read) | log scrape test |
| Secret exposure | secrets server-only (`PAYSTACK_*` never `NEXT_PUBLIC_`); gitleaks in CI; never print | invariant: no `PAYSTACK_SECRET` outside adapters/config |
| Clickjacking on pay pages | `frame-ancestors 'none'` (readiness F-3); script CSP once checkout method chosen (redirect needs none for Paystack JS) | header test |

### 7.2 Missing protections today (new repo) — must land with the integration

1. Window enforcement (N4). 2. Platform ceiling. 3. Stock reservation. 4. `amountOwed` minus applied. 5. Capture-role exemption for `paid`. 6. Durable rate limiter. 7. Signature scheme per N1 (update PA-01). 8. `reversed` status mapping (N5). 9. Single-tier `quantityLimit` check. 10. Monitoring (Sentry unused).

### 7.3 Live-environment actions for the owner (not engineering, not done here)

- **Rotate the legacy live Paystack secret key** and confirm in writing (N6). Rotation breaks the live system until it redeploys with the new key — schedule both together.
- Consider closing L1 (verify overrides), L2 (verify PII/email), L7 (receipt relay) in the legacy system while it remains live.
- Provision the **new** Paystack test account, generate a `whsec_` webhook signing secret for it, and never share keys with the legacy integration (D-22).

---

## 8. Deliverable 8 — Database migration plan

All **additive**. No drop/rename. Local first; staging only after review; production
only after explicit authorization. Each migration states its rollback (drop the new
objects — safe because nothing else depends on them until the next milestone).

| Order | Migration (proposed name) | Contents | Rollback |
|---|---|---|---|
| 1 | `…_payment_enums.sql` | `payment_attempt_status`, `contribution_status`, `stock_reservation_status`, `ticket_status` enums | drop types |
| 2 | `…_contribution_intents.sql` | intent table: collection/community ids, `checkout_idempotency_key` (unique per collection), selection lines (jsonb **of ids and integer quantities only**, validated by function), contact, answers, attendee names, member/obligation/cycle; RLS forced, officer select; no client write | drop table |
| 3 | `…_payment_attempts.sql` | `reference` unique, `intent_id` unique, `amount_kobo app.kobo CHECK > 0 AND ≤ platform max`, `currency='NGN'`, fee snapshot columns + `fee_schedule_version` FK, bearer, `tier_id` FK, `obligation_id` FK, `expires_at`, `provider_access_code`, status + `status_changed_at`; partial unique on `obligation_id` where live; CHECKs: `total_payable = contribution + (contributor ? fees : 0)`, `net = contribution − (absorbs ? fees : 0)`; transition trigger | drop |
| 4 | `…_stock_reservations.sql` | as §4.5; index `(tier_id) where status='reserved'`, `(item_id) …` | drop |
| 5 | `…_provider_transactions.sql` | append-only; unique `(provider, provider_transaction_id, fetched_hash)`; `provider_transaction_id text`; amount, currency, status raw + mapped, fees, paid_at, channel, hashed authorization, `superseded_by` | drop |
| 6 | `…_contributions.sql` | `attempt_id` unique, collection/community, `amount_kobo`, net, bearer, status (`applied` …), `obligation_id`, `cycle_key`; `contribution_lines` (unique `(contribution_id, line_no)`, tier/item FK, qty, unit price, amount); `tickets` (unique code, line FK, attendee name) | drop |
| 7 | `…_ledger_account_codes_more.sql` | E5: `transfer_fee_expense`, refund-charge account; per-collection account provisioning function `app.ensure_collection_accounts` | delete code rows only if unused (append-only table → add with care; rollback = new codes unused) |
| 8 | `…_payment_functions.sql` | `app.create_payment_attempt`, `app.mark_attempt_initialized`, `app.mark_attempt_failed`, `app.capture_payment`, `app.post_capture_journals`, `app.expire_attempts`, `app.resolve_payment_review` (permissioned); capture role + `block_manual_paid_status` exemption; explicit `REVOKE … FROM PUBLIC, anon, authenticated` | drop functions |
| 9 | `…_payment_grants.sql` | worker/web execution role grants; grant-matrix test update | revoke |
| 10 | `…_payment_rate_limits.sql` | durable initialize limiter (mirror `notification_rate_limits`) | drop |
| 11 | `…_fee_schedule_<version>.sql` | only if F7 chooses a new provider-fee model: new `fee_schedules` row + `flat` columns (additive, nullable) | the row stays (append-only); the code stops referencing it |
| 12 | `…_reconciliation.sql` | `reconciliation_runs`, `reconciliation_records` (boundary ③ then ②) | drop |

Generated types (`packages/db/src/generated-types.ts`) regenerate after each. CI's
drift check must pass. `03_money_invariants.sql` gains the new money columns; the
"no function writes the ledger" gate is replaced by "only `app.post_capture_journals`
and listed writers write the ledger".

---

## 9. Deliverable 9 — Testing strategy

| Layer | Tests | Tooling |
|---|---|---|
| Unit (domain) | resolver per model incl. duplicate-name and same-price tiers, baskets, stock limits, window (once moved into a pure `isOpenForContributions(collection, now)`); fee vectors §6.3 + thresholds + overflow; gross-up solver if F7 option 1; reference format/entropy; status mapping table (all Paystack statuses); state transition table as data | vitest (`packages/domain/test`) |
| Unit (adapter) | Paystack adapter against recorded fixtures: initialize ok/refused/5xx/timeout→`unknown`; verify success/failed/abandoned/ongoing/reversed/not found; `Paystack-Signature` valid, wrong secret, stale `t`, future `t`, two `v1` (rotation), malformed; legacy header valid/invalid; body re-serialised → fails | vitest (`packages/adapters/test`), no network |
| Database | every new table: RLS forced, officer/collector/anon visibility, cross-community isolation; transitions allowed/forbidden; CHECKs; `paid` only via capture role; journals balance per capture for both bearers; idempotent capture (call twice → one contribution, one journal pair); reservation arithmetic; grant matrix; `PUBLIC` EXECUTE invariant | pgTAP (`supabase/tests`) |
| Integration (fake provider) | orchestrator end to end: submit → attempt → initialize → webhook (signed by fake) → worker → capture → outbox; Paystack failure; DB failure between provider ack and mark-initialized (sweep recovers); amount mismatch → `needs_review`; late success after `failed`/`expired` | vitest + local Supabase |
| Concurrency | duplicate webhook ×20 parallel; webhook ∥ redirect ∥ sweep on one reference; two browser sessions verifying; double-submit same idempotency key; last-ticket race N>K; parallel captures on one collection (ledger view equals Σ) | extend `scripts/verify/reference-concurrency.mjs` (`npm run test:concurrency`) |
| Security | tampered amount/tier/qty/foreign ids; invalid/replayed signatures; forged callback; anon/authenticated cannot execute money functions; contributor cannot read intents; callback_url ignored; logs contain no PII | vitest + pgTAP |
| Regression | 2026-08-06 tier collision (init + capture use same id); legacy L1–L13 each as a negative test; readiness F-2 (`NOTHING_OWED` after paid) | all layers |
| Sandbox (M8.9) | real test keys on staging: card success, failed card, abandoned checkout, bank transfer, webhook delay, webhook-before-redirect and reverse, resend from dashboard, `fees` field present (PA-05), subaccount split (PA-06), settlement timing (PA-04) | staging, Paystack test mode only |
| E2E | each of the seven flows to receipt; mobile; under-review screen | Playwright in CI (host memory limits locally) |

Never: live keys in tests, production data, or a live transaction.

---

## 10. Deliverable 10 — Implementation roadmap

Milestone numbers continue the existing sequence (Phase 4 plan §23). Effort in
engineer-days for one engineer familiar with the repo; ranges reflect review cycles.

| # | Milestone | Tasks | Files (verified paths or new beside them) | Depends on | Acceptance | Effort |
|---|---|---|---|---|---|---|
| **P0** | Decisions | F7 provider-fee model; N3 reconfirmation; O-14 reservation TTL; O-15 target behaviour; platform ceiling value; update PA-01/PA-03 for N1 | `docs/phase-4/financial-decisions.md`, `provider-assumptions.md` | founder | written answers | — |
| **M8.3** | Payment records | migrations 1–6 (§8); transition triggers; RLS; pgTAP | `supabase/migrations/*`, `supabase/tests/*`, `packages/db/src/generated-types.ts` | P0 ceiling | pgTAP green; drift clean; no writer yet | 6–9 |
| **M8.3b** | Resolver + window hardening | pure window check; single-tier stock check; `amountOwed − applied`; ceiling; status mapping incl. `reversed` | `packages/domain/src/contribution.ts`, new `payment-reference.ts`, `packages/adapters/src/payment-provider.ts` | — | unit tests incl. regressions | 2–3 |
| **M8.4** | Attempt + capture functions | migration 7–10; `app.create_payment_attempt`, `app.capture_payment`, journals, capture role, outbox rows; `packages/db/src/payments.ts` | `supabase/migrations/*`, `packages/db/src/*` | M8.3 | capture idempotent under parallel calls; journals balance; `paid` only via capture role | 8–12 |
| **M8.5** | Orchestrator on the fake provider | `apps/web/lib/payments/*`; `submitContributionAction` creates attempts; callback page; review UI with fee lines; worker sweep + event processor | `apps/web/app/[communitySlug]/[collectionSlug]/*`, `apps/worker/src/*` | M8.4 | full flow green against `FakePaymentProvider` for all seven flows; E2E in CI | 8–12 |
| **M8.6** | Reconciliation ③ + concurrency proof | boundary ③; concurrency harness cases §9 | `scripts/verify/*`, migration 12 | M8.5 | zero-variance on generated load; all races resolve to one effect | 4–6 |
| **M8.7** | Monitoring | Sentry, health endpoint, alarms: `needs_review` depth, unprocessed events age, `suspense` ≠ 0, `v_ledger_imbalances` rows, attempts stuck `created` | `apps/web`, `apps/worker`, `packages/config` | M8.5 | alerts fire in staging drills | 3–5 |
| **—** | Infrastructure (external) | staging app with public HTTPS URL; new Paystack test account; `whsec_` secret; PITR planned for production | — | owner | URL reachable; keys in secret store | external |
| **M8.9** | Paystack adapter + sandbox | `paystack-payment-provider.ts`; `/api/webhooks/paystack/route.ts`; dual-header verification; sandbox runs; answer PA-04/05/06/03 | `packages/adapters/src/*`, `apps/web/app/api/webhooks/paystack/route.ts` | infra, M8.5 | sandbox matrix §9 passes; webhook ping ok; fees field captured | 6–9 |
| M8.10+ | Withdrawals, refunds, full reconciliation, disputes, installments, cutover | unchanged from Phase 4 plan §23 | — | PA-04, F1/F2, O-* | per plan | per plan |
| **Launch gate** | Controlled rollout | O-1 counsel; legacy key rotated; PITR on; staging soak with test money; one pilot collection in production with low ceiling; dual-running plan F5 | — | all above | explicit authorization | — |

Risks per milestone are in §11; the largest schedule risk is the external
infrastructure gap before M8.9.

---

## 11. Deliverable 11 — Risk register

| # | Risk | Likelihood | Impact | Severity | Mitigation |
|---|---|---|---|---|---|
| R1 | Legacy live secret misused (N6) | medium | account compromise | **Critical** | rotate now; confirm in writing |
| R2 | Provider-fee model under-charges/over-promises (N2) | certain | ~₦100/tx loss or organiser shortfall at scale | **High** | F7 before launch; reconcile estimate vs actual from day one |
| R3 | Fee policy change surprises migrating organisers (N3) | high | churn, disputes | **High** | reconfirm D-10; communicate; per-community override exists (`platformRateOverride`) |
| R4 | PA-04 false (no controlled settlement) | unknown | withdrawal product changes | **High** | sandbox first in M8.9; ledger already survives |
| R5 | Webhook verification built on the old header only (N1) | medium | spoofing resistance weaker; break when secret key rotated/deleted | **High** | implement both; prefer whsec |
| R6 | Oversell without reservations | high once ticketing is live | stranded money with no refund path | **High** | §4.5 before ticketing goes live |
| R7 | Pay after deadline (N4) | medium | unwanted funds, refund demand | Medium | window check in action + DB |
| R8 | No PITR on production ledger | — | unrecoverable ledger | **High** | mandatory before real money |
| R9 | Capture partially succeeds | low | inconsistent records | Medium | two-transaction design §4.7; retries; pgTAP |
| R10 | Paystack event id absent from payload | medium | weaker dedupe | Low | idempotent capture; fallback identity |
| R11 | International card fees uncapped | medium | large variance on big payments | Medium | channel policy (F7 option 2) |
| R12 | Initialization abuse | medium | provider-side noise, cost | Medium | durable rate limit |
| R13 | `needs_review` grows unwatched | medium | money parked | Medium | alarm + owner (O-9) |
| R14 | Dual-running with legacy (F5) | high at cutover | double collection | **High** | cutover plan milestone |
| R15 | Refunds deferred while overpayment/oversell possible | medium | no remedy in product | Medium | keep visible; manual ops runbook; prioritise F1/F2 |

---

## 12. Required architectural decisions (Q1–Q16)

1. **One orchestrator for all types?** Yes. The lifecycle after amount resolution is identical; the legacy system's two copies of pricing (Node + Deno) are exactly what produced drift. Type logic stays in the resolver and the DB re-derivation.
2. **What belongs to type-specific strategies?** Base amount, units/lines, stock, obligation/cycle binding, attendee names, post-capture artefacts (tickets, obligation status). Nothing about fees, references, Paystack, verification or the ledger.
3. **Where does fee calculation live?** Only `packages/domain/src/fees.ts` (D-12). The DB stores the snapshot and checks its arithmetic, never recomputes rates.
4. **Idempotent initialization?** Client-generated per-submission key unique per collection on intents; one live attempt per obligation; provider initialize idempotent on our reference; `unknown` provider results resolved by sweep, never by re-initializing.
5. **Verification ↔ webhooks?** Both are triggers into one `confirmPayment`; the webhook is persisted first and processed by the worker; capture is serialized by the attempt row lock.
6. **Exactly-once financial effects?** Unique indexes: `payment_attempts.reference`, `contributions.attempt_id`, `ledger_journals.idempotency_key`, `financial_events(provider, provider_event_id)`, `provider_transactions(provider, id, hash)`; CAS transitions; never read-then-insert (D-25).
7. **Reference structure?** `KLK-` + 128-bit base32; separate from the human contributor reference.
8. **Attempts ↔ contributions?** 1:1 via unique `contributions.attempt_id`; lines and tickets hang off the contribution.
9. **Retrying failed/abandoned payments?** A new intent + attempt (new reference). Old attempts stay; a late success on an old attempt still captures.
10. **Concurrent contributions?** No shared counter is incremented; totals are ledger sums; stock uses row locks + reservations; obligation uses a partial unique index.
11. **Totals and drift?** No total column. Collection position = ledger view; reconciliation boundary ③ asserts contributions ↔ ledger at zero tolerance.
12. **Fee snapshots?** Columns on `payment_attempts` + `fee_schedule_version`; actual provider fee on `provider_transactions`; both copied into journal metadata.
13. **Refunds and reversals?** New refund rows and reversing/compensating journals; contributions move `applied → part_refunded/refunded/reversed`; nothing is edited or deleted. Built after F1/F2/PA-13.
14. **Reconciliation?** Sweep for pending attempts; boundary ③ now; ② and ④ with sandbox data; Webhook Events API to find events we never stored; reconciler never writes financial truth.
15. **Legacy mechanisms to retain?** Server-derived amounts; impossible-state guard; persist-before-provider; record-capture-before-validate; atomic claim under lock; raw-body signature check; webhook-as-trigger; `needs_review`; explicit EXECUTE revokes; id-based tier matching.
16. **Legacy mechanisms to replace?** Floats; name fallback; overrides/heuristic recovery; mutable wallets and nightly recompute; 5xx-for-retry; predictable references; client callback URL; unauthenticated PII receipt endpoint; capture-time capacity; forced fundraiser contributor-pays (now a per-collection choice).

---

## 13. Decisions needed before implementation

| # | Question | Owner | Blocks |
|---|---|---|---|
| **F7** | Provider-fee model: exact local model with gross-up, channel restriction, or keep the estimate and assign the variance (§6.4) | founder | correct totals shown to contributors; M8.4 fee snapshot shape |
| **N3** | Reconfirm D-10 (1.5% / ₦5,000) versus today's 0.5%/1% / ₦2,000, and the fundraiser bearer change; organiser communication | founder | launch |
| **Ceiling** | Platform per-transaction maximum (kobo) | founder | M8.3 CHECK |
| **O-14** | Stock reservation TTL / attempt expiry | founder | M8.4 |
| **O-15** | Does reaching a fundraiser target close it? | founder | M8.5 |
| **PA-01/03 update** | Adopt `Paystack-Signature` + `whsec_`; confirm event id in payload | engineering + sandbox | M8.9 |
| **N6** | Legacy secret rotated? | owner | any Paystack use |
| Existing | O-1 (licence), O-4 (contributor fees legality), PA-04/05/06, F1/F2, O-7/O-13, F5 | as in the register | as in the register |

**This document stops here. No implementation will begin without explicit
authorization.**

---

## 14. Update 2026-11-11 — decisions taken and recommendations

### 14.1 Fee model — decided by the owner (replaces F7, resolves most of N2/N3)

**What the owner stated.**

- Contributors are shown **two fees: 1.5% processing and 0.5% Kolekto** — 2% in total.
- Internally, Paystack charges Kolekto **1%** on Kolekto's transactions (a negotiated
  rate; the rest of Paystack's public price is waived). Kolekto therefore keeps the
  other **1%**.

**What this means for the design.**

| Concept | Value | Where it lives |
|---|---|---|
| Processing fee (shown to contributor/host) | 1.5% of the contribution | new fee schedule version, `processingRate` |
| Kolekto fee (shown) | 0.5% of the contribution | same schedule, `platformRate` |
| Total fee charged | 2% (subject to caps, §14.2) | `calculateFees` |
| Expected Paystack cost (internal, never shown) | 1% of the **amount charged** | same schedule, `providerCostEstimateRate` — an estimate only |
| Actual Paystack cost | `fees` field returned by verify | `provider_transactions.provider_fee_kobo`, authoritative (D-11) |
| Kolekto's revenue | total fee charged − actual Paystack cost | ledger: `platform_fee_income` credited with the **whole** fee charged; `provider_fee_expense` debited with the actual Paystack fee |

This needs one change to the fee engine's shape: today `FeeSchedule.gatewayRate` is
both the line shown to the contributor *and* the estimate of Paystack's cost. Under
this model those are different numbers (1.5% shown, 1% cost), so the schedule gains a
separate internal cost estimate. It is a **new schedule version**; the existing
`2026-09-founder` row and `SCHEDULE_2026_09_FOUNDER` are not edited. Nothing in code
or the database has been changed yet.

Worked examples (rates as stated, caps as recommended in §14.2, Paystack cost 1% of
the amount charged):

| Contribution | Bearer | Contributor charged | Host receives | Paystack cost | Kolekto keeps |
|---|---|---|---|---|---|
| ₦2,000 | contributor pays | ₦2,040 | ₦2,000 | ₦20.40 | ₦19.60 |
| ₦10,000 | contributor pays | ₦10,200 | ₦10,000 | ₦102 | ₦98 |
| ₦10,000 | host absorbs | ₦10,000 | ₦9,800 | ₦100 | ₦100 |
| ₦500,000 | contributor pays | ₦504,000 | ₦500,000 | ₦2,000 if Paystack caps at ₦2,000; **₦5,040 if not** | ₦2,000; **−₦1,040 if not** |
| ₦1,000,000 | contributor pays | ₦1,004,000 | ₦1,000,000 | ₦2,000 if capped; **₦10,040 if not** | ₦2,000; **−₦6,040 if not** |

**Three things to settle before this is built:**

1. **Is the negotiated 1% capped?** If Paystack's 1% has no cap, every payment above
   roughly ₦400,000 loses money once Kolekto's own fees are capped (the last two
   rows). Get the cap, and whether the ₦100 flat fee is also waived, **in writing from
   Paystack**, then confirm it on the first sandbox transactions from the `fees` field.
2. **Does the 1% apply to international cards and pay-with-transfer?** Negotiated
   rates are often local-card only. Whatever the answer, the actual fee is recorded per
   transaction; add an alarm when Paystack's actual fee on a payment exceeds the total
   fee Kolekto charged on it.
3. **How the 1.5% is labelled.** Telling a contributor "Paystack charges 1.5%" when
   Paystack charges Kolekto 1% is a statement about a third party that is not true, and
   that carries consumer-protection and Paystack-terms risk. **Recommendation:** label
   the lines "Processing fee 1.5%" and "Kolekto fee 0.5%" (or one line, "Transaction
   fee 2%") and do **not** name Paystack or describe the processing fee as a pass-through.
   This keeps the numbers the owner wants and removes the false statement. The
   "provider fee disclosure wording" item is already on counsel's list (Phase 4 plan
   §20); this wording should go to counsel with it.

**How it compares with production today.** Production shows 1.5% gateway + 0.5%
platform (1% for fundraisers), each capped at ₦2,000. The decided model is the same
for every type except fundraisers, which go from 1% to 0.5% if one rate applies to all
(§14.2). The D-10 rates (1.5% + 1.5%, cap ₦5,000) are superseded, so N3's "price rise
for migrating organisers" largely disappears.

### 14.2 Fee recommendations for the parts not stated

| Question | Recommendation | Why |
|---|---|---|
| Caps | Processing fee capped at **₦2,000**, Kolekto fee capped at **₦2,000** (₦4,000 total maximum), **only if** Paystack's 1% is capped at ₦2,000 or less. If it is uncapped, either drop the Kolekto-fee cap or cap the total no lower than Paystack's cost at the platform ceiling | Same caps contributors see today; guarantees Kolekto never charges less than it pays |
| Fundraiser rate | **0.5%, the same as every other type** | One rate is simpler to explain and to disclose; today's 1% fundraiser rate is a revenue choice the owner can keep by adding a category rate (`fee_schedule_category_rates` already supports it) |
| Who bears the fee | Host chooses per collection, for every type including fundraisers; default **host absorbs** until counsel answers O-4 | Today fundraisers force fees onto donors; a choice is fairer and matches D-15 |
| Rounding | Half away from zero, once per fee line, in kobo (unchanged) | Already built and tested |
| Fee base | The contribution amount, never the total charged (unchanged) | Avoids a fee on a fee for the contributor |

### 14.3 Opening and closing dates — decided: dates only, enforced

**What the owner stated.** The opening and closing of a collection are **dates, with no
time**, and they must be enforced.

**Current behaviour (verified in code).** The wizard and settings use
`datetime-local` inputs (`NewCollectionForm.tsx:1012-1033`, `SettingsPanel.tsx:228-235`),
the values are stored in `collections.starts_at` / `deadline_at` (`timestamptz`), and
the input has no timezone, so the stored moment depends on the server's timezone.
`submitContributionAction` checks only `status = 'active'`; the dates are never
checked. The notification worker reads `deadline_at` for reminders
(`apps/worker/src/notification-rules.ts`).

**Rule (recommended precisely):**

- Dates are calendar days in **Africa/Lagos** (no daylight saving; assumption A-1).
- **Opening date:** contributions are accepted from **00:00 Lagos** on that day.
- **Closing date:** contributions are accepted **through the end of that day**
  (until 00:00 Lagos the next day). "Closes on 30 November" means people can still pay
  on 30 November.
- Opening and closing on the same day is allowed (a one-day window). The current check
  `deadline <= start → error` (`packages/validation/src/collection.ts:181`) becomes
  "closing date before opening date → error".
- Either date may be empty: no opening date means open on publish; no closing date
  means open until the host closes it.
- **Checked at the moment a payment is started**, both in the server action and again
  inside `app.create_payment_attempt`. A payment started before the window closes and
  finished after midnight is **still recorded** — money already taken is never refused.
- The public page shows "Opens 1 Dec" / "Closes 30 Nov" and disables the pay button
  outside the window; the server check is what actually enforces it.
- **Event dates keep their time.** `event_starts_at` / `event_ends_at` are when the
  event happens, not when payment opens, and an event needs a start time. A ticketing
  collection's default closing date becomes the event's date (sales through the end of
  that day).

**Schema recommendation (additive, reversible).** Add `opens_on date` and
`closes_on date` to `collections` as the source of truth. Keep `starts_at` /
`deadline_at` for existing readers (reminders, public page) but derive them by trigger
from the date columns (`opens_on` 00:00 Lagos; `closes_on` + 1 day 00:00 Lagos as the
exclusive end), so there is one place a host's choice is written. Backfill existing
rows by converting their timestamps to Lagos calendar dates. Inputs become
`type="date"`. Rollback: drop the trigger and the two columns; the timestamp columns
still hold the derived values. The new system has no production database yet, so the
backfill touches local and staging only.

Enforcement is pure and testable: `isOpenForContributions(opensOn, closesOn, now)` in
`packages/domain` (caller passes `now`, like `settlement.ts`), mirrored by the SQL
check, with vectors at 23:59:59 and 00:00:00 Lagos on both boundary days.

### 14.4 Fundraiser target — decided: the host may choose to close when it is reached

**What the owner stated.** A fundraising host can choose whether the collection closes
once the target is hit.

**Recommended behaviour:**

| Point | Recommendation |
|---|---|
| Setting | `close_when_target_reached boolean not null default false`, shown in the fundraiser's goal step only when a target is set; a `CHECK` refuses `true` without `target_amount_kobo` |
| What counts as "raised" | The sum of **contribution amounts** of completed payments — what donors gave, before fees, whoever bears them. Never a stored total; read from contributions/ledger |
| When it closes | Inside the capture transaction: after the contribution is recorded, lock the collection row, sum, and if raised ≥ target set status `active → closed` with reason `target_reached`, write an audit row, and notify the host |
| Payments in flight | Payments already started when the target is hit are **still recorded** in full and shown as received after the target was reached. Money is never refused |
| The final donation | Not trimmed to the remaining amount. Overshoot is allowed; trimming would surprise donors and only shifts the overshoot to the next concurrent payment |
| New checkouts | Refused once raised ≥ target ("This fundraiser has reached its goal") |
| Reopening | Explicit host action (raise the target and reopen, or reopen); turning the setting off does not silently reopen a closed collection |
| Hosts who do not opt in | Target stays a display goal; the fundraiser keeps accepting donations past it, as today |

### 14.5 Recommendations for the decisions still open

| # | Decision | Recommendation | Reason |
|---|---|---|---|
| Ceiling | Largest single payment | **₦5,000,000 per payment**, stored as a versioned platform setting (not a constant), with the host's own min/max inside it | Bounds fraud and fat-finger exposure; high enough for estate levies and dues; raise on evidence |
| O-14 | How long stock is held during checkout | **Hold 30 minutes.** Before releasing a hold, the sweep asks Paystack about the payment. Payment attempts stay checkable for **24 hours** (sweep at 5, 15, 30, 60 minutes, then hourly) | Long enough for card/OTP and bank-transfer checkouts; short enough that a popular event does not show "sold out" while seats sit in abandoned tabs |
| Late payment after a hold expired | Record it. If stock remains, issue it. If the item/ticket sold out meanwhile, mark the payment "needs review" and let the host decide (honour it or refund manually) | Refunds are not built; money must stay visible, never refused |
| PA-01 / PA-03 | Webhook signatures | Generate a `whsec_` signing secret on the **new** test account, verify `Paystack-Signature` (timestamp + 300-second window), accept the old `x-paystack-signature` only until the new header is confirmed on delivered events, then turn the old one off by config | Matches Paystack's current docs; replay protection; safe secret rotation |
| N6 | Legacy live secret key | Owner rotates it in a scheduled window together with a legacy redeploy, and records that it was done | It is recoverable from git history today |
| F1 / F2 | Refund charge | **3% of the amount actually refunded**, borne by the **collection (host)**, deducted from the collection's available funds; refunds allowed only while the collection has enough available balance | Proportional for partial refunds; the host chose to refund; never creates a debt on Kolekto |
| O-6 | Who can refund | Host requests, a second officer approves (`refund.initiate` already requires it), full or partial, no refund after funds are withdrawn without ops review | Uses permissions that already exist |
| O-7 / O-13 | Partial / installment payments | Keep deferred for launch; refuse partial amounts (already the plan). First type to add later: fixed dues, with each installment a normal payment against the obligation | Every type launches without it; it is the most complex rule set |
| O-11 | Overpaying one recurring period | Do not roll forward. Record the overpayment, show it to the host, resolve by refund once refunds exist | Automatic roll-forward hides money in a future period nobody has opened |
| O-12 | Saved-card auto-charging | Not at launch | Needs explicit consent/mandate design |
| Legacy `max_contributions` | Collection-wide cap on number of payments | Do not add unless a migrating host relies on it; ticketing/items stock covers the real cases | Avoids a second stock mechanism |
| F5 | Running old and new systems together | Move hosts per collection, never per community: new collections go to the new system; existing collections finish on the old one; no collection takes money in both | Clean attribution; no double collection |
| O-1, O-4, O-5, O-10 | Legal questions (holding funds/licence, passing fees to contributors, dispute liability, payload retention) | Take them, with §14.1 point 3's fee wording, to counsel as one pack before launch | Not engineering decisions; O-1 gates going live |

### 14.6 Effect on the roadmap

- **P0** shrinks to: Paystack written confirmation of the 1% (cap, flat fee,
  international, transfer channel); counsel pack (§14.5 last row); owner confirmation of
  the §14.2 and §14.5 recommendations.
- **M8.3** gains the date columns and trigger (§14.3), `close_when_target_reached`
  (§14.4), the platform ceiling setting, and the new fee schedule row.
- **M8.3b** gains `isOpenForContributions`, the schedule shape change (processing rate
  vs internal cost estimate) in `packages/domain/src/fees.ts`, and the switch of the
  wizard/settings inputs to `type="date"`.
- **M8.4** capture function gains the target check and auto-close.
- **M8.7** gains the alarm "actual Paystack fee > fee charged".
