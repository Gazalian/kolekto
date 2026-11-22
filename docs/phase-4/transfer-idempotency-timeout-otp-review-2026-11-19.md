# Transfer idempotency (PA-08), timeouts (PA-09) and OTP: review before implementation (2026-11-19)

**Branch:** `feat/payment-receipts-alarms` (all earlier uncommitted work preserved; this session changed no source file).
**Scope:** read-only inspection of the live code and schema, Paystack official documentation, one Paystack **TEST-mode** probe.
Staging (`kwolxuoeqwuedydxzncb`) stays paused and untouched. Legacy production not touched. No Paystack setting changed.
**Status:** findings only. Implementation waits on the owner decisions in §7.

Evidence labels used below: **[TEST]** actual Paystack TEST-mode call · **[DOCS]** Paystack official documentation ·
**[CODE]** read from the live file · **[UNIT]** / **[pgTAP]** existing automated test · **[UNTESTED]**.

---

## 1. Paystack facts established

Sources: `paystack.com/docs/transfers/single-transfers/`, `docs-v2.paystack.com/docs/api/transfer/`,
`/api/transfer-control/`, `/transfers/managing-transfers/` (fetched 2026-11-19).

| Question | Answer | Evidence |
|---|---|---|
| Does the reference protect against duplicate transfers? | Docs: "retry the transaction with the same reference in order to avoid double crediting. If a new reference is used, the transfer would be treated as a new request." Guidance, not a formal contract. | [DOCS] |
| What does Paystack do with a reused reference? | Second `POST /transfer` with the same reference → **HTTP 400, `code: duplicate_transfer_reference`**, "Reference already exists on a transfer". Exactly **one** transfer exists afterwards, for both a sequential and a concurrent pair. | **[TEST]** probe below |
| Unknown reference on verify | `GET /transfer/verify/:ref` → **HTTP 404, `code: not_found`**. | **[TEST]** |
| Which call returns the OTP challenge? | `POST /transfer` returns `status: "otp"`, "Transfer requires OTP to continue", with a `transfer_code`. | [DOCS] + [TEST] |
| How is the OTP submitted? | `POST /transfer/finalize_transfer` `{ transfer_code, otp }`. | [DOCS] |
| **Who receives the OTP?** | **The Paystack business owner**: "OTP sent to business phone"; "sent to their mobile number (and email if enabled)". | [DOCS] |
| Is the OTP tied to a transfer? | Yes, finalize takes the `transfer_code`. | [DOCS] |
| Resend | `POST /transfer/resend_otp` `{ transfer_code, reason: "resend_otp" \| "transfer" }`. | [DOCS] |
| Expiry, invalid-OTP response, attempt limits | **Not documented.** | [UNTESTED] |
| Cancel after the OTP challenge | **No cancel endpoint documented.** | [DOCS] |
| Alternative to OTP | Dashboard "server approval": Paystack calls a Kolekto URL with the transfer payload before processing; Kolekto answers 200 (approve) or 400 (reject) after matching reference and amount. Bulk transfers require OTP off. | [DOCS] |
| Failed / reversed in test mode | "Test transfers always return success, because there is no processing involved." Failed and reversed cannot be produced in TEST mode. | [DOCS] |

### TEST probe (2026-11-19, `sk_test_` key, ₦100 each, existing local test recipient)

```
== sequential same ref kprobe_seq_1795094234
200 true  "Transfer requires OTP to continue"   otp TRF_hcq9ru8igrn1dsfg
400 false "Please provide a unique reference. Reference already exists on a transfer" duplicate_transfer_reference
== concurrent same ref kprobe_con_1795094234
200 true  "Transfer requires OTP to continue"   otp TRF_thr1i3u9tpxhi94l
400 false "...Reference already exists on a transfer" duplicate_transfer_reference
== list transfers: kprobe_seq_… count=1 · kprobe_con_… count=1
== verify unknown ref: 404 code=not_found
```

Side effect: two ₦100 TEST transfers sit at `otp` on the TEST dashboard (never finalized; no real money).
Not run: the same probe on a live key (forbidden this session).

## 2. Current withdrawal and transfer flow [CODE]

1. Member with `withdrawal.request` on the collection (officer term in that community, optional collection scope)
   calls `app.request_withdrawal_to_account`: must be one of **their own** verified, name-matched, cooled-off bank
   accounts. Locks the collection's `collection_available` ledger row, re-reads the balance after the lock, refuses
   above available, applies the ₦1,000,000/day limit for unverified communities under a per-community advisory lock,
   posts the hold journal (available → withdrawing), idempotent per (collection, requester, key).
2. Community owner's request is auto-approved; anyone else's waits for the owner (`decide_withdrawal`). Over
   ₦1,000,000 is `requires_manual_review` and is never claimed by the worker.
3. Worker `claim_withdrawal_transfers` (`FOR UPDATE … SKIP LOCKED`): in one transaction creates the
   `withdrawal_transfers` row with a `ktr_` reference and moves the withdrawal to `processing`.
4. Worker pins the recipient (`initiating`), checks the Paystack balance, `POST /transfer` with that reference.
5. Response `otp` / `pending` is recorded, never settled. Timeout / 5xx → `unknown`, never re-sent in that tick.
6. Check stage (every 2 min, rows quiet ≥ 120 s) and the webhook both verify by reference; only the verify answer
   settles: success → payout journal (+ transfer-fee journal); failed → hold released; reversed after success →
   reversal journal, back to available.

## 3. PA-08: idempotency

| Property | Status | Evidence |
|---|---|---|
| A. One stable reference per withdrawal, persisted before the call | **VERIFIED** | [CODE] reference created in the claim transaction; [pgTAP] 63 |
| B. DB prevents a second transfer for a withdrawal | **VERIFIED** | [CODE] unique `(withdrawal_id)`, unique `(reference)`, unique `(transfer_code)`; guard trigger makes reference/amount/code immutable and blocks deletes |
| Ledger cannot post twice | **VERIFIED** | [CODE] journal keys `payout:<id>`, `transfer_fee:<id>`, `payout_reversal:<id>` are unique; settle is idempotent ([UNIT], [pgTAP] 63) |
| C1. Double-click / same API request twice | **VERIFIED** (same key) | [CODE] idempotency key returns the existing row |
| C2. Two members withdraw the same funds at once | **IMPLEMENTED, NOT YET VERIFIED** | [CODE] row lock on the available account; no two-session test exists (audit G9) |
| C3. Two workers claim one withdrawal | **IMPLEMENTED, NOT YET VERIFIED** | [CODE] `SKIP LOCKED` + `not exists transfer`; no two-session test |
| C4. Crash after Paystack accepted, before recording | **PARTIALLY VERIFIED** | [UNIT] "unsent transfer … same reference"; re-send is safe because Paystack rejects the reused reference **[TEST]** |
| C5. Webhook before the API response is persisted | **PARTIALLY VERIFIED** | [CODE] `record_withdrawal_transfer_state` keeps a final state; no test drives this order |
| C6. Duplicate webhook | **VERIFIED** | [UNIT] + [pgTAP] `already_paid` |
| D. Provider-level guarantee | **VERIFIED IN TEST MODE ONLY** | **[TEST]** `duplicate_transfer_reference`; live behaviour assumed identical, not observed |

### Gaps found

- **P8-1 (medium).** `initiate()` treats any refusal followed by verify `not_found` as "nothing moved" and **releases the
  hold at once**. If Paystack's verify lags behind a transfer it just accepted, Kolekto would show the money as
  available again while a transfer exists; a second withdrawal could then pay it out twice. Paystack now gives a
  machine-readable `duplicate_transfer_reference`; that code must never lead to a release, and any other refusal
  should be confirmed "not found" by a second verify after a quiet period before the hold is released.
- **P8-2 (low-medium).** `withdrawal_transfers_to_check` is a plain read with no lease. Two worker processes (or one
  tick overrunning the next) can verify and re-send the same row. Paystack's duplicate rejection and the idempotent
  settle keep the money safe, but it should not depend on that. Fix: claim with `FOR UPDATE SKIP LOCKED` and bump
  `last_checked_at` inside the claim (function replacement in a new migration; no table change).
- **P8-3.** No two-session concurrency tests for request, claim, check or settle.
- **P8-4.** No reconciliation against Paystack's own transfer list (a `ktr_`/`kprobe_` transfer at Paystack with no
  Kolekto row, or a different status, is not detected). `platform_reconciliation()` checks Kolekto's own books only.

## 4. PA-09: timeouts and ambiguous outcomes

| Scenario | Status | Evidence |
|---|---|---|
| A. Verify says success → paid, payout posted once | **VERIFIED** | live TEST transfer 2026-11-19 (after dashboard OTP) + [UNIT] + [pgTAP] |
| B. Verify says failed → hold released once | **VERIFIED (fake provider)** | [UNIT] + [pgTAP] 63 + itest controlled run; **cannot be produced in Paystack TEST** [DOCS] |
| C. Reversed → compensating journal, back to the same collection | **VERIFIED (fake provider)** | same; not producible in TEST |
| D. `otp` → stays reserved, not paid | **VERIFIED** | live TEST transfer parked at `otp` 2026-11-19 |
| E. `pending` → stays reserved, never re-sent | **VERIFIED** | [UNIT] |
| F. Timeout → `unknown`, reserved, verify original reference | **VERIFIED (unit)** | [UNIT] adapter + orchestration; not forced live |
| `unknown` + Paystack `not_found` → re-send under the **same** reference | **VERIFIED SAFE IN TEST** | duplicate reference rejected **[TEST]**; this is not a new transfer |
| Backoff and manual escalation | **GAP (P9-1)** | every open row is re-checked every 2 min forever; nothing marks a row for manual reconciliation; no OTP-age limit |
| `abandoned` mapped to failed (hold released) | **ASSUMPTION** | Paystack does not document `abandoned`; to confirm before relying on it |

Recommended (no new status): keep `initiating / pending / otp / unknown`; add an additive `escalated_at` column and an
operator read; back off by `attempts` (2, 5, 15, 60 min, then hourly); escalate an `unknown` or `pending` row after
24 h and an `otp` row after the agreed authorisation window; funds stay reserved throughout; only verify results settle.

## 5. OTP: the provider limitation (decision point)

**The owner's intended flow cannot be built on Paystack's transfer OTP.** Paystack sends the transfer OTP to the
**Paystack business owner's phone/email**, which is Kolekto's account, not the Treasurer's or Financial Secretary's.
A community member never receives it, so they cannot type it in. The only way a member could "enter the Paystack OTP"
is if someone at Kolekto read it off Kolekto's phone and passed it on, which defeats the purpose.

Also undocumented: OTP expiry, invalid-OTP behaviour, attempt limits, cancellation.

Options (§7 Q1):

- **A (recommended).** Member-facing OTP is **Kolekto's own step-up code**: generated server-side, sent to the member's
  verified email (and phone when SMS exists), stored only as a hash, bound to one withdrawal (id, amount, bank
  account), single use, 10-minute expiry, 5 attempts, resend with cooldown, never logged. Only a confirmed withdrawal
  is approved for transfer. For the Paystack side, on the **live** account later: replace Paystack's dashboard OTP with
  Paystack **server approval** (Paystack asks Kolekto before each transfer; Kolekto approves only a `ktr_` reference
  and amount that match an OTP-confirmed withdrawal), plus IP allow-list. This is not "turning OTP off to make it
  automatic": every transfer stays member-authorised and Kolekto-approved. The dashboard change is the owner's to make,
  not part of this session.
- **B.** Member step-up code as in A, and Paystack OTP stays on; a Kolekto operator finalizes each transfer in an
  operator screen (`finalize_transfer`) with the code Kolekto's phone receives. Safe but manual: every payout waits
  for a Kolekto person.
- **C.** Members receive Paystack's OTP: only possible if each community had its own Paystack business account,
  which is the organiser-account model the owner has rejected.

## 6. Other findings

- **Destination accounts are personal.** A withdrawal can only go to the requester's **own** verified account
  (`v_bank.user_id = v_uid`). There is no community- or collection-owned destination. Matches the name-match rule
  (§20 Q3); the owner should confirm it is intended (§7 Q3).
- **Approval.** Only the community owner approves (`decide_withdrawal` → `is_community_owner`), although
  `treasurer` holds `withdrawal.approve`. The owner's own request is auto-approved. Cross-community access is blocked
  by `has_permission_for_collection` (officer term joined on the collection's community) [CODE].
- **PA-04 / ADR 0015.** D-01 says `subaccount_controlled_settlement`, but the code sends `subaccountCode: null`: every
  payment lands in Kolekto's main balance and payouts are Kolekto transfers (the old `balance_and_withdraw` shape, with
  collection-level ledger and controls). The owner's ruling makes this the chosen model; D-01/ADR 0015 §1 need a
  superseding entry, and PA-04 becomes NOT APPLICABLE. This also means Kolekto holds third-party funds, so O-1 is
  directly in play for live money.
- **F8.** `SCHEDULE_2026_11_FOUNDER`: provider cost 100 bps capped 200,000 kobo [CODE]. Gives ₦10 / ₦100 / ₦1,000 /
  ₦2,000 / ₦2,000 for ₦1k / 10k / 100k / 200k / 500k. Note: the estimate is taken on the contribution, while Paystack
  charges on the amount charged; when the contributor pays the fees the estimate is ~2% low. Estimate only: the ledger
  books Paystack's reported `fees` (D-11).

## 7. Decisions needed

| # | Question |
|---|---|
| Q1 | OTP model: A (Kolekto step-up code + Paystack server approval later), B (step-up + Kolekto operator finalizes Paystack OTP), or other? |
| Q2 | Go-ahead to implement locally: P8-1 (code), P8-2 + P9-1 (one additive migration), P8-3 concurrency tests, P8-4 read-only Paystack transfer reconciliation, and the doc updates (superseding entry for D-01/PA-04, F8, O-1 deferred, PA-08/PA-09 results). |
| Q3 | Withdrawals go only to the requesting member's own verified account: confirm intended? |

---

## 8. Update after implementation (2026-11-19, same day)

The owner answered §7: **Q1 = A** (Kolekto member code by email + Paystack server approval later; never
auto-approve), **Q2 = go** (local only), **Q3 = yes** (the requesting member's own verified, name-matched account
only). The owner also made the community owner's approval mandatory for every withdrawal, including their own.
Full detail and evidence: [withdrawal-otp-owner-approval-2026-11-19.md](withdrawal-otp-owner-approval-2026-11-19.md);
decisions: [financial-decisions.md §22](financial-decisions.md); [ADR 0016](../adr/0016-member-code-owner-approval-paystack-server-approval.md).
Migration: `supabase/migrations/20261119120000_withdrawal_otp_owner_approval_transfer_reliability.sql` (additive;
applied to the local dev and itest databases only).

| Gap | Now | Evidence |
|---|---|---|
| P8-1 refusal + one `not_found` released the hold | A hold is released only if the transfer was never sent, or after a refusal that is not `duplicate_transfer_reference` / `insufficient_balance` / HTTP 429, at least 3 `not_found` checks and 30 min since the refusal, with no transfer code and no Paystack approval on record. Otherwise the row stays reserved and is escalated. | [pgTAP] 70 (t4–t7) · [UNIT] payments |
| P8-2 check stage had no lease | Checks are claimed with a 120 s lease and a token; only the token holder can record a result; a stale token is logged and changes nothing. | [pgTAP] 70 · concurrency script (two checkers + lease takeover) |
| P8-3 no two-session tests | `scripts/verify/withdrawal-concurrency.mjs`, 7 scenarios / 24 checks on a scratch copy of the itest database, 5 runs clean. | concurrency script |
| P8-4 no reconciliation against Paystack | Read-only comparison of Kolekto's transfer rows with Paystack's transfer list; runs and discrepancies are stored append-only; nothing posts journals. Unknown references (such as the `kprobe_` probes) are reported as `foreign_reference` (info). | [pgTAP] 70 · [UNIT] payments + adapters |
| P9-1 no backoff or escalation | Versioned policy `2026-11-19-default`: checks at 2, 5, 10, 30, 60, 120, 240 min, then every 6 h; escalate after 24 h, after 2 h at `otp`, or after 40 checks; funds stay reserved; an escalated row is listed for an operator. | [pgTAP] 70 |
| `abandoned` mapped to failed | **Unchanged and still an assumption.** The two probe transfers below did become `abandoned`, but whether Paystack can still process an `abandoned` transfer is not documented. | [TEST] observation only |

**The two ₦100 TEST probe transfers** (`kprobe_seq_1795094234` / `TRF_hcq9ru8igrn1dsfg`,
`kprobe_con_1795094234` / `TRF_thr1i3u9tpxhi94l`) were at `otp` at 14:12 UTC and **`abandoned`** at 15:43 UTC
(read-only list call, TEST key). Nothing was finalized, resent or recreated. They have no Kolekto withdrawal rows,
so reconciliation reports them as `foreign_reference`. No action is taken on them.

**Still not verified:** the real approval-URL request body and its signature (undocumented; the parser is written to
the documented fields and refuses anything it cannot match); whether Transfer Approval is offered on Kolekto's
account; any live-key behaviour; a provoked timeout.
