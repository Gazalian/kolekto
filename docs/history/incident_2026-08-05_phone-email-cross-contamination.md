# Incident: contributor phone field accepting an email address, crashing payment recovery

**Date investigated:** 2026-08-05
**Trigger reference:** `kolekto-1783668829043-357419`
**Status:** Resolved. Stuck payment recovered automatically post-fix. No other payment affected by the same DB error. Bounded-retry safety net added.

## 1. Root cause

A contributor typed their email address (`rasaqalimat7@gmail.com`) into the phone field on the checkout form for collection `f4c30113-d4e0-4f1f-bf96-8deacc40720e` ("Busybrain Night Of Majesty"). The frontend only validated that the phone field was *non-empty*, not that it looked like a phone number, so the email string was accepted and sent through checkout unchanged.

`contributions.phone` is `varchar(20)`. `rasaqalimat7@gmail.com` is 23 characters. Every code path that tried to insert this value verbatim failed with Postgres error `22001` (`value too long for type character varying(20)`).

Because the failing insert happened inside `verify-paystack-payment` (after Paystack had already captured the charge), the contribution was never recorded, so the pending payment stayed "orphaned." The scheduled recovery sweep (`scheduled-payment-recovery`, pg_cron every 5 minutes) kept re-invoking `verify-paystack-payment` for this reference — and kept hitting the same crash — with **no cap on retry attempts**. Over 26 days this produced **15,190 recovery attempts on a single payment** (7,620 direct `22001` DB errors + 7,568 sweep-wrapper failures), none of which could ever succeed without a code change.

### Category
Backend/data-mapping validation gap, compounded by a missing bounded-retry safeguard in the recovery infrastructure. Not a frontend typo-only issue — a `normalizePhone()` fix for exactly this class of bug had already been written, tested, and deployed to the **TEST** Supabase project on 2026-07-20 (commit `01fcc7a`), but was never deployed to **PRODUCTION**'s edge functions. Production ran the unpatched code for the full 26-day window.

### Exact bug location (pre-fix)
- `kolekto-fe-old/supabase/functions/verify-paystack-payment/_shared1.ts` — `normalizePaymentRequest()` built `contact.phone` as `String(contactSource.phone || "").trim()`, no format check, no length cap.
- `kolekto-fe-old/supabase/functions/initiate-paystack-payment/index.ts` — same pattern, allowed the charge to be initiated at all.
- `kolekto-be-old/controllers/deposit.js` (`initializePayment`, Node backend legacy/parallel checkout path) — called `normalizePhone()` before insert (so it wouldn't have crashed) but never *rejected* an implausible value, silently persisting garbage.
- `kolekto-be-old/controllers/contribution.js` (`createContribution`, exposed as public `POST /contributions/:id`) — inserted `phone: phoneNumber` **completely raw**, no normalization at all. This is a second, independent live path with the exact same crash risk as the original incident.

## 2. Fix implemented

Defense-in-depth, smallest-correct-fix per domain — reject before a charge happens wherever possible, normalize defensively wherever a charge has already been captured (never make a contributor's captured payment un-recordable):

| Layer | File | Behavior |
|---|---|---|
| Frontend | `kolekto-fe-old/src/components/contribute/ContributeFlow.tsx` | Rejects phone input with fewer than 7 digits before submit. |
| Edge fn (pre-charge) | `initiate-paystack-payment/index.ts` (prod v13) | Rejects implausible phone with `400 invalid_phone` **before** calling Paystack — no charge happens. |
| Edge fn (post-charge) | `verify-paystack-payment/_shared1.ts` (prod v29) | `normalizePhone()` strips to digits + one leading `+`, caps at 20 chars — charge already happened, so this normalizes rather than rejects, guaranteeing the insert can never overflow again. |
| Node backend (pre-charge) | `controllers/deposit.js` (`initializePayment`) | Added `isPlausiblePhone()` rejection before the Paystack charge, matching the edge function. |
| Node backend (pre-persist) | `controllers/contribution.js` (`createContribution`) | Added `isPlausiblePhone()` rejection + switched raw `phone: phoneNumber` to `phone: normalizePhone(phoneNumber)`. This route had **no protection at all** before this fix. |

Shared logic lives in `utils/normalizePhone.js` (`normalizePhone`, `isPlausiblePhone`, `MIN_PHONE_DIGITS = 7`), mirrored in the edge functions' inlined `normalizePhone()` (Deno can't import across projects) with an explicit "keep in sync" comment pointing back to this file.

No database columns were widened. The fix is entirely at the mapping/validation layer, per the explicit instruction not to widen `varchar(20)` unless absolutely necessary — it isn't; a real phone number never approaches that length.

### Objective 3 — cross-contamination search
Grepped the whole backend for other `phone`/`email` write sites into financial tables. Found and fixed the two Node-backend gaps above (`deposit.js`, `contribution.js`). `controllers/auth.js` also has a `phone` field but it's passed to `supabase.auth.signUp()` — Supabase Auth's own `auth.users.phone`, a completely different table/domain than `contributions.phone`, not the crash pattern from this incident, and out of Phase 1 scope; left untouched.

## 3. Deployment record (production, `busfgcmbndleljklrcbd`)

| Function | Before | After | Notes |
|---|---|---|---|
| `initiate-paystack-payment` | v12 | **v13** | Clean deploy, diff-verified against reconstructed original before deploying. |
| `verify-paystack-payment` | v27 | **v29** | v28 was a self-caught mistake — deployed with `verify_jwt: true` instead of the original `false`. In practice this did not cause an outage (the sweep and frontend both call it with a `Bearer` service-role/anon key, which itself satisfies Supabase's JWT gate), confirmed by function logs showing normal 200/400/500 business responses, never 401, throughout the v28 window. v29 redeploy restored `verify_jwt: false` to match the original config and is now live, content-verified by pulling the deployed source back down and grepping for the `normalizePhone` fix. |
| `scheduled-payment-recovery` | v4 | **v5** | Added the bounded-retry cap (§4). |

Backend Node service (`kolekto-be-old`, this repo): `controllers/deposit.js`, `controllers/contribution.js` patched, not yet deployed by me — deploy per your normal release process for this repo.

## 4. Bounded retries + dead-letter (Objective 6)

Evidence for why this was necessary, beyond the triggering incident: two *other* references (`kolekto-1784148992963-944195`, `kolekto-1784149298956-451613`) were each retried **~5,950 times** over three weeks because Paystack reported "Transaction reference not found" (an abandoned checkout that never reached Paystack) — a permanent, unrecoverable outcome that the sweep's existing "definitive non-success" auto-resolve logic didn't catch, because that logic only handles Paystack responding with a *known* transaction in a terminal state, not "no such transaction at all" (which comes back as an HTTP-level error, not a status field).

Rather than enumerate every possible permanent Paystack error string, added a generic backstop:

- `scheduled-payment-recovery`: new `MAX_SCHEDULED_ATTEMPTS = 20` (~100 minutes of retries at the 5-minute cadence — generous for transient issues, nowhere near thousands). Once a reference's attempt count exceeds this, the sweep stops calling `verify-paystack-payment` for it and instead writes a `payment_admin_actions` row with `action: "auto_dead_letter"` (kept distinct from `mark_resolved`, which specifically means "Paystack confirmed this was never a real payment" — dead-letter means "we gave up, a human should look").
- `get_orphaned_payment_candidates()` (Postgres RPC, migration `exclude_dead_lettered_from_orphaned_payment_candidates`) now excludes references whose last admin action is `auto_dead_letter`, in addition to the existing `mark_resolved` exclusion — so the sweep actually stops.
- Nothing is deleted. `pending_payment_context` rows are untouched.
- **Manual replay is unaffected**: `retryPayment` / `manualReconcilePayment` in `controllers/admin/paymentMonitoring.js` call `verify-paystack-payment` directly and never go through the candidate RPC, so an admin can always retry a dead-lettered reference on demand.
- Admin dashboard (`getPaymentMonitoring`): added a `dead_letter` category, `isDeadLettered` flag per item, and a `stats.deadLettered` count — additive fields only, no existing response shape changed.

## 5. Recovery of the specific stuck payment

No manual recovery action was required. Sequence of events, verified against production data:

1. `verify-paystack-payment` v29 deployed at `2026-08-05 14:44` UTC (approx).
2. The next scheduled sweep run picked up `kolekto-1783668829043-357419` and called the now-fixed `verify-paystack-payment` at `2026-08-05T14:45:04Z`.
3. `payment_recovery_log`: attempt #15189 logged `success: true, note: "new_contribution_recorded count=1"` at `14:45:04.360659Z`; the sweep wrapper logged its own `success: true, note: "scheduled_recovery_succeeded"` at `14:45:04.730681Z` for the same event (two log rows from two different call sites logging the same single outcome — not two separate financial events).
4. `contributions` table: exactly **one** row for this reference — `status: paid`, `phone: "7"` (the email correctly reduced to its only digit and safely truncated, no crash), `amount: 3000.00`, `gross_amount: 3060.00`, `created_at: 2026-08-05 14:45:04.311418Z`.
5. `wallets` for collection `f4c30113-...`: `updated_at` matches the same timestamp; `pending_balance: 3000.00` — the organizer was credited **exactly once**, correctly, for a legitimate ₦3,000 contribution.
6. No duplicate contribution rows, no duplicate wallet credit, no other reference shares the `22001` error code — this was an isolated incident.

Direct Paystack API verification from a local shell was attempted but the `.env` in this repo only holds a stale/inactive `sk_live_` key (this repo's env is configured for the TEST Supabase project per CLAUDE.md's environment-separation rule) — that channel was abandoned rather than trusted. The authoritative confirmation instead comes from `verify-paystack-payment`'s own successful call to the real production Paystack secret key (configured in Supabase's function secrets), corroborated by the function's own logs and the resulting DB state above.

## 6. Regression tests

`tests/normalizePhone.test.js` — 9 tests, all passing, including the exact regression case:
```js
normalizePhone("rasaqalimat7@gmail.com") // -> "7"
isPlausiblePhone("rasaqalimat7@gmail.com") // -> false
```
Full backend suite (`npm test`): 216/216 passing after all changes.

## 7. Financial ledger integrity confirmation

- Exactly one `contributions` row exists for the trigger reference; `status: paid`.
- The organizer's wallet (`wallets` table) reflects this contribution exactly once (`pending_balance` increment matches the contribution's net amount, `updated_at` timestamp-aligned with the contribution insert).
- No other payment reference in `payment_recovery_log` ever hit Postgres error `22001` — the DB-crash class of this bug affected exactly one payment.
- The two unrelated "Transaction reference not found" references never had a Paystack charge captured against them (Paystack has no record of the transaction), so there is no stranded money — they are abandoned-checkout noise, now correctly bounded by the new attempt cap instead of retried indefinitely.
