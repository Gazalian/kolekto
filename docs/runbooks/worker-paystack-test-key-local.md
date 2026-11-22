# Local worker — Paystack TEST key on, build, restart, key off

Local development only (worker against the dev database `127.0.0.1:54322`). Never a `sk_live_` key here.
Written 2026-11-22 (session 42).

## What the key does

| In `apps/worker/.env.local` | Worker does |
|---|---|
| no `PAYSTACK_SECRET_KEY` | Transfer stage off (`withdrawal_transfers_state enabled:false reason:no_paystack_key`). Approved withdrawals wait. |
| `sk_test_…` key, no `PAYSTACK_TRANSFERS_ENABLED` | Finishes transfers already in flight and runs reconciliation; **sends nothing new**. |
| `sk_test_…` key **and** `PAYSTACK_TRANSFERS_ENABLED=true` | Also sends every withdrawal that has been fully approved (member code + second approver) to Paystack TEST, within about a minute. TEST money only. |

A `sk_live_` key additionally needs `PAYSTACK_LIVE_TRANSFERS_APPROVED=true`; do not set either locally.

The worker reads `.env.local` only when it starts. Editing the file changes nothing until a restart.

## 1. Add the key

Copy the `PAYSTACK_SECRET_KEY=sk_test_…` line from `apps/web/.env.local` (same TEST key the web app uses) into
`apps/worker/.env.local`, plus the dispatch switch:

```
# --- Paystack TEST key for local payouts. Remove these 3 lines to switch payouts off. ---
PAYSTACK_SECRET_KEY=sk_test_...
PAYSTACK_TRANSFERS_ENABLED=true
```

Check (prints only the prefix):

```powershell
Select-String -Path apps\worker\.env.local -Pattern '^PAYSTACK' | ForEach-Object { $_.Line -replace '(sk_test_).*', '$1<hidden>' }
```

`.env.local` is git-ignored (`*.local`); never commit it.

## 2. Build

```powershell
npm run build --workspace apps/worker
```

Produces `apps/worker/dist/index.js`. Rebuild after any change to worker or package sources.

## 3. Restart

Stop the running worker first (Ctrl+C in its terminal). Only one worker should run.

A variable already set in the shell wins over `.env.local`, even when it is empty. Clear the Paystack ones, then
start:

```powershell
Remove-Item Env:PAYSTACK_SECRET_KEY, Env:PAYSTACK_TRANSFERS_ENABLED, Env:PAYSTACK_LIVE_TRANSFERS_APPROVED -ErrorAction SilentlyContinue
```

```powershell
npm run start --workspace apps/worker
```

Expect within a few seconds:
`"msg":"withdrawal_transfers_state","enabled":true,"dispatch":true,"testMode":true`.
`testMode:false` means a live key — stop the worker at once (Ctrl+C) and fix the file.

## 4. Remove the key when done

Delete the three lines added in step 1 from `apps/worker/.env.local`, then Ctrl+C the worker and start it again:

```powershell
npm run start --workspace apps/worker
```

Expect `"enabled":false,"reason":"no_paystack_key"`. Confirm the file is clean (should print nothing):

```powershell
Select-String -Path apps\worker\.env.local -Pattern '^PAYSTACK'
```

Transfers already sent keep settling through the Paystack webhook (web app); the worker's own checks resume the
next time it runs with a key.

## Reconciliation after a send

Since 2026-11-22 (migration `20261122100000`), a transfer sent less than 5 minutes before a reconciliation run and
not yet in Paystack's list is recorded as `provider_verification_pending` (info), not `missing_at_provider`. The
worker re-runs reconciliation about 6 minutes later; by then Paystack lists it, or it is checked by reference before
any warning is raised. The worker bundle with this logic needs that migration on the database it uses.
