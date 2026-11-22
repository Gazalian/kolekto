# Member OTP, mandatory owner approval, Paystack server approval, transfer reliability — 2026-11-19

Branch `feat/payment-receipts-alarms`, uncommitted. Local and isolated-test databases only. Nothing ran
against staging, legacy production or a live Paystack key. No Paystack dashboard setting was changed.

Owner brief: "Kolekto Phase 4 — Implement Member OTP, Mandatory Community Owner Approval, Paystack Server
Approval and Transfer Reliability Fixes" (2026-11-19). Decisions are recorded in
[financial-decisions.md §22](financial-decisions.md#22--decisions-of-2026-11-19-withdrawal-authorisation-owner)
and [ADR 0016](../adr/0016-member-code-owner-approval-paystack-server-approval.md).

Evidence labels: **[CODE]** read from this repository · **[PGTAP]** proved by a pgTAP test in one session ·
**[CONC]** proved by the two-session concurrency script · **[UNIT]** unit test with a fake or a stub ·
**[DOCS]** Paystack's documentation · **[TEST]** observed with the Paystack TEST key · **[UNKNOWN]** not established.

---

## 1. The flow

| # | Step | Where | State after |
|---|---|---|---|
| 1 | An officer with `withdrawal.request` asks for an amount from one collection, to one of **their own** verified saved bank accounts | `app.request_withdrawal_to_account` | `requested`, stage `awaiting_member_verification`; hold journal posted; `available_before_kobo` recorded; first code challenge `pending_delivery` |
| 2 | The worker generates a 6-digit code, stores HMAC-SHA256(secret, `challengeId:code`), then emails it | `apps/worker/src/withdrawal-otp-delivery.ts` | challenge `sent`, expires 10 min after issue |
| 3 | The member types the code; the web server hashes it and the database compares | `verifyWithdrawalOtpAction` → `app.verify_withdrawal_otp` | `member_otp_verified_at` set; stage `awaiting_owner_approval` |
| 4 | The community **owner** reviews and approves or rejects | `OwnerReview` dialog → `app.decide_withdrawal` | `approved` (stage `ready_for_transfer`) or `rejected` (hold released once) |
| 5 | The worker claims it — only with both facts recorded and the account still the requester's, verified, past cooling-off | `app.claim_withdrawal_transfers` | `processing`; transfer row `initiating`, leased, stable `ktr_…` reference |
| 6 | `initiate_requested_at` committed, then `POST /transfer` | `packages/payments/src/transfers.ts` | `pending` / `otp` / `unknown` |
| 7 | Paystack asks the approval URL; Kolekto answers 200 only for a fully authorised, reserved withdrawal | `POST /api/webhooks/paystack/transfer-approval` → `app.decide_transfer_approval` | `provider_approved_at` on the first approval |
| 8 | Verify by reference, settle only a provider-confirmed outcome | check stage, webhook | `paid` (payout + fee journals once) / `failed` (hold released once) / `reversed` (compensating journal) |

The member's code is not approval. The owner's approval is not payment. Paystack's approval request is
not payment. Only a verified provider success settles a withdrawal. **[CODE] [PGTAP 63, 69, 70]**

## 2. Member OTP (Option A)

| Rule | Value | Enforced by |
|---|---|---|
| Channel | the requester's sign-in email, only when Supabase Auth confirmed it (`auth.users.email_confirmed_at`) | `app.verified_account_email`; request refused with `EMAIL_NOT_VERIFIED` |
| Generation | `crypto.randomInt(0, 10^6)`, zero-padded | `generateWithdrawalOtp` (domain) |
| Storage | HMAC-SHA256(`KOLEKTO_WITHDRAWAL_OTP_SECRET`, `challengeId:code`), 64 hex; never the code | DB check constraint + `record_withdrawal_otp_issued` refuses anything else |
| Validity | 10 minutes from issue | `expires_at`, checked in `verify_withdrawal_otp`; state reads expired at once |
| Attempts | 5; the 5th wrong code locks the challenge; a locked code refuses even the right code | `verify_withdrawal_otp` (returns, never raises, so the count is kept) |
| Single use | a verified withdrawal answers `already_verified` | same |
| Binding | one challenge = one withdrawal + one member; the challenge id is inside the MAC | `OTP_CHALLENGE_MISMATCH`; a code from another challenge is `incorrect` |
| Resend | 60 s cooldown; supersedes the open code; at most 5 codes per request, 10 per member per hour | `app.request_withdrawal_otp` |
| Atomicity | withdrawal row locked, then challenge row; the attempt count, the challenge state and `member_otp_verified_at` change in one transaction | **[CONC 1, 2]** |
| Logging | the code is in worker memory and the email only; log lines carry counts; the audit log never contains a hash | **[UNIT] [PGTAP 69]** |
| Delivery failure | recorded `delivery_failed`; an unsent challenge lapses after 10 minutes; the email pause switch is honoured | **[UNIT]** |

UI states (`WithdrawalCodeEntry`, `withdrawalOtpStateAction`): sending, sent (masked email), enter code,
incorrect (attempts left), expired, too many attempts, resend (with cooldown), verified, waiting for owner,
owner rejected, ready for transfer. The screen and the email both say the code is not approval and not payment.

## 3. Community owner approval

- Only a current **owner** of the withdrawal's community approves or rejects (`app.is_community_owner`). A
  treasurer's `withdrawal.approve` does not satisfy it; a stranger and another community's owner are refused.
  **[PGTAP 69]**
- Approval is refused until the member has verified (`WITHDRAWAL_AWAITING_MEMBER_VERIFICATION`), and refused if
  the destination is no longer the requester's verified account past cooling-off
  (`WITHDRAWAL_BANK_ACCOUNT_CHANGED`). The guard trigger repeats the OTP condition, so even a direct write cannot
  approve an unconfirmed request.
- Rejection needs a reason, releases the hold once and closes open codes. Approval, OTP facts and
  `available_before_kobo` are write-once.
- **An owner approving their own request is allowed and recorded** (`owner_self_approved = true`). Before this
  change the owner's request was approved automatically (D-06); it is now an explicit, separate, audited step
  after the owner's own code. *This is the one point of §7.4 that needs the owner's confirmation* (see §10).
- The review dialog shows requester, amount, available before and after, bank, last four digits, holder name,
  requested time, code status, and flags (self-approval, manual review over ₦1,000,000, account changed or
  cooling off). The account cannot be substituted: the withdrawal stores its `bank_account_id` at request time.
- D-06 manual review over ₦1,000,000 is unchanged: such a withdrawal is never claimed for transfer.

**Update 2026-11-20 (migration `20261120100000`) — nobody approves their own withdrawal.** The self-approval
bullet above is superseded:

- The requester can never approve or reject their own withdrawal (they may still cancel it). The guard trigger
  repeats this (`WITHDRAWAL_SELF_APPROVAL`), so a direct write cannot self-approve either.
- A non-owner's request is approved by a current owner (`approved_as = 'owner'`).
- An owner's request is approved by a **designated second approver** (`approved_as = 'second_approver'`): a
  user the owner explicitly designated in `community_withdrawal_approvers` (`app.set_withdrawal_approver`,
  owner only, never themself) who also holds a current **admin or owner** term. The treasurer role never grants
  this. Designations are time-bounded (started/ended, never deleted); the basis is evaluated at the approval
  time, and `approved_as` is write-once.
- Designation and its end are audited (`withdrawal_approver.designated` / `.ended`); the approval audit records
  `approval_basis`. `owner_self_approved` is now always false for new approvals.
- **Gap:** there is no owner UI to designate an approver yet (SQL function only), so an owner's own withdrawal
  cannot be approved in the app until it exists. **[PGTAP 69, 63, 64, 70]**

## 4. Bank-account ownership (brief §8)

| Requirement | Enforcement |
|---|---|
| Belongs to the requester; same member initiating | request: `BANK_ACCOUNT_NOT_FOUND` unless `user_id = auth.uid()`; claim and approval-URL re-check `b.user_id = w.requested_by` |
| Verified, name-matched, not under review | request: `BANK_ACCOUNT_NOT_VERIFIED`; approve: `WITHDRAWAL_BANK_ACCOUNT_CHANGED`; claim filter; approval URL `account_not_verified` |
| Not cooling off | request: `BANK_ACCOUNT_COOLING_OFF`; approve, claim and approval URL re-check `usable_from` |
| Owner cannot substitute an account | `bank_account_id` is write-once on the withdrawal; `decide_withdrawal` takes no account |
| A change after initiation blocks | profile name change → account `needs_review` (20261118100200) → approval refused **[PGTAP 69]**, claim skipped **[PGTAP 64]**, approval URL rejects even after an earlier approval **[PGTAP 70]** |

No community-wide account was created.

## 5. Paystack server approval (approval URL)

### 5.1 Findings (brief §4, ten questions)

| # | Question | Answer | Label |
|---|---|---|---|
| 1 | How is it enabled? | Paystack Dashboard → **Settings → Preferences → Transfer Approval**: tick the domain (test / live) and enter the URL, then **Save changes**. Separate per domain. | [DOCS] |
| 2 | Per transfer? | "For each transfer request, we send an approval request to the merchant's server." While waiting, the transfer is `received`. | [DOCS] |
| 3 | Mechanism | A `POST` from Paystack to the merchant's approval URL. It is not one of the webhook events (`transfer.success` etc.) and it is configured separately from the webhook URL. | [DOCS] |
| 4 | What Paystack sends | "The payload used to initiate the transfer". No field list or example is published. Kolekto reads `reference`, `amount`, `recipient` at the top level or under `data`, and a recipient as a code or as an object with `recipient_code`. Whether a signature header is sent is not documented. | [DOCS] [UNKNOWN] |
| 5 | How Kolekto answers | HTTP **200** = approve (transfer proceeds, `pending`); HTTP **400** = reject (`rejected`). Body ignored. | [DOCS] |
| 6 | Reference and amount validation | Paystack asks the merchant to confirm the reference and amount match its system. Kolekto checks far more: see §5.2. | [DOCS] [CODE] |
| 7 | Rejection | 400 → `rejected`, a conclusive failure; nothing moves. The dashboard offers "Blacklist recipient" or "Do nothing" for rejected requests — Kolekto relies on "do nothing" (blacklisting is a dashboard action, not changed). | [DOCS] |
| 8 | Duplicate approval requests | Not documented. Kolekto answers deterministically (same state → same answer), logs every request, counts them per transfer, and reports more than one as `duplicate_approval_requests` (info) in reconciliation. | [UNKNOWN] [PGTAP 70] |
| 9 | Timeouts | "If the merchant server doesn't respond within a few seconds, we mark the transfer as `blocked`". `blocked` is conclusive; the verify path settles it `failed` and releases the hold once. The route makes one database call and no outbound call. | [DOCS] [CODE] |
| 10 | Available for this account / environment? | The docs name no plan restriction and say nothing about test mode. **Not established for Kolekto's account in either domain** — only the dashboard shows whether the setting is offered. Bulk transfers additionally require dashboard OTP off. URL approval runs *after* the OTP step, so with dashboard OTP still on, every transfer still parks at `otp`. | [DOCS] [UNKNOWN] |

### 5.2 What Kolekto approves

`app.decide_transfer_approval(reference, amount, recipient, signature)` answers `approve` only when every check
passes; otherwise the first failing reason is recorded and the route answers 400:

`unknown_reference` · `transfer_already_final` · `withdrawal_not_processing` · `amount_mismatch` (provider amount
vs transfer vs withdrawal) · `recipient_mismatch` · `recipient_not_selected_account` · `account_not_requesters` ·
`account_not_verified` · `collection_community_mismatch` · `member_not_verified` (challenge verified, same member,
same withdrawal) · `owner_not_approved` · `approver_not_owner` (owner term covering the approval time) ·
`manual_review_required` · `funds_not_reserved` (hold present, not released or reversed, withdrawing balance
covers it).

**Update 2026-11-20 (`20261120100000`).** The function is now
`app.decide_transfer_approval(reference, amount, recipient, signature, currency, transfer_code, payload_rejection)`.
The route parses Paystack's real body (`parseTransferApprovalRequest`: `data.details.body` and the single
`data.transfers[]` entry must agree on reference, amount, currency and recipient; the transfer entry must carry a
`TRF_` code and status `received`; anything else is refused as `payload_malformed`, `payload_body_missing`,
`payload_transfers_missing`, `payload_multiple_transfers`, `payload_field_invalid` or `payload_mismatch`) and
passes the refusal to the database so it is logged. New reasons: the `payload_*` codes, `already_paid`,
`currency_mismatch` (not NGN), `transfer_code_mismatch` (missing, or different from the code Kolekto holds),
`self_approved`, `approver_not_authorised` (no valid owner / second-approver basis at the approval time).
`approver_not_owner` is replaced by these. A redacted fixture of the real request lives in
`packages/adapters/test/fixtures/paystack-transfer-approval-request.redacted.json`. **[UNIT] [PGTAP 70]**

Every request is logged in `withdrawal_transfer_approval_requests` (append-only). The first approval sets
`provider_approved_at`; after that the transfer is treated as sent for ever (never released as unsent, never
re-sent). The route (`apps/web/app/api/webhooks/paystack/transfer-approval/route.ts`): POST only, JSON only,
64 KiB cap, fails closed on any error. If `x-paystack-signature` is present it must be the HMAC-SHA512 of the raw
body with the secret key; any other signature header is rejected; no header → decided on the merits and recorded
`signature: absent`. **[PGTAP 70] [UNIT]**

### 5.3 Dashboard change — needs the owner's explicit approval (not done)

Recommended order, **TEST domain first**:

1. Deploy the route to an environment Paystack can reach over HTTPS (local `localhost` is not reachable; this
   needs staging or a tunnel, neither authorised in this session).
2. Paystack Dashboard (TEST mode) → Settings → Preferences → **Transfer Approval** → tick *Test* → URL
   `https://<host>/api/webhooks/paystack/transfer-approval` → Save changes.
3. With the owner's separate approval, turn off the TEST domain's transfer OTP in the dashboard (its exact
   location was not confirmed from the docs), so TEST transfers reach the approval step instead of `otp`.
4. Run one ₦100 TEST withdrawal end to end; confirm the approval request arrives, record its real payload shape
   and headers, confirm 200 → `pending` → `success` and 400 → `rejected`.
5. Only after that, and only with a separate approval, the same for the live domain. The live business OTP stays on
   until then.

### 5.4 Observed on 2026-11-20 (local + ngrok, Paystack TEST key)

**Outgoing (TEST).** Withdrawal `KWD-A627ED3677BA6236` (₦100, member code verified, owner self-approved) was
dispatched by the worker at 10:13:52 UTC as transfer `ktr_c19673339a4837e86e3f7ad5`. Paystack answered `otp` at
10:13:54. **Paystack did not call the approval URL** (ngrok shows no Paystack request; the approval log holds only
local curl probes). This confirms question 10 above in TEST mode: with the TEST domain's transfer OTP on, transfers
stop at `otp` and the approval URL is never reached. When the owner then finalized the OTP in the dashboard
(10:20 UTC) the transfer succeeded **without** any approval request: an OTP-finalized transfer bypassed the
approval URL in this run. **[TEST]**

**First real approval request (TEST, 10:45:09 UTC)**, after the owner turned TEST transfer OTP off: withdrawal
`KWD-0FF76ADC1F9F5EA3`, transfer `ktr_5def794c9e69a7d82b68c9aa`. User-Agent `Needle/3.5.0`; `X-Paystack-Signature`
present and valid (HMAC-SHA512 with the TEST secret key). Body shape (question 4 answered):

```
{ "event": "transferrequest.approval-required",
  "data": { "integration", "domain": "test", "user", "source_ip",
            "details": { "headers": {…}, "body": { "source", "amount": "10000", "recipient": "RCP_…",
                                                   "reference": "ktr_…", "reason", "currency" },
                         "query": {}, "endpoint": "/transfer" },
            "transfers": [ { "reference", "amount": 10000, "transfer_code", "status": "received",
                             "recipient": { "recipientCode", "details": {…}, … }, … } ] } }
```

Kolekto's parser then read only a top-level or `data.reference`, answered 400 `unknown_reference`; Paystack
rejected the transfer, `transfer.rejected` arrived, the withdrawal failed and its hold was released once. The
parser has since been fixed for this shape (status doc, session 34 update). Note the body carries the caller's IP,
geo headers and the recipient's bank details: never log it.

**Inbound (LIVE) — a different Paystack feature.** At 2026-11-20 08:54:30 UTC Paystack POSTed a request with
User-Agent `Paystack Credit Request` (payer and receiver account fields, NIP session id, `amount` 51000,
`provider: titan-paystack`) to this same URL. This was a **real LIVE customer payment** (₦510, Paystack reference
`kolekto-1795164753146-401579`), not a TEST event: an earlier note classified it as TEST, which was wrong. The URL
had been entered in the LIVE *Inbound Transfer Approvals* field (Settings → Preferences → Virtual Account), which
is not the outgoing *Transfer Approval* setting. Paystack's own record shows the payment **Success**, message
"Approved", and its `charge.success` webhook delivered. Kolekto's local route never answered it (the local database
was failing at the time). **[LIVE, read-only]**

Since then the route recognises an inbound credit request (`isInboundCreditRequest` in
`packages/adapters/src/transfer-provider.ts`), never passes it to the outgoing decision, writes nothing, and holds
its 400 answer for 12 s — past Paystack's documented 5 s inbound deadline, after which Paystack's documented
default is to accept. This is a stop-gap only, approved by the owner on 2026-11-20; the real fix is to keep the URL
out of the inbound field.

### 5.5 Observed on 2026-11-20, session 35 — recipient blacklisted by the earlier rejection

Withdrawal `KWD-54DD01335BA5AB4D` (₦100, owner's own request): member code from Mailpit verified, approved in the
app by a designated second approver (an admin, not the owner), worker started with the TEST key. At 11:55:26 UTC
the worker sent `POST /transfer` for `ktr_bb677138b19c111d2360fc81`. **Paystack refused it: "Recipient is
blacklisted".** Paystack never created the transfer, so the approval URL was never called.

Cause: the 10:45 rejection of `ktr_5def794c9e69a7d82b68c9aa` (old parser, 400) met the dashboard's
*On Reject = Blacklist Recipient*, and Paystack blacklisted the member's recipient `RCP_mlpn…`. The recipient API
reported `active: true` after that rejection (session 34); the blacklist showed only as this refusal. This is the risk §10 point 8 warns
about, now observed.

Kolekto's handling was fail-safe and is unchanged: the refusal was logged (`initiate_refused`), the transfer moved
to `unknown`, the worker verified by reference (`not_found`), and the hold stayed in place — no release, no
payout, reconciliation 9/9. The worker was stopped before a re-send and the TEST key removed from its env. The
withdrawal stays `processing` with funds held until the owner un-blacklists the recipient in the Paystack TEST
dashboard (and, recommended, sets *On Reject* to *Do Nothing*); by the existing not-found policy the next worker run
re-checks and may re-send (inferred from the policy, not run). **[TEST]**

## 6. PA-08 — transfer idempotency

| Fix | What changed | Evidence |
|---|---|---|
| **P8-1** no release after one NOT FOUND | A hold is released without a provider-confirmed failure only by `app.release_withdrawal_transfer_never_sent`, and only when `app.transfer_release_eligible` is true: status open, no transfer code, Paystack never asked for approval, and either (a) never sent (`initiate_requested_at` null — committed before every POST) or (b) refused synchronously with a code other than `duplicate_transfer_reference` / `insufficient_balance` / `http_429`, then ≥ 3 consecutive NOT FOUND over ≥ 30 minutes. Re-send uses the **same** reference, only after ≥ 2 NOT FOUND, never after escalation, a transfer code or an approval request. A webhook's NOT FOUND writes nothing. | [PGTAP 70: 1 and 2 NOT FOUND not eligible; never-sent eligible; refused + 3 NF in 30 min held, after 31 min eligible; duplicate refusal never; approval-requested never] [UNIT] [CONC 6] |
| **P8-2** leases | Dispatch and check claims set `claimed_by`, `claimed_until` (policy lease 120 s) and a `claim_token`; `FOR UPDATE SKIP LOCKED`; only the token holder may mark, record or release; a stale token is logged as `stale_claim` and changes nothing; an expired lease can be taken over. | [PGTAP 70] [CONC 4, 5] |
| **P8-3** two-session concurrency | `scripts/verify/withdrawal-concurrency.mjs`, against a throwaway clone of the itest database (refuses any database not named `kolekto_scratch*` and any non-local host). | [CONC: 24 checks × 5 runs, all passed] |
| **P8-4** reconciliation report | `runTransferReconciliation` reads Paystack's transfer list (GET `/transfer`, paged) and Kolekto's rows, compares, and stores a run with discrepancies: `missing_at_provider`, `missing_in_kolekto`, `foreign_reference`, `amount_mismatch`, `reference_mismatch`, `recipient_mismatch`, `status_mismatch`, `stale_open`, `duplicate_provider_record`, `duplicate_approval_requests`, `success_not_in_ledger`, each with severity and a resolution status (`open` → `acknowledged` / `resolved`, operator and reason required). Read-only: posts no journal. An incomplete provider list suppresses "missing" findings. Worker runs it every 6 h over 7 days. Since 2026-11-22 a transfer sent within the grace period (5 min) and absent from the list is `provider_verification_pending`, and an older absent one is verified by reference before `missing_at_provider` (§12). | [PGTAP 70, 72] [UNIT] |

Concurrency scenarios: (1) same correct code twice → one `verified`, one `already_verified`, one audit row;
(2) two wrong codes on the last two attempts → one counted, one locks, attempts exactly 5; right vs wrong on the
last attempt → verified or locked, never both; (3) owner approve vs reject → exactly one wins, hold released only
if rejected; (4) two dispatchers → each of 3 withdrawals claimed once, one transfer each; (5) two checkers on one due
row → one wins; expired lease taken over; the late answer is stale and records nothing; (6) release-as-unsent vs
approval request → either approved and release refused, or released and Paystack told no — never both; (7) the
same success twice → `paid` + `already_paid`, one payout journal. Whole-ledger balance and collection
reconciliation hold afterwards.

## 7. PA-09 — timeouts, backoff, escalation

Policy `withdrawal_transfer_check_policies` version `2026-11-19-default` (append-only; a new version takes effect
from its `effective_from`):

| Setting | Value |
|---|---|
| First check | immediately after the ambiguous result |
| Then | 2, 5, 10, 30 min, 1 h, 2 h, 4 h; then every 6 h (cap) |
| Escalate | open 24 h since first send, or 2 h at Paystack's dashboard `otp`, or 40 checks |
| Re-send (same reference) | after 2 NOT FOUND, never once escalated |
| Refused-then-not-found release | ≥ 3 NOT FOUND over ≥ 30 min |
| Lease | 120 s |

Every look (dispatch, check, webhook) is a row in `withdrawal_transfer_checks` (append-only) with what Paystack
said and what Kolekto did. Escalation writes an audit row, lists the transfer in
`app.withdrawal_transfers_needing_attention()` (worker logs a `critical` line every 15 min), **keeps the funds
reserved** and keeps checking. Reaching a limit never releases funds and never allows a second transfer.
Transient refusals (429, 401/403, insufficient Paystack balance) are recorded as `unavailable`, so they never
count towards a release. **[PGTAP 70: backoff 120 → 300 → 600 → 1800 → 3600 → 7200 → 14400 → 21600; escalation
at check 40 and at 2 h OTP] [UNIT]**

## 8. Financial invariants (brief §9)

| # | Invariant | Evidence |
|---|---|---|
| 1 | Integer kobo | invariant script "money is bigint kobo"; no new conversion or rounding |
| 2 | One withdrawal, one collection | unchanged (`collection_id` write-once) |
| 3 | One stable transfer identity | one `withdrawal_transfers` row per withdrawal, `ktr_` reference write-once; re-send reuses it [PGTAP 70] [CONC 4] |
| 4 | No multiple payouts | `payout:` journal idempotency key [CONC 7] [PGTAP 63] |
| 5 | No cross-collection funds | unchanged; isolation [PGTAP 63] |
| 6 | Reserved once | hold at request, idempotent request key [PGTAP 63, 69] |
| 7 | Success posted once | [CONC 7] [PGTAP 63] |
| 8 | Failure releases once | [PGTAP 69, 70] [CONC 3, 6] |
| 9 | Reversal compensates | unchanged [PGTAP 63] |
| 10 | Ambiguous stays reserved | P8-1 / escalation [PGTAP 70] |
| 11–13 | OTP / owner approval / Paystack approval are not payment | positions unchanged after each [PGTAP 69, 70] |
| 14 | Only confirmed provider success finalises | `settle_withdrawal_transfer` only [CODE] |
| 15 | Auditable | request, resend, lock, verify, approve, reject, cancel, processing, approval-URL answer, escalation, discrepancy resolution [PGTAP 69, 70] |
| 16 | Ledger balanced | `v_ledger_imbalances` = 0 in every new test and on dev; `platform_reconciliation()` no failing check on dev |

## 9. The two Paystack TEST probe transfers (brief §10)

| Reference | Amount | Transfer code | Created (UTC) | Status at 14:12 UTC | Status at 15:43 UTC |
|---|---|---|---|---|---|
| `kprobe_seq_1795094234` | ₦100 (10 000 kobo) | `TRF_hcq9ru8igrn1dsfg` | 2026-11-19 13:17:18 | `otp` | **`abandoned`** (updated 14:18:53) |
| `kprobe_con_1795094234` | ₦100 | `TRF_thr1i3u9tpxhi94l` | 2026-11-19 13:17:21 | `otp` | **`abandoned`** (updated 14:18:53) |

Both are TEST-domain (`domain: test`), never Kolekto withdrawals, and never finalized. Paystack abandoned both on its
own about an hour after creation (its docs say an OTP not used within 30 minutes is abandoned). `abandoned` is
conclusive: nothing moved. **No action was taken and none is needed**; there is no cancel endpoint and no duplicate
was created. They will appear in a reconciliation run as `foreign_reference` (info) and can be acknowledged. **[TEST]**
This also confirms in TEST mode that an un-finalized OTP transfer ends `abandoned`, which Kolekto maps to `failed`.

## 10. Open points

1. **Owner self-approval.** Confirm that an owner may approve their own request after their own code (recorded,
   audited), or require a second owner. Today a community has one owner, so the alternative needs a design.
2. **Dashboard changes** in §5.3 — each needs explicit approval; none was made.
3. **Approval-URL payload and signature** — unknown until a real TEST request is observed. Still not observed on
   2026-11-20: the TEST transfer stopped at `otp` first (§5.4).
4. **Account availability** of Transfer Approval for Kolekto's Paystack business — check the dashboard.
5. **Existing approved-but-unverified withdrawals** (none on dev) would no longer be claimed after this migration:
   operations fails them (hold released) or the requester cancels.
6. **Configuration:** `KOLEKTO_WITHDRAWAL_OTP_SECRET` (≥ 32 characters) must be set for both the web app
   (`apps/web/.env.local`) and the worker; without it the worker's code stage stays off and code entry fails
   closed. It is not set in any local env file yet. (Set locally on 2026-11-20 in the three git-ignored
   `.env.local` files; staging and production still need it.)
7. O-1 (legal authority to hold funds) stays open and blocks real money. F8 is the owner's working assumption.
8. **On Reject = Blacklist Recipient** (one dashboard setting for TEST and live). Any 400 from Kolekto — a correct
   rejection, a database outage, a parser bug — asks Paystack to blacklist the member's own bank recipient, and
   every later transfer to that member is refused until someone clears it by hand (observed, §5.5).
   Recommendation: **Do Nothing**. Owner's decision; not changed by Claude.
9. Point 1 is resolved by `20261120100000` (second approver, §3 update); the owner designation UI is still to
   build.

## 11. Status and operating policy — 2026-11-20 (session 41)

Added after the session 40 rebuild and the session 41 review. Sections 1–10 above are kept as the historical
record; where they differ, this section and its links are current.

### 11.1 Withdrawal approval and OTP policy (current)

| Rule | Current value | Evidence |
|---|---|---|
| Member code | 6 digits, emailed only to the requester's Auth-confirmed address; HMAC-SHA256 stored, never the code; 10 min; 5 attempts then locked; single use; bound to one withdrawal and member; resend after 60 s; ≤ 5 codes per request, ≤ 10 per member per hour | [PGTAP 69] 102/102 on a clean database; [CONC 1, 2]; live Mailpit runs S38/S39 |
| Code logging | Next dev-only Server Function argument logging off (`apps/web/next.config.ts`); OTP actions log through `logEvent` (redacted) | [UNIT]; S39 dev-log check. Hosted logs not yet verified (risk register SR-14) |
| Who approves | Nobody approves their own withdrawal. Non-owner's request: a current owner. Owner's request: a designated second approver with an active admin/owner term and an active account. Treasurer role never qualifies | [PGTAP 69, 71]; S38 rolled-back probe and app approval |
| Thresholds | Over ₦1,000,000: `requires_manual_review`, never claimed or approved at Paystack; no operator path yet (O-3). Unverified community: ₦1,000,000 per day | [CODE]; risk register SR-11 |
| Paystack | TEST: transfer OTP off, Transfer Approval URL on, *On Reject* = Do Nothing (shared with LIVE). LIVE: transfer OTP **off**, LIVE approval **off** — must change before any LIVE payout (SR-02) | [TEST-PSK], [LIVE-RO] S34/S37 |

§3's "Gap: no owner UI" and §10 point 9 are closed: the owner UI exists (migration `20261120140000`, session 39) and
was verified in a browser against the itest database in session 40.

### 11.2 Managing the second approver (owner instructions)

1. Sign in as a community **owner** → the community → **Settings → Team** → section **"Withdrawal second approver"**.
   Other officers do not see the controls.
2. **Designate:** choose from the candidate list. It shows only people with an active admin or owner term and an
   active account, never yourself. Confirm. The panel shows "Active · designated … by …".
3. **Replace:** opens a dialog listing the other eligible people; the old designation ends and the new one starts
   in one step (audited once as `withdrawal_approver.replaced`).
4. **Remove:** ends the designation (`withdrawal_approver.ended`). Until you designate someone again, **your own
   withdrawals cannot be approved**; requests by other officers are still approved by you.
5. **History:** "Earlier designations" lists who designated and ended each one and when. Rows are never deleted.
6. A designee who loses their admin/owner term, or whose account is suspended or closed, stops being able to
   approve at once; the panel shows them as not eligible.
7. If nobody can be designated, the panel says so: invite someone you trust as an **admin**; once they accept, they
   appear as a candidate. Treasurers cannot be designated.

Known weaknesses to accept or fix before LIVE (risk register SR-09): a designation takes effect immediately, nobody
else is notified, and an owner could designate a second account of their own.

## 12. Transfer reconciliation — provider-verification grace period (2026-11-22, session 42)

**Why.** On 2026-11-22 the worker started, dispatched `ktr_6a1c…` and ran reconciliation in the same loop. Paystack's
transfer list did not yet show the new transfer, so the run recorded `missing_at_provider` (warning) for a transfer
Paystack had created, approved and paid (verified by reference). A false positive, not a payment fault.

**Rule now** (`packages/payments/src/transfer-reconciliation.ts`, migration `20261122100000`):

| Transfer absent from a complete Paystack list, sent… | Finding | Paystack asked again? |
|---|---|---|
| less than the grace period ago (5 min, `TRANSFER_RECONCILIATION_PROVIDER_GRACE_MS`) | `provider_verification_pending`, **info** | Not yet; the worker re-runs reconciliation about grace + 1 min later instead of 6 h |
| longer ago, verify by reference finds it | compared like a listed transfer (status/amount/code/recipient) | Yes, GET `/transfer/verify/:reference` |
| longer ago, verify says not found | `missing_at_provider` (critical if Kolekto says success, else warning), detail "verify by reference: not found" | Yes |
| longer ago, verify unavailable / throws / per-run cap (25) reached | `missing_at_provider`, detail names the reason | Attempted or capped |

- A pending-verification finding is a report line only. It never fails, settles, releases or re-sends a transfer.
  Reconciliation still never calls `initiateTransfer` (unit-tested) and posts no journal (pgTAP 72).
- A `transfer.success` / `transfer.failed` webhook during the grace period goes through the normal verified
  settlement path, unchanged. The later run then finds Paystack's record and raises nothing.
- Each run stores the grace it used: `transfer_reconciliation_runs.provider_grace_seconds` (null for earlier runs).
- Runs stay append-only. Existing discrepancies are untouched: the 20 Nov `ktr_bb67…` / `ktr_4f40…` warnings and the
  22 Nov `ktr_6a1c…` false positive on the dev database remain `open` for an operator to acknowledge with a reason.
- An incomplete provider list still suppresses every absent-transfer finding, inside or outside the grace period.

**Deployment order.** Apply `20261122100000` before running a worker bundle built from this code: the old database
constraint refuses the new kind, and that run would fail to record (logged, retried next interval; no money effect).
Applied so far: itest only (2026-11-22). Dev database: not yet.

**Tests.** `packages/payments/test/reconciliation-and-approval.test.ts` ("provider-verification grace period", 19
cases, including the seven in the brief); `apps/worker/test/withdrawal-otp-delivery.test.ts` (log line);
`supabase/tests/72_transfer_reconciliation_grace.sql` (21 assertions).

Running the worker locally with the Paystack TEST key: `docs/runbooks/worker-paystack-test-key-local.md`.
