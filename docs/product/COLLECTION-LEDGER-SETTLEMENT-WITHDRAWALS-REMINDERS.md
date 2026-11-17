# Collection ledger, settlement, withdrawals, reminders and reference lock

Status: built 2026-11-17 on `feat/payment-receipts-alarms`, verified on the
itest database only. Nothing here has been applied to staging or production.
Companion to `COLLECTION-FINANCIAL-OVERVIEW-AND-REGISTER.md` (the overview and
register, migration `20261116130000`).

Owner decisions (2026-11-17), recorded in `docs/phase-4/financial-decisions.md`:

| Topic | Decision |
|---|---|
| Withdrawals | Ledger + database lifecycle. Operations pays out by hand and records the result. No Paystack Transfers, no saved bank accounts. First withdrawal per collection free; later ones refused until O-2 fee brackets exist. |
| Settlement | T+1 05:00 Africa/Lagos, released only once the provider's settlement is recorded. |
| References | Once any applied contribution exists, references cannot be switched on and the format cannot change. |
| Reminders | Organiser-sent payment reminders: in-app for linked accounts, email to the roll address (honours opt-out, community notice, `email_sending_enabled`), 24-hour per-member cooldown. Never automatic. |

## 1. Migrations (apply in order, all additive)

| File | Adds |
|---|---|
| `20261117100000_ledger_source_provider_settlement.sql` | `provider_settlement` journal source type |
| `20261117100100_settlement_lifecycle.sql` | `settlement_schedules` (immutable, versioned rule), `contribution_settlements` (one per captured contribution: scheduled → provider-confirmed / discrepancy → released), `record_provider_settlement`, `release_due_settlements` |
| `20261117100200_withdrawals.sql` | `withdrawals`, `post_ledger_journal`, request / decide / processing / complete / fail, hold and hold-release journals |
| `20261117100300_collection_ledger_reads.sql` | `collection_settlement_summary`, `collection_reconciliation`, `collection_ledger` (paged), `platform_reconciliation` |
| `20261117100400_contributor_reference_lock.sql` | `collection_has_contributor_activity`, triggers on `collections.codes_enabled`, `collection_code_settings`, `collection_tiers.code_prefix` |
| `20261117100500_payment_reminders.sql` | `payment_reminder_batches` / `payment_reminders` (append-only), summary / roster / send, worker recipient function, policy matrix rows for `targeted_reminder` |

No migration drops, renames or rewrites an existing column or row. Existing
contributions get no settlement row (the trigger fires on new captures only),
so balances already shown do not move.

## 2. Ledger

* Integer kobo only. Every journal balances (`ledger_imbalances` stays empty).
* Corrections are new journals that reference the journal they reverse
  (`reverses_journal_id`); nothing is updated or deleted.
* Every journal carries a unique idempotency key, so the same posting cannot
  land twice.
* Collection positions come from `v_collection_position`: pending, available,
  on hold, withdrawing, withdrawn, chargeback, refund reserve.

## 3. Settlement (T+1 05:00 Lagos, provider-confirmed)

* Each capture gets a `contribution_settlements` row with `scheduled_release_at`
  computed by the schedule version in force at capture time. Changing the rule
  means inserting a new version; old rows keep their time.
* `record_provider_settlement(reference, provider_settlement_id, settled_kobo, settled_at)`
  records the provider's settlement. Outcomes: `confirmed`, `already_confirmed`,
  `conflict` (a different settlement id), `discrepancy` (amount differs —
  audited, money stays pending).
* `release_due_settlements(limit)` moves confirmed rows whose time has passed
  from pending to available with one `balance_release` journal each. Rows past
  their time but unconfirmed stay pending (`awaiting_provider`). Idempotent.
* Scheduled time and actual release time are stored separately.

## 4. Withdrawals

Lifecycle: `requested → approved → processing → paid`, or `rejected`,
`cancelled`, `failed`. Requested amount is held at request
(`collection_available → collection_withdrawing`); reject / cancel / fail
reverse the hold; paid moves withdrawing → withdrawn.

`request_withdrawal` locks the collection's ledger account row, re-reads the
available balance, and refuses: unverified identity, amount above available,
fee not configured (any withdrawal after the free first one), ₦1,000,000 daily
limit for unverified communities. Idempotent per key. Only the last four
account digits are ever returned or audited. The community owner's own request
is auto-approved; others wait for the owner (`decide_withdrawal`; rejection
needs a reason).

## 5. Reconciliation

`collection_reconciliation(collection)` (balance.view) and
`platform_reconciliation()` (operator only) return one row per identity with
expected, ledger and difference. The Money tab shows only "every figure traces
to the ledger" or the names of failing checks.

## 6. Contributor reference lock

Activity = any applied contribution (provider-confirmed money). Unpaid
checkouts do not count. After that the database refuses
`CONTRIBUTOR_REFERENCES_LOCKED` for: switching codes on, creating settings,
changing prefix / separator / digits / start number, a tier gaining a prefix.
Re-saving identical settings and switching references off stay allowed. The
web maps the error to: "You can no longer add new contributor references
because this collection already has active contributors. This helps preserve
the consistency of existing contributor records."

## 7. Payment reminders

* Managed, member-audience, non-recurring collections only; collection must be
  active. Sender needs `reminder.send`.
* Eligible: not exempt, not cancelled, no applied contribution. Paid members
  are skipped at send time and again in the worker's fan-out.
* Per-member cooldown 24 h; up to 500 members per call; idempotent per key.
* Email goes to the roll address only when the member has not opted out
  (`email_enabled` / `reminders_enabled`), the community has attested its
  communication notice, and `email_sending_enabled` is on. In-app goes to
  linked accounts.
* Bulk email caps are zero today, so reminder emails defer and age out after
  72 h until operations raises the caps. In-app works now.

## 8. Web

Collection page tabs (`apps/web/app/c/[slug]/collections/[collectionSlug]/`):

* **Money** (`MoneyPanel.tsx`, balance.view): settlement breakdown and rule,
  reconciliation line, withdrawals (request with confirmation, owner approve /
  reject with reason, cancel), paged ledger.
* **Reminders** (`RemindersPanel.tsx`, managed member collections): counts,
  filters (not paid / reminded / paid / everyone), search, select or whole
  page, confirmation dialog, history and cooldown per member.
* **Settings**: reference lock banner and disabled fields.
* Server actions in `money-actions.ts`; typed callers in
  `packages/db/src/collection-money.ts`. All run as the signed-in officer; no
  service-role key reaches the browser.

## 9. Operator runbook (psql, operator session)

These functions refuse every client role (`app.assert_payment_operator_session`).
Run them from an operator connection to the right environment, inside a
transaction, and read the result before committing.

```sql
begin;
-- Provider says reference KLK-... settled 490000 kobo under settlement id S-123:
select * from app.record_provider_settlement('KLK-...', 'S-123', 490000, '2026-11-18 04:10+01');
-- Release whatever is due (the worker does this every 5 minutes where it may):
select * from app.release_due_settlements(500);
-- Payout lifecycle:
select app.mark_withdrawal_processing('<withdrawal id>');
select app.complete_withdrawal('<withdrawal id>', '<bank or transfer reference>', now());
select app.fail_withdrawal('<withdrawal id>', 'Bank rejected the account');
-- Platform-wide check (every row should be ok):
select * from app.platform_reconciliation();
commit;
```

## 10. Worker

* `collection.remind_unpaid` now plans recipients from
  `app.payment_reminder_batch_recipients(batch)` (feature-detected).
* Settlement release stage runs every 5 minutes only where the worker's role
  may execute `app.release_due_settlements(integer)`; the least-privilege
  worker role has no such grant today, so release runs only with an operator
  connection. Logs counts and kobo only.
* `scripts/itest/itest.mjs` grants the worker role
  `app.payment_reminder_batch_recipients(uuid)`.

## 11. Deployment

No new environment variables. Order:

1. Apply the six migrations to staging (`supabase db push` against the staging
   project), run the pgTAP suite there, check `platform_reconciliation()`.
2. Grant the worker role `execute` on `app.payment_reminder_batch_recipients(uuid)`
   (same as itest). Optionally on `app.release_due_settlements(integer)` if the
   worker should release; otherwise schedule the operator call.
3. Deploy worker, then web.
4. Production only after staging is verified and the owner approves.

Rollback: the web and worker changes revert by redeploying the previous build;
the tables are new and unused by older code. Dropping the new tables would
destroy settlement and withdrawal history and is not a rollback to run once
real money has moved.

## 12. Known gaps

* Officers with balance.view can still SELECT `ledger_journals` / entries
  directly (pre-existing), which exposes platform fee legs (D-28).
* Nobody can withdraw until identity verification exists (DEC-04).
* Withdrawal concurrency proven by lock design and single-session tests; no
  two-session race test yet.
* Recurring collections have no reminders; refunds deferred (D-31).
* Send-time email recheck does not re-check "still unpaid"; the email tells
  recent payers to ignore it.
