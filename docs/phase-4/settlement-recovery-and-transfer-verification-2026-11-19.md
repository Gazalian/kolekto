# Settlement recovery, worker activation and withdrawal verification (2026-11-19)

**Branch:** `feat/payment-receipts-alarms` (uncommitted work from session 27 preserved; session 1 changed no source file; session 2's display and test changes are listed in §10).
**Scope:** LOCAL DEVELOPMENT ONLY (Docker `supabase_db_kolekto`, `127.0.0.1:54322`), Paystack TEST key (`sk_test_`).
Nothing hosted was connected to, unpaused or modified. Legacy production was not touched.

Classification: **Passed / Failed / Not tested / Blocked**.

## 1. Six overdue payments recovered: PASSED

One transaction on local dev: `approve_verified_charge_settlements(true)` then `release_due_settlements` then
`platform_reconciliation()`, with in-transaction assertions that would have rolled everything back.

| Check | Result |
|---|---|
| Approved | 6 (all `paystack`); 18 fake-provider seed rows `skipped_fake_provider` |
| Released | 6 payments, 108,347,600 kobo = ₦1,083,476 exactly |
| Balances after | `01a1c50c` available ₦1,075,000 · `01a1c508` ₦7,300 · `f835a9ba` ₦2,450 (pending ₦3,920 = fake seed) |
| Double credit | none (one `balance_release:<contribution>` journal per payment) |
| Reconciliation | 9/9 `ok` (before, immediately after, and after the later withdrawal) |

Dry run before applying returned the same 6 + 18 as the 2026-11-19 report.

## 2. Settlement worker: PASSED (with one limit)

Run 1 (operator connection `SUPABASE_DB_URL`, `apps/worker/.env.local`, `npm run build` then `node --env-file=.env.local dist/index.js`):

- Connected to `127.0.0.1:54322`; `settlement_release_state enabled:true`; timeouts applied.
- Release stage ran every 5 minutes (5 cycles, 0 errors), each `released:0, awaiting_provider:18, 8,916,000 kobo`
  (fake seed rows: correctly left pending). That is the empty-queue case handled.
- Idempotency, missed-cycle recovery (each run takes every due row) and exact T+1 boundaries: pgTAP 57 and 65 (a second run releases nothing; one journal per payment).
- Least privilege: no grants were added. The release function is operator-only by design, so the worker runs on the operator connection (documented in the stage header).
- Logs: JSON counts and kobo only, no references or names.

**Not done:** the controlled live pending→available test payment. A new payment captured now becomes due at 05:00 WAT tomorrow, so it cannot be shown inside this session. The rule itself is covered by pgTAP 57/65 (itest DB, 2,132 assertions).
**Suggested:** make one Paystack TEST payment now and confirm it releases after 05:00 WAT 2026-11-20 with the worker running. Status: **Not tested (needs the clock)**.

## 3. Bank accounts, browser QA (Account settings)

| Item | Result |
|---|---|
| Bank list loads | **Passed**: 299 banks from Paystack |
| Account number validation | **Passed**: submit disabled until exactly 10 digits, input capped at 10 |
| Paystack resolution + name match + save | **Passed** (evidence): account `OPay ••••4796` saved by you, resolved name "habeebulahi olamide ghazali" vs profile "Ghazali Habeebulahi Olamide", `name_matched = true`, `verified`, default, Paystack recipient created. I did not type the number myself. |
| Safe display | **Passed**: UI shows bank, last 4, status only; `my_bank_accounts()` returns last 4 |
| Only owner can access | **Passed** (database level): another user's `my_bank_accounts()` returns 0 rows; direct `SELECT` on `user_bank_accounts` is permission denied for `authenticated` |
| Mismatch cannot auto-approve | **Not tested in browser**. pgTAP 63 and `bank-name-match` unit tests cover it |
| Profile-name change re-review | **Not tested in browser**. pgTAP 64 (14 assertions) covers it |
| 48-hour cooling-off | **Not tested in browser** (first account has none by D-08; needs a second account). pgTAP 63 covers it |

## 4. Collection withdrawals, browser QA (`The Big One → Open test → Money`)

| Item | Result |
|---|---|
| Withdraw action found, collection named | **Passed** ("Withdraw from Open test") |
| Available / pending / total withdrawn figures | **Passed**: ₦1,075,000 / ₦0 / ₦0, matching the ledger view; after a ₦1,000 request ₦1,074,000 |
| Over available | **Passed**: UI shows "You can withdraw up to ₦1,075,000" and Continue stays disabled at ₦1,075,001. Server also enforces it (pgTAP 58/63) |
| Daily limit | **Passed**: ₦1,000,001 request refused by the server with the ₦1,000,000/day unverified-community message; no row written |
| Verified saved account required, one collection only | **Passed** in dialog (only the verified account is offered; request locks that collection's available account). Pending-only and other-collection funds: **not tested in browser** (this collection had no pending; pgTAP 58/63 cover it) |
| Cooling-off block | **Not tested in browser** |
| Confirmation + history | **Passed**: confirm step, then "Withdrawals in progress", then paid |
| Failed / reversed handling | **Not tested live** (see §5) |
| Approval rule | Owner requests auto-approve per decision §20; over ₦1,000,000 or by another officer needs approval. Not bypassed |

## 5. Paystack TEST transfer: PASSED for the success path; failed/reversed NOT tested live

| Step | Result |
|---|---|
| Credentials | TEST key, balance ₦66,963,837.80 (test funds), 299 banks, 0 prior transfers |
| Recipient creation | **Passed**: `RCP_…` stored on the account |
| Recipient reuse | **Not tested** (only one withdrawal) |
| Reservation | **Passed**: hold journal available→withdrawing, ₦1,000 |
| Initiation | **Passed**: worker claimed it, `POST /transfer`, our `ktr_` reference |
| Pending response | **Passed**: Paystack answered `otp`; row `otp`, withdrawal `processing`, nothing settled |
| Webhook signature | **Passed**: bad signature gives 401; correctly signed forged `transfer.success` gave `transfer_awaiting_otp` (body not trusted; Paystack re-verified, still `otp`, nothing settled) |
| Verification against Paystack | **Passed**: after you finalized the OTP in the dashboard, the worker's check settled it from Paystack's verify answer; withdrawal `paid`, transfer `success` |
| Ledger | **Passed**: `payout` journal Dr `collection_withdrawing` ₦1,000 + Dr `organiser_payouts` ₦1,000, Cr `collection_withdrawn` ₦1,000 + Cr `provider_receivable` ₦1,000; collection `withdrawing` ₦0, `withdrawn` ₦1,000, available ₦1,074,000; reconciliation 9/9 |
| Organiser receives full amount (§20) | **Passed**: amount ₦1,000, fee ₦0 charged to organiser |
| Transfer fee booked to `transfer_fee_expense` | **Not observed live**: Paystack's test mode reported a fee of 0, so no fee journal was posted. Booking is covered by pgTAP 63 and `transfers.test.ts` |
| Failed / reversed transfer | **Not tested live**. Covered by pgTAP 63 (failure releases the hold; reversal after success posts a reversal journal, status `reversed`) and `transfers.test.ts` with controlled provider responses |
| Unknown status after timeout | Code path: a timeout is `unknown`, never retried blind, resolved by verify-by-reference (D-27). Unit-tested, not forced live. Two `provider_unavailable` check results appeared in the log and resolved on the next check without a resend |

Finding: this TEST account has **transfer OTP enabled**. Kolekto deliberately has no OTP-entry step, so with OTP on every automatic transfer parks at `otp` until someone finalizes it in the Paystack dashboard. Automatic payouts need OTP off (documented audit §11), which makes the secret key alone able to move money.

## 6. Operational prerequisites

| Prerequisite | Status |
|---|---|
| Transfers work on the TEST account | Passed (one transfer settled) |
| Transfers approved on the LIVE account | **Not verified, blocked on external approval** |
| Sufficient funding | TEST balance ample. LIVE: **not verified** |
| OTP / approval arrangement | **Blocked**: OTP is ON for the TEST account; a decision is needed for live |
| Transfer webhooks configured in dashboard | **Not verifiable from here** (only the local handler was exercised, signature check passed) |
| Webhook signatures verified | Passed (code and probe above) |
| PA-04 provider settlement model | **Open** (unconfirmed per decisions §18) |
| O-1 legal review of holding third-party funds | **Open, blocks real money** |
| Fees F8 (negotiated Paystack 1%, ₦2,000 cap) | **Open** (written confirmation pending) |
| PA-08 / PA-09 transfer idempotency and timeout semantics | **Open** (§18 requires them verified before enabling) |

**Not production ready.** Live transfers stay off: `PAYSTACK_TRANSFERS_ENABLED` and `PAYSTACK_LIVE_TRANSFERS_APPROVED` are unset in every `.env`. I set `PAYSTACK_TRANSFERS_ENABLED=true` only on the one worker process I started, with a `sk_test_` key (the command refuses any other key), and then stopped it.

## 7. Staging plan (not started; staging `kwolxuoeqwuedydxzncb` remains paused)

Preconditions: sections 1–5 above accepted by the owner; separate go-ahead to unpause.

1. Owner unpauses the project; confirm identity: project ref `kwolxuoeqwuedydxzncb`, never the legacy production ref, before every step (`get_project` + `list_migrations`).
2. Take a backup/snapshot; state rollback (each migration header has one).
3. Apply in exact order, checking the ref and `list_migrations` before each: `20261118100000` then `20261118100100` then `20261118100200` then `20261119100000`.
   Note: local dev and itest had these applied by hand, so `schema_migrations` on those DBs does not list them. Staging should apply them through the migration tool so they are recorded.
4. Run the catch-up dry run on staging (`approve_verified_charge_settlements(false)`) and review. Approving there is a separate decision.
5. Deploy the worker with the operator connection (`SUPABASE_DB_URL` of staging); Paystack TEST key and `whsec_`; webhook endpoint `https://<staging>/api/webhooks/paystack` registered in the Paystack TEST dashboard with transfer events; decide OTP off for TEST.
6. Full verification: pgTAP against staging via a safe path, one TEST payment, T+1 release, one ₦1,000 TEST withdrawal, failed and reversed transfers using Paystack's test scenarios, reconciliation 9/9.

## 8. Verification run this session

- `npx tsc --build`: exit 0.
- `npm run invariants`: all seven hold.
- `npm test` (workspaces): exit 0, 0 failures.
- pgTAP on the isolated itest DB (all 67 files, run via `psql` in the container because the Supabase CLI could not connect): **2,132 ok, 0 not ok**, every plan matched.

## 9. Open items and issues noticed

1. Live pending→available test payment (needs 05:00 WAT).
2. Browser tests for mismatch, re-review and cooling-off; live failed/reversed transfers; recipient reuse.
3. Decide transfer OTP policy before any live use.
4. PA-04, PA-08, PA-09, F8, O-1.
5. Migrations on local dev/itest are applied by hand and absent from `schema_migrations`.
6. The shell in this environment pre-sets `PAYSTACK_SECRET_KEY` (empty) and other vars, which override `--env-file`; run tools with `env -u` or set them explicitly.
7. Withdraw dialog: clicking Request withdrawal gives no visible feedback until the server answers (a few seconds); a spinner exists (`loading={isPending}`), so this is latency, not a bug. Worth a look if it recurs.

Items 2 and 5 were closed in session 2 (§10). The rest stand.

## 10. Session 2: remaining QA gaps (same day, local dev + itest only)

### 10.1 "this-the-real-deal": pending past T+1 but not withdrawable. Not a bug in the money; the wording was wrong

`The Big One → this-the-real-deal` shows ₦15,000 pending past T+1. Those are 3 **fake-provider** seed/simulator payments.
Their schedule is `2026-11-t1-0500-lagos`, which requires a recorded provider settlement before release. Fake-provider
payments are never approved by the verified-charge catch-up (decisions §21), so the worker reports them every cycle as
`awaiting_provider` and correctly leaves them pending. Balances were **not** forced. A real Paystack TEST payment in that
collection would follow the verified-charge schedule and release at the next 05:00 WAT.

What was wrong was the explanation. The page said the provider had not released the funds, which reads as a Paystack
problem. Changed (display only, no amounts touched):

- `MoneyPanel.tsx` settling/awaiting-provider text, `money-view.ts` `eligibilityText("awaiting_provider")`, and the
  pending note in `CollectionDetailClient.tsx` now say the payment was received, T+1 has passed, and it is waiting for a
  Kolekto check before it can be withdrawn.

### 10.2 Payout account states the Money panel could not explain. Fixed

Before: with money available and a saved account that was still in its 48-hour cooling-off or under review, the panel
said "Add your bank account", although one was saved. Now (`money-view.ts` `payoutAccountWaiting`, `withdrawBlock`,
`MoneyPanel.tsx`, `page.tsx` reads `needs_review` from `my_bank_accounts()`):

- cooling-off: "Your bank account can receive withdrawals from <time> (48 hours after it was added, for your security)."
- under review: "Kolekto is checking your bank account …"
- `PayoutAccounts.tsx` (Account settings) explains a `needs_review` row the same way.

Unit tests added in `money-view.test.ts`. Verified in the browser on local dev.

### 10.3 Results

| Item | Result |
|---|---|
| Name mismatch → `needs_review`, cannot auto-approve | **Passed** (browser): second account in someone else's name saved as `needs_review`, never offered in the withdraw dialog. Left in `needs_review` on local dev |
| Profile-name change → re-review | **Passed** (browser + DB): renaming the profile sent ••••4796 back to `needs_review`; name restored, then operator re-approved it on local dev (`review_bank_account`), default and recipient kept |
| 48-hour cooling-off | **Passed** (server probe on local dev, rolled back): a second verified account is refused until `usable_from`; the new message shows in the UI |
| Pending-only block | **Passed** (browser, this-the-real-deal): Withdraw stays closed, the new wording is shown |
| Other-collection funds | **Passed**: the dialog only offers the open collection's available balance; the server refuses a request above it |
| Recipient reuse | **Passed**: a second withdrawal to ••••4796 reused the stored `RCP_…`; no new recipient |
| Failed transfer | **Passed** (controlled run on itest, real `dispatch`/`check` orchestration, fake provider): hold released to available, withdrawal `failed`, reconciliation 9/9 |
| Reversed transfer | **Passed** (same run): success then reversal posts the reversal journal, money back in available, status `reversed` |
| Transfer fee booked to `transfer_fee_expense` | **Passed** (same run, ₦25 fee): fee journal posted, organiser still receives the full amount |
| Live failed/reversed with the Paystack sandbox | **Not tested**: needs Paystack test scenarios and OTP off |
| Live pending→available T+1 payment | **Not tested (needs the clock)**: the worker is running on local dev (TEST key, transfer check only, release on); first chance 05:00 WAT 2026-11-20 |

### 10.4 Test fixes and itest reset

- pgTAP `63` assertion #61 counted every `transfer_fee_expense` entry in the DB, so it failed after any earlier run. Now
  scoped to its own fee journal (`transfer_fee:<withdrawal>`).
- My controlled runs had left ledger rows on itest that broke pgTAP 18/20/23/27. With the owner's approval itest was
  reset (`npm run itest:reset -- --confirm-reset-kolekto-itest`), all 146 migrations applied **through the tool**, so on
  itest the 2026-11-18/19 migrations are now recorded in `schema_migrations` (local dev still is not, item 5 above).

### 10.5 Verification (session 2)

- `npx tsc --build`: exit 0. `npm run invariants`: hold. `npm test`: 0 failures. Web vitest: 240 passed.
- Lint: 0 errors (1 pre-existing warning in `VerifyForm.tsx`).
- pgTAP on the freshly reset itest: 67 files, 2,132 planned, 2,132 ok, 0 not ok (`27_truncate_guards` re-run alone: 25/25; the
  full-run count was off by two because NOTICE lines were interleaved with `ok` lines).

### 10.6 Still open

1. Live T+1 payment (05:00 WAT 2026-11-20); live sandbox failed/reversed transfers.
2. Transfer OTP decision; live transfer approval, funding and webhook configuration; PA-04, PA-08, PA-09, F8, O-1.
3. Staging: still paused and untouched.
4. Noticed, not fixed: the Money panel takes several seconds to load; `notification_deliveries` is polled heavily;
   an expired session showed a 404 once before redirecting to login; the header and details overlap at about 790 px wide.
