# Phase 4 — open decisions

**Date:** 2026-09-22
**Status:** Architecture gate.

Four sections, and the split matters more than the contents:

- **A** — engineering decisions already made. Recorded so nobody reopens them,
  and so a reviewer can disagree with a named choice rather than an
  assumption.
- **B** — product and business decisions **the founder must make**. Every one
  of these changes what Kolekto promises somebody. None has been chosen here.
- **C** — provider-specific decisions, answerable by reading Paystack's
  documentation and contract.
- **D** — compliance, legal and accounting decisions, answerable only by
  counsel or an accountant.

**Nothing in B, C or D has been silently decided.** Where the architecture had
to name something to be coherent, it names *both* options and says which
decision governs.

---

## A. Engineering decisions already established

These are made, and made here or in an existing ADR. They need review, not a
ruling.

| # | Decision | Where | Why |
|---|---|---|---|
| A1 | Money is integer kobo, `bigint`, everywhere | [ADR 0003](../adr/0003-integer-kobo.md), `app.kobo` | a ₦3.59 unexplainable gap came from floats |
| A2 | The ledger is double-entry, append-only, and the sole source of truth | architecture §6, §14 | the old `wallets` cache could not explain itself |
| A3 | A balance is a view, never a column | §6 H | `wallet += delta` produced negative balances |
| A4 | Capture is recorded before any validation and cannot be un-recorded | state machines §1 | the ₦520,200 amount-mismatch `4xx` |
| A5 | A failed validation parks money in `needs_review`; it never returns a 4xx | §1 | same |
| A6 | Idempotency is a unique index, never a read-then-write | §9 | every "check then insert" in the old code was a race |
| A7 | A webhook is a trigger to verify, never evidence | §18 | a signed body says what was sent, not what is held |
| A8 | Provider events are stored before the 200 | §18 | the old system stored none, so a failed event was gone |
| A9 | "Transaction" is not a table; it is ours plus theirs | §5 | two near-duplicate tables made "which amount?" unanswerable |
| A10 | Corrections are reversing journals; nothing is edited or deleted | §14, machines §8 | |
| A11 | One fee function, one call site, enforced by an invariant | §7, matrix N5 | two "net" formulas caused the largest drift bucket |
| A12 | Every money row stores its `fee_schedule_version` | §15 | recomputing against current rates restated history |
| A13 | Availability is a `balance_release` journal, never a clock comparison | §16 | settlement staleness, with no reliable executor |
| A14 | Withdrawal and payout are separate entities | §17 | a withdrawal may need several attempts |
| A15 | A payout timeout is `unknown`, not `failed`, and blocks retry | machines §6 | a timeout is not a failure; retrying one can pay a bank twice |
| A16 | Item lines snapshot name and unit price beside the FK | §11 | a 2026 order must not be priced from a 2028 list |
| A17 | A ticket is its own entity, not an obligation | §11 | M7.5 said so in its own limitations |
| A18 | `obligations` never gains `amount_paid`; partial payment is derived | §13, [ADR 0006](../adr/0006-ledger-deferred.md) | |
| A19 | Reconciliation records verdicts and **cannot** correct anything | reconciliation §7 | a reconciler that writes truth is a second writer of truth |
| A20 | No opening balances; imported history never enters the ledger | §20 | an imported balance is an assertion nobody can trace |
| A21 | Every financial write is an `app.*` `SECURITY DEFINER` function that re-checks permission and derives tenancy from the row | §19, [ADR 0008](../adr/0008-authorization-model.md) | |
| A22 | No edge functions; writes live in reviewed migrations | [ADR 0005](../adr/0005-no-edge-functions.md) | a merged fix was still not live three weeks later |
| A23 | Raw provider payloads are staff-readable only and redacted in exports | §8 | they carry contributor PII |
| A24 | Step 2 (the ledger) gates steps 4–6 | matrix §10 | building capture before the ledger means building it twice |

---

## B. Product and business decisions — **the founder must decide**

Each of these changes a promise. The architecture accommodates every option
listed; it chooses none.

### B1 · DEC-01 — the settlement model

**The question:** does Kolekto hold community funds in its own Paystack
balance and release them on withdrawal, or do Paystack subaccounts settle each
community's share directly to its own bank?

**Why it cannot wait:** it decides the chart of accounts, whether a withdraw
button exists at all, and whether the Money screen is a wallet or a read-only
settlement history. Both charts are written down in architecture §6.

**What is already true, and is not a choice about the future:** Kolekto is
**already operating the balance model** — ₦46m across 292 withdrawals, pooled
in its own Paystack balance and released by manual bank transfers authorised
by staff. DEC-01 is a ruling on a live arrangement, not a greenfield choice.

**Blocks:** the whole of step 2, and therefore steps 4–10.

### B2 · DEC-06 — risk limits on withdrawals

Minimum and maximum withdrawal, daily and monthly caps, the threshold above
which a second approver is required, what triggers an automatic hold, and how
long a hold may last before somebody must act.

`requires_second_approver` already exists in the role matrix as a column; the
**numbers** are a business decision.

**Blocks:** step 8.

### B3 · DEC-07 — bank-account change controls

Whether changing a withdrawal destination imposes a cooling-off period before
the next withdrawal, and how long. The architecture supports it either way;
choosing zero is a decision, not a default.

**Blocks:** step 8.

### B4 · DEC-08 — the refund policy

Who may request a refund, within what window, whether fees are returned with
the principal, whether partial refunds are offered to contributors or only to
staff, and what a contributor is told.

Today there is **no refund path at all**, which is why an overpayment has no
remedy. That is the status quo being changed, not preserved.

**Blocks:** step 9.

### B5 · DEC-09 — chargebacks and disputes

What happens to a community's balance when a contributor disputes a payment:
held, deducted, or absorbed by Kolekto; who bears the loss if the dispute is
lost and the community has already withdrawn.

**Blocks:** the `holds` table and part of step 8.

### B6 · DEC-11 — the fee schedule

The real platform rate per category, the cap per component, and whether a
per-community negotiated rate is offered. The rates in
`packages/domain/fees.ts` today are **provisional** — carried from the old
system so the arithmetic could be tested against known behaviour — and are
labelled as such in the file.

**Blocks:** step 1 can proceed with the provisional schedule; going live
cannot.

### B7 · DEC-23 — unfinished installment plans

What happens to money already paid into a plan that is not completed by the
deadline: refunded, retained, or released to the organiser. The rule is stored
**on the plan at creation** (INS-20) so a later change cannot alter terms
somebody already accepted — but what the rule *is* is a product decision.

### B8 · DEC-25 — what "T+1" means

Calendar days or Paystack business days. It decides what a Friday evening
payment does over a weekend, which is a promise to organisers.

**Blocks:** step 7.

### B9 (new) · DEC-P3 — overpayment on a recurring collection

Does an overpayment of October sit as an over-settlement of October, or roll
forward to November? The architecture records it in full either way and does
**not** roll it forward, because rolling money between periods silently is a
decision nobody asked for.

### B10 (new) · DEC-P5 — stored-card recurring charging

Whether Kolekto ever charges a saved card automatically for a recurring
collection. This milestone designs recurring **obligations**, not recurring
**charges**. Automatic charging brings mandates, consent, and a different
regulatory posture.

### B11 (new) · DEC-P6 — operations ownership

Who watches `suspense`, how quickly it must be cleared, who is paged for a
`missing_internal` verdict, and what variance is tolerable at each
reconciliation boundary. The architecture makes all of it visible; it cannot
decide who looks.

---

## C. Provider-specific decisions

Answerable by reading Paystack's documentation, its dashboard and the
contract. They need a person to confirm them **in writing** before the adapter
is built — the old system's checklist P1–P11 exists for this.

| # | Question | Why it matters here |
|---|---|---|
| C1 | Exact webhook signature scheme and header | §18's authenticate step |
| C2 | Is there a stable per-event id, and is it unique for ever? | it is the webhook idempotency key (A6) |
| C3 | Retry schedule and total window | how long `needs_review` must retry, and the bound on the capture exposure |
| C4 | Does verify return the **settled** fee or an estimate? | which number is authoritative (§7) |
| C5 | Are transfers idempotent on our reference? | whether a retried payout can double-pay |
| C6 | What does a transfer return on timeout, and how is it queried? | the `unknown` state (machines §6) |
| C7 | Settlement batch API: does it list the transactions it covers? | boundary ④ of reconciliation |
| C8 | Transaction list API: can it be paged over an arbitrary period? | boundary ① |
| C9 | Refund API: partial refunds, and what the fee treatment is | DEC-08 needs this to be answerable |
| C10 | Subaccount split behaviour and its fee treatment | only if DEC-01 chooses the subaccount model |
| C11 | Currency support and what a non-NGN transaction looks like | the currency-mismatch path |
| C12 | Rate limits on verify and on the transaction list | how aggressively the sweep may run |

---

## D. Compliance, legal and accounting decisions

Not answerable by engineering, and not answered here.

| # | Question | Who |
|---|---|---|
| D1 · DEC-03 | May Kolekto hold third-party funds in its own Paystack balance and release them on request? Does that require a licence? | counsel |
| D2 · DEC-12 | May a platform fee be passed to a contributor? Both bearer models are implemented in `fees.ts`; which is lawful is not an engineering question | counsel |
| D3 · DEC-13 | Data residency, and how long raw provider payloads may be retained | counsel |
| D4 · DEC-04 / DEC-05 | What identity verification is required of a community before it may withdraw, and what may be stored | counsel |
| D5 | Is Kolekto's fee VAT-able, and does a receipt have to show it? | accountant |
| D6 | What does a community's statement need to contain to be accepted by its own auditors? | accountant |
| D7 | Retention: how long must financial records be kept, and may anything ever be purged? | counsel + accountant |
| D8 | Whose money is a `suspense` balance, legally, while it is unattributed? | counsel |
| D9 | If a dispute is lost after a community has withdrawn, who bears it? | counsel; pairs with DEC-09 |

---

## E. The critical path

Stated plainly, because it is the answer to "when can Phase 4 start?".

```
  DEC-01 + DEC-03  ──►  chart of accounts  ──►  ledger  ──►  everything else
   (founder+counsel)
```

**Nothing financial can be built until DEC-01 and DEC-03 close.** Not because
of process, but because the two settlement models are not variations on a
theme: under one Kolekto holds the money and needs twelve accounts, a
withdrawal flow and a licence; under the other it never does, and several of
those accounts, the withdraw button and the licence question all disappear.

What **can** proceed today, with no decision:

| Can be built now | Why it is safe |
|---|---|
| `fee_schedules` with the provisional schedule | the table's shape does not depend on the settlement model |
| wiring `calculateFees` to one call site, plus invariant N5 | pure arithmetic |
| invariants N6 and N7 | source-tree properties |
| the unit tests of matrix §1 | pure functions |
| the `PaymentProvider` contract as types only | a contract, not an implementation |
| extending `contributor_references` and `event_check_ins` with their nullable second parents and `CHECK` | additive, and already designed |

Everything else waits. That is ADR 0006's rule, and this milestone does not
change it — it makes the waiting specific.
