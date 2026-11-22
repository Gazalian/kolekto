# Security and financial-controls risk register — 2026-11-20 (session 41)

**Scope:** the Kolekto withdrawal, approval, transfer, ledger and settlement implementation on branch
`feat/payment-receipts-alarms` (uncommitted), plus the environment and provider configuration it depends on.
**Method:** inspection only. Code and migrations were read; the isolated test database (`kolekto-itest`) catalog was
queried read-only; pgTAP was run (every file rolls back). No LIVE Paystack call, no LIVE setting, no staging or
production database access, no balance or withdrawal state change.

**Companion documents:** [staging readiness](../phase-4/staging-readiness-2026-11-20.md) ·
[withdrawal OTP and approval](../phase-4/withdrawal-otp-owner-approval-2026-11-19.md) ·
[ADR 0016](../adr/0016-member-code-owner-approval-paystack-server-approval.md) ·
[financial decisions](../phase-4/financial-decisions.md) ·
[session 40 rebuild report](../phase-4/session-40-itest-rebuild-report-2026-11-20.md)

## Evidence labels

A passing unit test is not, by itself, proof that a control is secure. Each finding states which kind of evidence
exists.

| Label | Meaning |
|---|---|
| **[CODE]** | Read in the repository (migration, route, adapter, worker). Shows intent, not behaviour. |
| **[PGTAP n]** | pgTAP file *n* on the clean itest database (session 40 and this session: 70/70 files, 2,386/2,386). |
| **[CONC]** | `scripts/verify/withdrawal-concurrency.mjs` two-session runs on an itest clone (76/76 twice, session 40). |
| **[UNIT]** | Vitest with fakes or stubs. |
| **[CATALOG]** | Read-only query of the itest database catalog in this session. |
| **[BROWSER]** | Observed in the app in a browser (local dev or itest web server). |
| **[TEST-PSK]** | Observed with the Paystack TEST key against Paystack's TEST domain (sessions 34–38). |
| **[LIVE-RO]** | Read-only observation of the Paystack LIVE dashboard by the owner/Claude (session 34, 37). Nothing changed. |
| **[UNVERIFIED]** | Assumption or documentation only; not established in any environment. |

Severity: **Critical** (could lose or misdirect third-party money at scale, or a legal bar to operating) ·
**High** (money or control loss under a plausible single failure) · **Medium** (needs a second failure, or an
operational gap with financial consequences) · **Low** (defence in depth, fail-safe behaviour, hygiene).

## Summary

| ID | Area | Severity | Blocks staging | Blocks LIVE | Status |
|---|---|---|---|---|---|
| SR-01 | Legal: custody and control of third-party funds (O-1) | **Critical** | No | **Yes** | Open — counsel |
| SR-02 | LIVE Paystack: no transfer OTP and no LIVE approval URL | **High** | No | **Yes** | Open — owner |
| SR-03 | No error tracking, alerting or paging | **High** | No (needs attention) | **Yes** | Open |
| SR-04 | Branch uncommitted; CI never run on it | **High** | **Yes** | **Yes** | Open — owner approval to commit |
| SR-05 | Paystack key mode not bound to `KOLEKTO_ENV` | Medium | No (manual check) | **Yes** | Open |
| SR-06 | Approval URL accepts unsigned requests | Medium | No | **Yes** | Open |
| SR-07 | Inbound-credit stop-gap holds unauthenticated requests 12 s | Medium | No | **Yes** | Open (stop-gap) |
| SR-08 | Payout stage runs on the privileged server connection | Medium | No | **Yes** | Open |
| SR-09 | Second approver chosen by the owner alone, effective at once, no alert | Medium | No | **Yes** | Open |
| SR-10 | No alert to the member when a payout account is added or changed | Medium | No | **Yes** | Open |
| SR-11 | Manual review (> ₦1,000,000) has no operator path; O-3 open | Medium | No | **Yes** | Open — founder/ops |
| SR-12 | Operator tooling is SQL-only (account review, discrepancies, escalations) | Medium | No | **Yes** | Open |
| SR-13 | Hosted Auth settings and officer MFA not verified | Medium | **Yes** (sign-in) | **Yes** | Not verified |
| SR-14 | Production/hosted logging of sensitive values not verified | Medium | No | **Yes** | Partly fixed |
| SR-15 | Provider-side idempotency and LIVE balance funding unverified (PA-08, funding) | Medium | No | **Yes** | Not verified |
| SR-16 | Secret storage and rotation for hosted environments undefined | Medium | **Yes** | **Yes** | Open |
| SR-17 | Withdrawal OTP and sign-in share one channel (email) | Low | No | No | Accepted (mitigated) |
| SR-18 | Owner self-approval prevention | Low | No | No | Implemented, verified |
| SR-19 | Community/collection isolation and RLS on money tables | Low | No | No | Implemented, verified (itest) |
| SR-20 | Callback payload validation, reference and recipient binding | Low | No | No | Implemented, verified (TEST) |
| SR-21 | Duplicate transfer, webhook and payout prevention (Kolekto side) | Low | No | No | Implemented, verified |
| SR-22 | Ambiguous provider outcomes, failure recovery and hold release | Low | No | No | Implemented, verified (TEST) |
| SR-23 | Ledger idempotency and reconciliation | Low | No | Low (operator UI: SR-12) | Implemented, verified |
| SR-24 | Worker environment guards and dispatch switches | Low | No | No | Implemented, verified (unit + local) |
| SR-25 | Anonymous-callable SECURITY DEFINER read functions not re-reviewed | Low | No | No (review) | Not reviewed this session |
| SR-26 | Local credential hygiene (one itest password printed in S39, rotated S40) | Low | No | No | Resolved |

"Blocks staging" means it prevents a **controlled staging deployment with Paystack TEST keys only**. Staging is
blocked separately by infrastructure items (hosting, backups, URLs) — see the staging-readiness document.

---

## Findings

### SR-01 — Legal: custody and control of third-party funds (O-1) — **Critical**

- **Description.** Every contribution is charged into **Kolekto's own Paystack balance** and paid out later by a
  Kolekto-initiated transfer. Kolekto therefore holds third-party money and controls when it is released. Whether
  that needs a licence or another legal structure is unanswered (financial decisions §12 O-1; §22 B "deferred, not
  investigated").
- **Evidence.** [CODE] `packages/payments/src/orchestrator.ts:186` sends `subaccountCode: null`; ADR 0016 §Decision 1
  (Kolekto-held balance); `docs/phase-4/staging-preflight-2026-11-19.md` §5. Related open items O-4 (fee pass-through),
  O-5 (lost disputes after withdrawal), O-6 (refunds), O-10 (payload retention, data residency).
- **Impact.** Operating without the required authorisation can force a shutdown, freeze funds or expose the
  business and its officers to regulatory action, independent of how well the software works.
- **Mitigation.** Written legal opinion on O-1 (and O-4, O-5, O-10) before any real-money operation. If the answer
  is unfavourable, the documented alternative is Paystack subaccounts (ADR 0015 seam, `subaccount_auto_settle`) so
  that Kolekto never holds the funds; that is separate work.
- **Blocks staging:** No (staging uses TEST keys; no real money). **Blocks LIVE:** **Yes — a separate launch blocker,
  independent of every technical item.**
- **Status:** Open. Not investigated by engineering, by design.

### SR-02 — LIVE Paystack: no transfer OTP and no LIVE approval URL — **High**

- **Description.** On the LIVE Paystack business, "Confirm transfers before sending" (transfer OTP) is **off** and
  outgoing *Transfer Approval* for LIVE is **off** (no URL). A LIVE API transfer therefore needs neither an OTP nor an
  approval. Anyone holding the LIVE secret key can move the LIVE balance.
- **Evidence.** [LIVE-RO] session 34 (status doc §A); re-read session 37. The LIVE *Inbound Transfer Approvals* field
  still holds the local ngrok URL (greyed out, box unticked). *On Reject* is one setting for TEST and LIVE and is
  **Do Nothing** (owner changed it, session 37).
- **Impact.** A leaked LIVE key (laptop, CI log, hosting env) is directly convertible into transfers out of
  Kolekto's balance, which holds third-party money (SR-01).
- **Mitigation.** Before any LIVE payout: register the LIVE approval URL (`/api/webhooks/paystack/transfer-approval`
  on the production host) so every LIVE transfer must pass Kolekto's database decision; restrict API access by IP
  in the Paystack dashboard if the plan allows; keep the LIVE key out of every non-production environment (SR-05);
  leave *Receive Approval Requests* (inbound) unticked and ask Paystack support to clear its URL.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open — owner's decision. Claude changed no Paystack setting.

### SR-03 — No error tracking, alerting or paging — **High**

- **Description.** Escalated transfers, reconciliation discrepancies, worker refusals and webhook failures are
  reported only as JSON log lines (`withdrawal_transfers_needing_attention` logs a `critical` line every 15 min).
  `SENTRY_DSN` is read by no code; no log sink, alert route or on-call exists.
- **Evidence.** [CODE] `apps/worker/src/withdrawal-transfers.ts` (attention interval), `docs/environments/staging.md`
  §D, `docs/runbooks/worker-deployment-operator-guide.md` §4 (alerts listed, not wired).
- **Impact.** A stuck or ambiguous payout, a failed reconciliation or a stopped worker can go unnoticed while
  members wait or balances drift; the design relies on humans acting on escalations.
- **Mitigation.** Choose a log sink and alerting; wire at least: worker stopped/refused, escalated transfer,
  reconciliation discrepancy `open` with severity ≥ warning, webhook 5xx/401 rate, approval-URL rejects, OTP delivery
  failures. Write a payout incident runbook (who looks, what they may and may not do: never release by hand).
- **Blocks staging:** No, but staging is the place to prove the alerts. **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-04 — Branch uncommitted; CI has never run on it — **High (process)**

- **Description.** Sessions 27–41 are uncommitted on `feat/payment-receipts-alarms`: 8 migrations
  (`20261118100000` … `20261120140000`), the transfer adapters, worker stages, routes and tests.
- **Evidence.** `git status` (32 modified, 40+ untracked). CI (`.github/workflows/ci.yml`) runs invariants, typecheck,
  unit tests, `supabase db reset` + pgTAP, secret scan and E2E — none of it has seen this work. Run locally this
  session, the invariants script already fails one rule (`one-paystack-caller` on a session 39 redaction test
  fixture; staging readiness §2 item 13).
- **Impact.** Loss of work on a disk failure; no independent clean-room check; staging cannot be deployed from an
  uncommitted tree.
- **Mitigation.** Owner-approved commit(s) and a pull request; CI green (including Playwright E2E, not run since
  these changes) before any staging step.
- **Blocks staging:** **Yes.** **Blocks LIVE:** **Yes.**
- **Status:** Open — waiting for the owner's approval to commit.

### SR-05 — Paystack key mode is not bound to `KOLEKTO_ENV` — **Medium**

- **Description.** The transfer provider (web `apps/web/lib/payments/transfers.ts`, worker) and the hosted payment
  provider accept either `sk_test_` or `sk_live_` in every environment. Only the local checkout opt-in refuses a
  live key. Sending is still gated: a live key needs `PAYSTACK_TRANSFERS_ENABLED=true` **and**
  `PAYSTACK_LIVE_TRANSFERS_APPROVED=true` (`packages/adapters/src/paystack-transfer-provider.ts:366-376`).
- **Evidence.** [CODE] above; [UNIT] adapters tests cover the two-flag rule. Grep: no `KOLEKTO_ENV`/key-prefix check
  in `packages/adapters` or `apps/worker/src/worker-guards.ts`.
- **Impact.** A LIVE key pasted into staging or local would resolve real bank accounts, create LIVE recipients and
  let the approval route verify LIVE signatures; with both flags set by mistake it would move real money from a
  non-production database.
- **Mitigation.** Small adapter-level guard: refuse `sk_live_` unless `KOLEKTO_ENV=production`, refuse `sk_test_` in
  production (mirrors the existing database-target guards). Until then, the staging checklist verifies the key
  prefix by hand, without printing the key.
- **Blocks staging:** No (manual check in the checklist). **Blocks LIVE:** **Yes.**
- **Status:** Open. Not changed (out of this session's scope).

### SR-06 — Approval URL accepts unsigned requests — **Medium**

- **Description.** When no `x-paystack-signature` header is present, the request is decided on its merits and
  recorded `signature: absent`; an approving answer still sets `provider_approved_at`.
- **Evidence.** [CODE] `packages/adapters/src/paystack-transfer-provider.ts:212-218` returns `absent`;
  `supabase/migrations/20261120100000_…sql:419` accepts `valid` or `absent`, `:480` sets `provider_approved_at`.
  [TEST-PSK] every real Paystack approval request seen (sessions 34, 38) carried a valid signature.
- **Impact.** No money moves to an attacker: the 200 goes back to the caller, not to Paystack. But a forged request
  that matches a live transfer's reference, amount, recipient code and transfer code would mark it
  provider-approved, which permanently disables the automatic "never sent" release for that transfer; the funds then
  stay reserved until an operator reconciles. The reference is a random `ktr_` value, so this needs leaked data.
- **Mitigation.** Require `valid` (reject `absent`) in the route and in `app.decide_transfer_approval`. Small change;
  propose and test before LIVE.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-07 — Inbound-credit stop-gap holds unauthenticated requests for 12 s — **Medium**

- **Description.** The approval route recognises a Paystack inbound credit request and waits 12 s before answering
  400, so that Paystack's documented default (accept after 5 s) applies. The check runs **before** any signature
  check, so anyone can make the server hold a connection for 12 s per request.
- **Evidence.** [CODE] `apps/web/app/api/webhooks/paystack/transfer-approval/route.ts` (`inboundHoldMs = 12_000`).
  Context: the LIVE ₦510 inbound request of 2026-11-20 08:54 UTC (status doc §A).
- **Impact.** Cheap connection/compute exhaustion of the web tier (serverless duration costs or worker slots),
  which could delay real approval requests into Paystack's `blocked` outcome (fail-safe, but payouts stall).
- **Mitigation.** Verify the signature before the hold; cap concurrent holds; remove the stop-gap once Paystack
  support clears the LIVE inbound URL; never tick *Receive Approval Requests*.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open (owner-approved stop-gap of 2026-11-20).

### SR-08 — Payout stage runs on the privileged server connection — **Medium**

- **Description.** The worker's least-privilege role is deliberately **not** granted the nine transfer functions
  (they post ledger journals). Payouts run on the operator's server connection (`SUPABASE_DB_URL`).
- **Evidence.** [CODE] `apps/worker/src/withdrawal-transfers.ts` header and `WITHDRAWAL_TRANSFER_FUNCTIONS`;
  [CATALOG] `authenticated`/`anon` cannot execute any payout function (0 rows).
- **Impact.** A compromised worker host gets full database rights, not just payout rights.
- **Mitigation.** A dedicated payout role (no BYPASSRLS, EXECUTE on exactly the nine functions, nothing else) and a
  separate worker deployment or connection for payouts. Additive migration; prove with the itest worker-role
  pattern.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-09 — Second approver chosen by the owner alone, effective at once, no alert — **Medium**

- **Description.** Only an owner designates a second approver (`app.set_withdrawal_approver`,
  `app.replace_withdrawal_approver`). The designee must hold an active admin/owner term and an active account. There
  is no waiting period and nobody else is notified. An owner can invite a second account they control as admin,
  designate it, and approve their own request through it.
- **Evidence.** [CODE] `20261120140000_withdrawal_approver_management.sql` (eligibility = term `started_at <= now()`,
  no delay); [PGTAP 71] 54/54; [BROWSER] session 40 designate → replace → remove with audit rows
  `withdrawal_approver.designated` / `.replaced` / `.ended`.
- **Impact.** For an owner's own withdrawal, two-person control can collapse to one person. The destination is still
  the owner's own verified, name-matched account, so this does not redirect money to a stranger, but it removes the
  check against an owner withdrawing community money alone.
- **Mitigation.** Cooling-off on new designations (e.g. 48 h, as D-08) and on admin terms used for approval; email
  every other officer and the designee on designation changes; show the approver history to all officers; operator
  flag when a designation precedes a large owner withdrawal.
- **Blocks staging:** No. **Blocks LIVE:** **Yes** (or explicit owner acceptance of the risk, recorded).
- **Status:** Open. Designation, replacement, removal and audit are implemented and verified.

### SR-10 — No alert to the member when a payout account is added or changed — **Medium**

- **Description.** Adding, disabling or re-reviewing a saved bank account writes an audit row
  (`bank_account.*`) but sends no email or in-app notice.
- **Evidence.** [CODE] `20261118100100_bank_accounts_and_transfers.sql` (`app.write_audit_log` only); no notification
  call in `apps/web/app/account/bank-actions.ts` or `packages/db/src/bank-accounts.ts`.
- **Impact.** A session hijack that adds an account goes unnoticed by the real member. Mitigated by name matching,
  the 48 h cooling-off for accounts after the first, profile-name re-review, the member code and the second-party
  approval.
- **Mitigation.** Email the confirmed address on every account add/disable/re-review, and to officers when a
  requester's account changes during an open withdrawal.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-11 — Manual review over ₦1,000,000 has no operator path; O-3 open — **Medium (operational)**

- **Description.** Any withdrawal over ₦1,000,000 is flagged `requires_manual_review` and is never claimed for
  transfer; the approval URL answers `manual_review_required`. No function or screen clears the flag. D-06's middle
  band (₦1M–₦5M, "security checks") is not distinguished; the implementation is stricter than D-06. Daily limit
  (D-07): ₦1,000,000 per day for unverified communities, serialised by an advisory lock.
- **Evidence.** [CODE] `20261117100200_withdrawals.sql:38,295`, `20261119120000_…sql:336-425,1091,1560`;
  financial decisions D-06, D-07, O-3.
- **Impact.** Fail-safe (money cannot leave) but large withdrawals stay held indefinitely with the funds reserved;
  members can only cancel.
- **Mitigation.** Founder/ops to answer O-3; then an audited operator approval for manual review.
- **Blocks staging:** No. **Blocks LIVE:** **Yes** (for verified communities, which have no daily limit).
- **Status:** Open.

### SR-12 — Operator tooling is SQL-only — **Medium (operational)**

- **Description.** Re-approving a `needs_review` bank account, resolving reconciliation discrepancies, acting on
  escalated transfers and the settlement catch-up are database functions without an operator screen or role-based
  access.
- **Evidence.** [CODE] functions in `20261118100100`, `20261119100000`, `20261119120000`;
  `withdrawal-otp-owner-approval-2026-11-19.md` §6 P8-4.
- **Impact.** Operators need direct database access to resolve routine money events: more people with broad rights,
  more chance of a hand-written statement.
- **Mitigation.** Staff-realm operator screens (ADR 0009) calling only the audited functions; never raw SQL on money
  tables.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-13 — Hosted Auth settings and officer MFA not verified — **Medium**

- **Description.** Sign-in uses Supabase Auth email codes. On the hosted staging project the code template, OTP
  expiry/length, redirect URLs, SMTP and rate limits are unverified. No second factor exists for officers who
  approve withdrawals.
- **Evidence.** `docs/environments/staging.md` "Hosted Auth settings — not yet verified"; [UNVERIFIED].
- **Impact.** Staging sign-in may not work; in LIVE, an officer's email account is the single key to their Kolekto
  account (see SR-17).
- **Mitigation.** Configure and verify the hosted Auth settings; consider TOTP/passkey MFA for owners, admins and
  designated approvers before LIVE.
- **Blocks staging:** **Yes** (the sign-in journey). **Blocks LIVE:** **Yes.**
- **Status:** Not verified.

### SR-14 — Production/hosted logging of sensitive values not verified — **Medium**

- **Description.** The member's code leaked into the **local dev** log through Next's dev-only Server Function
  argument logging; that is now off (`apps/web/next.config.ts` `logging.serverFunctions: false`) and OTP actions log
  through the redacting `logEvent` (`apps/web/lib/server-log.ts`, `packages/domain/src/log-redaction.ts`). Neither
  route logs Paystack bodies (they carry IPs and bank details).
- **Evidence.** [UNIT] `log-redaction.test.ts`, `otp-logging.test.ts`; [BROWSER] session 39 live dev-log check (no
  code, no hash). Production build and the hosting platform's own request logs: [UNVERIFIED].
- **Impact.** A code or bank detail in a hosted log is readable by everyone with log access.
- **Mitigation.** On staging: run a TEST withdrawal and grep the platform logs for the code, the hash prefix and the
  account number; disable request-body capture in the platform.
- **Blocks staging:** No. **Blocks LIVE:** **Yes** (must be verified on staging first).
- **Status:** Fixed for local dev; hosted not verified.

### SR-15 — Provider-side idempotency and LIVE funding unverified — **Medium**

- **Description.** Kolekto never creates a second transfer for a withdrawal (one row, one `ktr_` reference,
  re-send with the same reference only after ≥ 2 NOT FOUND). Whether Paystack itself refuses a second transfer with
  the same reference (PA-08) is documented by Paystack but not observed by Kolekto. LIVE balance funding (payouts
  are paid from Kolekto's Paystack balance on a T+1 assumption without provider settlement records, §20 Q2) is not
  verified.
- **Evidence.** [PGTAP 70] [CONC 4, 6, 7] Kolekto side; [TEST-PSK] one transfer per reference in S38;
  [UNVERIFIED] provider duplicate behaviour and LIVE funding.
- **Impact.** If Paystack did not de-duplicate, a re-send after an unseen success could pay twice from Kolekto's
  balance; an underfunded balance leaves transfers waiting (fail-safe).
- **Mitigation.** A TEST-domain probe of a deliberate same-reference re-send (with owner approval); confirm with
  Paystack in writing; reconcile the LIVE balance against `collection_available` daily before LIVE payouts.
- **Blocks staging:** No. **Blocks LIVE:** **Yes.**
- **Status:** Not verified.

### SR-16 — Secret storage and rotation for hosted environments undefined — **Medium**

- **Description.** Secrets live in git-ignored `.env.local` files on one laptop. No hosting platform or secret store
  is chosen. `KOLEKTO_WITHDRAWAL_OTP_SECRET` must be identical on web and worker; no rotation procedure exists for it,
  for `KOLEKTO_SESSION_SECRET`, the Paystack keys or the webhook secret.
- **Evidence.** `docs/deployment/staging.md` §3; `.env.example`; session 35 rotated the OTP secret locally by hand.
- **Impact.** Secrets copied by hand between machines and chats; a rotation could break code verification for
  in-flight withdrawals (codes hashed with the old key fail closed, members must request a new code).
- **Mitigation.** Pick the platform secret store; document rotation (OTP secret rotation invalidates open codes —
  acceptable, fail-closed); scope Paystack TEST keys to staging only.
- **Blocks staging:** **Yes.** **Blocks LIVE:** **Yes.**
- **Status:** Open.

### SR-17 — Withdrawal code and sign-in share one channel — **Low (accepted, mitigated)**

- **Description.** OTP Option A: 6 digits from `crypto.randomInt`, HMAC-SHA256 with `challengeId`, 10-minute
  expiry, 5 attempts then locked, single use, bound to one withdrawal and one member, resend after 60 s, at most 5
  codes per request and 10 per member per hour; only to an email Supabase Auth confirmed. Sign-in is also an email
  code, so someone controlling the member's mailbox controls both.
- **Evidence.** [CODE] `20261119120000_…sql:104-122,476-513,640-654,733`; [PGTAP 69] 102/102; [CONC 1, 2];
  [BROWSER] sessions 38, 39 (Mailpit delivery, wrong then right code, lock behaviour in tests).
- **Impact.** Brute force is bounded (≤ 25 guesses per request, ≤ 50 per hour; ~2.5 × 10⁻⁵ success per request).
  Mailbox compromise still needs a second person's approval and pays only to the member's own name-matched account.
- **Mitigation.** MFA for officers (SR-13); account-change alerts (SR-10).
- **Blocks staging / LIVE:** No. **Status:** Implemented and verified locally.

### SR-18 — Owner self-approval prevention — **Low (control in place)**

- **Description.** Nobody approves or rejects their own withdrawal; an owner's request needs a designated second
  approver; the treasurer role never qualifies; `approved_as` is write-once; the approval URL refuses
  `self_approved` and `approver_not_authorised`.
- **Evidence.** [CODE] guard trigger `WITHDRAWAL_SELF_APPROVAL`, `app.decide_withdrawal`; [PGTAP 69, 71];
  [TEST-PSK]/[BROWSER] session 38 (owner UI shows only Cancel; rolled-back probe with the owner's JWT →
  `42501 FORBIDDEN`; approval by the designated approver; Paystack approval → 200 → success).
- **Residual:** SR-09. **Blocks staging / LIVE:** No. **Status:** Implemented and verified.

### SR-19 — Community/collection isolation and RLS on money tables — **Low (control in place)**

- **Evidence.** [CATALOG, this session] every `public` table has RLS enabled (0 without); all 25 money, withdrawal,
  transfer, approver and OTP tables have RLS **forced**; `anon` reads none of them; `authenticated` writes none
  directly and has no SELECT on `withdrawals`, `withdrawal_transfers`, `user_bank_accounts`,
  `withdrawal_otp_challenges`, `community_withdrawal_approvers` (reads go through definer functions);
  `authenticated`/`anon` can execute none of the payout/approval functions; every `app` SECURITY DEFINER function
  pins `search_path`. [PGTAP 01, 02, 04, 63, 69, 71] isolation across communities (another community's owner refused).
- **Residual:** staging catalog not yet checked (needs the migrations applied there). **Status:** Verified on itest.

### SR-20 — Callback payload validation, reference and recipient binding — **Low (control in place)**

- **Evidence.** [CODE] `parseTransferApprovalRequest` requires `data.details.body` and exactly one `data.transfers[]`
  entry to agree on reference, amount, currency, recipient; `TRF_` code and status `received`; 64 KiB cap, JSON only,
  fail closed. `app.decide_transfer_approval` re-checks amount, NGN, transfer code, recipient = the withdrawal's
  selected account = the requester's verified account, member code, approval basis, manual review, funds reserved.
  [UNIT] redacted real fixture; [PGTAP 70] 92/92; [TEST-PSK] session 38 real request → signature valid → 200 →
  success. Main webhook: HMAC-SHA512 required (401 on missing/bad), then Paystack verify is authoritative.
- **Status:** Implemented and verified (TEST).

### SR-21 — Duplicate transfer, webhook and payout prevention — **Low (Kolekto side)**

- **Evidence.** One `withdrawal_transfers` row per withdrawal; write-once `ktr_` reference; leases with claim tokens
  and `FOR UPDATE SKIP LOCKED`; `payout:<withdrawal>` journal idempotency key; same success twice → `already_paid`.
  [PGTAP 63, 70] [CONC 4, 5, 6, 7] [TEST-PSK] S38: exactly one Paystack transfer, one payout journal.
- **Residual:** provider side, SR-15. **Status:** Verified.

### SR-22 — Ambiguous outcomes, failure recovery and hold release — **Low (control in place)**

- **Evidence.** Timeout → `unknown` → verify by reference; never released after a timeout; release-as-unsent only
  when never sent, or refused synchronously (not duplicate/insufficient balance/429) then ≥ 3 NOT FOUND over ≥ 30
  min and never approval-requested; escalation after 24 h, 2 h at `otp` or 40 checks keeps funds reserved.
  [PGTAP 70] [CONC 3, 6] [TEST-PSK] session 37: `ktr_bb67…` → two more NOT FOUND → automatic release, exactly one
  release journal, balances restored, reconciliation 9/9. *On Reject* = Do Nothing (prevents recipient blacklisting,
  observed failure mode of session 35).
- **Status:** Implemented and verified (TEST).

### SR-23 — Ledger idempotency and reconciliation — **Low**

- **Evidence.** Integer kobo; balanced journals; `app.platform_reconciliation()` 9/9 and `v_ledger_imbalances` = 0
  after every TEST run (S37, S38); read-only Paystack transfer reconciliation every 6 h over 7 days with per-item
  resolution; [PGTAP 03, 20, 21, 57, 58, 63, 65, 70]. Settlement catch-up (§21) changes no stored amount.
- **Residual:** discrepancy resolution is SQL-only (SR-12); alerts (SR-03). **Status:** Verified.

### SR-24 — Worker environment guards and dispatch switches — **Low (control in place)**

- **Evidence.** [CODE] `apps/worker/src/worker-guards.ts`: refuses invalid `KOLEKTO_ENV`, the legacy estate,
  non-loopback hosts in local, staging without `KOLEKTO_EXPECTED_PROJECT_REF`, staging pointed at production, and a
  database URL naming a different project than the API URL. Transfer stage: check-only without
  `PAYSTACK_TRANSFERS_ENABLED=true`; live key additionally needs `PAYSTACK_LIVE_TRANSFERS_APPROVED=true`; no key →
  stage off. [UNIT] worker 824/824; [TEST-PSK] S37/S38 start-up states logged; cleanup restart shows
  `enabled:false reason no_paystack_key`.
- **Residual:** SR-05, SR-08. **Status:** Verified.

### SR-25 — Anonymous-callable SECURITY DEFINER read functions — **Low (not reviewed)**

- **Description.** Eight `app` SECURITY DEFINER functions are executable by `anon`: public collection page readers
  (`get_public_collection*`, `get_public_invite`, `redeem_invite_link`, `get_collection_member_context`,
  `find_collection_member`). Pre-existing, outside the withdrawal scope; `find_collection_member(uuid, text)` could
  allow member lookup on a public collection.
- **Evidence.** [CATALOG] this session.
- **Mitigation.** Review their output columns and rate limits in a separate public-surface review.
- **Status:** Not reviewed this session.

### SR-26 — Local credential hygiene — **Low (resolved)**

- The itest role password was printed once in the session 39 transcript; session 40 rotated it (old refused, new
  accepted on the host port; not in any file). `KOLEKTO_WITHDRAWAL_OTP_SECRET` rotated locally in session 35. No
  `sk_live_`/`pk_live_` in any env file (S36, S38).

## Not covered by this register

- Playwright E2E was not run for the withdrawal journey; no E2E spec covers it.
- The public contribution surface, notifications and imports were reviewed in earlier milestones, not here.
- No penetration test, dependency audit refresh or load test was performed this session.
