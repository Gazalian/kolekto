# Non-member contributions — payment-path technical design (for review)

Status: **PROPOSED — for owner review. Not approved for implementation. No code, migration or test written.**
Date: 2026-11-22. Requested by: owner review of Part F (section 2, "Non-member contributions are a separate phase").
Related: product doc `docs/product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md` Part F (F5, F7, F8, F10, F11 M9c/M10).

This document covers the change to the **payment path** that options B ("members and non-members") and A with
membership-ID proof ("members only") need. Option C ("everyone") is today's open collection and needs no payment-path
change. Nothing here changes Paystack integration, webhook handling, settlement, the ledger, withdrawals or
reconciliation.

---

## 1. What the code does today (read from itest, 2026-11-22)

| Where | Behaviour |
|---|---|
| `app.create_payment_attempt` | Managed collection (`audience_mode <> 'public'`): `p_member_id` is **required** (`MEMBER_REQUIRED`); the member must be returned by `app.get_collection_member_context` (`MEMBER_NOT_ELIGIBLE`). Open collection (`public`): a member id is **refused** (`MEMBER_NOT_EXPECTED`). `collections.allow_non_members` is **not read** anywhere in the payment path. |
| Where the member id comes from | `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`: `readContributorSession(collectionId)` — a server-side httpOnly cookie set by `findMemberAction` after `app.find_collection_member` returned exactly one match. Never a browser field. |
| `app.complete_payment_capture` | Locks the attempt, then the collection row (`for update`), then the obligation. A managed member with no obligation on an `all_members`/`groups` collection gets one created on capture (`20261114100000_obligation_on_capture`). Mismatches go to `needs_review` with a reason from a fixed vocabulary (`amount_mismatch`, `obligation_changed`, `already_paid`, …). Inserts the `contributions` row with `member_id`, `obligation_id`, `cycle_key`. |
| `public.contributions` | Append-only: `contributions_no_update`, `contributions_no_delete`, `contributions_no_truncate`. No column records how the payer was identified or their membership status. |
| `payment_attempts.review_reason` | Check constraint `payment_attempts_review_reason_vocabulary` — a new reason needs that constraint replaced. |
| Membership foundation (M9b, itest) | `app.validate_membership_id` issues a 30-minute access grant; `app.resolve_membership_access_grant(collection, token)` returns the member or null, re-checked live. **No payment code reads it yet.** |

Consequence: today a managed collection is members-only by construction, and an open collection is anonymous by
construction. "Members and non-members" does not exist in the payment path, whatever `allow_non_members` says.

## 2. Goals and non-goals

Goals:

1. Option B: on a managed collection with `allow_non_members = true`, a person who does not identify as a member can
   pay **as a guest**.
2. Option A with membership-ID proof: the member on the attempt comes from a valid access grant, checked **in SQL**.
3. Record, once, at capture, how the payer was identified and the member's status at that moment (F7).
4. Optional per-member contribution limit (F10), enforced at capture under the existing lock.

Non-goals: refunds, linking old payments (F8, separate M11), changing fees, settlement, ledger, withdrawals, Paystack
calls or webhooks; any backfill of existing contributions; creating Kolekto accounts; auto-classifying payers.

## 3. Proposed changes

### 3.1 New collection columns (M9c — collections, no payment function)

| Column | Type / default | Meaning |
|---|---|---|
| `member_verification` | enum `lookup` / `membership_id` / `membership_id_otp`, default `lookup` | How a member proves who they are. `lookup` = today's search. |
| `max_contributions_per_member` | `smallint null` (null = unlimited), check 1–1000 | F10. |

`allow_non_members` is reused, not duplicated. Default values keep **every existing collection exactly as today**
(`lookup`, unlimited, and `allow_non_members` already false on all existing managed collections — to be confirmed by a
count on each environment before M10, see §7).

### 3.2 New contribution columns (M10)

| Column | Values | Written |
|---|---|---|
| `payer_basis` | `member_verified` (grant), `member_identified` (lookup), `guest`; null = recorded before this existed | once, at insert, by `complete_payment_capture` |
| `member_status_at_payment` | the member's `member_status` at capture; null for guests and for old rows | once, at insert |

The columns are added nullable. **No existing row is updated** (the `contributions_no_update` trigger stays on; no
temporary disable). The attempt carries the same two values from creation (`payment_attempts.payer_basis`) so capture
does not have to guess.

### 3.3 `app.create_payment_attempt` (M10)

New optional parameter `p_access_token text default null` (signature change → drop + create, so the grant matrix test
and every caller are updated in the same migration). Decision table for a managed collection:

| `p_member_id` | `p_access_token` | `member_verification` | `allow_non_members` | Result |
|---|---|---|---|---|
| set | null | `lookup` | any | today's path, `payer_basis = member_identified` |
| set | any | `membership_id*` | any | **refused** `MEMBER_PROOF_REQUIRED` — the member must come from the grant |
| null | valid | `membership_id*` | any | member = `resolve_membership_access_grant`; `payer_basis = member_verified` |
| null | invalid/expired | any | any | **refused** `MEMBER_PROOF_EXPIRED` (generic wording to the browser) |
| null | null | any | **true** | guest: no member, no obligation, `payer_basis = guest` |
| null | null | any | false | **refused** `MEMBER_REQUIRED` (today's behaviour) |

Open collection (`public`): unchanged; `payer_basis = guest`.

Guest attempts on a managed collection: amount rules are those of the collection (`fixed` → the fixed amount;
`per_member` → **refused** `GUEST_NOT_SUPPORTED`, because a per-member amount has no member to read it from; `open` →
min/max as today). Lines/tiers unchanged.

Limit pre-check (only when `max_contributions_per_member` is set and a member is named): applied contributions for
that member on that collection **plus** unexpired `pending`/`initialized` attempts ≥ limit → `MEMBER_LIMIT_REACHED`.
This stops several open tabs; it is not authoritative (capture is).

### 3.4 `app.complete_payment_capture` (M10)

- Reads `payer_basis` from the attempt; reads the member's **current** status at capture and writes it to
  `member_status_at_payment`.
- A member who became `suspended`, `archived` or `merged` between attempt and capture: money has been captured, so the
  payment is never dropped. Proposed: `needs_review` with new reason `member_ineligible_at_capture`. (Alternative for
  review: apply it with the snapshot showing the status. Recommendation: review, because a suspended member is meant
  to be unable to pay.)
- Per-member limit (authoritative): re-count applied contributions for that member under the collection row lock the
  function already takes. At or over the limit → `needs_review` with new reason `member_limit_reached`. Never silently
  applied, never dropped.
- Guest capture: `member_id` null, `obligation_id` null, **no obligation created** (the on-capture rule requires a
  member already).
- `payment_attempts_review_reason_vocabulary` gains the two new reasons (constraint drop + add in the same
  transaction; existing rows all satisfy the wider list).

### 3.5 Web (after M10)

- Checkout reads the access grant from its own signed httpOnly cookie (separate from the contributor-session cookie)
  and passes the **token** to SQL, never a member id, for `membership_id*` collections.
- "Pay as a guest" button only when `allow_non_members` is true; the guest form asks name/email/phone as an open
  collection does today.
- Receipts: "Paid as a guest" wording; no member code.

## 4. Consequences

### 4.1 Existing managed collections

None while `allow_non_members = false` and `member_verification = 'lookup'` — which M9c sets as the defaults. The
decision table's first and last rows are exactly today's behaviour. Turning non-members on for an existing collection
is an officer action, audited, and changes only future attempts.

### 4.2 Obligations

- Guests never create, satisfy or reduce an obligation.
- Members' obligations work exactly as today (lookup or grant only changes *how* the member was established).
- Expected-vs-collected summaries must count guest money as collected but not against any obligation. Reports that
  join `contributions.member_id` to `members` must use a left join or treat null as "guest" — each one is listed and
  tested before M10 (register, expected summary, payment activity, reminders roster, overview counts).

### 4.3 Contribution limits

Applied, member-attributed contributions only. Guests are not limited (there is no identity to count). Payments
linked later (F8) never count. Refunds do not exist yet (D-31); when they do, refunded contributions should stop
counting (Q6).

### 4.4 Payment attempts

New nullable `payer_basis` on attempts; new error codes `MEMBER_PROOF_REQUIRED`, `MEMBER_PROOF_EXPIRED`,
`GUEST_NOT_SUPPORTED`, `MEMBER_LIMIT_REACHED` — mapped to plain wording in the web layer, with the grant failures
using one generic message (no enumeration). Idempotency (`checkout_key`) and reference handling unchanged.

### 4.5 Capture-time membership status

Written once, never derived later. Current membership is always read live from `members`; the snapshot answers only
"what was true when they paid".

### 4.6 Historical records

No backfill, no update, no trigger disabled. Every contribution captured before M10 shows "not recorded" for both new
columns. Linking an old guest payment to a member later is a separate append-only record (F8, M11), never an edit.

## 5. Risks and controls

| Risk | Control |
|---|---|
| A guest claims to be a member to reach someone's obligation | Guests never touch obligations; member path needs lookup or a grant checked in SQL |
| Grant replay after suspension | `resolve_membership_access_grant` re-checks status live; capture re-checks status again (§3.4) |
| Two tabs exceed a limit of 1 | Pre-check counts in-flight attempts; capture re-counts under the collection lock → `needs_review` |
| A report divides by members or inner-joins `members` | Every such query listed and tested with guest rows before M10 |
| Signature change breaks a caller | Drop + create in one migration; grant matrix test; typecheck catches TS callers |
| Money captured for an ineligible payer | Never dropped or auto-applied: `needs_review` with a reason, as for every other mismatch |

## 6. Tests (planned, none written)

- `78_contribution_eligibility.sql`: decision table rows one by one; guest on B creates no member, user or obligation;
  `per_member` + guest refused; existing public/unlisted/managed collections unchanged.
- `79_payment_snapshot_and_limits.sql`: snapshot values for each basis; member taken from grant only (a forged
  `p_member_id` with a `membership_id` collection refused); suspended-between-attempt-and-capture → `needs_review`;
  limit pre-check and capture check; guests not limited.
- Concurrency (`supabase-itest`, two connections): two captures for one member with limit 1 → one applied, one
  `needs_review`.
- Regression: `03_money_invariants.sql` and payment files 40–72 must pass **unchanged**; any change to their
  assertions is a stop-and-report.

## 7. Rollout and rollback

Order: itest → (approval) dev → (approval) staging → (approval) production, each separately approved.
Before M10 on any environment: count managed collections with `allow_non_members = true` (expected 0); if any exist,
stop and ask, because M10 would start accepting guests on them.
Rollback: restore the previous `create_payment_attempt` / `complete_payment_capture` bodies from a rollback script
kept with the migration; keep the new contribution columns (dropping them would lose recorded snapshots); revert the
review-reason constraint only if no row uses the new reasons.

## 8. Questions for the owner

1. Suspended/archived between attempt and capture: `needs_review` (recommended) or apply with the snapshot?
2. `per_member` collections: refuse guests (recommended), or let officers set a guest amount?
3. Guest receipts: show "Paid as a guest" (recommended) or nothing?
4. Should option B be allowed with `groups`/`selected_members` audiences (F5.2 rule), or only `all_members` at first?
