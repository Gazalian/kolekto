# Withdrawals, Paystack Transfers and T+1 settlement — audit (2026-11-18)

**Branch:** `feat/payment-receipts-alarms` at `6bf52c7` (clean).
**Brief:** "Complete withdrawal system, Paystack automation and T+1 settlement engine" (owner, 2026-11-18).
**Status:** Audit only. No code, schema or data changed. Implementation waits on the owner decisions in §10.

Everything below was read from the live files on this branch, not from earlier reports.

---

## 1. Payment lifecycle today

1. **Checkout.** `submitContributionAction` → `startCheckout()` (`packages/payments/src/orchestrator.ts`).
   Fees computed once by `calculateFees()` (`packages/domain/src/fees.ts`) and frozen onto the attempt (D-16).
   `app.create_payment_attempt` checks the window, target, eligibility and stock, then the adapter calls
   Paystack `POST /transaction/initialize` (`packages/adapters/src/paystack-payment-provider.ts`).
   `subaccountCode` is always `null` (`orchestrator.ts:186`), so **every payment lands in Kolekto's own
   Paystack balance**. Subaccounts (D-01 / ADR 0015) are not wired.
2. **Confirmation.** Either the callback page or `POST /api/webhooks/paystack` (`apps/web/app/api/webhooks/paystack/route.ts`).
   The webhook verifies the signature, then **does not trust the body**: it calls `confirmPayment()`,
   which re-verifies with `GET /transaction/verify/:reference`.
   - T1 `app.record_provider_transaction` stores the raw event (unique per attempt + content hash).
   - T2 `app.complete_payment_capture` writes the contribution (unique per attempt), posts the capture
     journals, converts stock, marks the obligation paid. Idempotent; a second call is `already_paid`.
3. **Settlement row.** A trigger creates one `contribution_settlements` row per new capture with
   `scheduled_release_at` from the versioned `settlement_schedules` row (T+1 05:00 Africa/Lagos).
4. **Sweep.** `apps/worker/src/payment-sweep.ts` expires abandoned attempts and re-verifies stale ones.

Webhook events for `transfer.*` are parsed (`parseWebhookSubject`) and **acknowledged and ignored**
(`transfer_ignored`).

## 2. Fee calculation today (D-28, schedule `2026-11-founder`)

| Line | Rate | Shown? | Where it goes in the ledger |
|---|---|---|---|
| "Processing fee" | 1.5 % of the contribution, uncapped | yes | `platform_fee_income` |
| "Kolekto fee" | 0.5 % of the contribution, uncapped | yes | `platform_fee_income` |
| Paystack's actual cost to Kolekto | negotiated 1 %, cap ₦2,000 (estimate only) | never | `provider_fee_expense`, **from Paystack's reported `fees`** (D-11) |

Fee bearer per collection (`fee_mode`): `community_absorbs` (default) or `contributor_pays`.

Worked example, ₦10,000, host absorbs: fees ₦150 + ₦50 = ₦200; organiser credited **₦9,800**.
Contributor pays: contributor charged ₦10,200; organiser credited **₦10,000**.
Fees are computed on the contribution, never on the total (no fee on a fee).

**Comparison with the brief.** The brief names "Paystack 0.5 % + Kolekto 1.5 %". The code shows
"Processing 1.5 % + Kolekto 0.5 %". **The organiser's net is identical (₦9,800 on ₦10,000)**; only
the labels and the internal split differ. In the code, Paystack's real charge is not a fixed percentage
at all: it is whatever Paystack reports on verify, booked as an expense, and Kolekto's revenue is
"total fee charged − actual Paystack fee". That already satisfies the brief's rules "record the actual
Paystack charge" and "never treat Paystack's fee as Kolekto revenue". See decision Q1.

## 3. Settlement today

- `settlement_schedules`: immutable, versioned rule (05:00 Africa/Lagos, next calendar day, every day — D-09).
- `contribution_settlements`: `scheduled → provider-confirmed / discrepancy → released`, scheduled and
  actual release times stored separately.
- `app.record_provider_settlement(reference, settlement_id, kobo, at)`: records the provider's settlement;
  mismatch → `discrepancy`, money stays pending.
- `app.release_due_settlements(limit)`: releases rows that are **due AND provider-confirmed**, one
  `balance_release` journal each, row locks + unique journal key → idempotent.
- Worker runs the release every 5 minutes (`apps/worker/src/settlement-release.ts`). Running it every
  5 minutes rather than once at 05:00 is deliberate: a missed or failed 05:00 run is retried automatically.

**Gaps.** (a) Provider settlement is recorded **by hand** from an operator session; there is no Paystack
settlement sync. Until there is, no payment ever becomes available without an operator. (b) The
least-privilege worker role has no grant on `release_due_settlements`, so the worker stage is skipped
unless it runs with the operator connection.

## 4. Withdrawals today (`20261117100200_withdrawals.sql`)

- `public.withdrawals`, one collection per withdrawal (D-03). Status machine
  `requested → approved → processing → paid`, plus `rejected`, `cancelled`, `failed`, guarded by a trigger;
  amount, destination and requester immutable; never deleted.
- `app.request_withdrawal`: locks the collection's `collection_available` ledger account row, re-sums
  entries, refuses above available, idempotent per (collection, requester, key), posts the hold journal
  (`collection_available → collection_withdrawing`) in the same transaction.
  Refuses: officer not `identity_verified`; any withdrawal after the free first one
  (`WITHDRAWAL_FEE_NOT_CONFIGURED`, O-2 brackets open); ₦1,000,000/day for unverified communities (D-07).
- `decide_withdrawal` (owner approve / reject with reason, D-06), `mark_withdrawal_processing`,
  `complete_withdrawal` (withdrawing → withdrawn), `fail_withdrawal` (hold reversed).
- **Payout is manual**: operations sends the bank transfer and records it. No Paystack Transfers.
- Destination is typed per request (name, NUBAN, bank) with no resolution. Only last four digits leave the DB.
- No `reversed` status and no reversal journal.

## 5. Profile and bank accounts today

- `public.users`: `full_name` (1–120 chars, from sign-up metadata), `identity_level`
  (`none` … `identity_verified`). **No identity-verification flow exists**, so no real user can pass the
  withdrawal gate today.
- **No saved bank account table, no Paystack bank list, no account resolution, no transfer recipients.**
- `role_permissions.requires_second_approver` is already `true` for `withdrawal_account.change`, and
  D-08 imposes a 48-hour cooling-off after a destination change. Neither is enforced anywhere yet because
  there is no saved destination to change.

## 6. Relevant tables and functions

Ledger: `ledger_account_codes`, `ledger_accounts`, `ledger_journals`, `ledger_entries`, `v_collection_position`,
`ledger_imbalances`. Payments: `fee_schedules`, `payment_limits`, `contribution_intents`, `payment_attempts`,
`payment_attempt_lines`, `provider_transactions`, `contributions`, `contribution_lines`, `stock_reservations`.
Settlement: `settlement_schedules`, `contribution_settlements`. Withdrawals: `withdrawals`,
`withdrawal_fee_schedules` (no rows). Reads: `collection_settlement_summary`, `collection_reconciliation`,
`platform_reconciliation`, `collection_ledger(_by_kind)`, `collection_payment_activity`, `collection_withdrawals`.

## 7. Ledger

Already a real double-entry ledger, and the brief's ten ledger rules are already enforced at the database:
balanced journals (deferred constraint trigger), immutable entries (revoke + trigger), corrections by
`reverses_journal_id`, unique idempotency key per journal, balances are views over entries (no balance
column), collection-scoped accounts with a `CHECK` that collection money names its collection, platform
income and provider expense at platform scope.

Chart of accounts (closed vocabulary): `provider_receivable`, `platform_fee_income`, `provider_fee_expense`,
`collection_pending`, `collection_available`, `collection_on_hold`, `collection_withdrawing`,
`collection_withdrawn`, `collection_refund_reserve`, `collection_chargeback`.

**Missing for Transfers:** an account for Paystack transfer fees (`transfer_fee_expense`, platform scope)
and, if Kolekto charges a withdrawal fee, an income line for it. A reversal needs no new account: it is a
journal from `collection_withdrawn` back to `collection_available`.

## 8. Bugs and gaps found

| # | Gap | Severity |
|---|---|---|
| G1 | Nobody can withdraw: the `identity_verified` gate has no verification flow behind it. | blocks the feature |
| G2 | T+1 release needs a hand-recorded provider settlement; no sync exists. | blocks automatic availability |
| G3 | Worker role cannot run the release (no grant). | blocks automatic availability |
| G4 | No saved bank accounts, no resolution, no name check, no recipients. | brief Phase 5 |
| G5 | No Paystack Transfers; `transfer.*` webhooks ignored; no verify fallback. | brief Phase 6 |
| G6 | No `reversed` withdrawal status or reversal journal. | brief Phase 7.4 |
| G7 | Second withdrawal per collection always refused (O-2 fee brackets never decided). | product decision |
| G8 | No Paystack transfer-fee account; transfer fee bearer undecided. | brief Phase 10 |
| G9 | Withdrawal concurrency proven only by lock design + single-session tests; no two-session race test. | test gap |
| G10 | Officers with `balance.view` can `SELECT` `ledger_journals` / `ledger_entries` directly, which shows platform fee legs (D-28 says Paystack cost is internal). | security, pre-existing |
| G11 | Status doc said sessions 25–26 uncommitted; they are committed in `6bf52c7`. | doc drift, fixed in the status report |

Not a gap, but a constraint the brief does not mention: **ADR 0005 forbids Supabase Edge Functions.**
Webhooks are Next.js route handlers in `apps/web`; scheduled work runs in `apps/worker`. The
implementation follows that rather than adding Edge Functions.

## 9. Recommended architecture

Reuse everything above. Add, behind the existing §18 flag (off by default, live payout stays manual
until the owner switches it on):

1. **Saved bank accounts on the profile** — `user_bank_accounts` (per user, several allowed, one default),
   bank code + name, account number (stored, only last four ever returned), resolved name, name-match
   result, status `verified | needs_review | rejected | disabled`, Paystack `recipient_code`,
   `verified_at`, `cooling_off_until` (D-08, 48 h). Adapter methods for `GET /bank`,
   `GET /bank/resolve`, `POST /transferrecipient`. Server actions only; the secret key never leaves the server.
   Name match: normalise (case, punctuation, whitespace, order of name tokens); auto-verify when the
   resolved name's tokens cover the profile name's first and last names; otherwise `needs_review` for an
   operator, never silently accepted.
2. **Withdrawal picks a saved verified account** instead of typed details. New request function checks
   ownership, `verified`, cooling-off passed, and keeps every existing check (lock, available, idempotency,
   limits, approval). Destination snapshot still frozen on the withdrawal row.
3. **Transfers** — `withdrawal_transfers` (one per attempt, unique Kolekto transfer reference, Paystack
   `transfer_code`, status, raw response, fee). Worker stage picks approved withdrawals, initiates
   `POST /transfer` (amount in kobo, `source: balance`, our reference), marks `processing`.
   Timeout = `unknown`, never retried blindly; resolved by `GET /transfer/verify/:reference` (D-27).
4. **Transfer webhooks** — same route, signature-verified, then **re-verified via the API** (same pattern
   as charges): `transfer.success` → `complete_withdrawal`; `transfer.failed` → `fail_withdrawal`
   (hold released); `transfer.reversed` → new `reversed` status + reversal journal
   (`collection_withdrawn → collection_available`). All idempotent by transfer reference.
5. **Transfer fee** — Paystack's actual transfer fee booked to a new `transfer_fee_expense` account at
   platform scope, separately from payment fees; who bears it per decision Q4.
6. **Settlement** — keep "release only after provider confirmation"; automate the confirmation per
   decision Q2; grant the worker role the release function in an additive migration.
7. **Tests** — pgTAP for every new function and transition, a two-session concurrency test, adapter tests
   against a mocked Paystack API, and a sandbox run with the test key (no live payout).

## 10. Decisions needed before building

| # | Question | Why it matters |
|---|---|---|
| Q1 | Keep D-28 fee labels (Processing 1.5 % + Kolekto 0.5 %, actual Paystack cost recorded as expense) or relabel as the brief states? | Organiser net is the same either way; relabelling changes contributor-facing copy and needs a new schedule version, not an edit. |
| Q2 | What confirms that a payment's funds are settled, so release can be automatic? | Today it is a manual operator step. Options: Paystack Settlements API sync (PA-04 / PA-10 unverified; settlements may not occur in test mode), or treat a verified charge plus T+1 as settled and check Paystack's balance before each transfer. |
| Q3 | Does a verified, name-matched bank account replace the `identity_verified` gate, or must both hold? | With both, nobody can withdraw until an identity-verification flow is built. |
| Q4 | Who bears Paystack's transfer fee, and does the second withdrawal per collection stay blocked until O-2 fee brackets exist? | The brief requires the fee shown before confirmation and booked separately. |

## 11. Paystack account prerequisites (to confirm on the dashboard, not assumed)

- The business is approved for Transfers (Paystack requires this for live transfers).
- Settlement preference keeps funds in the Paystack **balance** (otherwise Paystack sweeps them to
  Kolekto's bank and transfers fail for insufficient balance).
- Transfer OTP: Paystack's dashboard requires OTP on transfers by default; fully automated transfers need
  it disabled (Settings → Preferences → Transfers, or the disable-OTP API, which itself needs an OTP).
  Disabling it means anyone holding the secret key can move money, so the key must stay server-only and
  rotation must be documented.
- Transfer webhook events delivered to the same webhook URL; IP allow-list optional.
- Paystack's published Nigerian transfer fees (₦10 / ₦25 / ₦50 by amount band) are to be confirmed
  against the account's actual pricing; the ledger records the fee Paystack reports, not the published table.

## 12. What was built (2026-11-18, decisions in `financial-decisions.md` §20)

| Layer | What | Where |
|---|---|---|
| DB | `withdrawal_status` gains `reversed` (own file: an enum value cannot be used in the transaction that adds it). | `20261118100000_withdrawal_reversed_status.sql` |
| DB | Verified-charge T+1 schedule; `transfer_fee_expense` account; `user_bank_accounts` (RLS deny-all, immutable facts, guarded transitions); operator-only `register_bank_account` / `set_bank_account_recipient` / `review_bank_account`; client `my_bank_accounts` (last 4 only; bank-reported name only once verified), `set_default_bank_account`, `disable_bank_account`; `request_withdrawal_to_account` (own verified account, cooling-off, same lock and limits, fee 0) and the old typed-destination `request_withdrawal` revoked from clients; `withdrawal_transfers`; operator-only `claim_withdrawal_transfers` (SKIP LOCKED), `record_withdrawal_transfer_state`, `settle_withdrawal_transfer` (success → payout + fee journals; failed → hold released; reversed after success → reversal journal, status `reversed`), `withdrawal_transfers_to_check`; manual payout functions refuse a withdrawal that has a transfer; reconciliation extended. | `20261118100100_bank_accounts_and_transfers.sql`, pgTAP 63 (76) |
| Domain | `matchBankAccountName` (accents, titles, initials, apostrophes, order-free). | `packages/domain/src/bank-name-match.ts` |
| Adapters | `TransferProvider` contract; `PaystackTransferProvider` (banks, resolve, recipient, balance, initiate from balance with Kolekto's `ktr_` reference, verify; D-27: a timeout is `unknown`, never retried blind); `FakeTransferProvider`; `paystackTransfersEnabled`. | `packages/adapters/src/*transfer-provider.ts` |
| Orchestration | `dispatchWithdrawalTransfers`, `checkWithdrawalTransfers`, `confirmWithdrawalTransfer`. Only Paystack's verify answer settles; a refusal is verified before anything is failed; an unsent transfer is re-sent under the same reference only when Paystack has none. | `packages/payments/src/transfers.ts` |
| Worker | Payout stage: check every 2 min (also with the flag off, so in-flight transfers finish), dispatch every minute only with the flag on. Counts-only logs. | `apps/worker/src/withdrawal-transfers.ts` |
| Webhook | `transfer.*` routed by `ktr_` reference to `confirmWithdrawalTransfer` after the signature check; the body's event name is not trusted. | `apps/web/app/api/webhooks/paystack/route.ts` |
| Web | Account settings → "Bank accounts for withdrawals" (bank list, resolve, match, register, recipient). Withdraw dialog picks a saved verified account; fee row "Free — Kolekto pays the bank transfer fee"; history shows the transfer reference and reversals. | `apps/web/app/account/*`, collection `MoneyPanel.tsx` |

## 13. Deployment (none done; each step needs the owner's go-ahead)

1. **Paystack dashboard (§11):** transfers approved; settlement kept in the balance; decide OTP (fully automatic needs it off — then the secret key alone moves money); transfer webhooks on the existing URL.
2. **Migrations, staging first:** `20261118100000`, then `20261118100100`, then `20261118100200` (re-review on name change). Both additive. The second replaces function bodies (`guard_withdrawal`, `mark_withdrawal_processing`, `complete_withdrawal`, `fail_withdrawal`, reconciliation reads) and drops/recreates `app.collection_withdrawals` with extra columns; it changes no stored amount and no existing row.
   **Rollback:** revert the web/worker deploy first; then `revoke execute on app.request_withdrawal_to_account … from authenticated` and `grant execute on app.request_withdrawal(...) to authenticated` to restore the typed-destination path; re-apply the previous bodies of the replaced functions from `20261117100200` / `20261117100300`. Tables and the enum value stay (empty or unused is harmless); ledger rows are never deleted.
3. **Worker grants:** the payout stage needs EXECUTE on the five functions in `WITHDRAWAL_TRANSFER_FUNCTIONS` for the role the worker runs as. They are operator-only today; run the worker on the server connection, as for the settlement release.
4. **Env (server only, never `NEXT_PUBLIC_`):** `PAYSTACK_SECRET_KEY` (already used), `PAYSTACK_TRANSFERS_ENABLED=true` to send, and with a live key `PAYSTACK_LIVE_TRANSFERS_APPROVED=true`. Unset = check-only, nothing sent.
5. **First live payout:** one small owner withdrawal to the owner's own account, watched end to end (claim → transfer → webhook → `paid`, fee journal, reconciliation all ok) before anyone else withdraws.

## 14. Residual risks (owner to decide)

- **Profile name is user-editable — closed 2026-11-18 (owner chose re-review).** `20261118100200`: a change to `users.full_name` (ignoring case and spacing) moves every verified account of that user to `needs_review` and clears the default, audited with the last four digits only. New withdrawals to it are refused; an approved one is not claimed until an operator approves the account again (`app.review_bank_account`); if rejected, operations fail the withdrawal (`app.fail_withdrawal`), returning the hold. A withdrawal already processing finishes. Rollback in the migration header. pgTAP 64 (14). Residual: someone could still register an account under a new name, but that account then gets the 48 h cooling-off and the change is audited.
- **Account-existence probing.** A not-found resolution is not stored, so it is not counted by the 10-per-day limit (mismatches are counted, and their names are never shown). Paystack's own rate limits apply.
- **Full account numbers are stored** (needed to create recipients). RLS deny-all, operator-only reads, last 4 to clients.
- **Funds pool in Kolekto's Paystack balance** (no subaccounts): a balance shortfall delays every payout until topped up. The balance check prevents failed sends; reconciliation `held_funds_cover_organiser_liabilities` shows the gap.
