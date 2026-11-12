# Pre-payment-integration readiness — 2026-11-10

A scan of the repository for what must be settled before the Paystack
integration (M8.9 and the money path behind it) begins. Everything below was
read from the live code and the running local database on branch
`feat/collection-creation-redesign`, not carried over from earlier reports.

**Baseline at the time of the scan:** `npm run typecheck` clean; all seven
source-tree invariants hold; every workspace unit suite passes (web 173,
domain 171, adapters, worker, config, db). Local DB has all 126 migrations
applied; every financial table has RLS enabled **and forced**.

---

## 1. Fixed in this pass

| # | What | Where | Effect on stored money |
|---|---|---|---|
| F-1 | `fromNaira("1.005k")` and 1,616 other valid "k" shorthand inputs were **refused**, because the shorthand was multiplied as a float (`1.005 * 1000 = 1004.9999999999999`). Now the decimal point is moved in the text. An exhaustive probe of 110,000 shorthand inputs: 1,617 refusals before, 0 after, and 0 wrong amounts either way. | `packages/domain/src/money.ts` | None. The old code never produced a wrong amount, only a false rejection. Every input it accepted parses to the same kobo value. |
| F-2 | The amount resolver would offer a member whose obligation is `paid` the **full amount again**. Unreachable today (`app.block_manual_paid_status` blocks every path to `paid`), and the first thing a verified payment makes true. It now refuses with `NOTHING_OWED`. | `packages/domain/src/contribution.ts` | None today. Prevents a double charge once payments exist. |
| F-3 | No security response headers were set. Added `frame-ancestors 'none'` + `X-Frame-Options: DENY` (clickjacking on contribution pages), `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` (collection URLs are not leaked to the payment provider on redirect), and HSTS (no `includeSubDomains`/`preload`). Deliberately **no** script CSP until the checkout method is chosen. | `apps/web/next.config.ts` | None. |

| F-4 | `supabase/tests/01_rls_coverage.sql` test 4 failed on committed code: it requires every `public` table to have a policy, while M13.3 (20261109100000) made two evidence tables policy-less on purpose and `49_m13_3_communication_policy.sql` asserts exactly that. The two tests contradicted each other. 01 now names those two tables as the intended exception. | `supabase/tests/01_rls_coverage.sql` | None. No schema change. |
| F-5 | `npm run lint` failed on generated build output in `apps/web/.next-qa/` (the `kolekto-web-qa` dev server's dist dir), not on source. Added to the ignore list beside `.next-e2e/`. | `apps/web/eslint.config.mjs` | None. |

Tests added: `packages/domain/test/money.test.ts` (k shorthand),
`packages/domain/test/contribution.test.ts` (paid obligation, fixed and
per-member).

---

## 2. Must be built as part of the integration (engineering, unblocked)

These are not bugs in today's code — they are places where today's code is
correct only because no money moves, and each becomes wrong the moment it does.

1. **Obligation balance ignores money received.** `amountOwed()` is
   `expected − waived`. Once a contribution can be applied it must be
   `expected − waived − applied`, and `in_installments` needs a defined meaning
   (O-7). Today a partly-paid member would be asked for the whole amount.
2. **The `paid` trigger has no exemption.** `app.block_manual_paid_status`
   refuses *every* role. Its comment promises the money function will run as a
   restricted role it exempts; that role and exemption do not exist. Design it
   with the capture function, and extend the pgTAP that asserts no other path
   can reach `paid`.
3. **Stock is static capacity, not remaining stock.** `collection_tiers.quantity_limit`
   (`> 0` by `CHECK`) and `collection_items.quantity_available` are never
   decremented, so "sold out" cannot occur. Paid orders need an atomic
   reservation (row lock or conditional decrement inside the attempt-creating
   transaction) plus release on abandon/fail, or two contributors can buy the
   last ticket. The single-`tierId` path in `resolveContributionAmount` also
   skips the `quantityLimit` check the basket path applies — harmless while the
   limit is always ≥ 1, wrong once it can reach 0.
4. **Contributor-borne fees are never shown to the contributor.** The public
   page receives `fee_mode` but never calls `calculateFees`; a
   `contributor_pays` collection confirms the base amount only. The total
   payable must be computed server-side (fee engine, frozen on the attempt) and
   shown before redirect. Enabling it by default stays blocked on O-4.
5. **No upper bound on an open amount.** Without a collection `max`, the server
   accepts any `fromNaira` value; a 20-digit input exceeds Postgres `bigint`.
   Needs a platform per-transaction ceiling (a founder number, ideally at or
   below the provider's limit) enforced in the resolver and the DB.
6. **Rate limiting is per-process memory.** `apps/web/lib/lookup-throttle.ts`
   says so itself. Payment initialization creates provider-side transactions,
   so it needs a durable limiter (DB-backed, like the notification rate limits)
   or edge limiting, not this one.
7. **`submitContributionAction` stores nothing** by design. It becomes the
   caller of the attempt writer; keep its server-side re-derivation of every
   figure (it is correct and well-tested).
8. **Webhook route placement.** Put the Paystack receiver under
   `/api/webhooks/` — `middleware.ts`'s matcher already excludes that prefix,
   so the request is not redirected to `/login`. Reuse the SES route's
   persist-before-acknowledge shape (`packages/db/src/webhook-events.ts`).

The schema/function list itself (`contribution_intents`, `payment_attempts`,
`provider_transactions`, `contributions`, ledger writers, account provisioning,
releases, reconciliation) is unchanged from
[phase-4-implementation-plan.md §4](phase-4-implementation-plan.md) and is not
repeated here.

---

## 3. Blocked outside the code — needs you, not an engineer

| Item | Blocks | Status in repo |
|---|---|---|
| **Rotate the legacy live Paystack secret** found in `kolekto-be-old` history (M8.1/M8.2 S4) | safe use of any Paystack account | No record in this repo that it was rotated. Confirm. |
| New, separately provisioned Paystack **test** account for the new system | adapter, sandbox verification | `.env.example` keys exist; nothing reads them |
| PA-04 — is subaccount settlement timing controllable? | the whole D-01 settlement model, withdrawals | UNVERIFIED |
| PA-05, PA-06, PA-08–PA-15 | fee truth, transfers, settlement reconciliation | UNVERIFIED / UNKNOWN |
| O-1 — may Kolekto hold/time third-party funds; licence? | going live with real money | counsel |
| O-4 — may fees be passed to contributors? | `contributor_pays` | counsel |
| O-2, O-3, O-6, O-7, O-11 | withdrawal fees/approval, refunds, partial payments | founder |
| O-10 — provider payload retention/residency | storing `financial_events.payload` long-term | counsel |
| Public staging URL with the app deployed | any webhook integration test | staging Supabase exists (`docs/environments/staging.md`); confirm the web app is deployed and reachable |
| Monitoring — `SENTRY_DSN` is declared and read by nothing | knowing a payment path failed | not wired |

---

## 4. Noticed, not changed

- **pgTAP against the local DB still fails in 5 files (07, 34, 40, 44, 51)
  because of local data, not code.** The local stack has email sending switched
  on, bulk send caps opened to 1000/day and 5/sec, 22 notification delivery
  rows, and a real user holding the fixture phone `+2348031234567`. Those tests
  assume a freshly reset database, which CI provides. Not changed here, because
  resetting the local database would discard that dev state. `npm run db:reset`
  followed by `npm run db:test` is the way to confirm.

- `README.md` status table is stale: says notifications are "Not built"; they
  are built and running (M13.x).
- `apps/web/middleware.ts` uses the filename Next.js 16 deprecated in favour of
  `proxy.ts`. It still works; renaming touches the auth path and was left alone.
- `contributor-session.ts` does not type-check `issuedAt` on read (a cookie
  without it would never expire). Not exploitable — the cookie is HMAC-signed
  and only the server writes it — but worth a one-line guard when that file is
  next touched.
