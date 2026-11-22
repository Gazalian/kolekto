# Staging readiness, pgTAP exception, lint and itest wrapper assessment — 2026-11-20 (session 41)

**Status:** assessment only. Nothing was deployed, committed or pushed. Staging (`kwolxuoeqwuedydxzncb`) was not
unpaused or queried. Legacy production was not touched. No LIVE Paystack call or setting. The itest database was not
reset or rebuilt; pgTAP files ran inside transactions that roll back.

**Read with:** [security and financial risk register](../security/risk-register-2026-11-20.md) (SR-xx IDs below) ·
[staging preflight 2026-11-19](staging-preflight-2026-11-19.md) (still valid for the staging project facts) ·
[session 40 report](session-40-itest-rebuild-report-2026-11-20.md).

The older `docs/deployment/staging.md` and `docs/environments/staging.md` date from 2026-09-28, before the Paystack
adapters existed. Their environment-isolation rules still hold; their "no money moves in staging / no code reads a
Paystack key" statements are out of date and superseded by §5 below.

---

## 1. Four kinds of readiness

| Level | Verdict | Basis |
|---|---|---|
| **Local development** | **READY** (with one caveat) | Full TEST withdrawal end to end in session 38 (member code → second approver → Paystack approval callback → success → one payout journal → reconciliation 9/9); failure recovery in session 37. Caveat: the local dev database's migration history is behind (recent migrations applied with psql), so `supabase migration up` fails locally. |
| **Integration test (itest)** | **READY** | Built from all 149 migrations (session 40). pgTAP **70/70 files, 2,386/2,386** this session after the test-only scope fix in §3. Unit suites green (session 40: web 281, worker 824, domain 269, payments 45, adapters 240; `tsc -b` 0). Concurrency 76/76 twice. |
| **Controlled staging** | **NOT READY — blocked by infrastructure and process, not by a known code defect** | §2: no hosting platform, no public URL for webhooks/approval, branch uncommitted and never through CI, staging paused with unknown migration history and no backup method, secrets store and hosted Auth/email unconfigured. |
| **LIVE financial operations** | **NOT READY** | Everything staging needs, plus the legal custody question (SR-01) as a separate blocker, the LIVE Paystack controls (SR-02), monitoring (SR-03) and the LIVE-blocking items in the risk register. A successful TEST withdrawal does not establish LIVE readiness. |

## 2. Staging-readiness matrix

READY · NEEDS ATTENTION · BLOCKED · NOT VERIFIED. "Staging" means a controlled deployment with Paystack **TEST** keys
only, `PAYSTACK_LIVE_TRANSFERS_APPROVED` unset.

| # | Item | Status | Evidence | What must be done |
|---|---|---|---|---|
| 1 | Database migration consistency | **BLOCKED** | 149 migrations replay from zero on itest; history = source (S40). 8 of them are **uncommitted**. Staging's applied history is unknown (project paused). | Commit (owner approval) and pass CI's `db reset` + pgTAP. Unpause staging (owner approval), read its history with `list_migrations`, report the exact gap, back up, then apply with the migration tool so each is recorded — never hand-run SQL. Stop if staging holds anything unexpected. |
| 2 | Environment variable completeness | **NEEDS ATTENTION** | `.env.example` lists every variable; this session added `PAYSTACK_TRANSFERS_ENABLED` and `PAYSTACK_LIVE_TRANSFERS_APPROVED` (both documented as unset). | Staging set (web + worker): `KOLEKTO_ENV=staging`, `KOLEKTO_EXPECTED_PROJECT_REF=kwolxuoeqwuedydxzncb`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, new `KOLEKTO_SESSION_SECRET`, new `KOLEKTO_WITHDRAWAL_OTP_SECRET` (≥ 32 chars, identical on web and worker), `APP_BASE_URL`, `PAYSTACK_SECRET_KEY` (**`sk_test_` only — check the prefix without printing the key**, SR-05), `PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_CALLBACK_URL`, email sender variables. `PAYSTACK_TRANSFERS_ENABLED` only on the worker and only for the agreed test window. |
| 3 | Supabase configuration | **NOT VERIFIED** | Project paused; plan/backups unknown; hosted Auth settings unverified (`docs/environments/staging.md`). | Unpause; confirm plan and backup; set Auth code template (`{{ .Token }}`), OTP 300 s / 6 digits, site and redirect URLs, SMTP; confirm email confirmation required. |
| 4 | RLS and database roles | **READY (schema) / NOT VERIFIED (staging)** | itest catalog this session: RLS on every public table, forced on all money tables, no anon access, no client execute on payout functions, `search_path` pinned (SR-19). | Re-run the same read-only catalog checks on staging after the migrations. Payout runs on the privileged connection (SR-08) — acceptable for TEST staging, not for LIVE. |
| 5 | Paystack TEST configuration | **NEEDS ATTENTION** | TEST account: transfer OTP off, test Transfer Approval on, *On Reject* = Do Nothing (S37). Its webhook and approval URLs point at the **local ngrok tunnel**. Paystack keeps one webhook URL and one approval URL per domain, so staging and local cannot both receive TEST callbacks. | Owner decides: move the TEST URLs to staging (local TEST runs then stop receiving callbacks) or use a separate Paystack TEST business for staging. Claude does not change dashboard settings. |
| 6 | Transfer approval callback URL | **BLOCKED** | Route exists and is verified against real TEST requests (S38). No public staging host exists. | Host the web app; register `https://<staging host>/api/webhooks/paystack/transfer-approval` in the TEST domain's Transfer Approval (owner, dashboard). Never in the Inbound Transfer Approvals field. |
| 7 | Webhook configuration | **BLOCKED** | `/api/webhooks/paystack` verified with TEST (S38 `transfer.success` → paid). | Same host; register `https://<staging host>/api/webhooks/paystack` as the TEST webhook (owner). |
| 8 | Worker startup and dispatch safeguards | **READY (code) / BLOCKED (hosting)** | SR-24: environment guards, check-only default, two-flag LIVE gate, unit 824/824, observed start-up states. | Choose where the staging worker runs (`docs/runbooks/worker-deployment-operator-guide.md` §2); single instance; start with transfers disabled, confirm `withdrawal_transfers_state` and `withdrawal_otp_delivery_state` lines, then enable dispatch for the agreed window only. |
| 9 | Email and OTP delivery | **NEEDS ATTENTION** | Worker delivers codes via Mailpit locally (S38, S39). Staging has no sender configured; hosted Auth SMTP unverified. | Configure the SES (or SMTP) sender per `docs/runbooks/ses-sender-operator-setup.md`; confirm the pause switch; send one code to an organisation-member inbox. |
| 10 | Logging and observability | **NEEDS ATTENTION** | Structured, redacted JSON logs (SR-14). No sink, no Sentry, no alerts (SR-03). | Choose a log sink; wire the minimum alerts (SR-03); on staging, grep logs for a TEST code, hash prefix and account number after one withdrawal. |
| 11 | Error handling | **READY (code) / NOT VERIFIED (hosted)** | Approval route fails closed (400, never 500); webhook 401/503 semantics; worker stages never fatal; [UNIT] [PGTAP 70]. | Observe one deliberate failure on staging (e.g. wrong signature → 401) in the hosted logs. |
| 12 | Financial reconciliation | **READY (function) / NEEDS ATTENTION (operations)** | `platform_reconciliation()` 9/9 after TEST runs; transfer reconciliation every 6 h (SR-23). | Run both on staging after the first TEST payout; decide who reviews discrepancies (SR-12). |
| 13 | Automated test coverage | **NEEDS ATTENTION** | pgTAP 70/70 (2,386); unit suites green; concurrency script. **Not run:** Playwright E2E on this branch; no E2E spec covers withdrawals; CI has never seen the branch; web lint has 1 error (§4; lint is not a CI job). **Source-tree invariants fail 1 rule** (run this session): `one-paystack-caller` flags `packages/domain/test/log-redaction.test.ts:28`, a redaction fixture key `PAYSTACK_SECRET_KEY: "sk_test_abc"` (session 39, not a Paystack call). CI's invariants job would fail. | Commit → CI green; for the invariant, owner to approve appending `// invariant-allow: redaction test fixture, not a Paystack call` to that line (the rule's documented escape) or renaming the fixture key; add one E2E for the withdrawal UI (request → code → approver) with the fake transfer provider; decide on §4. |
| 14 | Deployment configuration | **BLOCKED** | No `vercel.json`, `Dockerfile`, `fly.toml` etc.; CI has no deploy job (`.github/workflows/ci.yml:8`). | Founder decision on hosting for web and worker; staging-only deploy job gated on CI. |
| 15 | Backup and rollback | **BLOCKED** | MCP tools cannot snapshot. Each new migration header carries a rollback note, valid only while no saved account/transfer exists (preflight §3). | Choose dashboard backup or `pg_dump` (owner supplies the password through a secret store, not chat); record the backup before the first migration; app rollback = redeploy previous build; worker rollback per runbook §7. |
| 16 | Monitoring and incident response | **NEEDS ATTENTION (staging) / BLOCKED (LIVE)** | No alerting or on-call (SR-03); worker runbook lists alerts A1–A10 but they are not wired. | Wire alerts on staging; write a payout incident runbook (never release or settle by hand; use the audited functions; who to call at Paystack). |

## 3. pgTAP file 32, assertion 5 — assessment and fix

**What failed.** `supabase/tests/32_notification_delivery_access.sql` #5 compared **every** policy on
`public.notification_deliveries` with `{notification_deliveries_select_own_inbox}`. On the itest database it also
saw `kolekto_itest_worker_notification_deliveries_select` and `…_insert` (reproduced this session).

**Where those policies come from.** `npm run itest:worker-role` (`scripts/itest/itest.mjs`, `workerRoleSql()`,
lines 645–680) creates them `TO kolekto_itest_worker` only, for the notification worker's integration lane. No
migration creates them; the role exists only in the itest stack. CI's pgTAP job runs on a plain `supabase start`
without that role, so #5 passes there.

**Answers to the four questions.**

| Question | Answer |
|---|---|
| Is the assertion counting environment-specific policies? | Yes. Its intent (comment above it) is that the broad officer policy is gone and no client-facing policy remains; the harness policies are neither. |
| Are the worker policies intentionally required? | Yes. The least-privilege worker role has no BYPASSRLS; without these policies the integration lane cannot read or insert deliveries. They must not be removed. |
| Should the test scope its expected policies? | Yes, narrowly. |
| Is a documentation-only exception appropriate? | Not needed: a safe test-only correction exists. |

**Fix (test only).** #5 now ignores a policy only when its **sole** role is `kolekto_itest_worker` **and** its name
carries the harness prefix `kolekto_itest_worker_notification_deliveries_`. Nothing else changed: same plan (62),
same expected set, no migration, no policy, no grant.

**Evidence.**

- File 32 alone: 62/62 (was 61/62).
- Negative probe in a rolled-back transaction: a policy `TO public` and a harness-named policy `TO authenticated`
  were both still reported by #5 as extra (the exclusion does not hide a real policy). Policy count afterwards: 3
  (unchanged).
- Full suite on itest: **70/70 files, 2,386/2,386 assertions** (was 69/70, 2,385/2,386).
- After the suite: worker role still has 10 policies; no withdrawals or journals; the only communities are session
  40's two browser-check rows.

## 4. Lint error `MoneyPanel.tsx:422` — assessment (no change made)

**Rule.** `react-hooks/set-state-in-effect` (React Compiler rules shipped with `eslint-config-next`):
"Calling setState synchronously within an effect can trigger cascading renders", pointing at `void refresh();` in
`WithdrawalCodeEntry`.

**What the code does.** `refresh` is an async `useCallback`; its first statement is
`await withdrawalOtpStateAction(withdrawalId)`, and every `setState` comes after that await or in its `catch`. So no
state is set synchronously in the effect body. The rule traces into the callback and cannot see the await boundary.

**Classification: a harmless existing pattern (lint false positive), not a state-management defect.** The same
pattern is already accepted elsewhere with a justified disable: `apps/web/app/notifications/NotificationsPageClient.tsx:93-96`
and `apps/web/components/NotificationProvider.tsx:129`. Not a configuration issue: the rule is right in general.

Minor observation: the fetch is not cancelled on unmount. In React 18+ a late `setState` after unmount is ignored;
the component is mounted once per withdrawal id (dialogs), so a stale response cannot show another withdrawal's state.

**Proposed narrow fix (awaiting approval; not applied).** Mirror the existing precedent, no behaviour change:

```tsx
  useEffect(() => {
    // Load the code status on mount. `refresh` only setStates after an await,
    // so this does not cascade synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
```

Impact: the web lint becomes clean; no runtime change. Alternative (small behaviour change, not recommended now): an
inline `cancelled` flag as in `CollectionDetailClient.tsx:308-320`.

## 5. `itest:reset` wrapper gap — assessment (no change made)

**Symptom (session 39).** With the itest stack stopped, the migration copy stale (146 vs 149 files) and the database
volume present, neither `itest:up` nor `itest:reset` could proceed.

**Root cause — the two commands refuse each other's precondition** (`scripts/itest/itest.mjs`):

| Command | Refuses when | Lines |
|---|---|---|
| `up` | the copy differs from `supabase/migrations` **and** the volume `supabase_db_kolekto-itest` exists → "Run itest:reset" | 819–823 |
| `reset` | `verifyRunningStack()` finds the database container absent or not running | 902, 268–272 |

`up` deliberately does not start a stale database (it would run on an older schema than the source), and `reset`
needs a running database because `supabase db reset --local` replays into the running container. Starting the
stopped stack is only done by `up`. So "stopped + stale + volume exists" has no supported path. Session 40 resolved
it by hand: cold backup → `.env.itest` moved aside → `docker volume rm supabase_db_kolekto-itest` (identity
checked) → `itest:up`.

**Should the wrapper be improved?** Yes, narrowly. Proposed change (not applied; needs the owner's approval):

- In `reset` only (already gated by `--confirm-reset-kolekto-itest`): if the test-stack containers exist but the
  database is stopped, run the same start sequence `up` uses — `checkPortsFree()`, `supabase start -x … --ignore-health-check`
  with the **existing** copy untouched, `waitHealthy()` — then continue with the unchanged reset (which rewrites the
  copy and replays every migration).
- Starting with the old copy should be safe: the CLI applies migrations when it initialises a new volume, not when
  it starts an existing one, and the reset that follows replays from zero. That CLI behaviour (pinned 2.109.1) is
  an assumption to confirm in the change's own test run before relying on it.
- No volume removal is added. `up`'s refusal and message stay as they are.
- Impact: `itest:reset` becomes usable from a stopped stack; nothing changes for a running stack; no new
  destructive operation; the developer stack is never touched (every CLI call keeps `--workdir supabase-itest` and
  the deny-list).

**Safe recovery procedure (until then, and for a corrupt volume).** The session 39 plan as executed in session 40:

1. `npm run itest:status` (read only). Confirm the stack is `kolekto-itest`.
2. Identify the volume exactly: name `supabase_db_kolekto-itest`, labels `com.supabase.cli.project=kolekto-itest`
   and `com.docker.compose.project=kolekto-itest`, and **no** container attached
   (`docker ps -a --filter volume=supabase_db_kolekto-itest` empty).
3. Cold backup to a directory outside every git repository; verify (`gzip -t`, `tar tzf`, `PG_VERSION`); record size
   and SHA-256.
4. Move `.env.itest` aside (never print it).
5. Owner's explicit approval, then `docker volume rm supabase_db_kolekto-itest` — by exact name only.
6. `npm run itest:up`, `npm run itest:worker-role`, `npm run itest:net-lockdown`, `npm run itest:status`.
7. Verify the new role password works on the host port and the old one is refused.

**Preventing deletion of non-itest volumes.**

- Never `docker volume prune`, `docker system prune --volumes`, `supabase stop --no-backup` or a wildcard/filter
  removal; only `docker volume rm <exact name>` after step 2.
- The developer volume `supabase_db_kolekto` differs only by the suffix — always compare the full name and the
  `com.supabase.cli.project` label.
- If the wrapper ever gains a volume operation: hard-code the single name, check both labels and zero attached
  containers, refuse anything else, and add `--no-backup` to its CLI deny-list (`FORBIDDEN_CLI_TOKENS`, line 99),
  which today does not include it.

## 6. Staging deployment checklist (controlled, TEST keys only)

Each step needs the owner's explicit go-ahead where marked ★. Claude never changes Paystack dashboard settings.

**A. Before anything touches staging**

1. ★ Owner approves committing sessions 27–41; open a PR; CI green (invariants, typecheck, unit, `db reset` + pgTAP,
   secret scan, E2E). Resolve or accept §4.
2. ★ Hosting decision for web and worker; secret store chosen (SR-16).
3. ★ Legal: confirm staging is TEST-only and holds no real member data (O-1 does not block TEST).

**B. Database**

4. ★ Unpause `kwolxuoeqwuedydxzncb`; verify ref and name with `get_project` (never `list_projects`).
5. Read `list_migrations`; report the exact gap against the repository; stop on anything unexpected.
6. ★ Backup (dashboard or `pg_dump`) recorded with size and checksum.
7. ★ Apply missing migrations in order with the migration tool (recorded), checking after each: no error, expected
   objects, money-table row counts unchanged, `app.platform_reconciliation()` all ok.
8. Read-only catalog checks as in risk register SR-19.

**C. Configuration**

9. Secrets into the platform store (§2 item 2). Check `PAYSTACK_SECRET_KEY` starts with `sk_test_` without printing
   it. `PAYSTACK_LIVE_TRANSFERS_APPROVED` absent everywhere.
10. Hosted Auth settings (§2 item 3); email sender; pause switch read.
11. ★ Owner: Paystack TEST webhook + Transfer Approval URLs → staging host (§2 item 5 trade-off); TEST transfer OTP off;
    *On Reject* = Do Nothing (one setting for TEST and LIVE — re-read, do not change).

**D. Smoke and first TEST payout**

12. Deploy web; `GET` on both Paystack routes → 405; `POST` without signature to the webhook → 401.
13. Start worker with `PAYSTACK_TRANSFERS_ENABLED` unset; read the three state lines.
14. Sign in, add a TEST bank account (name match), wait out cooling-off if not the first.
15. ★ ₦100 TEST withdrawal: code by email, designated approver approves, enable dispatch for one run, approval
    callback 200 (signature valid), success webhook, one payout journal, reconciliation 9/9, dispatch off again.
16. Grep hosted logs for the code, the hash prefix, the account number and the secret key prefix → none (SR-14).
17. Record results in a staging report; update this checklist.

**E. Never on staging:** a LIVE key, `PAYSTACK_LIVE_TRANSFERS_APPROVED`, legacy data or refs, manual ledger or
withdrawal edits, releasing a hold by hand.

## 7. Verdicts

1. **Local implementation ready?** **Yes, for local development and integration testing.** Evidence: S38 end-to-end
   TEST payout, S37 automatic failure recovery, pgTAP 70/70 (2,386), unit suites, concurrency 76/76, browser checks of
   the approver UI. Outstanding: the uncommitted branch (SR-04), the lint error (§4), the wrapper gap (§5), the local
   dev migration history.
2. **Ready for a controlled staging deployment?** **No — not yet.** No known code defect blocks it; it is blocked by:
   commit + CI (SR-04), hosting and deploy job, staging unpause + migration history + backup, secret store (SR-16),
   hosted Auth and email configuration (SR-13), a public URL for the Paystack TEST webhook and approval URL, and the
   owner's choice on sharing the Paystack TEST account between local and staging.
3. **Ready for LIVE financial operations?** **No.** In addition to every staging blocker and a successful staging
   run: **the unresolved legal question of Kolekto holding and controlling third-party funds (O-1, SR-01) is a
   separate LIVE blocker that no engineering work removes**; LIVE Paystack has no transfer OTP and no LIVE approval
   URL (SR-02); no monitoring or incident response (SR-03); key/environment binding (SR-05); unsigned approval
   requests (SR-06); the inbound stop-gap (SR-07); payout privilege (SR-08); second-approver designation controls
   (SR-09); account-change alerts (SR-10); O-3 manual review (SR-11); operator tooling (SR-12); MFA (SR-13); hosted
   logging (SR-14); provider idempotency and LIVE funding (SR-15).
