# Phase 4 — test matrix

**Date:** 2026-09-22
**Status:** Architecture gate. **No test here is written yet.**
Companion to [the money architecture](2026-09-22-phase4-money-architecture.md),
[the state machines](2026-09-22-phase4-state-machines.md) and
[reconciliation](2026-09-22-phase4-reconciliation-design.md).

The matrix is written **before** the implementation so that the implementation
is written against it. Where a test can live at more than one level it is
placed at the **lowest** one that can actually prove the claim — a
concurrency guarantee proven in TypeScript is a guarantee about a mock.

Counts are estimates for planning. The column that matters is "what it
proves".

---

## 0. Where each kind of test lives

| Level | Runner | Proves | Existing precedent |
|---|---|---|---|
| Unit | `node --test` in `packages/domain` | arithmetic and pure decisions | `money`, `fees`, `contribution`, `report` — 108 passing |
| Validation | `node --test` in `packages/validation` | the shape of what crosses a boundary | 58 passing |
| Database | pgTAP | constraints, RLS, permissions, state machines, idempotency | 428 passing across 17 files |
| Concurrency | `scripts/verify/*.mjs`, real connections | what happens when two callers race | `reference-concurrency.mjs`, 7 checks at 60 writers |
| Web unit | vitest in `apps/web` | server modules with no database | PDF renderer, export catalogue — 28 passing |
| Integration | pgTAP + a stubbed provider | the whole pipeline without a network | *new for Phase 4* |
| Browser | Playwright | journeys a person takes | 33 passing, 1 worker |
| Invariant | `scripts/invariants` | properties of the source tree | 4 passing |

**pgTAP cannot test concurrency.** It runs one session in one transaction, so
a counter that is safe and one that is not behave identically there. Every
concurrency claim below therefore has a script, following
`reference-concurrency.mjs`.

---

## 1. Unit — `packages/domain`

| # | Test | Proves | ~n |
|---|---|---|---|
| U1 | fee calculation golden vectors, every bearer × every category × boundary amounts | the arithmetic, in integer kobo | 40 |
| U2 | a fee is capped per component, independently | matches the behaviour carried from the old system | 6 |
| U3 | fees are computed on the contribution, never on the payable | a fee on a fee cannot drift the total upward | 4 |
| U4 | rounding is half away from zero, applied **once** per fee | the property the float version broke | 8 |
| U5 | `calculateFees` refuses a negative amount | a contribution is never negative | 2 |
| U6 | a schedule version round-trips onto the breakdown | L2 cannot recur | 2 |
| U7 | amount resolution per collection type (fixed, open, per-member, tiers, items, recurring) | the client is never the source of an amount | 24 (exists) |
| U8 | tier basket: price × quantity, duplicate ids refused, stock and per-order limits | ADR 0010 | 14 (exists) |
| U9 | item basket: same | | 12 (exists) |
| U10 | ticket resolution: one attendee name per unit, counted from the **resolved** basket | a stock-trimmed basket cannot leave a mismatched attendee list | 6 (exists) |
| U11 | partial payment arithmetic: required / paid / refunded / settled / remaining / excess | §13 of the architecture, in one pure function | 18 |
| U12 | derived obligation status from that arithmetic, every boundary | `part_paid` at 1 kobo either side; `over_settled` at +1 | 12 |
| U13 | `allocate()` splits with no kobo created or lost | one contributor paying for several members | 8 (exists) |
| U14 | state-transition tables as data: every allowed pair, every forbidden pair | the TypeScript mirror of the database triggers agrees with them | 60 |
| U15 | reference matching: provider reference ↔ attempt reference, case and whitespace | a reference read off a phone still matches | 8 |

**Estimated new: ~160.** Roughly 60 already exist.

---

## 2. Validation — `packages/validation`

| # | Test | Proves |
|---|---|---|
| V1 | a payment-initiation payload carries **no** amount field | the schema itself refuses a client amount |
| V2 | a withdrawal request rejects a non-integer, a negative and a zero amount | |
| V3 | a refund request rejects an amount above the contribution | |
| V4 | a provider reference matches its format; an unknown provider is refused | |
| V5 | every money field in every schema is an integer-kobo string, never a number | `JSON.stringify` cannot represent a bigint; a number would silently lose precision above 2^53 |

**Estimated new: ~20.**

---

## 3. Database — pgTAP

The largest block, because this is where the guarantees actually live.

### 3a. Uniqueness and idempotency

| # | Test | Proves |
|---|---|---|
| D1 | `unique (payment_attempts.reference)` refuses a second attempt on the same reference | |
| D2 | `unique (provider, provider_event_id)` refuses a duplicate webhook | webhook idempotency is a constraint, not a handler |
| D3 | `unique (provider, provider_transaction_id)` refuses a duplicate mirror | |
| D4 | `unique (payment_reference, line_index)` refuses a duplicate contribution | the index carried from the old system |
| D5 | `unique (ledger_journals.idempotency_key)` refuses a duplicate journal | |
| D6 | `unique (community_id, release_date)` makes the T+1 job safe to re-run | |
| D7 | `unique (withdrawals.reference)` makes a withdrawal retry safe | WDR-05 |
| D8 | `unique (reverses_journal_id)` — a journal is reversed at most once | |
| D9 | claiming contributions twice returns the same rows and reports idempotent | |
| D10 | posting the same journal twice is a no-op, not an error | |

### 3b. Ledger

| # | Test | Proves |
|---|---|---|
| D11 | a journal whose debits ≠ credits is refused at commit | the deferred balancing trigger |
| D12 | a journal with one entry is refused | |
| D13 | `update` on `ledger_entries` is refused for every client role | |
| D14 | `delete` on `ledger_entries` is refused for every client role | |
| D15 | the same, for `ledger_journals` | |
| D16 | a reversing journal has the original's entries with directions swapped | asserted by the posting function |
| D17 | a reversal of a reversal is refused | |
| D18 | a journal with `reverses_journal_id` and no reason is refused | |
| D19 | a balance is reconstructable: post N journals, sum entries, compare | the source-of-truth claim, executed |
| D20 | an entry amount of zero or negative is refused | direction carries the sign, not the amount |

### 3c. Authorization

| # | Test | Proves |
|---|---|---|
| D21 | the role matrix for `withdrawal.request`, `withdrawal.approve`, `refund.initiate`, `payment.resolve`, `balance.view`, `withdrawal_account.change` | as `17_operations_rbac.sql` does for M7.6 |
| D22 | each money function refuses a caller without its permission | the matrix is not the control; the function is |
| D23 | a collector cannot reach any money function | the field-agent role never touches money |
| D24 | a viewer can read balances and move nothing | |
| D25 | `withdrawal_account.change` and `refund.initiate` carry `requires_second_approver` | |
| D26 | another community's owner can read no money row of this one | RLS, as already asserted for references and the roll |
| D27 | `anon` holds nothing on any money table, and no money function | the grant-matrix allowlist gains each table explicitly |
| D28 | `provider_events` is unreadable by `authenticated` — staff realm only | raw payloads carry contributor PII |

### 3d. State machines

| # | Test | Proves |
|---|---|---|
| D29 | every allowed transition in each of the eight machines succeeds | |
| D30 | every forbidden transition is refused with its own error code | 8 machines × ~6 each |
| D31 | `captured → failed` is refused | **the ₦520,200 line, as a test** |
| D32 | `captured → expired` is refused | |
| D33 | `captured_at` cannot be cleared or changed | write-once per field |
| D34 | `amount_kobo` cannot change after capture | |
| D35 | `completed → needs_review` is allowed | a problem found later must be recordable |
| D36 | a payout in `unknown` cannot be retried without a resolving query | the rule that stops a bank being paid twice |
| D37 | `withdrawal: completed → anything` is refused | |

### 3e. Isolation and tenancy

| # | Test | Proves |
|---|---|---|
| D38 | a contribution's collection, member and community must agree | as `assert_obligation_tenancy` already does |
| D39 | a payment attempt naming another community's collection is refused | |
| D40 | a ledger entry naming another community's account is refused | |
| D41 | a refund naming a contribution from another community is refused | |
| D42 | two collections in one community keep separate contributions and separate balances | as `17_operations_rbac.sql` proves for references |

### 3f. Immutability and history

| # | Test | Proves |
|---|---|---|
| D43 | a contribution cannot be updated or deleted | |
| D44 | a provider transaction cannot be updated; a correction is a new row with `supersedes_id` | |
| D45 | a provider event cannot be updated or deleted | |
| D46 | a collection with contributions cannot be deleted | the existing delete guard, extended |
| D47 | a member with contributions cannot be deleted | |
| D48 | `migration.unattributed_payments` has no `collection_id` column | the ₦19.8m rows can never be attributed by a migration |
| D49 | no money query joins `migration.*` | the preserved history is never financial truth |

**Estimated new: ~190 assertions, across 4–5 new files.**

---

## 4. Concurrency — real connections, following `reference-concurrency.mjs`

Every one of these opens N connections, holds them at a barrier, releases them
together, and asserts the outcome. **None of these can be written as pgTAP.**

| # | Test | Proves | N |
|---|---|---|---|
| C1 | N simultaneous webhooks for one event | exactly one stored; N−1 conflict; no duplicate credit | 30 |
| C2 | N simultaneous verifications of one reference | exactly one set of contributions; the rest report idempotent | 30 |
| C3 | webhook and redirect and sweep, all at once, for one payment | one credit, whichever wins | 3 × 10 |
| C4 | N simultaneous withdrawal requests against one balance | the sum approved never exceeds available | 24 |
| C5 | withdrawal approval racing a balance release | no over-withdrawal; the ledger check holds inside the transaction | 20 |
| C6 | N simultaneous journal postings with the same idempotency key | one journal, N−1 no-ops | 30 |
| C7 | N simultaneous refunds of one contribution | the total refunded never exceeds the contribution | 20 |
| C8 | N simultaneous payout submissions for one withdrawal | one payout; the rest refused | 20 |
| C9 | the T+1 release job run N times at once | one release per community per date | 10 |
| C10 | contributions claimed while the attempt is being read | the `FOR UPDATE` lock serialises; no torn state | 20 |

**Estimated: 10 scripts, ~70 checks.** Each also runs at a higher N in CI.

---

## 5. Integration — the pipeline, with a stubbed provider

A `PaymentProvider` test double implementing the §8 contract. **No network.**

| # | Journey | Proves |
|---|---|---|
| I1 | initiate → verify success → contributions → journals → completed | the happy path end to end |
| I2 | initiate → webhook first → redirect second | the redirect writes nothing |
| I3 | initiate → redirect first → webhook second | the webhook writes nothing |
| I4 | webhook arrives for a payment never initiated here | captured into `suspense`, `needs_review`, money on the books |
| I5 | the same webhook delivered five times | one credit |
| I6 | verify returns an amount different from the attempt's | `captured` then `needs_review`, both figures recorded, **not** a 4xx |
| I7 | verify returns a different currency | same |
| I8 | metadata names a collection that has been deleted | captured, `suspense`, `needs_review` |
| I9 | metadata names a tier from another collection | captured, `needs_review`, no contribution |
| I10 | the provider times out during verify | the attempt stays `initialized`; the sweep resolves it |
| I11 | the ledger write fails mid-pipeline | the transaction rolls back; the attempt stays `captured`; retry completes it |
| I12 | an operator replays a stored event from the inbox | the same pipeline; nothing written twice |
| I13 | a partial payment, then a second, then a final | three contributions, one obligation, derived status walks `part_paid → settled` |
| I14 | an overpayment | recorded in full, `over_settled`, money on the books |
| I15 | a refund of a partial payment | `part_refunded`, journal posted, reference voided |
| I16 | a reversal of a wrongly applied contribution | both rows survive; the balance returns |
| I17 | T+1 release, then a withdrawal, then a successful payout | the full outbound path |
| I18 | a payout failure, then a retry | funds return to available by reversal; the retry succeeds |
| I19 | a payout timing out into `unknown`, then resolved by a query | no double payment |
| I20 | reconciliation over a period with one of each verdict | the six boundaries produce the right verdicts and change no balance |

**Estimated: ~20 journeys.**

---

## 6. Failure and adversarial

| # | Test | Proves |
|---|---|---|
| F1 | a webhook with a bad signature | rejected before parsing; **not** stored as an event |
| F2 | a webhook with a valid signature but a forged amount | the provider's `verify()` is what decides; the body is only a trigger |
| F3 | a replayed webhook from six months ago | idempotent; writes nothing |
| F4 | a client posting an amount at initiation | the schema has no field for it (V1) |
| F5 | a client posting another community's `collection_id` | resolved through RLS; matches nothing |
| F6 | a client posting a `tier_id` from another collection | refused at resolution |
| F7 | a forged contributor reference at checkout | a reference is not an authorisation; it identifies, it does not authorise |
| F8 | a provider reference colliding across two providers | every external key is `(provider, id)` |
| F9 | a duplicate Kolekto reference | `unique (reference)` |
| F10 | provider outage during initiate | the attempt stays `created`; the contributor is told plainly |
| F11 | provider outage during a payout | `unknown`, not `failed`; retry blocked until resolved |
| F12 | a non-owner attempting a withdrawal | refused by `require_permission` |
| F13 | an officer changing the bank account and immediately withdrawing | second approver, plus DEC-07's cooling-off if it sets one |
| F14 | a refund above the contribution | refused by the sum check |
| F15 | an attempt to delete a contribution, a journal, an entry or an event | four separate refusals |
| F16 | an attempt to update a balance directly | there is no balance to update |

**Estimated: ~16.**

---

## 7. Browser

Written last, and deliberately few: a journey test is the most expensive proof
per guarantee, so it is spent on what only a browser can show.

| # | Journey | Why a browser |
|---|---|---|
| B1 | a contributor pays a fixed collection and sees a receipt | the whole path, as a person experiences it |
| B2 | a contributor pays a tiered collection; the amount matches the tier they chose | the tiered-amount incident, as a test |
| B3 | a contributor buys three tickets and names three attendees | the basket and attendee path |
| B4 | an officer sees a contribution on the roll and the obligation moves to `part_paid` | the money boundary finally crossing |
| B5 | an officer exports contributions with references and amounts | the export gains its money columns |
| B6 | an officer requests a withdrawal; a second officer approves it | two roles, one flow |
| B7 | a viewer sees balances and no withdraw button | RBAC as a person meets it |
| B8 | the payment inbox: a `needs_review` payment, investigated and resolved | the operator path |

**Estimated: 8.** At one worker (the setting M7.6 established) that is
roughly 15 minutes of suite time.

---

## 8. Invariants — source-tree properties

Three additions to the four that exist.

| # | Invariant | Why |
|---|---|---|
| N5 | **`calculateFees` has exactly one call site** | the direct fix for L3, two "net" formulas |
| N6 | **no `balance` column exists in any migration** | a balance is a sum; a column invites an increment |
| N7 | **no money query references `migration.*`** | preserved history is never financial truth |

Existing and unchanged: money is bigint kobo; RLS on every table; no money
writes outside the database; one Paystack caller.

---

## 9. What must pass before implementation is called done

```
Unit            ~220   (≈60 exist)
Validation       ~78   (58 exist)
Database        ~620   (428 exist)
Concurrency      ~77   (7 exist)
Web unit         ~28   (28 exist)
Integration      ~20   (new)
Failure          ~16   (new)
Browser           41   (33 exist)
Invariants         7   (4 exist)
```

And, unchanged from M7.6's standard: typecheck, lint and a production build
pass; the browser suite runs at one worker; persistence is verified across a
stack restart; `db reset` is never run.

---

## 10. Order of work

Each step is shippable and each is provable before the next begins.

| Step | Build | Cannot start before |
|---|---|---|
| 1 | `fee_schedules`, and wiring `calculateFees` to its one call site | DEC-11 for real rates; the table can exist with the provisional schedule |
| 2 | `ledger_accounts`, `ledger_journals`, `ledger_entries`, the balancing trigger, the append-only guards | **DEC-01 and DEC-03** — the chart depends on them |
| 3 | `provider_events`, the webhook receiver, the signature check | DEC-02 |
| 4 | `payment_attempts`, `contribution_intents`, the state machine trigger | step 1 |
| 5 | `provider_transactions`, `verify()`, the capture write | steps 2–4 |
| 6 | `contributions`, `contribution_lines`, `tickets`, the claiming function | step 5 |
| 7 | `balance_releases` and the T+1 job | steps 2 and 6, DEC-25 |
| 8 | `withdrawals`, `payouts`, `withdrawal_accounts` | step 7, DEC-06, DEC-07 |
| 9 | `refunds` | step 6, DEC-08 |
| 10 | reconciliation, all six boundaries | steps 3–9 |

**Step 2 is the gate.** Everything financial posts to the ledger, and the
ledger's shape is the one thing that changes with DEC-01/DEC-03. Building
steps 4–6 first and the ledger afterwards would mean writing the capture path
twice — which is exactly what ADR 0006 refused to do, and refuses still.
