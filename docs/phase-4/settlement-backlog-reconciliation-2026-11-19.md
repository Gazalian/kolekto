# Settlement backlog: why recent payments never became withdrawable (2026-11-19)

**Branch:** `feat/payment-receipts-alarms` (session 27 + this session uncommitted).
**Brief:** "Withdrawal system investigation, bank account management, T+1 settlement debugging" (owner, 2026-11-19).
**Owner decision taken this session:** audited catch-up (`financial-decisions.md` §21).

Everything below was read from the live files and the local dev database on 2026-11-19 ~10:00 WAT.

---

## 1. Which database holds the affected payments

| Environment | State | Finding |
|---|---|---|
| New production | **Does not exist** (`docs/phase-4/environments.md`). | Nothing to inspect. |
| Legacy production `busfgcmbndleljklrcbd` | Off-limits by project rule; not visible to this account. | Not read. |
| Staging `kwolxuoeqwuedydxzncb` | Only hosted project visible; **paused (INACTIVE)**. | Cannot have taken payments. |
| **Local dev** (Docker, `supabase_db_kolekto`) | Running; Paystack TEST-mode opt-in used for QA 14–17 Nov. | **Holds the affected payments.** |

So "recent payments" are Paystack **test-mode** payments on local dev. No real customer money is involved anywhere this codebase connects to.

## 2. Root cause

Two layers, both confirmed from code and data:

1. **Rule frozen on the old schedule (the actual block).** Every payment captured before
   2026-11-18 00:00 WAT got schedule `2026-11-t1-0500-lagos` (`requires_provider_confirmation = true`).
   `app.release_due_settlements` (`20261117100100_settlement_lifecycle.sql:489`) releases a row only
   when it is due **and** `provider_confirmed_at` is set. That is set only by
   `app.record_provider_settlement`, which nothing calls automatically (no Paystack settlement sync).
   The only release ever made was a hand-entered QA record (`LOCAL-QA-STL-1`, 17 Nov).
   Session 27 added the verified-charge schedule (`2026-11-18-t1-0500-lagos-verified-charge`), but a
   settlement row's schedule is immutable (guard trigger), so it helped only captures from 18 Nov on.
   There have been none since.
2. **No scheduler running.** The release runs inside `apps/worker` every 5 minutes. No worker process
   was running locally (only `next dev`), there is no deployment of the worker anywhere, and the
   least-privilege worker role has no grant on the release function (it must run on the operator
   connection). Even payments on the new rule are released only while a worker is running.

What was **not** the cause (checked):

- Lagos day maths: `app.settlement_due_at` gives Mon 23:55 WAT → Tue 05:00, Tue 00:00 → Wed 05:00
  (calendar day in Africa/Lagos, not +24 h). pgTAP 57 covers the vectors.
- Missed cycles: the release picks **every** due row on each run, oldest first, so a failed 05:00 run is
  recovered by the next run. No cycle bookkeeping to fall behind.
- Idempotency and locking: `FOR UPDATE SKIP LOCKED` + unique journal key `balance_release:<contribution>`.
- Capture recording, fee allocation and ledger: all 25 captures have a settlement row; all nine platform
  reconciliation identities hold (§5).

## 3. Affected payments (local dev, Paystack TEST mode)

Gross = charged to contributor. "Kolekto fees" = 1.5 % processing + 0.5 % Kolekto (D-28), frozen on the
attempt. "Paystack fee" = what Paystack's verify reported, booked to `provider_fee_expense`.

| Reference | Collection | Gross ₦ | Kolekto fees ₦ | Paystack fee ₦ | Net to organiser ₦ | Bearer | Captured (WAT) | Due (WAT) | State |
|---|---|---:|---:|---:|---:|---|---|---|---|
| KLK-24670YFXM5EY8VP8A6N8PF6TSV | f835a9ba | 1,200.00 | 24.00 | 18.00 | 1,176.00 | host | 14 Nov 14:36 | 15 Nov 05:00 | eligible, not released |
| KLK-5GMYS9S55HKE72JGBC7ZHJGGDW | 01a1c50c | 1,020,000.00 | 20,000.00 | 2,000.00 | 1,000,000.00 | contributor | 14 Nov 15:58 | 15 Nov 05:00 | eligible, not released |
| KLK-6RM66N2FQACYGV21W0KF8GHCV4 | 01a1c50c | 10,200.00 | 200.00 | 102.00 | 10,000.00 | contributor | 16 Nov 10:57 | 17 Nov 05:00 | eligible, not released |
| KLK-6JE8H4V5WEP0K7TRSDDZ5MP2M6 | 01a1c50c | 15,300.00 | 300.00 | 153.00 | 15,000.00 | contributor | 16 Nov 11:48 | 17 Nov 05:00 | eligible, not released |
| KLK-0GZWX76BV0BC7NCEY642849YJ3 | 01a1c508 | 7,446.00 | 146.00 | 74.46 | 7,300.00 | contributor | 16 Nov 12:28 | 17 Nov 05:00 | eligible, not released |
| KLK-1K5P94GRVR2QWBF632V4VDPBG5 | 01a1c50c | 51,000.00 | 1,000.00 | 510.00 | 50,000.00 | contributor | 17 Nov 14:32 | 18 Nov 05:00 | eligible, not released |
| KLK-5VGSG970J83S5YC50GQSETTDHK | f835a9ba | 1,300.00 | 26.00 | 19.50 | 1,274.00 | host | 14 Nov 14:37 | 15 Nov 05:00 | released 17 Nov (hand QA record) |

Grouping (brief §2.2):

| Group | Count | Net ₦ |
|---|---:|---:|
| Successfully paid and correctly pending (not yet due) | 0 | 0 |
| **Eligible for settlement but not processed** | **6** | **1,083,476.00** |
| Settled but not reflected in the dashboard | 0 | 0 (dashboard reads the ledger view; it matches) |
| Failed or incomplete payments in balances | 0 | 0 (every contribution comes from a `completed` attempt) |
| Missing or inconsistent ledger entries | 0 | 0 (all reconciliation identities hold) |
| Needs manual reconciliation | 18 | 89,160.00 — **fake-provider seed data** from 24 Sep; never approved, left pending |

Per collection now: `01a1c50c` pending ₦1,075,000, available ₦0 · `01a1c508` pending ₦7,300, available ₦0 ·
`f835a9ba` pending ₦5,096 (₦1,176 of it Paystack, the rest seed), available ₦1,274. Withdrawn everywhere: ₦0.
No withdrawals or saved bank accounts exist on local dev.

Fee check: organiser net = contribution − 2 % (host absorbs) or = contribution (contributor pays), integer
kobo, matches the frozen attempt. Paystack's reported fee varies (1.5 % on the first two small test charges,
1 % later, ₦2,000 cap on the ₦1.02m charge); it is booked as Kolekto's expense and never reduces the
organiser's net. The payment fee and the transfer fee are separate accounts (`provider_fee_expense`,
`transfer_fee_expense`).

## 4. The fix (this session)

`supabase/migrations/20261119100000_settlement_verified_charge_catchup.sql`:

- `contribution_settlements.verified_charge_approved_at` — nullable, write-once (guard trigger).
- `app.approve_verified_charge_settlements(p_apply, p_limit)` — operator only. Lists due, unconfirmed
  payments on a provider-confirmed schedule. Approves only verified, non-fake charges; audits each
  (`settlement.verified_charge_approved`). `p_apply = false` is a dry run.
- `app.release_due_settlements` — one extra condition: an approved row counts as releasable.
- `app.guard_contribution_settlement` — approval written once, only on a pending, unconfirmed row.
- Rollback in the migration header. No stored amount changes.

Not a fake provider confirmation: `provider_confirmed_at` is untouched, so
`provider_receivable_vs_unconfirmed` keeps its meaning.

## 5. Evidence

- itest DB: migration applied by hand; **pgTAP 65: 24/24**; full suite **67 files, 2,132 assertions,
  0 failures** (includes 57, 58, 62, 63 and the guardrail files 01, 02, 03, 18).
- `tsc --build` clean; `npm run invariants` all seven hold; worker unit tests 813 pass; payments 24 pass.
- Local dev: migration applied by hand; dry run returned exactly the 6 eligible + 18 skipped above;
  **0 rows approved**; platform reconciliation 9/9 ok before any approval.

## 6. Recovery on local dev — waiting for the owner's go-ahead

```sql
-- operator session (postgres), local dev only
begin;
select * from app.approve_verified_charge_settlements(true, 500);  -- expect 6 approved, 18 skipped
select * from app.release_due_settlements(500);                    -- expect released 6, 108347600 kobo
select * from app.platform_reconciliation();                       -- expect all ok
commit;
```

Expected afterwards: `01a1c50c` available ₦1,075,000, `01a1c508` ₦7,300, `f835a9ba` ₦2,450.

## 7. Already built (session 27, still uncommitted) — maps to the brief

| Brief part | Where | Verified |
|---|---|---|
| Bank accounts (Part 3) | Account settings → "Bank accounts for withdrawals" (`/account`, `apps/web/app/account/PayoutAccounts.tsx`, `bank-actions.ts`); Paystack bank list + resolve; `matchBankAccountName`; `user_bank_accounts` (RLS deny-all, last 4 only to clients) | pgTAP 63/64, unit tests; **no browser QA yet** |
| Withdraw per collection (Part 4) | Collection page → money panel → Withdraw (`MoneyPanel.tsx`); `request_withdrawal_to_account` locks the collection's available account | pgTAP 58/63, two-session race tests |
| Paystack transfers (Part 7) | `PaystackTransferProvider`, `packages/payments/src/transfers.ts`, worker stage, `transfer.*` webhook re-verified via API | unit tests; **no test-mode transfer sent end to end yet** |
| Status + ledger (Parts 8–9) | `reversed` status, payout/fee/reversal journals, reconciliation extended | pgTAP 63 |

## 8. Still open

1. Owner go-ahead to run §6 on local dev.
2. Run the worker with the operator connection wherever releases should happen (locally: start
   `apps/worker`); deploy it with staging. Without a running worker, nothing is released on any rule.
3. Browser QA of the bank-accounts screen and withdraw dialog; one Paystack TEST-mode transfer end to end.
4. Staging: un-pause, apply `20261118100000` → `20261118100100` → `20261118100200` → `20261119100000`
   (separate approval; rollback in each header).
5. Paystack dashboard prerequisites (audit 2026-11-18 §11): transfers approved, funds kept in balance,
   OTP decision, transfer webhooks.
