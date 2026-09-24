# Phase 4 — readiness audit and implementation plan

**Date:** 2026-09-24
**Branch:** `m8.1-financial-foundation` @ `69fc30c`, working tree clean
**Status:** Audit and plan. **No code, schema or configuration was changed by
this audit.** The two amendments to the decision register are listed in §27.
**Companions:** [financial decisions](financial-decisions.md) ·
[provider assumptions](provider-assumptions.md) ·
[ADR 0015](../adr/0015-subaccount-custody-and-collection-level-ownership.md) ·
[M8.1 report](../history/2026-09-24-m8.1-financial-foundation-report.md)

Every claim below was verified against the live local database, the working
tree, or a command whose output is quoted. Nothing is carried over from an
earlier session's memory.

---

## 1. Executive summary

**Kolekto's financial *record* layer exists and is tested. Its financial
*movement* layer does not exist at all.** That division is deliberate and it is
enforced by the test suite rather than by intention: 560 pgTAP assertions across
21 files, including a gate that fails the build if a payment, contribution,
withdrawal, payout or refund table appears, or if any database function becomes
able to write to the ledger.

Verified inventory: 10 financial tables, 3 views, 6 guard functions. Row counts
today are **1 fee schedule and 12 account codes — reference data only. Zero
ledger accounts, zero journals, zero entries, zero provider events, zero
operation claims.** No fabricated financial record exists anywhere.

**Two findings from this audit matter more than the plan.**

**Finding 1 — a live Paystack secret key is recoverable from the legacy
backend's git history.** Not in this repository; in `kolekto-be-old`. Details
and remediation in §16. It needs a key rotation, which is a live-environment
action this audit did not and must not perform.

**Finding 2 — the new system has no staging environment, no production
environment, and no deployment path of any kind.** No linked Supabase cloud
project, no deployment configuration, and CI has no deploy job (deliberately —
its own comment says deployment is configured when staging exists). Phase 4
cannot be integration-tested against Paystack sandbox until somewhere exists to
deploy it, because a webhook needs a public URL. **This is the longest lead-time
item in the whole plan and nothing in the repository can shorten it.**

**Four places where this brief and the built system disagree.** Each is
reported rather than resolved, per §20 of the brief:

| # | The brief says | The system does | Where |
|---|---|---|---|
| A1 | provider events must carry processed timestamp, processing status, attempt count, error, replay status | `financial_events` is strictly immutable and carries none of these | §10 |
| A2 | "do not hardcode a guessed cutoff"; T+1 must be configurable | 05:00 Africa/Lagos is a hardcoded constant — not a guess (it was an explicit founder decision), but not configurable either | §7 conflict |
| A3 | withdrawal states include `reversed` and `awaiting approval` | the designed machine has neither; it forbids any transition out of `completed` | §12 |
| A4 | a refund incurs a further 3% charge | the fee model has no refund charge concept at all | §14 |

None of the four blocks the next milestone. A1 and A4 change a schema that has
not been built yet, A2 is a small refactor of a constant into a table, and A3 is
a state-machine design question for the founder.

**Recommended next milestone is M8.2: the Paystack adapter seam plus recorded
fixtures, with no network access.** It is the largest piece of work that is
entirely unblocked. Reasoning in §25.

## 2. Current Phase 4 readiness

| Subsystem | State | Classification |
|---|---|---|
| Money primitives (integer kobo, rounding, allocation) | **complete**, 154 domain tests | — |
| Fee calculation and versioned schedules | **complete** for capture-time fees; no refund charge, no transfer fee computation | partly SAFE NOW |
| Double-entry ledger, balancing, append-only | **complete**, 50 pgTAP assertions | — |
| Collection-level attribution | **complete**, enforced by `CHECK` | — |
| Provider-event idempotency store | **exists**, lacks processing state (A1) | REQUIRES FOUNDER DECISION on shape |
| T+1 settlement calculation | **complete** as a pure function; not configurable (A2) | SAFE NOW to make configurable |
| Chart of accounts vocabulary | **complete**, 12 codes | — |
| Balance projections | **complete** as views | — |
| Payment attempt / contribution / provider transaction | **absent** | SAFE NOW (schema); writer needs adapter |
| Paystack adapter | **interface only**, `createSettlementProvider()` throws by design | SAFE NOW with fixtures |
| Webhook receiver | **absent** | BLOCKED on a public URL (§8) |
| Balance release (T+1 job) | **absent** | SAFE NOW after A2 |
| Withdrawal / payout | **absent** | BLOCKED on PA-04, O-2, O-3 |
| Refund | **absent** | BLOCKED on founder (bearer) + PAYSTACK (economics) |
| Reconciliation | **designed in full**, not built | boundary ③ SAFE NOW; ①④ need a provider |
| Partial / installment payments | **absent and not designed to rule level** | REQUIRES FOUNDER DECISION |
| Staging / production infrastructure | **absent** | BLOCKED, external |
| Monitoring | **absent** (`SENTRY_DSN` is declared and read by nothing) | SAFE NOW |
| Transactional email | **absent** (`EMAIL_PROVIDER` unused) | REQUIRES FOUNDER DECISION (provider choice) |

## 3. What already exists in the repository

Verified by querying the running local database, not by reading migrations.

**Tables (10)**

| Table | Purpose | Rows now |
|---|---|---|
| `fee_schedules` | versioned, effective-dated, append-only | **1** (`2026-09-founder`) |
| `fee_schedule_category_rates` | per-category platform rate override | 0 |
| `withdrawal_fee_schedules` | versioned withdrawal fee schedule | **0, deliberately** |
| `withdrawal_fee_brackets` | the ₦100–₦500 brackets | **0, deliberately** (O-2) |
| `ledger_account_codes` | the chart as a closed vocabulary | **12** |
| `ledger_accounts` | accounts, scoped platform / community / collection | 0 |
| `ledger_journals` | financial events, unique on `idempotency_key` | 0 |
| `ledger_entries` | debits and credits, always positive | 0 |
| `financial_events` | raw provider events, unique on `(provider, provider_event_id)` | 0 |
| `financial_operation_claims` | `(scope, key)` claims for outbound operations | 0 |

**Views (3)** — `v_ledger_account_balances`, `v_collection_position`,
`v_ledger_imbalances`. All `security_invoker`, so the caller's RLS decides the
rows.

**Functions (7 in `app`)** — `assert_journal_balances`,
`assert_journal_has_entries`, `assert_ledger_account_scope`,
`block_fee_schedule_mutation`, `block_financial_event_mutation`,
`block_ledger_mutation`, `set_collection_fee_mode`. **Six of the seven exist
only to refuse things.** None writes a financial record.

**Domain code** — `packages/domain/src/money.ts` (branded `Kobo`, half-away-from-zero
rounding applied once, exact allocation), `fees.ts` (`calculateFees`, two
schedule versions, VAT, asymmetric caps, `ProviderFee` estimate-versus-truth),
`settlement.ts` (`availableAt`, `releaseIsDue`, Lagos calendar handling),
`contribution.ts` (server-side amount resolution for all seven collection types,
already tested).

**Adapter seam** — `packages/adapters/src/settlement-provider.ts`: interface
only, three-valued `SettlementModel`, and `createSettlementProvider()` throws.

**Guarantees enforced by tests, not intent** — 5 source-tree invariants; 560
pgTAP assertions; a gate asserting the ledger is empty and unwritable; a
grant-matrix test asserting the exact set of tables `authenticated` may read; a
drift check in CI asserting migrations reproduce the schema.

**Architecture already designed and still accurate** — the 932-line money
architecture, 453-line state machines (8 machines), 234-line reconciliation
design (6 boundaries, 9 verdicts), and the test matrix. This audit re-read all
four and found no claim in them contradicted by current code, other than the
four conflicts in §1.

## 4. What is completely missing

Nothing below exists in any form. Listed in dependency order.

1. **`contribution_intents`** — what a contributor chose before money moved.
2. **`payment_attempts`** — the amount lock; one attempt, one provider, a
   server-generated reference, a frozen fee breakdown.
3. **`provider_transactions`** — the provider's own statement of fact, separate
   from our attempt so "which amount is right?" is answerable.
4. **`contributions`** — money Kolekto asserts arrived, applied to a collection.
   Plus `contribution_lines` for item baskets and `tickets` for admitted units.
5. **Every ledger writer** — capture, fee posting, balance release, withdrawal,
   payout, refund. Today nothing can write a journal at all.
6. **Per-collection account provisioning** — a collection's accounts must be
   created on first use; no function does this.
7. **The Paystack adapter implementation** — initialize, verify,
   `authenticateWebhook`, `parseWebhook`.
8. **The webhook receiver** — persist-before-acknowledge, signature check,
   dedupe, verify, claim.
9. **`balance_releases` and the T+1 job.**
10. **`withdrawal_accounts`, `withdrawals`, `payouts`** — and the 48-hour
    cooling-off, daily limits and approval thresholds that act on them.
11. **`refunds` and the refund charge.**
12. **`provider_settlements`.**
13. **`reconciliation_runs` / `reconciliation_records`** and the six comparisons.
14. **Installment plans and partial-payment derivation.**
15. **Disputes and holds.**
16. **State-transition triggers** — the designs specify database-enforced
    machines; not one exists yet.
17. **All monitoring, alerting and operational tooling.**

## 5. What can be safely implemented now

Each item is unblocked by every external party. Classification: **SAFE NOW**.

| # | Item | Why it is safe | Size |
|---|---|---|---|
| S1 | Paystack adapter **seam + recorded fixtures + fakes**, no network | a contract and test doubles touch no provider | M |
| S2 | `contribution_intents`, `payment_attempts`, `provider_transactions`, `contributions`, `contribution_lines` **schema + state triggers**, with no writer that calls a provider | shapes are settled by the architecture; the amount lock is server-side arithmetic | L |
| S3 | Capture and fee **posting functions**, driven by a fake provider in tests | posts journals from a recorded transaction; no network | L |
| S4 | Per-collection **account provisioning** function | pure bookkeeping | S |
| S5 | **T+1 configurability (A2)** — move hour and timezone into a versioned settlement schedule | removes a hardcoded constant; behaviour unchanged | S |
| S6 | `balance_releases` + the release **posting function** (not the scheduler) | a journal writer; the job that calls it can come later | M |
| S7 | Reconciliation **boundary ③** (contributions ↔ ledger) | both sides are ours; needs no provider | M |
| S8 | **Refund charge representation** in the fee model, bearer left unset (A4) | representing a charge is not deciding who pays it | S |
| S9 | **Monitoring wiring** — Sentry, structured logs, a health endpoint | no financial semantics | S |
| S10 | **Load/concurrency harness** for reference generation and journal idempotency | proves the unique-index guarantees under parallelism, which M8.1 did not | M |
| S11 | Provider-event **processing-outcome table (A1)** — append-only attempts, once the founder confirms the shape | see §10; my recommendation is an append-only sibling table | S |

**Explicitly not safe now, even though it looks adjacent:** anything that calls
Paystack, the webhook endpoint (needs a public URL), withdrawal execution,
refund execution, and the T+1 scheduler in an environment where nobody is
watching it.

## 6. What is blocked by external decisions

| Blocked item | Blocked by | Class |
|---|---|---|
| Withdrawal **anything** | PA-04 (can subaccount settlement timing be controlled?) | REQUIRES PAYSTACK CONFIRMATION |
| Withdrawal fee computation | O-2 (the ₦100–₦500 brackets) | REQUIRES FOUNDER DECISION |
| Withdrawal approval workflow | O-3 (what "security checks" and "manual review" mean) | REQUIRES FOUNDER DECISION |
| Refund execution | refund charge bearer; PA-13 refund fee economics | REQUIRES FOUNDER DECISION + PAYSTACK |
| Enabling `contributor_pays` by default | O-4 (may a platform fee lawfully be passed on?) | REQUIRES LEGAL/COMPLIANCE |
| Going live with real money | O-1 (may Kolekto hold/control timing of third-party funds? licence?) | REQUIRES LEGAL/COMPLIANCE |
| Partial/installment payments | O-7 (rules per collection type) | REQUIRES FOUNDER DECISION |
| Dispute handling beyond holds | O-5 (who bears a lost dispute after withdrawal) | REQUIRES LEGAL/COMPLIANCE |
| Raw payload retention | O-10 (residency and retention) | REQUIRES LEGAL/COMPLIANCE |
| VAT other than zero | O-8 (is Kolekto's fee VAT-able?) | REQUIRES ACCOUNTING/TAX |
| Webhook integration testing | a public staging URL | BLOCKED (external infrastructure) |
| Sandbox settlement/subaccount verification | a Paystack test account | BLOCKED (external) |

## 7. Paystack requirements

Current belief state, from [provider assumptions](provider-assumptions.md),
re-checked against this brief. **Three ESTABLISHED, four UNVERIFIED, eight
UNKNOWN.**

| Requirement | Status | Note |
|---|---|---|
| Test/sandbox account, separate from live | **NOT OBTAINED** | the single hard prerequisite for M8.4 onward |
| Test secret + public keys | NOT OBTAINED | must be new, never legacy (§16) |
| Webhook signing scheme | **ESTABLISHED** | HMAC SHA-512 over the raw body, `x-paystack-signature`; verify before parsing |
| Retry schedule | **ESTABLISHED** | 3 min × 4, then hourly, to 72 h; delivery is at-least-once |
| Stable event id | **ESTABLISHED** (listable/resendable) | it is the dedupe key |
| Whether the event id is unique for ever | UNVERIFIED | PA-03 partial |
| Subaccount settlement timing controllable | **UNVERIFIED — highest impact** | PA-04; D-01 depends on it |
| Verify returns settled fee vs estimate | UNVERIFIED | PA-05; decides when provider fee becomes truth |
| Split/subaccount fee treatment matches our model | UNVERIFIED | PA-06; a mismatch is systematic, not occasional |
| Attribution granularity (per-organiser, not per-collection) | UNVERIFIED | PA-07; forces capture-time attribution |
| Transfer idempotency on our reference | **UNKNOWN** | PA-08; we do not rely on it |
| Transfer timeout semantics | **UNKNOWN** | PA-09; timeout ≠ failed |
| Settlement report decomposition | UNKNOWN | PA-10; reconciliation boundary ④ |
| Transaction list pagination over arbitrary periods | UNKNOWN | PA-11; boundary ① |
| API rate limits | UNKNOWN | PA-12; bounds sweep frequency |
| Refund fee economics | UNKNOWN | PA-13; and now compounded by the 3% charge (§14) |
| Dispute/chargeback operations | UNKNOWN | PA-14 |
| Non-NGN transactions | UNKNOWN | PA-15; mismatch is `needs_review`, never converted |
| KYC/KYB requirements for subaccount creation | **NOT INVESTIGATED** | new in this brief; needed before an organiser can be onboarded |
| Transaction and transfer limits | NOT INVESTIGATED | new in this brief |

**Sandbox verification order, when an account exists:** PA-04 first (it can
invalidate a product decision), then PA-06 (it can invalidate the fee model),
then PA-05, then PA-08/PA-09 (they gate payouts), then the rest.

## 8. External infrastructure requirements

**This is the section with the most missing, and none of it is in the
repository's power.** Verified: no `vercel.json`, `Dockerfile`, `fly.toml`,
`render.yaml` or `netlify.toml`; no linked Supabase project
(`supabase/.temp/project-ref` absent); CI has four jobs and no deploy job.

**Paystack**

| Item | Status |
|---|---|
| New test/sandbox account | **REQUIRED, absent** |
| Test webhook endpoint registered against a staging URL | REQUIRED, absent (depends on staging) |
| Test subaccount(s) | REQUIRED, absent |
| Test transfer capability enabled | REQUIRED, absent |
| Test refund capability | REQUIRED, absent |
| Written answers to PA-04…PA-15 | REQUIRED, absent |
| KYC/KYB pack for organiser subaccounts | REQUIRED, not investigated |

**Supabase**

| Item | Status |
|---|---|
| Staging project | **absent** |
| Production project for the NEW system | **absent** (`KOLEKTO_PRODUCTION_PROJECT_REF` is empty) |
| Automated backups on staging and production | absent |
| Point-in-time recovery on production | absent — **mandatory before real money**; a financial ledger without PITR has no recovery story |
| A tested restore | absent — an untested backup is a hope |
| Service-role key held only in a secret store | N/A until projects exist |
| Database monitoring / slow-query visibility | absent |

**Deployment**

| Item | Status |
|---|---|
| Staging environment with a public HTTPS URL | **absent — blocks all webhook work** |
| Production environment | absent |
| Domain and subdomain plan | absent |
| TLS | follows from the host |
| Secret management (not `.env` files) | absent |
| Separation so a staging deploy cannot reach production | partly designed: `packages/config` asserts non-production is not pointed at the production ref, and that guard is real code |

**Monitoring**

| Item | Status |
|---|---|
| Application error tracking | `SENTRY_DSN` is declared in `.env.example` and **read by nothing** |
| Webhook failure alerting | absent |
| Reconciliation break alerting | absent |
| Withdrawal/payout failure alerting | absent |
| `suspense` balance watch | absent (and O-9 has not named an owner) |
| Security alerting | absent |
| Uptime / health check | absent |

**Email** — `EMAIL_PROVIDER` / `EMAIL_API_KEY` declared, unused. No transactional
sender, no production sending domain, no delivery monitoring. Local development
uses the Supabase mail catcher on port 54324. A payment receipt is a financial
document; it needs a real sender before launch.

**Security**

| Item | Status |
|---|---|
| Secret scanning in CI | **present** (gitleaks, plus an assertion that no `.env` or link file is tracked) |
| Production access control | absent, no production exists |
| Secret rotation procedure | absent — and §16's finding needs one now |
| Audit logging | **present and append-only** (`audit_logs`) |
| Incident response runbook for the NEW system | absent (the legacy `PAYMENT_OPERATIONS_RUNBOOK.md` is reference only) |
| Backup restore rehearsal | absent |

## 9. Environment matrix

Variable **names** only. No value in this repository, and none in this
document. Both `.env.local` files are git-ignored (verified), and
`.env.example` is the only env file ever tracked (verified against full history).

| Variable | Local | Staging | Production | Notes |
|---|---|---|---|---|
| `KOLEKTO_ENV` | `local` | `staging` | `production` | parsed strictly; anything else throws |
| `NEXT_PUBLIC_SUPABASE_URL` | local stack | staging project | prod project | project ref extracted and compared |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | local | staging | prod | publishable only |
| `SUPABASE_SERVICE_ROLE_KEY` | local | staging | prod | **never** a `NEXT_PUBLIC_` var; secret store only |
| `SUPABASE_DB_URL` | local | staging | prod | server only; used for `app.*` writes |
| `KOLEKTO_PRODUCTION_PROJECT_REF` | set, to assert *not* prod | set | set | the guard that stops a clone writing to production |
| `KOLEKTO_SESSION_SECRET` | dev value | distinct | distinct | ≥32 chars, enforced |
| `PAYSTACK_SECRET_KEY` | **test** | **test** | future prod, separate | **empty today, verified** |
| `PAYSTACK_PUBLIC_KEY` | **test** | **test** | future prod | **not yet declared** — add when the adapter lands |
| `PAYSTACK_WEBHOOK_SECRET` | **test** | **test** | future prod | **empty today, verified** |
| `PAYSTACK_CALLBACK_URL` | local | staging URL | prod URL | **not yet declared**; must never be a legacy URL |
| `EMAIL_PROVIDER` / `EMAIL_API_KEY` | mail catcher | real sender, test domain | real sender, prod domain | unused today |
| `SENTRY_DSN` | optional | required | required | declared, unused |
| `LOG_LEVEL` | `info` | `info` | `info`/`warn` | |

**Three rules for this matrix, and the third is new:**

1. Never a legacy live value in any column. §16.
2. Production values exist only in the host's secret store, never in a file.
3. **A staging Paystack key must be a test key.** Staging is publicly reachable
   and will be pointed at by a real webhook; a live key there would move real
   money from a non-production deployment.

## 10. Database architecture

**Present.** 77 migrations. Every table has RLS enabled *and* forced, an
explicit grant-allowlist entry, and, for financial tables, append-only
enforcement by both withheld privilege and a blocking trigger. CI replays all 77
from scratch and asserts zero schema drift.

**Next, in dependency order:** `contribution_intents` → `payment_attempts` →
`provider_transactions` → `contributions` (+ `contribution_lines`, `tickets`) →
`balance_releases` → `withdrawal_accounts` / `withdrawals` / `payouts` →
`refunds` → `provider_settlements` → `reconciliation_*` → installment plans →
`disputes` / `holds`.

**Conflict A1 — provider-event processing state.** The brief requires
`financial_events` to carry a processed timestamp, processing status, attempt
count, error and replay status. The table as built is **strictly immutable**: it
records what the provider said, and a trigger refuses every `UPDATE`. Those
requirements are mutable by nature.

I am not resolving this unilaterally. The options:

| Option | Effect |
|---|---|
| **(a) Append-only sibling table** — `financial_event_processing_attempts`, one row per attempt, carrying status, error, timestamp and attempt number; current state is the latest row. **My recommendation.** | Keeps the evidence immutable, makes the processing history richer than a counter would (you can see *each* failure, not just how many), and satisfies every question the brief lists. Cost: a join, or a small view. |
| (b) Mutable columns on `financial_events` | Simpler to query. Costs the immutability guarantee on the table that holds provider evidence, and an `UPDATE` path on a financial table is the thing M8.1 spent a migration preventing. |
| (c) Split the table | Evidence immutable, processing separate. Same as (a) but with a bigger migration and no extra benefit. |

**Recommend (a). Needs a one-line founder or engineering confirmation before
M8.3.** Classification: REQUIRES FOUNDER DECISION (shape only — the requirement
itself is not in question).

## 11. Ledger architecture

**Built and tested.** `ledger_accounts` / `ledger_journals` / `ledger_entries`;
`Σ debits = Σ credits` asserted by a deferred constraint trigger at commit
(tested including a one-kobo imbalance and an empty journal); append-only via
withheld privileges plus blocking triggers; corrections only as reversing
journals; `idempotency_key` unique; collection attribution mandatory by `CHECK`
except for platform-only `fee` and `adjustment` journals; a 12-code closed
vocabulary with scope and type guards; balances as `security_invoker` views.

**The brief's ledger checklist against what exists:**

| Must support | Status |
|---|---|
| captured payment, provider fee, Kolekto fee | account codes exist; **no writer** |
| contributor-paid vs organiser-absorbed fee | fee model handles both; frozen onto the attempt at creation — attempt does not exist yet |
| locked/pending funds, available funds | `collection_pending`, `collection_available` exist |
| withdrawal, payout | `collection_withdrawing`, `collection_withdrawn` exist |
| refund | `collection_refund_reserve` exists |
| **refund charge** | **missing** — see §14 |
| reversal / correcting journal | `reverses_journal_id` + `reversal` source type |
| journals balance, entries append-only | enforced and tested |
| taxes/levies kept separate | `vat_payable` account exists; VAT is 0 |
| **transfer/withdrawal fee** | schedule table exists (empty); **no account code** — needs one |

**Two gaps to close in the next ledger migration:** an account code for the
withdrawal/transfer fee, and one for the refund charge. Both are additive and
depend on §14's bearer decision only for *how they are posted*, not for whether
the accounts exist.

## 12. Payment state machines

Eight machines are designed in full
([state machines](../history/2026-09-22-phase4-state-machines.md)), with two
governing rules worth restating because they are the safety properties: **a
state is a column with a `CHECK` and a trigger, never a free string**, and **once
money is known to exist, no state may hide it** — `failed` is reachable only
before capture.

The brief's §12 separation (checkout intent / provider transaction /
contribution / ledger journal must not share a table) is exactly what the
architecture specifies. `contribution_intents`, `payment_attempts`,
`provider_transactions`, `contributions` and `ledger_journals` are five
entities, and "transaction" is deliberately not a table of its own — it is ours
plus theirs.

**Conflict A3 — withdrawal states.** Brief versus design:

| Brief | Design | Assessment |
|---|---|---|
| `requested` | `requested` | same |
| `awaiting approval` | — | `requested` currently means this. But D-06 has **three** approval tiers (≤₦1M owner; ≤₦5M owner + security checks; >₦5M owner + manual review), and the two upper tiers plausibly need a distinct state so a withdrawal parked in manual review is visibly different from one nobody has looked at. **Founder decision.** |
| `approved` | `approved` | same |
| `processing` | `executing` | naming only; I would adopt the brief's word |
| `completed` | `completed` | same |
| `failed` | `failed` | same |
| `reversed` | — | **a real gap.** The design forbids any transition out of `completed`, treating a post-completion reversal as a separate inbound event. The brief wants a `reversed` state. Both are defensible; they are not compatible. **Founder decision**, and it interacts with O-5 (who bears a reversal after the organiser has the money). |
| `cancelled` | `cancelled` | same |
| — | `rejected` | the design has it, the brief omits it; it is needed and should stay |

Payout keeps its own machine with `unknown` — the state that exists so a timeout
cannot be read as a failure and a retry cannot pay a bank twice.

## 13. Withdrawal architecture

Decided (D-03 … D-08): always collection-level, never community; first
withdrawal free, subsequent ones ₦100–₦500 by amount; 24-hour processing target;
three approval tiers; ₦1,000,000 daily limit unless the community is `verified`;
48-hour cooling-off after a bank-account change.

Present today: every permission it needs already exists as a row
(`withdrawal.request`, `withdrawal.approve`, `withdrawal_account.change` with
`requires_second_approver` already true), `communities.verification_status`
already exists, and `withdrawal_fee_schedules` exists with **no rows**.

Missing: `withdrawal_accounts`, `withdrawals`, `payouts`, the cooling-off check,
the daily-limit check, the approval workflow, the fee computation, the transfer
fee account code, and the withdrawal/payout separation in code.

**Entirely gated on PA-04.** If Paystack subaccount settlement cannot be
timing-controlled, then Paystack pays the organiser directly and none of the
above has anything to act on. **Do not build this subsystem before PA-04 is
answered in writing.** The ledger already survives either answer.

## 14. Refund architecture

**New information in this brief: a refund incurs a further 3% charge. The bearer
of that charge is not finalised.** M8.1 recorded refunds as wholly deferred with
no charge concept, so the register is now out of date; §27 lists the amendment.

What the architecture must represent, without deciding the bearer:

1. **The refund charge is its own fee component.** Not the platform fee, not the
   provider fee, not the withdrawal fee. It needs its own account code and its
   own line in the fee model, because the brief is explicit that these must not
   collapse into one generic fee.
2. **The bearer is configuration, resolved at refund time and then frozen** —
   the same pattern `fee_mode` uses for capture. Candidates the model must be
   able to express: contributor, organiser/collection, Kolekto absorbs, or split.
   **I am not choosing.**
3. **The charge is versioned** with the refund fee schedule, so a refund in 2027
   is explicable by the schedule in force when it happened.
4. **A refund never deletes a contribution.** It is a new row plus a journal.
5. States per the designed machine: requested → approved → submitted →
   succeeded / failed, plus rejected and cancelled; full and partial; retry as a
   new refund rather than a mutated one; `refund.initiate` already requires a
   second approver.
6. **Refunding more than the contribution is refused** by a `CHECK` against the
   sum across refunds.

**Blocked by two things, not one:** the bearer (FOUNDER) and PA-13, Paystack's
actual refund fee treatment (PAYSTACK). A 3% Kolekto charge stacked on an
unknown provider refund cost is not a model anyone can reason about yet.

Ambiguity I am flagging rather than resolving: **3% of what?** The original
contribution, the amount being refunded (which differs for a partial refund), or
the original total including fees. For a ₦10,000 contribution refunded ₦4,000
the three readings give ₦300, ₦120 and ₦309. **FOUNDER DECISION.**

## 15. Reconciliation architecture

Designed in full and, on reading it against this brief, it already satisfies
§13. Six boundaries — provider↔events, provider transactions↔attempts,
contributions↔ledger, settlements↔transactions, withdrawals↔ledger,
payouts↔withdrawals. Nine verdicts with severities and owners, of which
`missing_internal` is the worst thing the system can say. `reconciliation_runs`
and `reconciliation_records` carry the **evidence** as jsonb, so a verdict does
not send somebody back to reconstruct the comparison.

The property that matters, and it matches the brief's prohibition exactly: **the
reconciler cannot correct anything.** An operator resolves a mismatch by posting
a journal through the normal permissioned function and then linking it;
`resolution_journal_id` is a pointer, never a cause. There is no
reconciliation-specific write path, so there is no second writer of financial
truth.

Zero tolerance is defined per boundary: boundary ③ is truly zero (both sides are
ours), ② and ④ tolerate the provider's documented fee rounding, and a tolerated
variance is still **recorded** as `matched` with a non-zero variance so
"we did not notice" and "it was inside the band" are distinguishable.

**Boundary ③ is buildable now** (S7). ① and ④ need a live provider.

## 16. Security architecture

**Present:** RLS enabled and forced on every table; `anon` holds nothing; every
write an `app.*` `SECURITY DEFINER` function that re-checks permission and
derives tenancy from the row; append-only `audit_logs`; append-only financial
tables; gitleaks in CI plus an assertion that no `.env` or Supabase link file is
tracked; a config guard that refuses to let non-production processes point at
the production project ref.

### Finding 1 — a live Paystack secret is in the legacy repository's git history

**Severity: high. Action required, and not by me.**

| Where | Detail |
|---|---|
| `kolekto-be-old/.env` | on disk, untracked, correctly git-ignored; contains a full live-key value |
| `kolekto-be-old/.env.bak.pre-email-fix` | same |
| `kolekto-be-old` **git history** | a full live-key pattern appears in **2** historical diffs; commit `1f82604` (2025-12-31) added a file named `prod.env` |

No tracked file at `HEAD` contains it, and `.env` is ignored now — but **history
is not remediated by a later `.gitignore`.** Anyone with a clone of that
repository can recover the key.

**Recommended remediation, in order, and all of it is the founder's to run:**

1. **Rotate the live Paystack secret key.** This touches the live environment,
   so it must be scheduled: rotating a key that live code is using will break
   payment processing until the new key is deployed. Plan the deploy and the
   rotation together.
2. Treat the legacy repo's history as compromised for that secret. Rewriting
   history is optional once the key is rotated and is not worth the risk on a
   repository that is now reference-only.
3. Delete `.env.bak.pre-email-fix`, which exists for no current purpose.
4. Confirm the legacy repository is private and audit who has clone access.

**I did not read, print, copy, or use any key value. The checks above report
only presence, file path, and pattern counts.**

### Finding 2 — the `PUBLIC` EXECUTE default will recur

M8.1 found and fixed six `app.*` functions that were `anon`-executable because
Postgres grants `EXECUTE` to `PUBLIC` on every new function. Only
`02_grant_matrix.sql` failing caught it. **Every future migration that adds a
function has this hazard**, and Phase 4 adds many. Recommend a sixth invariant
or an authoring-time check. Classification: SAFE NOW, small.

### Security work still required for Phase 4

Forged webhook rejection; replay resistance (the unique indexes give this, but
untested under parallelism); unauthorised withdrawal and refund attempts;
cross-community and cross-collection isolation on every new table; privilege
escalation; rate limiting on payment initiation; and no client-supplied amount
ever trusted — the last is already the pattern in `contribution.ts`.

## 17. Monitoring and observability

**Nothing exists.** `SENTRY_DSN` is declared and read by no code; there is no
health endpoint, no structured logging beyond `LOG_LEVEL`, and no alerting.

Minimum before real money moves, in priority order:

1. **Webhook failures and `needs_review` depth** — a rising `needs_review` queue
   is money parked and waiting.
2. **`suspense` balance non-zero** — captured money with no attributable
   collection. O-9 has not named who watches it.
3. **`v_ledger_imbalances` returning any row** — should be impossible; if it
   ever returns a row, a constraint has been bypassed.
4. **Reconciliation breaks**, especially `missing_internal`.
5. **Payouts stuck in `unknown`** — each one blocks a retry and holds an
   organiser's money.
6. **Failed transfers and withdrawal backlog against the 24-hour target.**
7. Application errors, database health, auth failures.

The first five are financial alarms and have no equivalent in a generic
application monitor. Classification: SAFE NOW to wire; the thresholds for 2 and
4 are O-9, a founder/ops decision.

## 18. Test strategy

**Today:** 5 source-tree invariants; 295 unit tests (154 domain, 83 web, 58
validation); 560 pgTAP assertions across 21 files; an E2E suite that is not run
routinely because of host memory limits; CI replays every migration from scratch
and checks for drift.

| Layer | Have | Need |
|---|---|---|
| **Unit** | fee calculation, rounding, caps, both bearers, schedule versioning, T+1 across every boundary the brief names (Mon→Tue, Fri→Sat, Sat→Sun, Sun→Mon, exact midnight, exact 05:00, month/year/leap) | installment arithmetic; refund charge arithmetic once §14 closes; state-transition tables as pure functions |
| **Database** | journal balancing incl. one-kobo, empty-journal refusal, append-only on update and delete, reversal, duplicate idempotency key, attribution `CHECK`, chart-of-accounts scope/type guards, RLS with a viewer who can read and a collector who cannot, cross-community isolation | the same for every new table; state-transition triggers; withdrawal isolation; refund sum `CHECK` |
| **Integration** | **none** | recorded Paystack fixtures with a fake adapter first; then sandbox: duplicate webhook, out-of-order webhook, delayed webhook, webhook-before-redirect and the reverse, failed payment, refund, transfer, failed transfer, reversed transfer, **and the timeout-then-success case that produces `unknown`** |
| **E2E** | collection creation, contributor journey up to the money boundary, references, exports, mobile | payment, receipt, ledger assertion, pending→available, collection withdrawal, transfer, reconciliation |
| **Load** | a reference-concurrency harness exists (`npm run test:concurrency`) | payment burst, webhook burst, concurrent payments on one collection, **concurrent withdrawals on one collection**, and parallel duplicate journals — M8.1's idempotency rests on unique indexes and has not been demonstrated under real parallelism |
| **Security** | grant matrix, RLS coverage, authorization, no `PUBLIC`-executable definer functions | forged webhook signature, replay, unauthorised withdrawal, unauthorised refund, privilege escalation, cross-collection withdrawal attempt |

**The gap I would close first is the load/concurrency layer**, because every
idempotency claim in M8.1 is currently proven by construction rather than by
observation, and "the unique index makes it impossible" is a claim worth testing
once with real threads.

## 19. Migration and cutover implications

Unchanged and restated because Phase 4 must not quietly reverse it: legacy
production history becomes **immutable imported history** and **never new
financial truth**. No opening balances. The new ledger starts empty — verified
empty today. `migration.unattributed_payments` has no `collection_id` column at
all, which is what makes a well-meaning backfill of the ₦19.8m impossible.

**The old system is live and processing real transactions.** That has two
consequences this plan must respect:

1. **Both systems will be live simultaneously** during any cutover. Two systems
   taking money for the same organiser needs an explicit plan: which collections
   are served by which system, how an organiser is moved, and what happens to a
   collection that is mid-cycle. **Not designed. REQUIRES FOUNDER DECISION**, and
   it is a bigger piece of work than it sounds.
2. **Legacy withdrawals continue to be made from the legacy system** while the
   new one is built. Nothing in the new system may assume it is the only writer
   of an organiser's money until cutover completes.

A cutover plan is out of scope here and should be its own milestone document, not
a section in this one.

## 20. Decision register

Classified per §15 of the brief. Items carried from
[financial decisions](financial-decisions.md) keep their O-numbers.

**ENGINEERING — decide in-house, no external input**

| # | Decision | Recommendation |
|---|---|---|
| E1 | Provider-event processing state shape (A1) | append-only sibling table (§10) |
| E2 | T+1 configurability (A2) | versioned settlement schedule table |
| E3 | Withdrawal state naming: `executing` vs `processing` | adopt `processing` |
| E4 | A sixth invariant for the `PUBLIC` EXECUTE default | add it |
| E5 | Account codes for the withdrawal/transfer fee and the refund charge | add with the next ledger migration |
| E6 | Whether the release scheduler is pg_cron, the worker, or external | the `apps/worker` process exists for exactly this |

**FOUNDER / BUSINESS**

| # | Decision | Blocks |
|---|---|---|
| O-2 | the ₦100–₦500 withdrawal fee brackets | withdrawal fee computation |
| O-3 | what "security checks" and "manual review" mean | approval workflow |
| O-7 | partial/installment rules per collection type | installments |
| O-11 | recurring overpayment roll-forward | recurring |
| O-12 | stored-card recurring charging | automatic charging |
| O-13 | unfinished installment plan money | installments |
| **F1** | **refund charge bearer** (new) | refunds |
| **F2** | **3% of what, exactly** (new, §14) | refunds |
| **F3** | **does a completed withdrawal need a `reversed` state** (A3) | withdrawal machine |
| **F4** | **is a distinct "awaiting approval" state wanted** for the upper approval tiers | withdrawal machine |
| **F5** | **dual-running and cutover plan** (§19) | launch |
| **F6** | **email provider choice** | receipts |

**PAYSTACK**

PA-04 (highest impact), PA-05, PA-06, PA-07, PA-08, PA-09, PA-10, PA-11, PA-12,
PA-13, PA-14, PA-15, plus **KYC/KYB requirements** and **transaction/transfer
limits**, both new in this brief and not yet investigated.

**LEGAL / COMPLIANCE**

O-1 (may Kolekto hold or control the timing of third-party funds; licence),
O-4 (may a platform fee be passed to a contributor), O-5 (who bears a lost
dispute after withdrawal), O-10 (payload retention, data residency), plus
**provider fee disclosure wording** and **withdrawal account ownership** — must
an organiser's payout account be in the community's own name? — both new here.

**ACCOUNTING / TAX**

O-8 (is Kolekto's fee VAT-able and must a receipt show it), plus **the tax
treatment of the refund charge** and **what a community's statement must contain
to satisfy its own auditors**.

## 21. Provider questions

Consolidated in §7 and tracked in
[provider assumptions](provider-assumptions.md). Ask PA-04 first. It is the only
one that can invalidate a product decision rather than an implementation detail,
and §13 should not begin until it is answered in writing.

## 22. Legal and compliance questions

Listed under LEGAL/COMPLIANCE in §20. **O-1 is the one that gates launch**: the
model in D-01 has Kolekto controlling when an organiser's funds settle, and
whether that constitutes holding third-party funds — and whether it needs a
licence — is not an engineering question and is not answered anywhere in this
repository. It does not block building, because the answer does not change the
ledger's shape. It blocks taking real money.

## 23. Exact implementation sequence

Each milestone ends in a reviewable state. No milestone depends on a decision
that is still open at its start.

| # | Milestone | Contents | Gate | Class |
|---|---|---|---|---|
| **M8.2** | **Provider seam and fixtures** | `PaymentProvider` contract; a `FakePaymentProvider`; recorded Paystack fixture payloads hand-written from documented shapes (not captured from live); fixture-driven tests | none | **SAFE NOW** |
| M8.3 | Payment records | `contribution_intents`, `payment_attempts`, `provider_transactions`, `contributions`, `contribution_lines`, `tickets`; state-transition triggers; the amount lock; **E1 resolved** | E1 | SAFE NOW after E1 |
| M8.4 | Capture and fees post to the ledger | account provisioning; capture journal; fee journal; `needs_review`; driven entirely by the fake provider | M8.2, M8.3 | SAFE NOW |
| M8.5 | T+1 release | E2 configurability; `balance_releases`; the posting function; the scheduler in the worker | E2 | SAFE NOW |
| M8.6 | Reconciliation boundary ③ | contributions ↔ ledger, verdicts, evidence, no write path | M8.4 | SAFE NOW |
| M8.7 | Concurrency and load proof | parallel duplicate webhooks, concurrent payments, concurrent journals | M8.4 | SAFE NOW |
| M8.8 | Monitoring | Sentry, health, the seven financial alarms of §17 | — | SAFE NOW (thresholds need O-9) |
| **—** | **Infrastructure** | staging Supabase + a deployed staging app with a public URL | **external** | **BLOCKED** |
| M8.9 | Paystack sandbox integration | real adapter, webhook receiver, signature check, sandbox verification of PA-04…PA-09 | test account + staging URL | REQUIRES PAYSTACK |
| M8.10 | Withdrawals and payouts | after PA-04 is confirmed; O-2, O-3, F3, F4 | PA-04, O-2, O-3, F3, F4 | BLOCKED |
| M8.11 | Refunds | F1, F2, PA-13 | F1, F2, PA-13 | BLOCKED |
| M8.12 | Full reconciliation | boundaries ①②④⑤⑥ | M8.9, M8.10 | BLOCKED |
| M8.13 | Disputes and holds | O-5 | O-5 | BLOCKED |
| M8.14 | Installments and partial payments | O-7, O-13 | founder | BLOCKED |
| M9 | Cutover | F5, O-1 | founder + counsel | BLOCKED |

**Note the shape:** M8.2 through M8.8 — seven milestones, most of the remaining
engineering — are entirely unblocked. The infrastructure gap sits between M8.8
and M8.9 and should be started **now, in parallel**, because it has the longest
lead time and blocks everything after it.

## 24. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **PA-04 is false**, and subaccounts auto-settle | **high** | verify in sandbox before M8.10. The ledger survives it; the withdrawal product does not |
| R2 | **The live key in legacy history is used by someone** | **high** | rotate (§16). Nothing else reduces it |
| R3 | **No PITR on a production ledger** | **high** | mandatory before real money; an append-only ledger with no recovery point is a single failure away from unreconstructable |
| R4 | Infrastructure lead time stalls the project after M8.8 | medium-high | start staging procurement now, in parallel |
| R5 | Dual-running produces two systems taking money for one organiser | medium-high | F5; design before cutover, not during |
| R6 | Refund economics turn out uneconomic (3% + unknown provider cost) | medium | model it before promising it (F1, F2, PA-13) |
| R7 | Idempotency proven by construction, not observation | medium | M8.7 |
| R8 | The `PUBLIC` EXECUTE default recurs in a Phase 4 migration | medium | E4 |
| R9 | E2E remains unrun on this host, so no end-to-end money path is ever exercised locally | medium | run the money E2E in CI, not on this machine |
| R10 | Provider fee model (1.5%) diverges from actual | low-medium | designed for: both figures kept, difference reconciled |
| R11 | `suspense` grows with nobody watching | medium | O-9 plus §17 alarm |

## 25. Recommended next milestone

**M8.2 — the provider seam, a fake provider, and recorded fixtures. No network
access.**

Why this and not something else:

- It is **completely unblocked**. No founder decision, no Paystack account, no
  staging, no legal answer.
- It is the **dependency for M8.3 through M8.7**. Every one of those needs a way
  to simulate a provider, and building them without one means building them
  twice.
- It **cannot create a false impression that payments work**, because the fake
  provider is obviously a fake and `createSettlementProvider()` keeps throwing.
- It makes the sandbox work in M8.9 **cheap**: by then the only new thing is the
  real HTTP client, with every behaviour already specified by a fixture test.

**In parall, and not by me:** start the staging Supabase project and a staging
deployment, and open the Paystack test-account conversation. Those two have the
longest lead times in this plan and neither depends on any code.

**Before M8.3 I need one answer: E1**, the provider-event processing-state shape
(§10). My recommendation is the append-only sibling table.

## 26. Files inspected

**Not modified, read for this audit.**

Repository state: `git status`, `git branch`, `git log`, migration and test
counts. Configuration: `.env.example`, `packages/config/src/env.ts`,
`supabase/config.toml`, `.github/workflows/ci.yml`, `package.json`,
`supabase/.temp/project-ref` (absent), `supabase/.branches/_current_branch`;
presence checks for `vercel.json`, `Dockerfile`, `fly.toml`, `render.yaml`,
`netlify.toml` (all absent).

Documentation: `docs/phase-4/financial-decisions.md`,
`docs/phase-4/provider-assumptions.md`,
`docs/adr/0015-subaccount-custody-and-collection-level-ownership.md`,
`docs/history/2026-09-24-m8.1-financial-foundation-report.md`,
`docs/history/2026-09-22-phase4-money-architecture.md`,
`docs/history/2026-09-22-phase4-state-machines.md` (in full),
`docs/history/2026-09-22-phase4-reconciliation-design.md` (in full),
`docs/history/2026-09-22-phase4-open-decisions.md`,
`docs/history/2026-09-24-m7.9-qa-closure-and-financial-gate-report.md`,
`docs/adr/README.md`, `docs/adr/0003`, `0006`, `0012`.

Code: `packages/domain/src/{money,fees,settlement,contribution,index}.ts`,
`packages/adapters/src/settlement-provider.ts`, `apps/worker/src/index.ts`,
`scripts/invariants/run-all.mjs`, `scripts/db/reset.mjs`,
`apps/web/app/c/[slug]/collections/FeeConfigurator.tsx`.

Database: live inventory of financial tables, views and `app.*` functions, and
row counts for all ten financial tables, queried directly.

Security: env-file locations and ignore status across the repository; a
full-history scan of this repository for committed credentials; a
presence-and-count scan of five legacy repositories; commit-level identification
in `kolekto-be-old`. **No secret value was read, printed or copied.**

## 27. Files changed

**No code, schema, migration, test or configuration file was changed by this
audit.**

Two documentation amendments, because a living register that contradicts a
decision the founder has since made is worse than no register:

| File | Amendment |
|---|---|
| `docs/phase-4/financial-decisions.md` | D-18 amended: a refund incurs a further 3% charge; the charge is real, the **bearer and the base are OPEN** (F1, F2). Previously the register said no refund charge had been specified. |
| `docs/phase-4/financial-decisions.md` | D-09 annotated: the 05:00 Africa/Lagos boundary stands as a decision, but the brief requires it to be configurable rather than a constant; recorded as E2. |
| `docs/phase-4/phase-4-implementation-plan.md` | this document, new |

## 28. Tests executed

All run after the last change to the repository, on the current commit.

| Gate | Command | Result |
|---|---|---|
| Invariants | `npm run invariants` | **5/5 hold** |
| Typecheck | `npm run typecheck` | **0 errors** |
| Lint | `npm run lint` | **clean** |
| Unit — domain | `npm test` | **154 passed, 0 failed** |
| Unit — web | `npm test` | **83 passed, 0 failed** |
| Unit — validation | `npm test` | **58 passed, 0 failed** |
| Database | `npm run db:test` | **560 passed across 21 files, 0 failed** |

**Not run:** Playwright E2E (host memory, as documented since M7.8); migration
replay from scratch (requires `supabase db reset`, which is gated behind an
explicit confirmation because it destroyed local data on 2026-09-20 — CI does
this replay on every pull request).

## 29. Git status

```
branch:  m8.1-financial-foundation
HEAD:    69fc30c  feat(phase4): the ledger, and the decisions that unblocked it
before:  e3de9f6  feat(collections): the wizard, the fee split, and M7.9's QA closure
         0d1bc2c  docs(phase4): the money architecture, before any of it is built
```

Working tree was **clean** at the start of this audit. The only changes now
present are the three documentation files listed in §27. 77 migrations, 21 pgTAP
files. No destructive database operation was performed; no database was reset; no
migration was applied.

## 30. Confirmation regarding the legacy live Paystack environment

**The legacy live Paystack environment was not touched in any way.**

Specifically, and each of these is a statement about what did not happen:

- No request of any kind was made to any Paystack API, live or test.
- No webhook, callback URL, subaccount, split or settlement configuration was
  viewed through Paystack or changed.
- No key was rotated.
- No transaction, transfer or refund was initiated.
- No Paystack credential value was read, printed, copied into the new system, or
  written to any file. The credential checks performed reported only whether a
  variable was empty, a file path, and a count of pattern matches.
- The legacy production database was not connected to.
- The legacy repositories were read only — no file in any of them was modified,
  created or deleted.
- `PAYSTACK_SECRET_KEY` and `PAYSTACK_WEBHOOK_SECRET` are **empty** in both
  `.env.local` files, verified; and nothing in the new codebase reads either
  variable.

The one legacy-related action this audit recommends — rotating the live secret
key exposed in `kolekto-be-old`'s git history (§16) — is a live-environment
change that was **deliberately not performed** and that needs a scheduled
deploy, because rotating a key the live system is using will interrupt real
payment processing.

---

## Summary classification

### A. SAFE TO BUILD NOW

M8.2 provider seam, fake provider and fixtures · payment/contribution/provider-transaction
schema and state triggers (after E1) · capture and fee posting against the fake
provider · per-collection account provisioning · T+1 configurability (E2) ·
`balance_releases` and its posting function · reconciliation boundary ③ · refund
**charge representation** with no bearer · monitoring and the seven financial
alarms · the concurrency/load harness · a sixth invariant for the `PUBLIC`
EXECUTE default · account codes for the transfer fee and refund charge.

### B. WAIT FOR PAYSTACK

A test account and test keys · webhook registration · the real adapter · PA-04
(gates all withdrawal work) · PA-05, PA-06, PA-07 · PA-08 and PA-09 (gate
payouts) · PA-10 and PA-11 (gate reconciliation ① and ④) · PA-12 · PA-13 (gates
refunds) · PA-14 · PA-15 · KYC/KYB requirements · transaction and transfer limits.

### C. WAIT FOR FOUNDER

E1 provider-event processing shape (**needed before M8.3**) · F1 refund charge
bearer · F2 what the 3% is charged on · F3 whether a completed withdrawal can be
`reversed` · F4 whether "awaiting approval" is a distinct state · F5 dual-running
and cutover · F6 email provider · O-2 withdrawal fee brackets · O-3 security
checks and manual review · O-7 partial-payment rules · O-9 who watches `suspense`
and at what threshold · O-11, O-12, O-13.

### D. WAIT FOR LEGAL / COMPLIANCE

O-1 holding and timing third-party funds, and whether a licence is needed —
**gates launch** · O-4 passing a platform fee to a contributor · O-5 dispute
liability after withdrawal · O-10 payload retention and data residency · provider
fee disclosure wording · withdrawal account ownership · O-8 and the refund
charge's tax treatment (accounting).

### E. DO NOT TOUCH

The legacy live Paystack environment, in any respect · the legacy production
database · legacy keys, webhook secrets, callback URLs, subaccount, split and
settlement configuration · legacy production environment variables · the legacy
repositories' contents · `migration.unattributed_payments` and the ₦19.8m matter
· opening balances in the new ledger — there are none and there must never be ·
the local database via `db reset` without explicit confirmation.

### F. NEXT ENGINEERING MILESTONE

**M8.2 — the provider seam, a fake provider, and recorded fixtures, with no
network access.** Blocked by nothing. In parallel, and not engineering work:
start the staging Supabase project and staging deployment, and open the Paystack
test-account conversation. Answer **E1** before M8.3 begins.

**Awaiting review before any further financial subsystem is implemented.**
