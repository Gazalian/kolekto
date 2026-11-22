# Staging preflight: settlement, bank accounts and withdrawals (2026-11-19)

**Status:** PREFLIGHT ONLY. Nothing was unpaused, applied, deployed or changed on staging.
Legacy production was not listed, connected to or inspected. No Paystack setting was touched.
**Branch:** `feat/payment-receipts-alarms` (all session 27+ work still uncommitted and intact).

## 1. Staging project identity (verified read-only, `get_project`)

| Field | Value |
|---|---|
| Ref / id | `kwolxuoeqwuedydxzncb` (matches the intended ref) |
| Name | `kolekto staging` |
| Organisation | `gffmdnyuzihxoqievxbc` |
| Region | `eu-west-2` |
| Postgres | 17.6.1.166 (engine 17, GA channel) |
| Created | 2026-09-26 |
| **Status** | **`INACTIVE` (paused)**. Database tools cannot run until it is unpaused. |

Only this ref was queried. `list_projects` was deliberately not called, so no legacy project metadata was read.

Not yet known (needs the project running): staging's migration history, data volume, whether the
plan includes automatic backups.

## 2. Local working tree and migration state

- 23 modified and 25 untracked files (bank accounts, transfers, worker transfer stage, pgTAP 63–65,
  four migrations, three reports). Nothing discarded; local DB not reset.
- Repository: 146 migrations. **The four target migrations are untracked (never committed).**
- Local dev `schema_migrations`: 141 rows, last `20261117120100`. Five migrations are applied to local
  dev **by hand and not recorded**: `20261117130000` (committed in `6bf52c7`) and the four below.
  Their objects exist locally (`user_bank_accounts`, `withdrawal_transfers`,
  `app.approve_verified_charge_settlements(boolean, integer)`, `app.collection_payment_activity`).
- itest: all 146 recorded (reset through the tool in session 2).

**Risk:** the brief lists four migrations, but `20261117130000` is also newer than anything
confirmed on staging. Staging's real history must be read after unpausing; if anything else is
missing, I stop and report the full gap rather than applying only the four.

## 3. Intended migrations (in this order, ref and `list_migrations` re-checked before each)

| # | Version | Size | What it does | Rollback (from the file header) |
|---|---|---|---|---|
| 0 | `20261117130000` *(only if staging lacks it)* | — | collection payment activity read | drop the function |
| 1 | `20261118100000` | 16 lines | adds `reversed` to `withdrawal_status` | none needed; an unused enum value is harmless (cannot be dropped) |
| 2 | `20261118100100` | 1,468 lines | `user_bank_accounts`, `withdrawal_transfers`, five withdrawal columns, verified-charge settlement schedule row, functions | only while no saved account or transfer exists: restore prior function bodies, drop new functions and both tables, drop the five columns; schedule row stays (append-only) |
| 3 | `20261118100200` | 108 lines | profile-name change sends verified accounts back to review | drop trigger + function, restore guard from #2 |
| 4 | `20261119100000` | 294 lines | write-once `verified_charge_approved_at`, operator catch-up function | drop the function, restore release + guard from `20261117100100`; column may stay |

Applied with the Supabase migration tool so each is recorded. No hand-run SQL.
After each: errors, expected tables/functions/triggers/policies, row counts of money tables
unchanged, `platform_reconciliation()` 9/9.

**Backup.** The MCP tools cannot take a snapshot. Options: (a) the dashboard backup if the plan
includes one; (b) `supabase db dump` / `pg_dump` with the staging connection string, which needs the
staging database password from you. I will not apply anything without one of these done and recorded.

## 4. Configuration needed before the end-to-end test (not available today)

| Item | Status |
|---|---|
| Staging DB operator connection (`SUPABASE_DB_URL`) for the worker | needed from you |
| Where the worker runs for staging (a host, or a local process pointed at staging) | **undecided** |
| Web app deployed at a public staging URL (Paystack callback + webhooks) | **not confirmed** |
| Paystack TEST secret key + webhook secret for staging; webhook URL registered with transfer events | needed |
| Transfer OTP **off** on the Paystack TEST account (otherwise every payout parks at `otp`) | your decision |
| `PAYSTACK_TRANSFERS_ENABLED=true` on the staging worker only, TEST key only; live flag stays unset | to set at deploy |

The T+1 test cannot be shortened: a payment captured on day D releases at 05:00 WAT on D+1.
Timestamps will not be edited and nothing will be force-released.

## 5. Owner note: "collector manages funds from their own Paystack account"

Owner, 2026-11-19: withdrawals stay attributed to one collection internally; if that model does not
work, the collector can manage funds from their own Paystack account.

What the code does today (checked, not assumed): `packages/payments/src/orchestrator.ts:186` sends
`subaccountCode: null`, so **every payment lands in Kolekto's main Paystack balance**, and payouts are
transfers from that balance. That is Kolekto holding third-party money, which is exactly what O-1
(counsel) asks about. D-01's subaccount model is not wired yet.

The fallback the owner describes already has a name and a seam: `subaccount_auto_settle`
(`packages/adapters/src/settlement-provider.ts`, ADR 0015 §"Why this does not reintroduce…").
Each organiser gets a Paystack **subaccount**; Paystack splits each charge and pays the organiser's
bank on Paystack's schedule; Kolekto never holds the money; there is no withdraw button.

What it changes and what it keeps:

| Kept | Changes |
|---|---|
| Ledger, per-collection attribution recorded at capture (D-02) | Withdrawal UI, cooling-off, approval thresholds, daily limits and Kolekto transfers have nothing to act on |
| Fees (Kolekto fee taken by the split) | Per-collection "available / withdrawn" becomes "settled by Paystack" (provider settles per organiser, not per collection, PA-07) |
| Reconciliation shape | Kolekto needs the organiser's bank details to create the subaccount (same resolution + name match) |

One point needs your answer: "their own Paystack account" can mean a Paystack **subaccount under
Kolekto** (above; the organiser has no Paystack login and sees settlements only through Kolekto), or
the organiser's **own Paystack merchant account** (they sign up with Paystack themselves; Kolekto
would need their keys, which Paystack has no safe delegated-access flow for). I recommend the
subaccount. Until you confirm, nothing is built and §1 D-01 stands.

This also bears on the staging run: bank-account, withdrawal and transfer tests (brief §5–7) only
matter for the model where Kolekto holds funds. They are still worth running on staging, because
that model is fully built; the fallback would be a separate piece of work.

## 6. Production gate (unchanged from the 2026-11-19 report)

| Item | Status |
|---|---|
| PA-04 subaccount settlement control | **Open** (and unused: charges carry no subaccount) |
| PA-08 transfer idempotency | **Open** (code uses our own `ktr_` reference; provider behaviour unverified) |
| PA-09 transfer timeout semantics | **Open** (timeout → `unknown` → verify; unit-tested only) |
| F8 negotiated fee / cap | **Open** |
| O-1 legal authority to hold funds | **Open, blocks real money** |
| Live transfer approval | **Not verified** |
| Live balance funding | **Not verified** |
| Live webhook configuration | **Not verified** |
| OTP / transfer authorisation policy | **Open** (OTP on for TEST) |

Not staging-ready and not production-ready. Nothing was committed.

## 7. Waiting for

1. Explicit go-ahead to unpause `kwolxuoeqwuedydxzncb`.
2. Backup method (dashboard or a dump with the staging password).
3. Go-ahead to apply the migrations after I report staging's real history.
4. The configuration in §4.
5. Your answer on §5 (subaccount vs organiser's own merchant account).
