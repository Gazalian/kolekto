# Incident: tiered-collection payment amount regression (reported 2026-08-06)

> **Phase 2 update (same day):** payment-initialization has been migrated
> out of the Supabase Edge Function entirely and into this backend's new
> `services/paymentService.js`/`services/pricingService.js`, structurally
> eliminating the root cause described below (edge functions being an
> ungoverned, git-independent write path). `ContributeFlow.tsx` now calls
> `POST /api/payments/initialize-payment` directly. The Edge Function is left
> deployed, unmodified, and unused as a rollback target for a bake period —
> see the plan this was implemented from for the full rollout/rollback
> sequence. This does not change anything below, which remains the accurate
> record of the original regression and its root cause.

**Reported symptom:** collection `da3e3a24-1133-4cdd-8e2a-c3ca53389db1` ("FARSTECH
SIWES MALETE", a `tiered` collection) always sends ₦51,000 to Paystack Checkout
regardless of which price tier the contributor selects, and this bug was
reportedly fixed once before.

**Status:** Root-cause vulnerability found, confirmed live in production, and
fixed. The specific ₦51,000 figure in the report could **not** be reproduced
against this collection's actual production data (see "What did not match",
below) — the reporter may have the wrong collection ID, a stale screenshot, or
be describing a different incident. The vulnerability that was found and fixed
is real, independently confirmed, and matches the *mechanism* described
(a previously-fixed tier-selection bug reappearing in production).

---

## Root Cause

The payment flow for this collection does **not** go through this repository
(`kolekto-be-old`) at all. `kolekto-fe-old/src/components/contribute/ContributeFlow.tsx:691`
calls a Supabase **Edge Function**, `initiate-paystack-payment`, directly via
`supabase.functions.invoke(...)` — bypassing `kolekto-be-old`'s
`POST /api/payments/initialize-payment` (`controllers/deposit.js#initializePayment`)
entirely. That backend route is well-defended (`validateContributionAmount`,
`routes/payment.js:9-13`) but is **not in the live path** for this collection
type. This alone violates this repo's CLAUDE.md write-authority rule
("Edge Functions do not own financial writes") and is the structural reason a
backend-side fix can never protect this flow.

The edge function's amount logic (`normalizePaymentRequest` /
`matchTier`, `kolekto-fe-old/supabase/functions/initiate-paystack-payment/index.ts`)
re-derives `contributionAmount` server-side from `collection.price_tiers`,
matched against `metadata.selectedTierId` — it does **not** trust the client's
claimed amount. A commit on 2026-08-01 (`8294d28`, "Id verification", repo
`kolekto-ng/kolekto-fe-old`) hardened `matchTier()` after discovering that its
previous implementation:

```ts
// PRE-FIX (the exact code found live in production on 2026-08-06):
return (
  tiers.find((tier) => {
    if (requestedTierId && tier.tierId === requestedTierId) return true;
    if (requestedTierName && tier.tierName === requestedTierName) return true;
    return false;
  }) || null
);
```

resolves tiers with a single `.find()` that matches on **either** ID or name.
If two tiers in a collection share a display name (the fix's own commit
message cites a real example: "UI/UX — first payment" vs "UI/UX — full
payment"), the array-order-first tier with the colliding name wins regardless
of which tier's ID was actually selected — so every selection collapses to
one tier's price. This is precisely the symptom category reported ("no matter
which tier is selected, the same amount is always charged").

**On 2026-08-06 (before this investigation's fix), that exact pre-fix
`matchTier()` was confirmed live in production** — see "Why Previous Fix
Failed" below for the proof.

---

## Why Previous Fix Failed

This was **not** a merge conflict, a duplicated code path, or a frontend
regression. It was a **deployment/source-of-truth failure**:

1. The fix landed in git (`kolekto-fe-old`, commit `8294d28`, 2026-08-01,
   later merged to `main` via `3a9d6e8`).
2. Supabase Edge Functions in this project are deployed **manually**
   (`supabase functions deploy`) with **no CI/CD** wiring a git merge to an
   actual deploy. The function's own file header states it is designed to be
   "safe to paste directly into the Supabase web console editor" — i.e., the
   live function can also be edited completely outside git.
3. Using the Supabase CLI (already authenticated and linked to project
   `<PRODUCTION_PROJECT_REF-redacted>` in this environment), I pulled the **live deployed
   source** read-only (`supabase functions download initiate-paystack-payment
   --project-ref <PRODUCTION_PROJECT_REF-redacted>`) and byte-diffed it against git HEAD:
   **867 lines of difference**. The live function was the **pre-fix**
   version — missing the entire FPE-engine migration and the `matchTier`
   hardening from commit `8294d28`.
4. The function's own `updated_at` timestamp (`supabase functions list`)
   showed a deploy on **2026-08-05 14:31 UTC — four days after the git fix
   landed**. That means someone redeployed **stale/old source** to
   production *after* the fix already existed in git, silently reverting it.
   This is deployment amnesia, not a code-level regression.
5. Independently, production also contained a fix that git HEAD was missing:
   a phone-plausibility check (`isPlausiblePhone`/`MIN_PHONE_DIGITS`)
   addressing a separate, real incident (`kolekto-1783668829043-357419`, a
   contributor's email typed into the phone field). This proves the
   divergence goes **both ways** — the Supabase console and git each
   accumulated changes the other never received. There is no single source
   of truth for this function's code, which is the systemic condition that
   makes "a previously-fixed bug reappears" not just possible but inevitable
   over time.
6. This exact deploy-drift failure mode was **already documented** for the
   sibling function `verify-paystack-payment` in
   `docs/VERIFY_PAYSTACK_PAYMENT_DEPLOYMENT_RUNBOOK_2026-08-06.md` (written
   the same day), describing two prior incidents of stale/placeholder code
   being deployed to that function. `initiate-paystack-payment` was not
   covered by that audit and had the same disease.

### What did not match

The reported collection's real price tiers (pulled read-only from production,
`collections.price_tiers` for `da3e3a24-1133-4cdd-8e2a-c3ca53389db1`) are:

| Tier | Price | Fee-inclusive total (contributor-borne) |
|---|---|---|
| UI/UX (Physical Classes) | ₦80,000 | ₦81,600 |
| Data Analysis (Physical Classes) | ₦80,000 | ₦81,600 |
| Frontend (Physical Classes) | ₦90,000 | ₦91,800 |
| Cyber Security (Physical Classes) | ₦120,000 | ₦122,400 |

All names and IDs are unique — the pre-fix `matchTier()` collision bug cannot
actually be triggered by *this specific* tier set (no duplicate names). Every
real payment on this collection (4 paid contributions, `contributions` table,
2026-07-28 through 2026-08-01, cross-checked against `pending_payment_context`
and `payment_recovery_log`) charged **exactly** its selected tier's price.
₦51,000 appears nowhere in this collection's real transaction history, and
there has been no payment activity on it since 2026-08-01. The stale
production code was a real, live, unpatched vulnerability — it just happens
not to be triggerable by this particular collection's data. Any tiered/ticket
collection with duplicate tier display names, however, was exposed the entire
time production ran the pre-fix version.

---

## Files Changed

All changes are in `kolekto-fe-old` (the actual live payment surface for this
bug); no `kolekto-be-old` files were changed (its `initializePayment` path was
already correctly defended and is not in the live path for tiered checkout).

- **`supabase/functions/initiate-paystack-payment/index.ts`** (deployed to
  production, v13 → v14, verified byte-identical post-deploy):
  - Restored the 2026-08-01 `matchTier()` fix that had been silently reverted
    in production (ID-first resolution across all tiers, name is a fallback
    only — see inline comment).
  - Re-merged in the `isPlausiblePhone`/`MIN_PHONE_DIGITS` check that was
    live in production but absent from git, so this fix does not itself
    regress the `kolekto-1783668829043-357419` incident.
  - Added an **impossible-state guard**: for `tiered` and tiered-`ticket`
    collections, if the server-resolved tier price disagrees with what the
    client claimed it was paying (beyond ₦1 rounding tolerance), the request
    is now rejected (`409 tier_amount_mismatch` / `ticket_amount_mismatch`)
    instead of silently proceeding with the server value. This adds a second,
    independent layer of protection: even if `matchTier` itself is ever
    broken again by a future edit, this assertion catches the resulting
    inconsistency before Paystack is ever called.
  - Added one structured `TIER_AMOUNT_AUDIT` log line per initialization
    (collection ID, tier ID, tier name, tier price, frontend-claimed amount,
    backend-resolved amount, final Paystack amount in kobo and naira,
    correlated by the Paystack reference) — see "Regression Protection".
  - Updated the file's header comment to document the divergence and point
    at the verification discipline to use on every future deploy.
- **`supabase/functions/initiate-paystack-payment/index.audit.test.ts`** (new):
  Node-native regression suite (`node --experimental-strip-types --test`) —
  see "Regression Protection".
- **`package.json`**: added `test:edge-payment` script.
- **`vitest.config.ts`**: excluded `supabase/functions/**` from vitest's
  default glob so the new Node-native test file isn't picked up by `npm test`
  and run under the wrong test runner.

---

## Regression Protection

1. **Single source of truth for amount.** `contributionAmount` for every
   collection type is derived exactly once, server-side, inside
   `normalizePaymentRequest` — never from a client-supplied value. This was
   already true in the git-HEAD version; the fix here was making sure that
   version is what's actually running.
2. **Validation / impossible states.** New: for tiered and tiered-ticket
   checkouts, an explicit assertion now compares the server-resolved amount
   against what the client believed it was paying and **rejects** (not logs
   and continues) on any disagreement beyond ₦1. Confirmed live in
   production — see "Evidence" below.
3. **Logging.** Every initialization now emits one `TIER_AMOUNT_AUDIT` log
   line with collection ID, tier ID/name, tier price, frontend amount,
   backend amount, and the exact amount sent to Paystack (kobo + naira),
   keyed by the Paystack reference — the same correlation ID used throughout
   the rest of this pipeline (`PAYMENT_INITIATED`, webhook, verify).
4. **Regression tests.** `index.audit.test.ts` does **not** hand-maintain a
   mirror of the logic (a mirror is exactly what let this drift go
   undetected for days) — it reads the real `index.ts` file at test-run
   time, strips only the two Deno-only remote imports Node can't resolve,
   and dynamically loads the rest completely unmodified. 15 tests cover:
   every tier in the real collection's tier set (lowest/highest/middle,
   in-array-order and out-of-order selection), a synthetic duplicate-tier-name
   collision (the exact historical bug shape), the new impossible-state
   rejection for both tiered and tiered-ticket, unmatched-tier rejection,
   fixed collections, fundraising (custom amount + minimum enforcement),
   open_pool, flat tickets, and tiered tickets. I additionally proved the
   suite has teeth by mechanically reinstating the exact pre-fix `matchTier`
   body and re-running: 2 of 15 tests fail immediately; restoring the correct
   version returns to 15/15 — this is a genuine regression trap, not
   decoration.
5. **This can't silently happen again the same way** because: (a) the
   deployed source is now byte-verified against the file in this repo
   (`sha256sum` match confirmed post-deploy — see Evidence), (b) the test
   suite tests the actual shipped file rather than a copy that can drift
   independently, and (c) the file's own header now documents the
   verify-after-every-deploy discipline. What this does **not** yet fix: the
   underlying process gap (no CI enforcing that git and the deployed function
   agree) is still open — see "Recommended follow-up" below.

### Recommended follow-up (not done in this pass — scope was "fix the confirmed drift")

- Wire `initiate-paystack-payment` into the same CI-verified deploy
  discipline already written up for `verify-paystack-payment` in
  `docs/VERIFY_PAYSTACK_PAYMENT_DEPLOYMENT_RUNBOOK_2026-08-06.md` (hash
  checks, download-and-diff after every deploy, no more console-editor
  pasting as a parallel, ungoverned edit path).
- Migrate this payment-initialization write path into `kolekto-be-old`
  proper (`PaymentService` → repository), per this repo's own CLAUDE.md rule
  that Edge Functions must not own financial writes. As long as the edge
  function remains the live path, it remains a second, harder-to-govern copy
  of logic that also exists (in a more defensible form) in
  `controllers/deposit.js`.

---

## Evidence

**Live deployment drift (before fix), byte-diff:**
`git diff --stat` between the downloaded live source and git HEAD:
`1 file changed, 146 insertions(+), 867 deletions(-)` — production was
running a version 867 lines shorter, missing the FPE engine and the
`matchTier` fix.

**Deploy timestamp vs. fix timestamp:**
Fix commit `8294d28`: 2026-08-01 13:13:50 +0100.
Live function `updated_at` (pre-remediation): 2026-08-05 14:31:15 UTC.
→ stale code was deployed *after* the fix existed in git.

**Real production data for `da3e3a24-1133-4cdd-8e2a-c3ca53389db1`** (read via
Supabase REST, service role, read-only): 4 paid contributions, each charging
exactly its selected tier's price (₦80,000 / ₦80,000 / ₦90,000 / ₦120,000);
matching `pending_payment_context` and `payment_recovery_log` rows for all 4;
no activity since 2026-08-01; no ₦51,000 anywhere.

**Post-fix redeploy verification:**
- `supabase functions list` → `initiate-paystack-payment` v13 → v14, `status: ACTIVE`, `verify_jwt: false`.
- `supabase functions download` immediately after deploy → `diff` against the
  local file deployed from: **zero output** (byte-identical);
  `sha256sum` match: `860dc086c5d83d1c6d3d6e4f963dd16640ba9292dd3c5a599b2066cf56bc15ea` on both sides.

**Live smoke tests against the redeployed production function:**

| Test | Request | Result |
|---|---|---|
| CORS preflight | `OPTIONS` | `204` |
| Missing fields | `POST {}` | `400 {"error":"A valid email address is required."}` |
| Intentional mismatch (₦51,000 claimed against the real ₦80,000 UI/UX tier) | `POST` with `selectedTierId:"1", contributionAmount:51000` | **`{"error":"The amount for the selected tier does not match what was submitted. Refresh the page and try again.","code":"tier_amount_mismatch"}`** — the new guard, confirmed live |
| Correct selection (UI/UX tier) | `POST` with `selectedTierId:"1", contributionAmount:80000` | Success; `pending_payment_context` row written with `contributionAmount:80000, totalPayable:81600, selectedTier:"UI/UX (Physical Classes)", selectedTierId:"1"` — exactly correct, end-to-end, in production |

**Regression suite:** `npm run test:edge-payment` → **15/15 passing**;
mechanically reverting to the pre-fix `matchTier` body → **2/15 failing**
(proving the suite actually detects this exact regression class), then
restored to 15/15.

---

## Success Criteria — checked against this incident

- [x] Selecting any tier sends exactly that tier's amount to Paystack — proven both by the regression suite and a live production smoke test.
- [x] No hardcoded or stale amount can override the selected tier — `contributionAmount` is derived server-side only; client-claimed amounts are now asserted against it and rejected on mismatch.
- [x] Frontend, backend, and database use a single authoritative payment amount for this flow — `normalizePaymentRequest` inside the (now-correct, verified) edge function.
- [x] Automated regression tests cover all collection types — fixed, fundraising, open_pool, flat ticket, tiered ticket, tiered (every tier + a synthetic collision case).
- [x] Logging clearly records the chosen tier and final amount sent to Paystack — `TIER_AMOUNT_AUDIT` log line.
- [x] Root cause documented, not just the symptom — deployment drift with no CI-enforced git↔production parity, in both directions.
- [ ] **Partially open:** the previous regression *path* (manual, ungoverned deploys with no CI verification) is reduced by the verify-after-deploy discipline and the new test suite, but not structurally eliminated — see "Recommended follow-up." Closing that fully requires either CI-gated deploys for this function or migrating the write path into `kolekto-be-old` per the CLAUDE.md write-authority rule.
