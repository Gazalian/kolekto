# Phase 4 — financial decisions

**Status:** Living document. This is the authority on *what Kolekto has decided
about money.* Where it disagrees with an earlier dated document, this one wins
and §14 says exactly what it superseded.
**Opened:** 2026-09-24 (M8.1)
**Companions:** [provider assumptions](provider-assumptions.md) ·
[ADR 0015 — settlement model and collection-level ownership](../adr/0015-subaccount-custody-and-collection-level-ownership.md)
**Prior art, still worth reading:**
[money architecture](../history/2026-09-22-phase4-money-architecture.md) ·
[state machines](../history/2026-09-22-phase4-state-machines.md) ·
[reconciliation](../history/2026-09-22-phase4-reconciliation-design.md) ·
[open decisions](../history/2026-09-22-phase4-open-decisions.md) ·
[M7.9 financial gate](../history/2026-09-24-m7.9-qa-closure-and-financial-gate-report.md)

---

## How to read this

Four labels, and the difference between them is the point of the document.

| Label | Means |
|---|---|
| **CLOSED** | Decided. Build to it. Reopening it needs a new entry here, not a conversation. |
| **DEFERRED** | Deliberately not decided, and deliberately not built. The architecture must not make it impossible later. |
| **OPEN** | Needed before the thing it gates goes live. Named so it cannot be mistaken for decided. |
| **ASSUMPTION** | Believed but unverified. Every one has a named verification route. Provider assumptions live in [their own document](provider-assumptions.md). |

An entry never reads "decided by default". The old system's worst financial
properties were all defaults nobody chose.

---

## 1 · Money custody and settlement — **CLOSED**

**D-01. Kolekto uses Paystack subaccounts, with Kolekto controlling when
organiser funds settle.** Closes DEC-01.

```
Kolekto Paystack main account
        │
        ├── Kolekto economics ......... platform fee income, gateway fee expense
        │
        └── Organiser Paystack subaccount
                    │
                    └── that organiser's collection funds
```

The subaccount gives per-organiser attribution and splits the economics at the
provider. Kolekto controls the *timing* of the organiser's settlement, which is
what makes a withdrawal (§3) and a T+1 availability rule (§4) meaningful.

**This is a third model, and it is named because the two the repository already
described are not it.** `packages/adapters/src/settlement-provider.ts` and
[ADR 0006](../adr/0006-ledger-deferred.md) define exactly two:

| Existing name | What it meant |
|---|---|
| `balance_and_withdraw` | Kolekto pools funds in its own Paystack balance and releases them on withdrawal. What Kolekto operates in production today — ₦46m across 292 withdrawals, released by manual bank transfer. |
| `subaccount_auto_settle` | Paystack settles each organiser's share to their own bank on Paystack's schedule. Kolekto never holds the money, `supportsWithdrawal = false`, and there is no withdraw button at all. |

D-01 is neither. It takes the subaccount's attribution and economics from the
second and the controlled release from the first. The new name is
`subaccount_controlled_settlement`.

**What this depends on, and is therefore not yet proven:** that a Paystack
subaccount can be operated on a settlement schedule Kolekto controls rather than
one Paystack runs automatically. That is
[PA-04](provider-assumptions.md#pa-04--subaccount-settlement-timing-is-controllable),
**UNVERIFIED**, and it is the single most consequential unverified belief in
Phase 4. The ledger built in M8.1 is deliberately shaped to survive either
answer — see ADR 0015 §4 for why the chart of accounts does not change if
PA-04 turns out to be false.

**D-01a. What DEC-03 still asks is not answered here.** Whether Kolekto may
lawfully hold or control the timing of third-party funds, and whether doing so
requires a licence, remains **OPEN** (§12, O-1) and is counsel's, not
engineering's. D-01 rules on the *mechanism*. It does not rule on the licence.

## 2 · Financial ownership is the collection — **CLOSED**

**D-02. Every naira is attributable to one collection. There is no community
wallet.** Closes the ambiguity the 2026-09-22 architecture left at community
scope.

```
Community
  ├── Collection A → contributions → ledger entries → available funds → withdrawals
  └── Collection B → contributions → ledger entries → available funds → withdrawals
```

Forbidden, permanently: `communities.balance`, `communities.wallet_balance`, or
any other community-level figure used to authorise money. A community-level
*reporting* projection may exist later; it may never be the record a withdrawal
is checked against.

**Consequences, stated so they are not rediscovered:**

- `ledger_accounts` carries a nullable `collection_id`; uniqueness is
  `(community_id, collection_id, code)` with `nulls not distinct`. Platform
  accounts have both null; community-scope accounts have `collection_id` null;
  collection-scope accounts carry both.
- Every journal that moves organiser money carries a non-null `collection_id`,
  enforced by a database `CHECK` against the journal's `source_type`. This is
  the structural answer to the attribution failure that produced the ₦19.8m
  unattributed set: money cannot be recorded as an organiser's without naming
  whose collection it is.
- A Paystack subaccount is **per organiser, not per collection**. Provider-side
  attribution is therefore coarser than Kolekto's. That is a permanent
  reconciliation boundary (see [reconciliation design](../history/2026-09-22-phase4-reconciliation-design.md)),
  not a defect, and it is why internal attribution cannot be reconstructed from
  Paystack alone and must be recorded at capture time.
- WDR-06 — allocating one withdrawal across several collections — is **dropped**.
  It only existed because withdrawal was community-level.
  `allocateByWeights()` in `money.ts` stays: it is correct, tested, and costs
  nothing unused.

## 3 · Withdrawals — **CLOSED**, with the fee brackets **OPEN**

**D-03. A withdrawal is always from one collection.** Never from a community,
never spanning collections.

**D-04. The first withdrawal from a collection is free. Subsequent ones carry a
fee between ₦100 and ₦500, by amount.** The product intent is to encourage one
withdrawal per collection without making a second one impossible.

**D-04a. The brackets are OPEN (§12, O-2) and are therefore not in code.**
`withdrawal_fee_schedules` is versioned and effective-dated exactly like
`fee_schedules`, and M8.1 creates it **with no bracket rows**. A withdrawal fee
cannot be computed until a schedule version exists, which is the correct
behaviour for a number nobody has chosen. Hardcoding a guess in the range would
be indistinguishable, later, from a decision.

**D-05. Processing target: within 24 hours** of approval. An operational target,
not a ledger property.

**D-06. Approval thresholds.** Closes DEC-06's approval half.

| Withdrawal amount | Requirement |
|---|---|
| ≤ ₦1,000,000 | owner approval |
| > ₦1,000,000 and ≤ ₦5,000,000 | owner approval **and** security checks |
| > ₦5,000,000 | owner approval **and** manual review |

`role_permissions.requires_second_approver` already exists as the mechanism and
is already `true` for `refund.initiate`, `withdrawal_account.change` and
`collection.change_amount`. What "security checks" and "manual review" consist
of operationally is **OPEN** (§12, O-3); the *thresholds* are closed.

**D-07. Daily limits, by community verification.** Closes DEC-06's limit half.

| `communities.verification_status` | Daily withdrawal limit |
|---|---|
| anything other than `verified` | ₦1,000,000 per day |
| `verified` | no platform limit |

`communities.verification_status` already exists (`unverified`, `pending`,
`verified`, `rejected`, `expired`). Only `verified` lifts the limit; `pending`
is not verified.

The architecture distinguishes four things and must keep them distinguishable:
platform risk control, community verification status, approval requirement, and
withdrawal amount. None of them may be bypassed in the financial layer, and
none is checked only in a screen.

**D-08. Changing a withdrawal bank account imposes a 48-hour cooling-off
period.** Closes DEC-07. A destination changed within the last 48 hours cannot
receive a payout. This sits alongside — not instead of — the existing
second-approver requirement on `withdrawal_account.change`.

## 4 · Settlement and availability — **CLOSED**

**D-09. T+1 means the next calendar day. Every day.** Closes DEC-25.

A successfully captured payment becomes available at **05:00 Africa/Lagos on
the following calendar day.** Not business days, not weekdays, not "24 hours
later", not "the next settlement run".

| Captured | Available |
|---|---|
| Monday 14:00 | Tuesday 05:00 |
| Friday 23:00 | Saturday 05:00 |
| Saturday 10:00 | Sunday 05:00 |
| Sunday 23:59 | Monday 05:00 |
| Monday 00:00 exactly | Tuesday 05:00 |
| Monday 05:00 exactly | Tuesday 05:00 |

**D-09a. The calculation is deterministic and lives in the domain.**
`availableAt(capturedAt)` in `packages/domain/src/settlement.ts`. Pure, total,
no hidden clock — `packages/domain` forbids `Date.now()` and requires the caller
to pass `now`, which is why this belongs there and not in SQL.

**D-09b. Timezone is explicit: `Africa/Lagos`, UTC+01:00, no DST.** Timestamps
are stored UTC and the boundary is computed against Lagos local time. Lagos has
never observed daylight saving, so the offset is a constant — but it is written
down as an assumption (§13, A-1) rather than assumed silently, because "the
offset never changes" is precisely the kind of belief that goes wrong quietly.

**D-09c. Availability is a recorded event, not a clock comparison.** This
survives from the 2026-09-22 architecture unchanged and matters more than the
hour: money is available because a `balance_release` journal was posted, never
because `now() > available_at`. `available_at` says *when a release becomes due*;
the journal says *that it happened*. The old system compared `created_at`
against a cutoff function and could not then answer whether a balance was
available or merely overdue for release.

**D-09d. M8.1 builds the calculation and its tests. It does not build the
worker.** No job, no scheduler, no release journal posting.

**D-09e (added 2026-09-24). The boundary stands as a decision, but it must stop
being a constant.** `SETTLEMENT_HOUR = 5` and `SETTLEMENT_TIMEZONE` are
hardcoded in `packages/domain/src/settlement.ts`. The hour is not a guess — it
is this decision — but a hardcoded financial boundary cannot be varied per
environment, cannot be changed without a deploy, and leaves no record of what it
was when a historical payment was released. It should move into a versioned,
effective-dated settlement schedule, the same pattern `fee_schedules` uses, so a
release journal can record which boundary applied to it. Tracked as **E2**; an
engineering change with no behaviour change.

## 5 · Fees — **CLOSED**

**D-10. The rates.** Closes DEC-11 for the platform rate.

| Component | Rate | Cap per component |
|---|---|---|
| Kolekto platform fee | **1.5%** (150 bps), all categories | **₦5,000** |
| Provider fee, modeled | **1.5%** (150 bps) | **₦2,000** |
| VAT | **0%** | — |

The caps are asymmetric by decision, not by oversight: Kolekto's own fee caps
at ₦5,000, the modeled provider fee at ₦2,000. This required splitting the fee
schedule's single `maxFeePerComponent` into `maxPlatformFee` and
`maxGatewayFee`. The pre-existing `SCHEDULE_2026_09_PROVISIONAL` sets both to
₦2,000, so its behaviour and its golden vectors are unchanged.

**D-11. The modeled provider fee is an estimate. Paystack's reported fee is the
truth.** Both are kept; neither overwrites the other.

| Field | Meaning | Written when |
|---|---|---|
| `estimated_provider_fee_kobo` | Kolekto's model, at 1.5% | payment attempt creation |
| `actual_provider_fee_kobo` | what Paystack reports | provider verification |
| `platform_fee_kobo` | Kolekto's own fee | payment attempt creation |

The difference between estimated and actual is a **reconciliation input, not an
error**. The founder's current understanding is that Paystack charges about 1%;
the model stays at 1.5% until actual data says otherwise, and the model is never
the authority once actual data exists. A community's net is provisional until
the provider reports.

**D-12. One fee implementation.** `calculateFees()` in
`packages/domain/src/fees.ts` is the only place a fee is computed. No
`amount * 0.015` anywhere, no second "net" formula, no rate literal outside a
schedule. Enforced by a source-tree invariant (`npm run invariants`), because
the largest single drift bucket in the old system was two implementations of
"net" that disagreed by exactly the fees.

**D-13. Fee schedules are versioned and effective-dated. A change is a new
version, never an edit.** Every money row stores the `fee_schedule_version` it
used, so changing a rate cannot restate history. The old system recomputed
balances nightly against *current* constants, which silently restated every
historical balance whenever a rate moved.

**D-14. VAT is 0%, and is represented explicitly.** A `vatRate` on the schedule
and a `vat` amount on every breakdown, both zero. An absent field would be
indistinguishable from an unconsidered one, and re-introducing VAT later would
then be a schema change instead of a schedule version.

## 6 · Who bears the fee — **CLOSED**

**D-15. A collection chooses its fee bearer, and the choice is financially
authoritative.** Closes the engineering half of DEC-12.

| Founder's term | Enum value, in code since the first migration | Contributor pays | Collection is credited |
|---|---|---|---|
| `CONTRIBUTOR_PAYS` | `contributor_pays` | ₦10,150 | ₦10,000 |
| `ORGANIZER_ABSORBS` | `community_absorbs` | ₦10,000 | ₦9,700 |

*(Illustrative, at 1.5% + 1.5% under D-10.)*

The enum values are **not being renamed.** `public.fee_mode` is referenced by
migrations, write functions, pgTAP tests and UI; renaming it would be a large
diff that changes no behaviour. `community_absorbs` and `ORGANIZER_ABSORBS`
denote the same thing.

**D-16. The bearer is frozen onto the payment attempt, not read live.** The fee
breakdown and the schedule version are stored at attempt creation and every
later reader — webhook, ledger, receipt, reconciliation — reads the *stored*
breakdown. Nothing recalculates. A fee preview shown in a screen is a preview;
the attempt's stored breakdown is the fee.

**D-17. Contributor fee passing is permitted as a product decision.** DEC-12's
legal half — whether a platform fee may lawfully be passed to a contributor —
remains **OPEN** (§12, O-4) with counsel. Both bearer models are implemented, and
the default stays `community_absorbs`, the conservative answer, until counsel
rules. Engineering is not blocked by this and does not wait for it.

## 7 · Refunds — **DEFERRED**

**D-18. REFUNDS = DEFERRED.** No refund system in M8.1. Closes nothing about
DEC-08; records that it is deliberately not being answered.

Explicitly **not** invented here: the refund fee bearer, the approval policy,
the refund-after-withdrawal rule, the accounting treatment, any UI, any
workflow.

**D-18a (added 2026-09-24). A refund incurs a further 3% charge. Who bears it,
and what it is charged on, are OPEN.**

The founder has stated the charge. Two things about it are not stated, and
neither may be guessed:

- **The bearer** — contributor, organiser, Kolekto, or split. Tracked as
  **F1**. The architecture must make this configuration resolved at refund time
  and then frozen onto the refund, the same way `fee_mode` is frozen onto a
  payment (D-16).
- **The base** — 3% of the original contribution, of the amount actually being
  refunded, or of the original total including fees. Tracked as **F2**. For a
  ₦10,000 contribution refunded ₦4,000 the three readings give ₦300, ₦120 and
  ₦309, so this is not a rounding detail.

**The refund charge is its own fee component**, never folded into the platform
fee, the provider fee or the withdrawal fee. It needs its own account code and
its own line in the fee model, and it is versioned with a refund fee schedule so
a refund is explicable by the schedule in force when it happened.

Note that this charge sits on top of [PA-13](provider-assumptions.md), which is
**UNKNOWN**: Paystack's own refund fee treatment is not established. A 3%
Kolekto charge stacked on an unknown provider cost is not yet a model anybody can
reason about, so refunds are blocked on both F1/F2 and PA-13.

**What the architecture must nevertheless preserve:** a refund must be addable
later without corrupting the ledger. That means (a) nothing is ever deleted, so
a refund is a new journal rather than an un-recording; (b) journals carry
`reverses_journal_id` so corrections are already expressible; (c) a contribution
is immutable, so refunding one cannot mutate it. All three land in M8.1 for
their own reasons, which is why refunds stay addable.

Until refunds exist, an overpayment is a **recorded and visible** state rather
than an invisible one. The old system had no refund path at all, so an
overpayment had no remedy and left no trace of needing one.

## 8 · Partial and flexible payments — **DEFERRED**

**D-19. PARTIAL PAYMENTS = DEFERRED.** Not implemented, not faked.

No `amount_paid` column is added anywhere. `obligations` never gains one — that
is [ADR 0006](../adr/0006-ledger-deferred.md)'s rule and M8.1 keeps it. When
partial payments arrive, `required` / `paid` / `outstanding` are **derived** from
contributions in a view, never stored and edited, because a stored total and a
computed one that disagree is the defect class this whole phase exists to remove.

The 2026-09-22 architecture §13 designs this in full. The design stands; the
implementation waits.

## 9 · Disputes and chargebacks — initial operational policy, **CLOSED as
provisional**

**D-20.** An initial policy, so engineering can proceed. Subject to future
legal and accounting review, and labelled as such wherever it is implemented.

1. A dispute is associated with the affected payment and its collection.
2. The affected amount may be placed on hold.
3. Unrelated funds in the same collection remain available.
4. A successful chargeback is economically attributed to the affected
   collection and organiser.
5. If the organiser has already withdrawn, the collection may carry an
   outstanding negative obligation.
6. Future incoming funds satisfy that obligation before becoming available for
   further withdrawal.
7. Confirmed Kolekto system errors are handled separately by operations.

**D-20a. M8.1 does not build the dispute system.** It only refrains from making
D-20 impossible. Concretely, three properties in M8.1 are what keep it
buildable: a collection's available balance is a **sum over entries** rather
than a non-negative column, so a negative position is representable; accounts
exist at collection scope, so a hold can be collection-specific without
freezing the community; and corrections are reversing journals, so a chargeback
is a posting rather than an edit.

Who bears the loss when a dispute is lost after withdrawal is **OPEN** (§12,
O-5) and is counsel's.

## 10 · Legacy boundary — **CLOSED**

**D-21. The old Kolekto is reference only.** Read it to understand historical
behaviour. Do not carry its architecture, its code, or its configuration.

**D-22. No legacy Paystack anything.** No credentials, no webhook secret, no
subaccount configuration, no live environment variables, and no pointing the
new system at the old Paystack environment. The new system receives its own
separately provisioned Paystack configuration when integration begins, which is
not M8.1.

Verified at the time of writing: **nothing in this repository reads
`PAYSTACK_SECRET_KEY` or `PAYSTACK_WEBHOOK_SECRET`.** `.env.example` documents
them as `NOT USED YET`; `.env.local` is git-ignored; a source-tree invariant
already forbids any Paystack call site outside `packages/adapters`.

**D-23. Imported legacy history never becomes new financial truth.** Unchanged
from what is already built, restated so Phase 4 cannot quietly reverse it:
imported rows are read-only, retain provenance and original identifiers, and
**never become opening balances**. The new ledger starts empty. Every entry in
it describes something that happened after it was built. An imported balance is
an assertion nobody can trace.

**D-24. The ₦19.8m matter stays closed.** Approximately ₦19.8m of successful
legacy deposits without collection attribution were investigated before this
milestone and are **not reopened here.** Their rows are preserved in
`migration.unattributed_payments`, which has **no `collection_id` column at
all** — the absence is what makes a well-meaning future backfill impossible.

The goal now is forward-looking: D-02's mandatory collection attribution is the
structural reason the new architecture cannot produce a second set.

## 11 · Financial invariants — **CLOSED**

Enforced at the database wherever a database can enforce it.

| # | Invariant | How M8.1 enforces it |
|---|---|---|
| 1 | Every monetary amount is integer kobo | `app.kobo` domain; source-tree invariant; `03_money_invariants.sql` |
| 2 | Every journal balances: `Σ debits = Σ credits` | deferred constraint trigger, checked at commit |
| 3 | Ledger entries cannot be edited | `revoke update` + blocking trigger |
| 4 | Ledger entries cannot be deleted | `revoke delete, truncate` + blocking trigger |
| 5 | Corrections are reversing journals | `reverses_journal_id`; no other mechanism exists |
| 6 | A duplicate financial event cannot create a duplicate effect | unique indexes, not read-then-write (§below) |
| 7 | Financial truth never depends on a mutable balance column | balances are views over entries; no balance column exists |
| 8 | Every collection-attributable movement names its collection | `CHECK` on the journal |
| 9 | Imported history cannot become new financial truth | D-23; provenance `CHECK`s already in place |
| 10 | RLS and authorization are enforced server-side | RLS enabled *and* forced; every write an `app.*` `SECURITY DEFINER` function calling `require_permission` |

**D-25. An idempotency key is a unique index, never a lookup-then-insert.**
Every "check if it exists, then insert" in the old code was a race. The insert
is attempted and the conflict *is* the answer. Identity dimensions: provider
event id, provider transaction reference, internal operation id, transfer
reference, payment attempt id. Enforced at the database, never by a disabled
button.

**D-26. Provider delivery is at-least-once.** Paystack retries every 3 minutes
for the first 4 attempts, then hourly, for up to 72 hours, whenever it does not
receive an HTTP 200. The same event arriving twice, or five times, or after a
timeout, must produce one financial effect.

**D-27. A timeout is not a failure.** For any provider operation that moves
money outward, `TIMEOUT ≠ FAILED`. The state is `unknown`, it blocks retry, and
it is resolved by querying the provider — never by retrying blindly. Kolekto
generates its own transfer reference precisely so that query is possible.

## 12 · OPEN items

Each blocks something. None blocks M8.1.

| # | Question | Whose | Blocks |
|---|---|---|---|
| O-1 | May Kolekto hold or control the timing of third-party funds? Licence required? (was DEC-03) | counsel | going live with real money |
| O-2 | The ₦100–₦500 withdrawal fee brackets | founder | computing any withdrawal fee |
| O-3 | What "security checks" and "manual review" mean operationally (D-06) | founder + ops | withdrawal approval implementation |
| O-4 | May a platform fee lawfully be passed to a contributor? (was DEC-12) | counsel | enabling `contributor_pays` by default |
| O-5 | Who bears a lost dispute after the organiser has withdrawn? (was DEC-09) | counsel | dispute implementation |
| O-6 | Refund policy in full (was DEC-08) | founder + counsel | refunds |
| O-7 | Partial payment rules per collection type | founder | partial payments |
| O-8 | Is Kolekto's fee VAT-able, and must a receipt show it? | accountant | any VAT change from 0 |
| O-9 | Who watches an unattributable-funds balance, and how fast must it clear? (was DEC-P6) | ops | operations runbook |
| O-10 | Raw provider payload retention and data residency (was DEC-13) | counsel | storing payloads long-term |
| O-11 | Does an overpayment of one recurring cycle roll forward? (was DEC-P3) | founder | recurring overpayment handling |
| O-12 | Stored-card recurring charging (was DEC-P5) | founder + counsel | automatic charging |
| O-13 | Unfinished installment plan money (was DEC-23) | founder | installment plans |

## 13 · ASSUMPTIONs made by Kolekto

Provider assumptions are in [their own document](provider-assumptions.md). These
are ours.

| # | Assumption | Why it is safe to hold | How it gets verified |
|---|---|---|---|
| A-1 | `Africa/Lagos` is UTC+01:00 with no DST, permanently | Nigeria has never observed DST | Settlement tests compute against the IANA zone rather than a hardcoded `+01:00`, so a future change surfaces as a test failure rather than a wrong availability date |
| A-2 | 1.5% is a reasonable *model* of Paystack's fee even though the founder's understanding is ~1% | It is only ever an estimate; actual reported fees supersede it per D-11 | First real transaction data |
| A-3 | A flat 1.5% platform rate across all categories is intended | The founder's decision states one rate and no category variation | Founder review of this document |

## 14 · What this document supersedes

Stated precisely, because a reader of the 2026-09-22 documents needs to know
which parts to stop trusting.

| Superseded | By | Nature of the change |
|---|---|---|
| DEC-01 framed as a binary choice between two settlement models | **D-01** | A third model is named. `SettlementModel` gains `subaccount_controlled_settlement`. |
| Chart of accounts at community scope; `ledger_accounts unique (community_id, code)`; `v_community_balance`; "the community's balance row locked" | **D-02**, ADR 0015 | Accounts, balances and locking move to collection scope. |
| WDR-06, allocating one withdrawal across the collections it covers | **D-03** | Dropped. A withdrawal is from one collection. |
| "The T+1 job runs at 00:05 WAT and releases everything captured before 00:00 WAT" (architecture §16) | **D-09** | The boundary is 05:00 Africa/Lagos on the following calendar day. Calendar days, not business days — DEC-25 closed. |
| Platform rate 0.5% default / 1% fundraiser; single ₦2,000 cap per component (`SCHEDULE_2026_09_PROVISIONAL`) | **D-10** | A new schedule version: 1.5% flat, platform cap ₦5,000, gateway cap ₦2,000. The provisional schedule is **not edited** and keeps its golden vectors. |
| Fee schedule has no VAT concept | **D-14** | VAT is explicit and zero. |
| [ADR 0006](../adr/0006-ledger-deferred.md): "do not build the ledger until DEC-01 and DEC-03 are closed" | **D-01**, ADR 0015 | Superseded in part. DEC-01 is closed by D-01, which determines the chart of accounts, so the ledger is buildable. DEC-03 survives as **O-1** and still gates *going live*, not building. |

**Not superseded, and still authoritative:** everything in the 2026-09-22
architecture's §2 (what the old system got right), §3 (what it got wrong and
why), §9 (the ten idempotency operations), §13 (partial payment derivation),
§18 (webhook ordering), §19 (the threat table), §20 (historical data). The
state machines and reconciliation designs stand in full.

## 15 · Not built in M8.1

Recorded so "was this forgotten?" has an answer.

Live Paystack checkout · the webhook endpoint · signature verification code ·
Paystack transfers · payout execution · withdrawal UI · automated withdrawals ·
the refund system · partial payments · dispute processing · the settlement
worker · any Paystack credential · any generic community wallet · any mutable
balance as a source of truth.

M8.1 builds the documentation, the fee schedule foundation, the fee calculation
contract, the ledger, its balancing and append-only protections, the financial
idempotency foundation, collection-level attribution, the settlement timestamp
contract, and the tests for all of it.
