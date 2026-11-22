# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payment-receipts-alarms` (sessions 20–24 committed, session 25 uncommitted; cut from `main`, which holds PR #33 merged 2026-11-14)  
**Last commits** (on `main` after the merge):

- `b99660d` Merge pull request #33 from Gazalian/feat/payments-foundation
- `92fe539` docs(payments): status after sessions 14-18
- `8f932bb` fix(itest): itest:reset waits for storage like itest:up
- `a868fc2` feat(payments): local Paystack test opt-in and sandbox runner
- `ae2c215` feat(payments): abandoned checkout waits for its hold
- `771a1a0` fix(adapters): read Paystack webhook id from data.id
- `4063739` docs(payments): correct session 12 status — PR #31 already merged
- `3668131` feat(payments): create member obligation on capture for all-members/groups
- `46b6e16` feat(domain): M8.3b resolver hardening — stock, applied, status, ceiling

**Authoritative docs** (read these before changing anything):

- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-22, session 42b — **reconciliation grace period built and verified on itest (unit + pgTAP); NOT yet on the dev database; worker `.env.local` now holds the TEST key + dispatch switch but the running worker was not restarted**; session 42 and earlier detail below unchanged.

### Session 42b — provider-verification grace period for transfer reconciliation (nothing committed)

**Done.** A transfer absent from Paystack's list within 5 min of dispatch is `provider_verification_pending` (info),
never `missing_at_provider`; after 5 min Paystack is asked by reference (GET only) before any warning. The worker
re-runs reconciliation ~6 min after a run with pending items. Each run stores `provider_grace_seconds`. Details:
`withdrawal-otp-owner-approval-2026-11-19.md` §12.

**Why.** Session 42's start-up run flagged the just-paid `ktr_6a1c…` as missing (false positive).

| Check | Result |
|---|---|
| Migration `20261122100000` on **itest** (single transaction + `schema_migrations` row; itest migration copy updated, byte-identical) | APPLIED |
| pgTAP 72 (new) / 70 / full suite on itest | 21/21 · 92/92 · 71 files, 2,407 assertions, 0 failures; 0 rows left behind |
| Unit: payments 64 (19 new) · worker 825 (1 new) · adapters 240 · domain 269 · db 6 | all pass |
| `tsc -b` | clean |
| `npm run invariants` | only the known `one Paystack caller` hit at `packages/domain/test/log-redaction.test.ts:28` (session 39, unchanged) |
| Dev DB (`:54322`) | read-only check only: migration absent; existing open warnings (`ktr_bb67…` ×4, `ktr_4f40…`, `ktr_6a1c…`) untouched |
| Worker | `apps/worker/.env.local`: `PAYSTACK_SECRET_KEY` (`sk_test_`, copied from web, never printed) + `PAYSTACK_TRANSFERS_ENABLED=true`; backup of the file before the edit in the session scratchpad. Running worker (keyless, 09:32 bundle) **not** restarted; `dist` **not** rebuilt. No approved withdrawals waiting (withdrawals: 4 paid, 2 failed, 2 cancelled) |

**Next (needs the owner's OK):** apply `20261122100000` to the dev database → `npm run build --workspace apps/worker`
→ restart the worker (runbook `docs/runbooks/worker-paystack-test-key-local.md`). Building first without the
migration would make a run with a pending item fail to record (no money effect, but the report is lost).

**Paste-ready prompt:** "Apply migration 20261122100000 to the local dev database (127.0.0.1:54322) only, rebuild the
worker, restart it with the TEST key from apps/worker/.env.local using a clean environment, confirm
`enabled:true dispatch:true testMode:true` and a recorded reconciliation run with `provider_grace_seconds=300`. Do not
acknowledge existing warnings. No commit."

### Session 42 — result: TEST withdrawal `KWD-25ABD04865040369` PAID (nothing committed)

Owner said "Yes, send it". One dispatch run, then payouts off again.

| Step | Evidence (UTC, 2026-11-22) | Result |
|---|---|---|
| Worker bundle | `dist/index.js` was from 2026-11-20 11:47, older than session 39 sources; rebuilt with `npm run build` (esbuild). Old bundle kept in the session scratchpad | DONE |
| Clean start | Keyless worker PID 20000 stopped (identity checked; 0 open transfers). The shell inherited app variables (an empty `EMAIL_PROVIDER` would have overridden `mailpit`; `PAYSTACK_SECRET_KEY` empty), so the worker was started with them removed (`env -u …`), plus the `sk_test_` key (prefix-checked, never printed) and `PAYSTACK_TRANSFERS_ENABLED=true` in the process environment only. No env file edited | VERIFIED: `withdrawal_transfers_state enabled:true dispatch:true testMode:true` |
| Dispatch | `dispatch examined 1 initiated 1`; transfer `ktr_6a1c7ff6a7fb5c06d6d6fe9e`, initiate requested 08:34:26.871, Paystack `received` | VERIFIED |
| Approval callback | 08:34:30.827: `approve` / `authorised`, provider amount 130000, **signature valid**; audit `withdrawal.transfer_approved_by_kolekto` | VERIFIED |
| Provider outcome | `transfer.success` webhook → check `paid` 08:34:35; Paystack TEST verify: **success**, 130000 NGN, `TRF_ygwudrdiql5ochh9`, domain test, fee 0; dashboard list shows it first | VERIFIED |
| Withdrawal | `paid` 08:34:34.740, `payout_reference TRF_ygwudrdiql5ochh9`; exactly 1 transfer row; no release journal | VERIFIED |
| Ledger | hold `withdrawal_hold:01a20242…` (available debit / withdrawing credit 130000) and payout `payout:01a20242…` (withdrawing debit, organiser_payouts debit, withdrawn credit, provider_receivable credit, 130000 each). No fee journal (fee 0) | VERIFIED |
| Balances (collection `01a1c50c…`) | after: available 107,250,000 / withdrawing 0 / withdrawn 250,000 kobo (session 38 end: 107,380,000 / 0 / 120,000 → −/+ 130,000) | VERIFIED |
| Reconciliation | `platform_reconciliation()` 9/9 ok; ledger imbalances 0 | VERIFIED |
| Cleanup | Keyed worker stopped right after success; restarted keyless → `enabled:false reason no_paystack_key`, OTP delivery still on; 0 secret-shaped strings in both worker logs; 0 `PAYSTACK` lines in `apps/worker/.env.local` | VERIFIED |

**Transfer reconciliation run at start-up** (read-only report, nothing posted): 2 `info` `foreign_reference`
(the 19 Nov `kprobe_*` probes, known) and 2 `warning` `missing_at_provider`: `ktr_bb67…` (correct — Paystack never
created it; withdrawal `KWD-54DD…` failed and released in session 37) and `ktr_6a1c…` (**false positive**: the run
read Paystack's list seconds after this dispatch, before the new transfer appeared; Paystack verify confirms it).
All four left `open` for an operator to acknowledge with a reason — not resolved by hand. Follow-up (Low): skip
transfers initiated within the last few minutes in `missing_at_provider`.

**Next:** unchanged from session 41 (commit approval, lint/invariant/wrapper decisions, hosting, SR-05/SR-06). To
send a future approved TEST withdrawal, repeat this run; payouts stay off between runs by design.

### Session 42 — "approved withdrawal not showing on Paystack" (diagnosis, before the run)

**Finding.** `KWD-25ABD04865040369`, ₦1,300 (130,000 kobo), local dev: requested 07:56:51 UTC, member code verified
07:57:14, approved 08:08:21 by the designated second approver (`approved_as second_approver`), hold journal present,
not manual review. **No `withdrawal_transfers` row**, so it was never claimed or sent. Paystack TEST transfer list:
newest entry is still `ktr_4f40…` (20 Nov, session 38). Nothing is wrong with the withdrawal or Paystack.

**Cause.** The running worker (PID 20000, started 2026-11-20 15:17, `--env-file=.env.local`) has no Paystack key
and no `PAYSTACK_TRANSFERS_ENABLED`: session 38's cleanup left payouts off on purpose (`withdrawal_transfers_state
enabled:false reason no_paystack_key`). An approved withdrawal waits, funds held, until a worker with dispatch on runs.

**Preconditions checked (read only):** bank account verified, past cooling-off, recipient set, requester's own;
the only claimable withdrawal; 0 open transfers; ngrok up → `localhost:3000`, approval route 405 locally and via the
tunnel; key in `apps/web/.env.local` is `sk_test_`, no `sk_live_` in web/worker env files; Paystack TEST balance
NGN 66,962,637.80; TEST dashboard: transfer OTP off, test approval on with the ngrok URL, live approval off,
*On Reject* = Do Nothing. No setting changed.

**Next:** with the owner's yes — restart the worker once with the TEST key and `PAYSTACK_TRANSFERS_ENABLED=true`
passed in the process environment only (no env file edited), watch dispatch → approval callback (signature valid,
200) → `transfer.success` → `paid`, one payout journal, reconciliation 9/9; then restart it without the key.

### Session 41 — final security review, risk register, staging readiness (nothing committed)

**Done:**

| Task | Result | Where |
|---|---|---|
| 1 Risk register | 26 findings (1 Critical, 3 High, 12 Medium, 10 Low) with evidence labels (code / pgTAP / concurrency / unit / catalog / browser / Paystack TEST / LIVE read-only / unverified), staging and LIVE blocking flags | [`docs/security/risk-register-2026-11-20.md`](../security/risk-register-2026-11-20.md) |
| 2 Staging readiness | 16-item matrix; local READY, itest READY, staging NOT READY (infrastructure + process, no known code defect), LIVE NOT READY | [`staging-readiness-2026-11-20.md`](staging-readiness-2026-11-20.md) §1–2, §6 checklist |
| 3 pgTAP 32 #5 | Counted the itest harness's own `kolekto_itest_worker` policies. Test-only fix: skip a policy only if its sole role is `kolekto_itest_worker` **and** it has the harness name prefix. Negative probe (`TO public`, harness name `TO authenticated`) still fails #5. **Full suite on itest: 70/70 files, 2,386/2,386.** Worker policies untouched (10) | `supabase/tests/32_notification_delivery_access.sql`; readiness §3 |
| 4 Lint `MoneyPanel.tsx:422` | `react-hooks/set-state-in-effect` false positive: `refresh` sets state only after `await`. Same pattern already disabled with a comment in `NotificationsPageClient.tsx:95`. **Fix proposed, not applied** | readiness §4 |
| 5 `itest:reset` gap | Root cause: `up` refuses stale copy + existing volume; `reset` refuses a stopped database. Proposed: `reset` starts a stopped stack first (no volume operation). **Not applied.** Safe recovery + volume-deletion guards documented | readiness §5 |
| 6 Docs | ADR 0016 amended; withdrawal doc §11 (current OTP/approval policy, second-approver instructions); financial decisions §23 (status note, no new decision); itest README; banners on the two stale staging docs; `.env.example` gains the two payout switches (unset) | — |

**Top blockers.** Staging: commit + CI (owner approval), hosting platform + deploy job, staging unpause + migration
history + backup, secret store, hosted Auth/email, public URL for the Paystack TEST webhook and approval URL (and the
owner's choice: one Paystack TEST account cannot call both local ngrok and staging). LIVE, in addition: **O-1 legal
custody of third-party funds (separate blocker)**, LIVE Paystack has no transfer OTP and no LIVE approval URL,
no monitoring/alerting, key mode not bound to `KOLEKTO_ENV`, unsigned approval requests accepted, inbound 12 s
stop-gap, payout on the privileged connection, second-approver designation controls, account-change alerts,
manual review/O-3, operator tooling, MFA, hosted logging, provider idempotency and LIVE funding.

**Not done / not verified:** Playwright E2E (no withdrawal spec exists); unit suites not re-run this session (only
docs, `.env.example` and one pgTAP file changed); no staging, LIVE or production access of any kind.
**Found:** `node scripts/invariants/run-all.mjs` fails `one-paystack-caller` on
`packages/domain/test/log-redaction.test.ts:28` (session 39 fixture key `PAYSTACK_SECRET_KEY`, not a real call) —
CI would fail; fix proposed in readiness §2 item 13, not applied.

**Next:** owner decisions — (1) approve committing sessions 27–41 and opening a PR; (2) approve or decline the lint
fix (readiness §4) and the wrapper change (§5); (3) hosting platform; (4) Paystack TEST account for staging. Then
the small LIVE-hardening fixes in priority order: SR-05 key/env binding, SR-06 require signed approval requests,
SR-07 signature before the inbound hold, SR-09 designation waiting period + notices, SR-10 account-change emails.

**Paste-ready prompt for the next session:**

> Session 42. Read the "Latest report" in docs/phase-4/payment-integration-status-2026-11-12.md, then
> docs/security/risk-register-2026-11-20.md and docs/phase-4/staging-readiness-2026-11-20.md. Decisions: [commit
> yes/no], [lint fix §4 yes/no], [wrapper change §5 yes/no], [hosting platform], [Paystack TEST account for
> staging]. If commit is approved: group the work into reviewable commits (migrations, adapters/payments, worker,
> web, tests, docs), scan the diff for secrets, open a PR, and get CI green including E2E. Then implement SR-05 and
> SR-06 as small, tested changes (pgTAP + unit), proposing each diff first. Same strict rules: no LIVE transfers or
> settings, no production or staging database access without explicit approval, no reset, no push or deploy
> without my approval.

### Session 40 — approved itest rebuild + full verification (nothing committed)

**Done:** cold backup of `supabase_db_kolekto-itest` (`itest-backups/supabase_db_kolekto-itest-2026-11-20.tgz`, 25,721,067 bytes, SHA-256 `fa457812…f09f7eaa`, verified) → old `.env.itest` moved beside it → volume removed → `itest:up` (149/149 byte-identical, history = source) → `itest:worker-role`, `itest:net-lockdown`, `itest:status` all pass. New role password generated and never shown; host-port login: new accepted, old and wrong refused (28P01); no password in any tracked or untracked file.

**Results:** pgTAP 69/70 files, 2,385/2,386 — only 32 #5 (known: the itest worker role's own policies). 57/62/65 first failed on a date-dependent fixture (pin `now() - 3 days` lost to the 2026-11-17 23:00 UTC verified-charge schedule); fixed in the three test files only, proven first with temporary copies. tsc 0/0; web 281, worker 824, domain 269, payments 45, adapters 240; concurrency 76/76 ×2 on an itest clone. Browser on an itest-only web server: designate → replace → remove works; audit `designated` / `replaced` / `ended` rows; history kept. Full detail: [`session-40-itest-rebuild-report-2026-11-20.md`](session-40-itest-rebuild-report-2026-11-20.md).

**Why:** the stale itest (146 of 149 migrations) could not run the suite; dev data hid real results (18 and 63 pass on a clean database).

**Next:** done in session 41 (above).

**Paste-ready prompt used for session 41 (kept for history):**

> Session 41. Read the "Latest report" in docs/phase-4/payment-integration-status-2026-11-12.md and docs/phase-4/session-40-itest-rebuild-report-2026-11-20.md. Finish the Session 39 brief: Task 6 security and financial-controls risk register (finding, severity, evidence, recommended action, blocks staging/LIVE; record that LIVE Paystack transfer OTP/approval settings are off and are not to be changed; legal custody question as a separate launch blocker), Task 7 staging-readiness assessment (READY / NEEDS ATTENTION / BLOCKED / NOT VERIFIED), and the documentation updates. Same strict rules: no LIVE transfers or settings, no production or dev database changes, no reset, no commit, push or deploy without my approval.

### Session 39 — withdrawal hardening (nothing committed)

**Done (why):**

| Task | What | Evidence |
|---|---|---|
| 1 OTP logging | Leak source: Next.js 16 dev-only Server Function argument logging (`logging.serverFunctions`, gated on `NODE_ENV === 'development'`). Turned off in `apps/web/next.config.ts`; new structured redaction (`packages/domain/src/log-redaction.ts`, `apps/web/lib/server-log.ts`); OTP actions log `withdrawal_otp_verify` / `withdrawal_otp_resend` with ids and outcomes only | domain 10 tests + `otp-logging.test.ts` 15 cases pass. Live: fresh ₦100 request `KWD-A0F63A21DBD22316`, wrong code then right code → dev log shows two `withdrawal_otp_verify` lines (`incorrect`, `verified`); neither code nor any part of the stored hash in the log. Request then cancelled by the requester: hold + release journals only |
| 2 Approver UI | Settings → Team → "Withdrawal second approver" (owner only): current approver, eligibility, designate / replace / remove with confirmation, history (who, when). Migration `20261120140000_withdrawal_approver_management.sql` (local dev only): atomic audited replace, owner-only candidate/history functions, suspended/closed accounts lose approval authority (`withdrawal_decider_basis`) | pgTAP 71 54/54; 69/70/64/58 pass; `approver-view.test.ts` 6 pass. Live: panel renders for the owner, Remove dialog opened and cancelled, no horizontal scroll at 375 px |
| 2 fix | Officers list on Settings was always empty: `officer_terms` has two FKs to `users`, so `users(full_name)` failed with PGRST201. Now `users!officer_terms_user_id_fkey(full_name)` | Live: officers and approver panel show; web tsc 0; `app/c` vitest 150/150 |
| 3 Concurrency script | `scripts/verify/withdrawal-concurrency.mjs` rewritten: 10 scenarios, own fixtures, run-scoped cleanup, refuses unless DB is `kolekto_scratch*`, local and quiescent | 76/76 twice on a scratch clone; refused `postgres` |
| 4 Wording | "community owner approves" removed from UI, email and comments | worker/web tests updated and pass |

**Stopped:** Task 5 — see [`session-39-itest-pre-reset-report-2026-11-20.md`](session-39-itest-pre-reset-report-2026-11-20.md). `itest:reset` cannot run (stack stopped; `up` refuses because the migration copy is 146 vs 149 files and the volume exists). Proposed: cold backup → move `.env.itest` aside → `docker volume rm supabase_db_kolekto-itest` → `itest:up` → `itest:worker-role` + `itest:net-lockdown`. Needs the owner's explicit yes. Disclosure: the local itest role password was printed in the session transcript once; the rebuild rotates it.

**Next:** superseded by session 40 above (rebuild approved and done).

### Session 38 — end-to-end TEST withdrawal `KWD-F78DB08FF0E40945`: PASS

| Step | Evidence (UTC, 2026-11-20) | Result |
|---|---|---|
| Preflight | Old `KWD-54DD…` failed, 1 release journal, no payout; balances available 107,390,000 / withdrawing 0 / withdrawn 110,000 kobo; reconciliation 9/9; Paystack TEST On Reject **Do Nothing** (after reload), test approval URL = ngrok route, TEST transfer OTP off; recipient not in `is_blacklisted=true` (0 results); only `sk_test` keys, no live flag; 0 open transfers locally and at Paystack; 0 claimable withdrawals; web dev server restarted (it was down: ngrok 502) with `kolekto-web-clean-env`, route GET → 405 | VERIFIED |
| Request | Owner (app, email-code sign-in) requested ₦100 to OPay ••••4796 (verified, name-matched account `01a1f342…`, `RCP_mlpn6hon3jbfoic`). Withdrawal id `01a1f94d-f434-75ca-9863-8d1466f3e711`, 14:13:17.929, hold journal `ebc77be2…` | VERIFIED |
| Member code | Worker (no Paystack key) delivered Mailpit message `6R9VZo9h…` 14:13:46 from noreply@kolekto.test; code entered in the app → `member_otp_verified_at` 14:14:07.893, challenge `01a1f94d-f4eb…`, audit `withdrawal.member_verified` | VERIFIED |
| Self-approval refused | Owner UI shows only "Cancel request". Rolled-back probe with the owner's JWT: `can_decide=false`; `app.decide_withdrawal(…,'approve')` → `42501 FORBIDDEN: nobody approves or rejects their own withdrawal`; approver `can_decide=true` | VERIFIED |
| Independent approval | Designated approver `approver.e2e@kolekto.test` (`1b431e55…`, admin) approved in the app 14:16:07.194; `approved_as second_approver`, not self, `owner_self_approved=false`; audit `withdrawal.approve` `approval_basis: second_approver` | VERIFIED |
| Dispatch | Worker with TEST key (environment only) + `PAYSTACK_TRANSFERS_ENABLED=true`: `dispatch examined 1 initiated 1`. Transfer `ktr_4f407d1b9c82e8dad677be72`, initiate requested 14:16:59.178, Paystack `received` 14:16:59.750. Worker stopped immediately after the callback | VERIFIED |
| Approval callback | ngrok: POST `/api/webhooks/paystack/transfer-approval` 14:17:00, UA `Needle/3.5.0`, `X-Paystack-Signature` present, **200**, 1457 ms end to end (route 644 ms). Body: event `transferrequest.approval-required`, domain test, endpoint `/transfer`, `details.body` ref `ktr_4f40…` / amount "10000" / NGN / `RCP_mlpn…`, exactly 1 `transfers[]` entry with the same ref / 10000 / NGN / `RCP_mlpn…` / `TRF_0br21xdy0py7d7iy` / status received. Kolekto log: 14:17:01.417 `approve` `authorised`, signature **valid**, linked to the transfer; `provider_approved_at` set, `provider_approval_count 1`; audit `withdrawal.transfer_approved_by_kolekto` | VERIFIED |
| Provider outcome | Paystack TEST verify: **success**, `TRF_0br21xdy0py7d7iy`, 10000 NGN, `RCP_mlpn…`, transferred 14:17:03, fee 0. Exactly 1 Paystack transfer with this reference | VERIFIED |
| Settlement | `transfer.success` webhook (POST `/api/webhooks/paystack` 200) → check #2 source webhook `paid` 14:17:07; withdrawal **paid** 14:17:06.541, `payout_reference TRF_0br21xdy0py7d7iy`; audit `withdrawal.paid` | VERIFIED |
| Ledger | Journals for the withdrawal: hold `ebc77be2…` and payout `9b5c1af4-c05f-4795-8ea2-19de71292d55` (`payout:01a1f94d…`: withdrawing debit 10000 / withdrawn credit 10000 / organiser_payouts debit 10000 / provider_receivable credit 10000). No release, no reversal, no fee journal (fee 0). 1 transfer row for the withdrawal | VERIFIED |
| Balances | Before request: available 107,390,000 / withdrawing 0 / withdrawn 110,000. After hold: 107,380,000 / 10,000 / 110,000. After payout: **107,380,000 / 0 / 120,000** | VERIFIED |
| Reconciliation | `app.platform_reconciliation()` 9/9; ledger imbalances 0 | VERIFIED |
| Cleanup | Worker restarted with no Paystack credentials: `withdrawal_transfers_state enabled:false reason no_paystack_key`; `apps/worker/.env.local` has 0 Paystack lines; no `sk_` string in any worker log; LIVE settings and keys untouched (live approval off, no live key or `PAYSTACK_LIVE_TRANSFERS_APPROVED`). Later that no-key worker exited cleanly (exit 0, last log 2026-11-22 08:32 UTC, no error, no `sk_` in log); no worker process is running now | VERIFIED |

Still open: owner UI to designate a second approver; Next dev log prints the member's OTP from server-action arguments (seen again this run; production logging not reviewed); `scripts/verify/withdrawal-concurrency.mjs` outdated; full pgTAP on a clean itest (needs reset approval); stale UI copy "community owner approves"; LIVE "Confirm transfers before sending" off (owner's decision).


### Session 37 — Phases 1–4 done; Phase 5 (new ₦100 TEST withdrawal) waits for the owner's approval

| Phase | Evidence | Result |
|---|---|---|
| 1–2 On Reject | Owner changed it in the dashboard (Test view, Settings → Preferences → Transfer Approval → On Reject) and saved. After a full reload: **Do Nothing**. Switched the dashboard *view* to Live and reloaded: also **Do Nothing** → one shared setting for TEST and LIVE. Other transfer boxes unchanged (live approval off, test approval on, "Confirm transfers before sending" off). View returned to Test. Claude changed no setting. | VERIFIED |
| 3 Recipient | Dashboard Transfers → Recipients has a filter *All / Only Blacklisted / Exclude Blacklisted*: "Only Blacklisted" → "No recipients". TEST API `GET /transferrecipient?is_blacklisted=true` → 0, `=false` → 8 including `RCP_mlpn6hon3jbfoic` (filter honoured). | VERIFIED (final proof is a transfer Paystack accepts) |
| 4 Recovery | Worker started 13:55 UTC with the TEST key passed through the environment only (no env file edited), `PAYSTACK_TRANSFERS_ENABLED` unset → `withdrawal_transfers_state enabled:true dispatch:false testMode:true`; 0 dispatch runs. Checks on `ktr_bb677138b19c111d2360fc81`: #3 not_found 13:55:27, #4 not_found 14:05:43 (count 3) → `release_failed` (`released_never_sent`). Worker stopped. | VERIFIED |
| Withdrawal | `failed` 14:05:43, reason "Paystack refused the transfer and has no record of it after repeated checks…"; `release_journal_id cd7d6426…`; payout and reversal journal null; `paid_at` null. Audit `withdrawal.failed` (system). | VERIFIED |
| Ledger | Exactly two journals for the withdrawal: hold `088323bc…` (available debit 10000 / withdrawing credit 10000) and release `cd7d6426…` 14:05:43 (withdrawing debit 10000 / available credit 10000, key `withdrawal_release:01a1f8cc…`, actor system). No payout journal. | VERIFIED |
| Balances (collection `open-test`) | Before: available 107,380,000, withdrawing 10,000, withdrawn 110,000 kobo. After: available **107,390,000** (= `available_before_kobo` at request), withdrawing **0**, withdrawn 110,000 (unchanged). | VERIFIED |
| Reconciliation | `app.platform_reconciliation()` 9/9 ok; `v_ledger_imbalances` 0 | VERIFIED |
| Provider | TEST verify `ktr_bb67…` → 404 "Transfer not found"; TEST transfer list still 5, latest `ktr_5def…` 10:45 — nothing new was created | VERIFIED |

State after Phase 4: no open transfers (2 success, 2 failed); worker stopped; `apps/worker/.env.local` has no Paystack lines; dispatch off.


### Session 36 — preflight result: STOPPED, nothing dispatched

| Check | Evidence | Result |
|---|---|---|
| Withdrawal `KWD-54DD01335BA5AB4D` | `processing`, ₦100, `approved_as second_approver` by admin `1b431e55…` (not the requester), member code verified 11:52:22, `hold_journal_id 088323bc…` only; no payout / release / reversal journal; one ledger journal (`collection_available` debit 10000, `collection_withdrawing` credit 10000). Audit: designated 11:50:04 → request 11:52:03 → member_verified 11:52:22 → approve (basis second_approver) 11:54:47 → processing 11:55:25 | VERIFIED |
| Transfer `ktr_bb677138b19c111d2360fc81` | `unknown`, `refused_at` 11:55:27, `refusal_code unknown` ("Recipient is blacklisted"), `not_found_count 1`, no transfer code, `provider_approved_at` null, 0 approval callbacks | VERIFIED |
| Paystack never created it | TEST `GET /transfer/verify/ktr_bb67…` → 404 "Transfer not found"; not in the last 5 TEST transfers (latest is `ktr_5def…` rejected) | VERIFIED |
| Safe retry of the same withdrawal | **Not permitted by the state machine.** `app.record_withdrawal_transfer_check` allows a re-send only when the refusal code is null or transient (`insufficient_balance`, `http_429`); this one is `unknown`. Its designed path is `app.transfer_release_eligible`: refused, never approved, NOT FOUND ≥ 3 (policy `refused_release_min_not_found`) and ≥ 1800 s since refusal → automatic release + withdrawal failed | VERIFIED (code + live policy row) |
| Recipient usable | TEST `GET /transferrecipient/RCP_mlpn…` → `active: true`, domain test; the API has no blacklist field, so un-blacklisting cannot be confirmed without a transfer attempt | UNCERTAIN |
| Worker credentials | Only `sk_test` keys in the three `.env.local` files (no `sk_live`/`pk_live` anywhere); worker env currently has no Paystack key (transfers off) | VERIFIED |
| Live dispatch disabled | A live key also needs `PAYSTACK_LIVE_TRANSFERS_APPROVED=true` (`packages/adapters/src/paystack-transfer-provider.ts:373`); not set in any env file; dashboard "Confirm transfers in live mode" unticked | VERIFIED |
| On Reject = Do Nothing | Paystack dashboard (Test view) → Settings → Preferences, read after a full reload: **On Reject = Blacklist Recipient** (options: Blacklist Recipient / Do Nothing) | **FAILED** — contradicts the owner's note; not changed by Claude |

Recovery procedure proposed (needs the owner's go-ahead; nothing done): (1) owner sets *On Reject → Do Nothing* and **saves** (one setting for test and live), and confirms the recipient un-blacklist; (2) run the worker with the TEST key and `PAYSTACK_TRANSFERS_ENABLED` unset, so the check stage only verifies `ktr_bb67…` by reference — two more NOT FOUND checks make it release-eligible and the database releases the hold once and fails the withdrawal (audited, automatic, no manual release); (3) verify release journal once, reconciliation 9/9; (4) new ₦100 withdrawal (member code, designated approver); (5) enable TEST dispatch for one run, observe the approval callback, success, payout once; disable again.


### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–35 **uncommitted**, not pushed. Local only, Paystack TEST only. Staging paused and untouched; legacy production not read or written; no LIVE setting, record or transfer touched; no Paystack dashboard setting changed by Claude. Database not reset; no Docker volume removed.

**The end-to-end TEST payout is BLOCKED, not done.** Paystack refused the new transfer with *"Recipient is blacklisted"*: the 10:45 rejection of `ktr_5def…` (session 34, old parser) met *On Reject = Blacklist Recipient*, and Paystack blacklisted the member's recipient `RCP_mlpn…`. Kolekto stayed safe (below). Needs the owner in the Paystack TEST dashboard.

### Done this session

| # | Item | Class |
|---|---|---|
| 1 | Environment preserved (no reset, no commit, files kept) | VERIFIED |
| 2 | `parseTransferApprovalRequest` rewritten for Paystack's real body: `data.details.body` and exactly one `data.transfers[]` entry must agree on reference / amount / currency / recipient; `TRF_` code and status `received` required; result is `{ok, request}` or `{ok:false, rejection: payload_*, reference}`. No invented fields, no "first entry" shortcut. | FIXED AND VERIFIED (unit; not yet by a real approving callback) |
| 3 | `app.decide_transfer_approval` now 7 args (+ currency, transfer code, parser refusal). New reasons `payload_*`, `already_paid`, `currency_mismatch`, `transfer_code_mismatch`, `self_approved`, `approver_not_authorised`. Route answers 200 only for parse ok **and** approve. | FIXED AND VERIFIED (pgTAP 70, payments unit) |
| 4 | Redacted fixture `packages/adapters/test/fixtures/paystack-transfer-approval-request.redacted.json` from the real capture (leak check passed); regression + 11 valid/invalid parser tests; signature valid / tampered tests | VERIFIED |
| 5 | On Reject recommendation → **Do Nothing** (owner decision, not changed). Now proven necessary: see blocker. | RECOMMENDATION |
| 6 | `KOLEKTO_WITHDRAWAL_OTP_SECRET` rotated in the three git-ignored `.env.local` files (64 chars, identical, never printed); OTP sent and verified with the new key; secret absent from worker logs, dev-server log and tracked files | FIXED AND VERIFIED |
| 7 | Nobody approves their own withdrawal; an owner's request needs an owner-designated admin/owner (`community_withdrawal_approvers`, `app.set_withdrawal_approver`, `approved_as`), treasurer never enough, audited, time-bounded. Migration `20261120100000` (applied locally with psql; rollback note in its header) | FIXED AND VERIFIED (pgTAP 69 102/102, 64 16/16, 70 92/92; app flow in browser) |
| 8 | TEST worker prepared from backup, started with TEST key, then cleaned: TEMPORARY lines removed (file equals the pre-test backup), worker restart shows `withdrawal_transfers_state enabled:false reason no_paystack_key` | VERIFIED |
| 9 | Real TEST journey: new ₦100 `KWD-54DD01335BA5AB4D` → OTP in Mailpit → verified → approved in the app by the designated approver (not the owner) → worker dispatch 11:55:26 UTC → **Paystack refused: Recipient is blacklisted** → no approval callback | BLOCKED |
| 10 | Failure safety on that refusal: logged `initiate_refused`, transfer `unknown`, verify by reference `not_found`, hold kept, no release, no payout, `platform_reconciliation()` 9/9; worker stopped before any re-send | VERIFIED |

Tests: adapters 240/240, payments 45/45, worker 824/824, web vitest 260/260, root `tsc --build` 0. pgTAP on the dev DB: 69, 70, 64 all pass; 63 78/80 and 18 one failure — environmental only (dev data: 18 awaiting-provider captures, non-empty ledger). Other files that fail on dev data (07, 14, 20, 23, 34, 38, 40, 44, 51, 57, 62, 65) were not caused by this change; a clean itest run was not done (itest down; `itest:reset` needs approval).

### Open findings

- **Withdrawal `KWD-54DD01335BA5AB4D` is `processing` with ₦100 held**, transfer `ktr_bb677138b19c111d2360fc81` `unknown` (not_found 1). Do not release by hand. After the recipient is un-blacklisted, the next worker run re-checks it under the existing policy.
- **Next dev server logs server-action arguments**, so a member's 6-digit OTP (already used) appears in the local dev log (`verifyWithdrawalOtpAction … {"code":"…"}`). Dev mode only as far as seen; production logging not checked. Not changed.
- No owner UI to designate a second approver (SQL only) — blocks owner self-withdrawals in the app. Copy still says "community owner approves". No db-client wrapper for set/list approvers.
- `scripts/verify/withdrawal-concurrency.mjs` still uses owner self-approval and the 4-arg `decide_transfer_approval`; will fail until updated. Not run.
- Local `supabase_migrations` history is behind the applied schema (`migration up` fails at `20261118100100`); new migrations were applied with psql.

### Next (in order)

1. **Owner (Paystack TEST dashboard):** un-blacklist recipient `RCP_mlpn…` (Transfers → Recipients) and set *On Reject* → **Do Nothing**. Claude must not do this.
2. Re-add the TEST lines to `apps/worker/.env.local` (scratchpad backup `worker.env.local.session34.bak`), start the worker from a clean shell (`unset EMAIL_PROVIDER PAYSTACK_SECRET_KEY …`), let it re-check / re-send `ktr_bb67…`; confirm callback (signature valid, parse ok, 200, latency), Paystack success, payout journal once, no release, reconciliation 9/9. Remove the lines again.
3. Owner UI for second-approver designation; update copy; db-client wrappers.
4. Update `scripts/verify/withdrawal-concurrency.mjs`; full pgTAP on itest.
5. Owner (LIVE): check the ₦510 in the legacy admin (unchanged from session 34).

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 35).
Local only, Paystack TEST only. No staging, no legacy production, no Live mode, no dashboard changes by Claude.
Precondition (owner): recipient RCP_mlpn… un-blacklisted in the Paystack TEST dashboard and On Reject = Do Nothing.
Then re-add the TEST worker lines from the scratchpad backup, start the worker from a clean shell, and let it
re-check/re-send ktr_bb677138b19c111d2360fc81 (withdrawal KWD-54DD01335BA5AB4D, approved by the designated
second approver). Verify: Paystack approval callback (signature valid, parse ok, 200, latency), transfer success,
payout journal once, no release, platform_reconciliation() 9/9. If Paystack answers anything unexpected, stop and
investigate; do not retry repeatedly. Remove the worker TEST lines afterwards.
```

---

## Session 34 report (archived 2026-11-20 — kept for history)

**Last updated:** 2026-11-20, session 34 (authenticated Paystack dashboard audit, LIVE ₦510, first real Paystack approval callback)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–34 **uncommitted**, not pushed. Staging paused and untouched. Legacy production not read or written. No Paystack dashboard setting changed by Claude (only the dashboard *view* was switched Test → Live → Test). No LIVE transfer, refund or record change. No code changed this session.

**Update after session 34 (same day, parallel session) — Next step 1 done: approval parser fixed.** `parseTransferApprovalRequest` (`packages/adapters/src/transfer-provider.ts`) now reads Paystack's real `transferrequest.approval-required` body: exactly one `data.transfers` entry (array or index-keyed object; zero or several → unreadable → 400), its `reference`, `amount` and `recipient.recipientCode` (`recipient_code` also accepted). `data.details.body`, when present, is cross-checked: a different reference → unreadable (400); a different amount or recipient → passed as null, which `app.decide_transfer_approval` rejects as `amount_mismatch` / `recipient_mismatch` while logging the reference. Older shapes (top level / `data.reference`) unchanged. Evidence: the captured 10:45:09 body replayed through the parser → `ktr_5def794c9e69a7d82b68c9aa`, 10000 kobo, RCP code, not inbound; replayed to the running local route (no signature header) → linked to the transfer, 400 `transfer_already_final` (correct: that transfer is failed) — this replay added one row to the local approval log. Tests: adapters 240/240 (+7 for the real shape, synthetic values; the real capture is not committed because it holds personal data), payments 43/43, web webhook routes 37/37, web `tsc` 0, worker 824/824, `tsc --build` 0. pgTAP not run (no SQL changed). **Approve → 200 → success not yet seen with a real Paystack request** (needs the new ₦100 run in step 3).

Also fixed earlier the same day (session 33): the worker's transfer reconciliation failed every run (`INVALID_DISCREPANCIES: an array is required`) because `packages/db/src/withdrawal-controls.ts` passed jsonb with a bare `::jsonb` cast; now `::text::jsonb`. Verified: run recorded (provider_mode test, 4 vs 2, 2 info `foreign_reference` = the 2026-11-19 `kprobe_*` probes).

**Mode trap found:** the Paystack dashboard shows a red "Test" label with a grey switch when it is in **TEST**, and a green switch with "Live" when in LIVE. The first read of Preferences was TEST; confirmed by the transfers list ("TEST TRANSFER" badges) and by the "Switched integration — live state" toast. All LIVE claims below were re-read after a full page reload in LIVE.

### A. LIVE incident (read-only)

| Claim | Class |
|---|---|
| Paystack LIVE transaction 6781876817: NGN 510.00, **Success**, ref `kolekto-1795164753146-401579`, Bank Transfer, fee NGN 5.10, paid 2026-11-20 08:54 UTC (09:54 Lagos), message "Approved", metadata collection "100L NACOS COURSE REGISTRATION", payer bank Kuda (account masked). Refunds: none. Disputes: none. | VERIFIED (dashboard, LIVE) |
| `charge.success` webhook delivered | OWNER-REPORTED (this dashboard version shows no webhook log on the transaction page) |
| LIVE *Inbound Transfer Approvals → Receive Approval Requests*: **unchecked** (off). The Webhook URL field still holds `https://bonnet-ruse-unsettled.ngrok-free.dev/api/webhooks/paystack/transfer-approval` but is greyed out (inactive while the box is off). | VERIFIED (LIVE, after reload) |
| The stored inbound URL is Kolekto's **outgoing** approval route (wrong feature). | VERIFIED |
| LIVE outgoing *Transfer Approval*: "Confirm transfers in live mode" **off**, live URL empty. "Confirm transfers in test mode" on with the ngrok URL. On Reject: **Blacklist Recipient** (one setting for both modes). | VERIFIED |
| LIVE transfer OTP ("Confirm transfers before sending"): **off**. With live approval also off, a LIVE API transfer needs neither OTP nor approval — anyone holding the live secret key can move money. Owner's decision; flagged. | VERIFIED (security observation) |
| LIVE webhook URL `https://api.kolekto.com.ng/api/payments/webhook` (legacy production app); TEST webhook = ngrok. | VERIFIED |
| When the inbound box was turned off | UNKNOWN (no LIVE audit-log entry for preferences) |
| Whether the ₦510 became a contribution in Kolekto LIVE | **BLOCKED** — lives in legacy production, which the owner rule forbids reading. Owner to check the legacy admin by the reference. If missing: record a discrepancy, use the audited recovery process, never create by hand. |
| Future inbound risk: none while the box stays off (Paystack sends no inbound requests). Residual: if anyone ticks the box, requests go to the ngrok laptop URL. | INFERRED |

Recommended LIVE action (owner): leave *Receive Approval Requests* **off**. Do not tick it just to clear the URL field (ticking + saving would re-activate inbound approvals). If the URL must be cleared, ask Paystack support.

### B. TEST withdrawal readiness

| Item | Evidence | Class |
|---|---|---|
| Previous transfer `ktr_c19673339a4837e86e3f7ad5` (KWD-A627) | Paystack TEST: **Success**, timeline initiated 10:13 → awaiting OTP 10:13 → successful 10:20 UTC (OTP finalized in dashboard). Kolekto: transfer `success` via `transfer.success` webhook 10:20:52, withdrawal `paid`, payout journal once (4 entries, balanced), no release; `provider_approval_count 0` (approval URL never called). | VERIFIED |
| TEST outgoing Transfer Approval | "Confirm transfers in test mode" on; URL = ngrok `/api/webhooks/paystack/transfer-approval`; reachable (GET 405 in 0.6 s). | VERIFIED |
| TEST business OTP | Dashboard box off, **and proven**: new transfer went `received` → approval request, no `otp` step. | VERIFIED |
| Fresh withdrawal `KWD-0FF76ADC1F9F5EA3` ₦100 | requested 10:43:20 UTC; hold journal (2 entries) | VERIFIED |
| OTP delivery | Mailpit `4ic7Un2Ry2p9dg9hth0R2j` 10:43:22 from noreply@kolekto.test, subject with the reference | VERIFIED |
| Member verified | 10:43:54 | VERIFIED |
| Owner approval | 10:44:45, self-approval (owner is requester) | VERIFIED |
| Worker dispatch | `ktr_5def794c9e69a7d82b68c9aa`, Paystack `received`, 10:45:10 | VERIFIED |
| **Real Paystack approval callback** | 10:45:09 UTC, UA `Needle/3.5.0`, `X-Paystack-Signature` **valid**. Kolekto answered **400 `unknown_reference`** in 179 ms. | VERIFIED — **BUG** |
| Cause | Real body is `{event:"transferrequest.approval-required", data:{integration, domain:"test", details:{body:{source, amount:"10000" (string), recipient:"RCP_…", reference:"ktr_…", reason, currency}, endpoint:"/transfer", headers…}, transfers:[{reference, amount:10000, transfer_code, status:"received", recipient:{recipientCode, …}}]}}`. `parseTransferApprovalRequest` (`packages/adapters/src/transfer-provider.ts:188`) reads only top-level or `data.reference`, so reference = empty. | VERIFIED |
| Result | Paystack TEST: **Rejected** (initiated → request received → rejected). Kolekto: transfer `failed`, withdrawal `failed` 10:45:11, release journal once (2 entries), no payout. TEST recipient still `active: true` (API has no blacklist flag). | VERIFIED |
| `app.platform_reconciliation()` | 9/9 ok after both outcomes | VERIFIED |
| Full journey (approve → success) | not reached because of the parser bug | BLOCKED |
| Worker cleanup | `PAYSTACK_SECRET_KEY` + `PAYSTACK_TRANSFERS_ENABLED` removed from `apps/worker/.env.local` (backup in session scratchpad `worker.env.local.session34.bak`); old worker (PID 28692) stopped; restarted in a terminal tab: `withdrawal_transfers_state enabled:false reason no_paystack_key`, OTP delivery enabled | FIXED AND VERIFIED |

Route audit (inbound stop-gap, `route.ts:63`): classifies by `session_id` + payer/receiver account and no reference → the real outgoing body (no `session_id`) is never treated as inbound; inbound branch writes nothing, runs before any DB access (unaffected by DB outage), only a fixed log line; separate route from `/api/webhooks/paystack`; `setTimeout` does not block the event loop. Cost: each inbound-shaped POST holds a connection 12 s with no auth before the hold. Now unnecessary (inbound off in both modes) but harmless; remove only after deciding what an inbound request should get.

Other risks: *On Reject = Blacklist Recipient* means any Kolekto fail-closed 400 (DB down, parser bug) asks Paystack to blacklist the member's own bank recipient. Recommend **Do Nothing** (needs owner approval; it is one setting for both modes). During this session an 8-character prefix of the local `KOLEKTO_WITHDRAWAL_OTP_SECRET` was printed in a tool output (local-only key); rotate it if wanted.

### Next (in order)

1. ~~Fix `parseTransferApprovalRequest` for the real shape.~~ Done (see the update at the top of this report).
2. Owner: decide *On Reject* → Do Nothing.
3. Re-add the TEST lines to `apps/worker/.env.local` (from the backup), restart worker from a clean terminal, run one new ₦100 withdrawal, confirm approve → success → payout once → reconciliation 9/9. Then remove the lines again.
4. Owner (LIVE): check the ₦510 in the legacy admin.
5. Full pgTAP on itest; concurrency script.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 34).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
The approval parser already reads Paystack's real body (fixed after session 34; adapters 240/240).
Make sure the dev server serving the ngrok URL runs the current code (restart with the
kolekto-web-clean-env launch config, then warm the route). Then, with owner OK, one new ₦100 TEST withdrawal
end to end (worker TEST lines from the scratchpad backup, removed again after), verify approve 200,
transfer success, payout journal once, platform_reconciliation() 9/9.
```

---

## Session 33 report (archived 2026-11-20)

**Last updated:** 2026-11-20, session 33 (LIVE ₦510 investigation; inbound vs outgoing approval separation; TEST withdrawal journey)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–33 **uncommitted**, not pushed. Staging `kwolxuoeqwuedydxzncb` paused and untouched. Legacy production not read or written (rule kept by the owner). No Paystack dashboard setting changed by Claude. No LIVE transfer, LIVE payment, refund or LIVE record change.

**Correction to session 32.** Session 32 (archived below, finding 8) called the 09:54 `Paystack Credit Request` a TEST event and told the owner to look in the TEST dashboard. **That was wrong: it was a real LIVE customer payment of ₦510.** The archived text is kept unchanged except for a correction note.

### A. LIVE (read-only)

| Claim | Class |
|---|---|
| 2026-11-20 08:54:30 UTC, Paystack (UA `Paystack Credit Request`, from 52.214.14.220) POSTed an inbound credit request (₦510, `provider: titan-paystack`, payer bank Kuda, receiver account ending 5107) to `https://bonnet-ruse-unsettled.ngrok-free.dev/api/webhooks/paystack/transfer-approval`. ngrok recorded no response. | CONFIRMED (ngrok capture) |
| Paystack's record: NGN 510.00, **Success**, reference `kolekto-1795164753146-401579`, bank transfer, fee NGN 5.10, paid 08:54 UTC, message "Approved", no refund or dispute, `charge.success` webhook 6781876817 delivered. | CONFIRMED (owner pasted Paystack dashboard record) |
| The URL had been put in the LIVE *Inbound Transfer Approvals* field (Preferences → Virtual Account), a different feature from the outgoing *Transfer Approval*. | INFERRED (payload shape + UA); the owner said they would remove it |
| The URL has since been removed from the LIVE inbound field. | UNKNOWN (owner action; Claude cannot see the LIVE dashboard) |
| The approval-log row at 09:23:50 UTC (reject, `unknown_reference`, signature absent) is this request finishing ~29 min late after the local DB recovered. Paystack had already accepted the payment by then. | INFERRED |
| Whether the live Kolekto system created a contribution for this payment. | UNKNOWN (legacy production not read; owner to check the live admin. If missing, record a discrepancy; do not create one by hand) |
| Risk to future LIVE inbound payments while the URL stays in the inbound field: Paystack documents only "no answer in 5 s = accept"; a 400 answer is undocumented and could reject a customer's payment. | INFERRED from Paystack docs |

Stop-gap (owner-approved 2026-11-20), verified on the running server: the route detects an inbound credit body (`isInboundCreditRequest`), never decides it, writes nothing, and answers 400 only after 12 s (synthetic inbound probe: 400 `inbound_credit_not_handled` after 15.6 s, no DB row; outgoing-shaped probe decided in 0.38 s). It only protects while this local server + tunnel is the URL; removing the URL from the inbound field is the real fix.

### B. TEST (local + ngrok, Paystack TEST key)

| Step | Evidence | Class |
|---|---|---|
| KWD-B830 cancelled via audited UI action | status `cancelled`, exactly 1 release journal, audit `withdrawal.cancel`; available 97,400,000 → 107,400,000 kobo; withdrawing → 0 | VERIFIED |
| Stage A: new ₦100 withdrawal `KWD-A627ED3677BA6236` (10:11:03 UTC) | 1 withdrawal, 1 hold journal (2 entries), audit `withdrawal.request` | VERIFIED |
| OTP delivery | challenge claimed 10:11:04.40 → issued 04.57 → `sent` 04.92 (1.6 s); Mailpit message `05SuoSg7CbfiEaZmc6SlTl` from noreply@kolekto.test, subject with the reference; worker `withdrawal_otp_delivery sent:1` | VERIFIED |
| Member entered code (owner did it in the browser pane) | challenge `verified` 10:11:23, attempt 1 of 5; audit `withdrawal.member_verified` | VERIFIED |
| Stage B: owner approval | `approved` 10:12:04, `owner_self_approved = true`, audit `withdrawal.approve` | VERIFIED |
| Treasurer cannot substitute for the owner | covered by pgTAP 69; not re-run this session | NOT RE-VERIFIED |
| Stage C: worker dispatch (TEST key, `PAYSTACK_TRANSFERS_ENABLED=true`, live gate unset) | transfer `ktr_c19673339a4837e86e3f7ad5` created 10:13:52, Paystack answered **`otp`** 10:13:54; withdrawal `processing`; 1 transfer, no payout journal, hold intact | VERIFIED |
| Paystack called the approval URL | **No.** No Paystack request in ngrok, none in `withdrawal_transfer_approval_requests`. The TEST domain's transfer OTP is on, so the transfer stops at `otp` before approval (as predicted in withdrawal-otp doc §5.1 q10). | VERIFIED (not called) |
| Approval URL itself | reachable over HTTPS, warmed (1.2 s), real TEST provider (signed probe → `valid`) | VERIFIED |
| Ledger posted once / transfer success | not reached | BLOCKED (needs owner: finalize the OTP in the TEST dashboard, or let Paystack abandon it) |
| Platform reconciliation (local) | `app.platform_reconciliation()` 9/9 ok after dispatch | VERIFIED |
| Transfer reconciliation vs Paystack TEST | **was failing on every run** (`INVALID_DISCREPANCIES: an array is required`); fixed; run recorded: provider_mode `test`, provider 4, Kolekto 2, 2 info `foreign_reference` (the old `kprobe_*` probes) | FIXED AND VERIFIED |

What happens to `ktr_c1967…` without action: Paystack abandons an un-finalized OTP transfer (seen on 2026-11-19 after ~1 h; docs say 30 min). The worker's check stage then marks it failed and releases the hold once. Do **not** retry it or start a second transfer for KWD-A627.

### Files changed (session 33)

- `apps/web/app/api/webhooks/paystack/transfer-approval/route.ts` — inbound credit requests held 12 s then 400, never decided; provider errors → 400 (not 500).
- `apps/web/app/api/webhooks/paystack/transfer-approval/route.test.ts` — 13 tests (inbound not decided within 5 s, provider throws → 400, malformed JSON).
- `packages/adapters/src/transfer-provider.ts` — `isInboundCreditRequest()`; `packages/adapters/test/transfer-approval-and-list.test.ts` +3 tests.
- `packages/db/src/withdrawal-controls.ts` — `record_transfer_reconciliation_run` params now `::text::jsonb` (the codebase rule in `packages/db/src/payments.ts`); bare `::jsonb` double-encoded them.
- `supabase/tests/70_transfer_reliability.sql` — plan 83: missing OTP, missing owner approval, missing reservation, not processing.
- `docs/phase-4/withdrawal-otp-owner-approval-2026-11-19.md` — §5.4 (observations), open points 3 and 6.
- Git-ignored: `.claude/launch.json` (`kolekto-web-clean-env`), `apps/worker/.env.local` (TEST key + `PAYSTACK_TRANSFERS_ENABLED=true`, marked "remove after the run"; backup of the previous file in the session scratchpad).
- No migration created or modified.

### Regression cases (brief list of 12)

valid approval, unknown reference, wrong amount, wrong recipient, missing OTP, missing owner approval, missing reservation, already paid → pgTAP 70 (+ route tests); inbound Credit Request, malformed request, provider error, DB failure → route/adapters unit tests. "Provider timeout" at the approval URL is Paystack's side (no answer → `blocked`); covered only by the route's fail-closed tests, not by a real timeout.

### Tests (session 33)

`tsc --build` 0; web `tsc` 0; worker 824/824; payments 43/43; db 6/6; adapters 233/233; web approval route 13/13. pgTAP 70 on the dev DB: 82/83 — test 56 fails only because of 8 pre-existing probe rows on dev; **full pgTAP on clean itest not run** (itest stopped for memory). Concurrency script not run.

### Next (in order)

1. Owner (LIVE): confirm the URL is gone from *Inbound Transfer Approvals*; check in the live admin whether the ₦510 (`kolekto-1795164753146-401579`) became a contribution. Report back; no correction without approval.
2. Owner (TEST), choose one: (a) finalize `ktr_c19673339a4837e86e3f7ad5` in the Paystack **TEST** dashboard before Paystack abandons it, then check ngrok for the first real approval request; or (b) let it be abandoned, confirm the hold is released once, then (with approval) turn off the TEST transfer OTP and run a new ₦100 withdrawal.
3. After the run: remove `PAYSTACK_SECRET_KEY` and `PAYSTACK_TRANSFERS_ENABLED` from `apps/worker/.env.local`.
4. Run full pgTAP on itest (`npm run itest:up`) when memory allows; concurrency script.
5. Then decide whether the inbound stop-gap stays.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 33).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
Check KWD-A627ED3677BA6236 / ktr_c19673339a4837e86e3f7ad5: status, withdrawal_transfer_checks,
withdrawal_transfer_approval_requests, ngrok 127.0.0.1:4040. Never retry it or start a second transfer for it.
If abandoned: confirm exactly one release journal and platform_reconciliation() 9/9.
If finalized by the owner: record the real approval request (payload shape, headers, decision), the ledger
(payout posted once) and reconciliation. Then remove the TEST transfer lines from apps/worker/.env.local and
run full pgTAP on itest.
```

---

## Session 32 report (archived 2026-11-20 — kept for history; see the correction in the session 33 report)

> **Correction (session 33):** finding 8 below and "Next" step 2 call the 09:54 request a TEST event in the TEST dashboard. It was a **real LIVE customer payment of ₦510** sent by the LIVE *Inbound Transfer Approvals* setting. The rest of this report stands.

**Last updated:** 2026-11-20, session 32 (withdrawal "keeps loading" + no OTP email: debugging and fixes)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–32 **uncommitted**, not pushed. Environment used: **local only** (Docker `supabase_db_kolekto`, Next dev on :3000, ngrok tunnel `https://bonnet-ruse-unsettled.ngrok-free.dev` → :3000). Staging `kwolxuoeqwuedydxzncb` paused and untouched; legacy production untouched; no Paystack dashboard setting changed; Paystack TEST key only; no transfer initiated.

**The end-to-end journey is NOT yet demonstrated.** It is blocked by the PC running out of memory (0.2 GB free of 7.9 GB): the Docker engine API returns 500, local Supabase auth on :54321 times out (so nobody can sign in), Postgres cancels statements (57014). The owner is freeing memory; Docker Desktop may need a restart.

### What was found (session 32)

| # | Finding | Status |
|---|---|---|
| 1 | Stuck withdrawal `KWD-B830B2B23307C5D3` (₦100,000, "Open test", 2026-11-20 08:32 UTC): request, hold journal and OTP challenge were all created; the challenge sat in `pending_delivery`, never claimed. **Failing stage: worker OTP delivery.** | VERIFIED |
| 2 | The running worker was a stale `dist/index.js` built 2026-11-19 12:18, **before** the OTP stage existed — it had no withdrawal-OTP code at all. | FIXED AND VERIFIED (rebuilt; worker logged `withdrawal_otp_delivery_state enabled:true`) |
| 3 | `KOLEKTO_WITHDRAWAL_OTP_SECRET` was absent from every `.env.local`. | FIXED AND VERIFIED (one random 43-character value written to root, `apps/web` and `apps/worker` `.env.local`, all git-ignored; value never printed) |
| 4 | **Indefinite spinner:** the code screen showed "sending" + spinner and polled every 3 s for as long as the challenge stayed `pending_delivery` — for ever when the worker was not delivering. | FIXED, unit-tested; NOT verified in a browser |
| 5 | Server actions that throw (network drop) were not caught in the request, code, resend, owner-decision and money-load paths. | FIXED (try/catch → message); NOT verified in a browser |
| 6 | Approval URL `/api/webhooks/paystack/transfer-approval` answered **500** (`authenticateApprovalRequest is not a function`): the dev server had run ~40 h and its provider cached on `globalThis` predated that method. | FIXED AND VERIFIED (dev server restarted → 400 `unknown_reference` in ~1.1 s via HTTPS; route now fails closed with 400 on any provider error; regression test added). First request after a restart took ~30 s (dev compile): warm the route before any TEST transfer. |
| 7 | **Paystack has never sent an outgoing-transfer approval request** (ngrok capture; `withdrawal_transfer_approval_requests` empty before today's probes). | VERIFIED |
| 8 | **Probably the wrong dashboard field:** at 09:54 local Paystack POSTed a `Paystack Credit Request` (an *inbound* bank-transfer credit: payer/receiver accounts, session id, amount 51000) to the approval URL. That is Paystack's *Inbound Transfer Approvals* feature (Settings → Preferences → Virtual Account), not the outgoing *Transfer Approval*. Kolekto answers 400 to it; what Paystack does with an inbound 400 is undocumented (only "no answer in 5 s = auto-accept" is documented), so incoming Pay-with-Transfer contributions could be rejected. | VERIFIED (request seen); consequence UNKNOWN |
| 9 | Local email goes to **Mailpit** (`http://127.0.0.1:54324`), never to a real inbox. A Gmail member will not receive the code locally, by design. Real inbox delivery needs SES (staging/production). | VERIFIED |
| 10 | A process started from a shell that has **empty** `EMAIL_PROVIDER` / `PAYSTACK_SECRET_KEY` etc. in its environment ignores `.env.local` (Node `--env-file` never overrides an existing variable). Start the worker from a clean terminal. | VERIFIED |
| 11 | After the dev-server restart, an app page open in the Claude browser pane reload-looped (~1/s: "Compiled" → full reload). Not caused by file writes; stops when the pane leaves the app. Cause not identified; possibly memory pressure. | NOT RESOLVED |
| 12 | Local `supabase_migrations.schema_migrations` records nothing ≥ 20261118 although those migrations are applied (applied by psql). `db:migrate` would try to re-apply them. | VERIFIED, not changed |

Reconciliation before any change: `app.platform_reconciliation()` 9/9 ok. No financial record edited. The unsent challenge of KWD-B830 lapsed to `delivery_failed / not_sent_within_validity` through the worker's own claim function; the withdrawal stays `requested` with its hold.

### Files changed (session 32)

- `apps/web/app/c/[slug]/collections/[collectionSlug]/money-view.ts` — `withdrawalCodePhase()` (bounded "sending", "stalled" after 60 s, "sent" only after the email provider accepted).
- `apps/web/app/c/[slug]/collections/[collectionSlug]/MoneyPanel.tsx` — uses it; polling separated from user actions; try/catch on every action; "Processing withdrawal request…"; after an unanswered request the form is locked so a retry reuses the same idempotency key.
- `apps/web/app/c/[slug]/collections/[collectionSlug]/money-actions.ts` — missing OTP key → clear server log + "nothing counted" message.
- `apps/web/app/c/[slug]/collections/[collectionSlug]/withdrawal-stage.test.ts` — 5 tests for the phase.
- `apps/web/app/api/webhooks/paystack/transfer-approval/route.ts` (+ `route.test.ts`) — fail closed 400 on provider error.
- `apps/worker/src/withdrawal-otp-delivery.ts` — subject "Your Kolekto withdrawal verification code (KWD-…)".
- No migration created or modified.

### Tests (session 32)

`tsc --build` exit 0; web `tsc --noEmit` exit 0. Unit: domain 259/259, payments 43/43, adapters 230/230, db 6/6, config 63/63, worker suite exit 0, web 258/258 (16 files). **pgTAP not run** (itest database unreachable: Docker engine failing). Concurrency script not run. The session-31 adapters flake did not recur in this run; cause still unknown.

### Next (in order)

1. Owner: free memory (or restart Docker Desktop). Check `http://127.0.0.1:54321/auth/v1/health` answers 200.
2. Owner: in the Paystack **TEST** dashboard, check where the URL was pasted. Remove it from *Inbound Transfer Approvals* (Preferences → Virtual Account) unless that is wanted; put it in the outgoing *Transfer Approval* setting. Do not touch Live mode.
3. Start the worker from a clean terminal: `cd apps/worker`, `npm run build`, `npm start`.
4. Browser journey: cancel KWD-B830 (owner chose this on 2026-11-20; the audited Cancel releases the hold) → request ₦100 → code in Mailpit → enter it → owner approves → warm the approval route → `PAYSTACK_TRANSFERS_ENABLED=true` + TEST key in `apps/worker/.env.local` → TEST transfer → verify, ledger, `platform_reconciliation()`.
5. Re-run pgTAP on itest once Docker is healthy.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 32).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
First confirm local Supabase auth is healthy (127.0.0.1:54321/auth/v1/health = 200) and the worker logs
withdrawal_otp_delivery_state enabled:true. Then run the browser journey from "Next" step 4 and record evidence
(Mailpit message, OTP state rows, owner approval, approval-URL request row, TEST transfer status, ledger, reconciliation).
Re-run pgTAP on itest.
```

---

## What is done (M8.3 + M8.4)

Everything below lives in the **database only**. No form wiring, no Paystack API calls, no webhook route yet.

### Migrations committed

| File                                                                                   | What it adds                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `supabase/migrations/20261111100000_payment_records.sql`                               | Tables, enums, guards (see below)               |
| `supabase/migrations/20261111100100_payment_functions.sql`                             | All DB-side functions (see below)               |
| `supabase/migrations/20261110100000_update_collection_allows_draft_missing_amount.sql` | Allow draft collections without a target amount |

### Tables added (`_payment_records` migration)

- **`payment_limits`** — append-only config: `max_payment_kobo` ₦5,000,000 (500 000 000 kobo), `hold_minutes` 30, `check_window_hours` 24. Version `2026-11-launch`. Truncate-guarded.
- **`fee_schedules`** — versioned fee config. Gained `provider_cost_rate_bps` + `max_provider_cost_kobo`. Row `2026-11-founder`: platform 150 bps, gateway 0 (shown), Kolekto internal 100 bps capped ₦2 000.
- **`collections`** — gained `close_when_target_reached boolean default false` (must have target if true).
- **`contribution_intents`** — idempotency key per (collection, key). Stores contributor name, email (required), phone (required).
- **`payment_attempts`** — one live attempt per obligation (partial unique index). Reference `KLK-[26 chars]`. Frozen fee columns with arithmetic CHECKs. Status: `created → initialized → captured/failed/expired/needs_review → completed`.
- **`payment_attempt_lines`** — line breakdown per attempt.
- **`stock_reservations`** — holds tier/item stock during checkout. Status: `reserved → converted/released`.
- **`provider_transactions`** — append-only raw provider events. Unique on `(attempt_id, content_hash)`. Deny-all RLS (operator-session only).
- **`contributions`** — one per captured attempt. Unique on `attempt_id`.
- **`contribution_lines`** — per-tier/item contribution breakdown.

### Functions added (`_payment_functions` migration)

All functions use the operator-session idiom: `SECURITY DEFINER`, `set search_path = ''`, EXECUTE revoked from public/anon/authenticated, inner guard rejects non-operator calls.

| Function                                    | Purpose                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.create_payment_attempt(...)`           | Validates collection open/visible, window, target, member context, obligation, amounts, fees; reserves stock; returns `(attempt_id, reference, status, amount_kobo, provider_access_code, reused)` |
| `app.mark_payment_attempt_initialized(...)` | Transitions attempt to `initialized` after provider init call                                                                                                                                      |
| `app.release_payment_attempt_stock(...)`    | Releases reservations when attempt abandoned                                                                                                                                                       |
| `app.mark_payment_attempt_failed(...)`      | Marks attempt `failed`                                                                                                                                                                             |
| `app.expire_payment_attempt(...)`           | Marks attempt `expired` (refuses if stock hold still active)                                                                                                                                       |
| `app.record_provider_transaction(...)`      | T1: stores raw provider event; maps mismatches to `needs_review`                                                                                                                                   |
| `app.complete_payment_capture(...)`         | T2: idempotent capture — posts journals, converts reservations, marks obligation paid, optionally closes fundraiser                                                                                |
| `app.post_payment_journal(...)`             | Single-statement CTE journal+entries writer (idempotent by key)                                                                                                                                    |
| `app.ensure_ledger_account(...)`            | Upserts ledger account                                                                                                                                                                             |
| `app.stock_remaining(...)`                  | Reads available stock excluding a given attempt                                                                                                                                                    |
| `app.collection_window_state(...)`          | Lagos calendar-day open/closed/not-yet-open                                                                                                                                                        |
| `app.current_payment_limits()`              | Latest active limits row                                                                                                                                                                           |
| `app.current_fee_schedule_version()`        | Latest fee schedule ≤ today (Lagos)                                                                                                                                                                |

### Fee model (decisions taken — D-11 through D-16, D-28)

- Kolekto shows: **1.5% processing + 0.5% platform** (both uncapped, payer-facing)
- Internal provider cost: **1% capped ₦2 000** (not shown to payer)
- Actual provider fee is authoritative over estimate (D-11); fee breakdown frozen on attempt creation (D-16)
- Error codes: the authoritative list is every `raise exception 'CODE:` in `20261111100100_payment_functions.sql` (e.g. `COLLECTION_NOT_ACTIVE`, `COLLECTION_NOT_YET_OPEN`, `COLLECTION_WINDOW_CLOSED`, `TARGET_REACHED`, `MEMBER_NOT_ELIGIBLE`, `SOLD_OUT`, `CHECKOUT_KEY_REUSED`, `UNKNOWN_PAYMENT_REFERENCE`). The contributor-facing copy is `CHECKOUT_ERROR_MESSAGES` in `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`. An earlier version of this list named codes the SQL never raises; grep the migration rather than trusting a copy.

### Security properties verified

- Operator-session guard: stray `SET ROLE authenticated` before calling any function → `FORBIDDEN`
- RLS enabled + forced on all payment tables
- `provider_transactions` deny-all RLS (officer select via `transaction.view` permission on other tables)
- Idempotency: unique index on `(collection_id, checkout_idempotency_key)` for intents; unique reference per attempt; content-hash dedup on provider events
- Imported-collection guard: `create_payment_attempt` refuses with `COLLECTION_IMPORTED`
- `complete_payment_capture` idempotent: second call with same attempt returns `already_paid` → `needs_review` (does not double-post)
- `block_manual_paid_status` trigger: `paid` status on obligation only allowed if a matching captured contribution exists

### Tests (pgTAP)

- `supabase/tests/52_payments.sql` — 76 tests, all green (plan(76); 76/76 pass)
- Updated: `01_rls_coverage.sql`, `02_grant_matrix.sql`, `03_money_invariants.sql`, `18_fee_configuration.sql`, `27_truncate_guards.sql`

### Contributor contact fields (committed earlier)

- `packages/validation/src/contribution.ts` — `contributorContactSchema` (name, email, phone all required)
- `apps/web/app/[communitySlug]/[collectionSlug]/ContributeForm.tsx` — Email + Phone fields added, both required, with hints

---

## What is NOT done yet

### M8.5 — Orchestrator + form wiring (IN PROGRESS)

#### Done (2026-11-12, session 2)

- **`packages/domain/src/payment-reference.ts`** — `KLK-` + 26 chars Crockford base32 from 128-bit random. `generatePaymentReference()` + `isPaymentReference()`. 7 tests pass.
- **`packages/db/src/payments.ts`** — typed callers for all payment DB functions via `withOwnerConnection`: `createPaymentAttempt`, `markPaymentAttemptInitialized`, `markPaymentAttemptFailed`, `expirePaymentAttempt`, `recordProviderTransaction`, `completePaymentCapture`. bigint values passed as strings with `::bigint` cast.
- **`apps/web/lib/payments/orchestrator.ts`** — `startCheckout()` (validates env, calculates fees, creates attempt, initializes provider, marks initialized/failed) and `confirmPayment()` (verifies with provider, T1 record_provider_transaction, T2 complete_payment_capture). Handles all ProviderResult outcomes. Refuses `fake` provider in production.
- **`apps/web/lib/payments/provider-factory.ts`** — returns `FakePaymentProvider` with `defaultScenario: "success"`. M8.9 replaces this with env-based Paystack selection.
- **`submitContributionAction`** wired — after existing validation (collection status, member context, contact, answers, tier/item resolution, attendee names), calls `startCheckout`. Returns `payment.checkoutUrl`, `payment.reference`, `payment.fees` (formatted naira strings). DB error codes mapped to user-facing messages.
- **Callback page** — `apps/web/app/[communitySlug]/[collectionSlug]/payment/callback/page.tsx` + `PaymentCallback.tsx` + `actions.ts`. Reads `?reference=` from redirect, calls `confirmPayment`, shows result.
- **TypeScript compiles clean** across domain, db, adapters, and web packages.

#### Still needed for M8.5 acceptance

- Worker sweep, fee review, local fake checkout and the seven-flow integration test: **built in session 4**. The integration test passes on the reset itest DB (session 5, 10/10).
- **E2E test** — all seven collection flows end-to-end, in CI

**Acceptance for M8.5:** full happy path + all seven collection flows work against `FakePaymentProvider`; E2E passes in CI.

### M8.9 — Paystack adapter + sandbox (after M8.5)

- `packages/adapters/src/paystack-payment-provider.ts` — real Paystack calls (initialize, verify)
- `apps/web/app/api/webhooks/paystack/route.ts` — webhook handler with dual-header signature verification (`Paystack-Signature` + `whsec_`)
- Sandbox test matrix: card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend from dashboard, reversed, `fees` field present, subaccount split
- **Paystack test keys needed** — stored in `.env.local` (never committed); `whsec_` for webhook verification

### M8.3b — Resolver hardening (can run alongside M8.5)

- Pure window check in `packages/domain/src/contribution.ts`
- Single-tier stock check
- `amountOwed − applied` calculation
- Ceiling check
- Status mapping including `reversed`
- Unit tests for the above

### Still open / deferred

| Item                                                                                             | Where                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Legacy secret key (N6) — confirm Paystack keys rotated since Aug 2026 incident                   | Manual: check with Paystack dashboard    |
| `fake` provider accepted by DB in all envs — **DONE**: orchestrator refuses `fake` in production | `apps/web/lib/payments/orchestrator.ts`  |
| Idempotent reuse compares totals/member, not line breakdown                                      | Low risk; note in code                   |
| DB error messages contain internal IDs — **DONE**: orchestrator maps codes to user copy          | `submitContributionAction` in actions.ts |
| `answers` jsonb column is unbounded                                                              | Future: add size CHECK                   |
| Bought tiers/items can't be deleted (FK RESTRICT) — UX needed                                    | Future milestone                         |
| Paystack subaccount per collection (ADR 0015) — O-1/O-4 owner actions                            | M8.9+                                    |
| Withdrawals, refunds, reconciliation, disputes                                                   | M8.10+ per Phase 4 plan                  |

---

## Key invariants the new code must respect

1. **Integer kobo everywhere.** `app.kobo` bigint domain. Never floats, never rounding without confirming the existing rule.
2. **Never multiply fee rates in SQL.** All rate arithmetic is in `packages/domain/src/fees.ts` (D-12). DB only stores pre-computed kobo amounts.
3. **Fee breakdown frozen at attempt creation** (D-16). Never recompute from live schedule after attempt exists.
4. **Actual provider fee authoritative** (D-11). Record the real `fees` field from Paystack verify response; don't use the estimate for the final journal.
5. **Operator-session for all money writes.** Use `withOwnerConnection` from `packages/db/src/client.ts`. Never call money functions from a Supabase client with `anon`/`authenticated` role.
6. **F5 — no collection takes money in both systems.** The `is_imported` flag blocks `create_payment_attempt`. Do not remove this guard.
7. **D-29 — Lagos calendar day.** Collection windows use Africa/Lagos timezone for start/end. `collection_window_state` handles this; don't reimplement it in TypeScript.
8. **D-30 — close on target.** `close_when_target_reached` is handled by `complete_payment_capture`; no extra check needed in the orchestrator.

---

## How to continue in a new session

1. Read [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) §4 (architecture), §5 (per-type blueprints), §10 (roadmap), §14 (decisions taken 2026-11-11).
2. Read [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — especially the "Built on 2026-11-11" section at the bottom.
3. Read the two migration files:
   - `supabase/migrations/20261111100000_payment_records.sql`
   - `supabase/migrations/20261111100100_payment_functions.sql`
4. The next thing to build is **M8.5 — the orchestrator layer** described above.
5. Branch is `feat/payments-foundation`. Docker + Supabase local stack needed to test; `supabase test db` for pgTAP.
