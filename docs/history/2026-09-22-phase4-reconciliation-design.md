# Phase 4 — reconciliation design

**Date:** 2026-09-22
**Status:** Architecture gate. **Nothing here is implemented.**
Companion to [the money architecture](2026-09-22-phase4-money-architecture.md)
and [the state machines](2026-09-22-phase4-state-machines.md).

---

## 1. Why this is a feature and not a script

The old system's reconciliation was a tool somebody ran when something looked
wrong, and it needed credentials the person investigating did not have. Its
own root-cause report opens by saying the author could not run it. When it
was finally run, it found **48 of 57 collections with balance drift** — and
then the work of establishing that no money was actually lost took a code
audit, because the comparison could say *that* two numbers disagreed and not
*why*.

That is the shape this design rejects. Reconciliation here is:

- **continuous**, not summoned
- **stored**, so a verdict has a history and a trend
- **explanatory**, carrying the evidence for its verdict
- **incapable of correcting anything**, so running it is always safe

The last point is the important one. A reconciler that can fix things is a
second writer of financial truth, and two writers is how the old estate ended
up with two definitions of "net" (L3).

---

## 2. The six boundaries

Money crosses six boundaries between Paystack and a community's bank. Each is
reconciled independently, because a break at one should not be reported as a
break at another.

```
     ┌────────────────────────┐
  ①  │ provider ↔ provider_events        did we receive every event?
     ├────────────────────────┤
  ②  │ provider_transactions ↔ payment_attempts    do the two sides agree?
     ├────────────────────────┤
  ③  │ contributions ↔ ledger_entries    is every contribution posted?
     ├────────────────────────┤
  ④  │ provider_settlements ↔ contributions   did the bank get what it should?
     ├────────────────────────┤
  ⑤  │ withdrawals ↔ ledger_entries      is every withdrawal accounted for?
     ├────────────────────────┤
  ⑥  │ payouts ↔ withdrawals             did every approved transfer land?
     └────────────────────────┘
```

| # | Left side | Right side | The question |
|---|---|---|---|
| ① | provider's transaction list for a period | `provider_events` | did we hear about everything? |
| ② | `provider_transactions` | `payment_attempts` | same reference, same amount, same currency, same collection? |
| ③ | `contributions` | `ledger_entries` | does every applied contribution have balancing entries, and no entries a contribution cannot explain? |
| ④ | `provider_settlements` | Σ `provider_transactions` in the batch | did the provider pay what its own transactions add up to, less its own fees? |
| ⑤ | `withdrawals` | `ledger_entries` | does every withdrawal's ledger position match its state? |
| ⑥ | `payouts` | `withdrawals` | did every approved withdrawal end in exactly one successful payout? |

Boundary ① is the one the old system could not do at all, because it stored no
events (L8).

---

## 3. Verdicts

Every comparison produces exactly one verdict per key.

| Verdict | Means | Severity | Who acts |
|---|---|---|---|
| `matched` | both sides agree in every compared field | none | nobody |
| `amount_mismatch` | both sides exist; the amounts differ | **high** | finance |
| `currency_mismatch` | both sides exist; the currencies differ | **high** | finance |
| `missing_internal` | the provider has it; we do not | **critical** | engineering, then finance |
| `missing_provider` | we have it; the provider does not | **critical** | engineering |
| `duplicate` | two internal records claim the same external key | **high** | engineering |
| `unmatched` | neither side can be paired, for a reason not above | medium | finance |
| `needs_review` | the comparison itself could not be made | medium | engineering |
| `resolved` | an operator has explained it, with a reason | none | — |

`missing_internal` is the worst thing this system can say. It means money
exists at the provider and Kolekto has no record — which is precisely the
condition the capture-first design exists to prevent, and finding one means a
guarantee has been broken, not merely a number.

---

## 4. The record

```
reconciliation_runs
  id                uuid pk
  boundary          text          -- one of the six
  period_start      timestamptz
  period_end        timestamptz
  started_at, finished_at
  started_by        uuid null     -- null when scheduled
  totals            jsonb         -- counts per verdict
  unique (boundary, period_start, period_end, started_at)

reconciliation_records
  id                uuid pk
  run_id            uuid fk
  boundary          text
  external_key      text          -- provider reference, settlement id, …
  internal_key      text null     -- our reference, contribution id, …
  community_id      uuid null     -- null when we cannot attribute it yet
  verdict           text
  external_amount_kobo app.kobo null
  internal_amount_kobo app.kobo null
  variance_kobo     app.kobo null -- external − internal, signed
  evidence          jsonb         -- the two rows, field by field
  resolved_at       timestamptz null
  resolved_by       uuid null
  resolution_reason text null
  resolution_journal_id uuid null -- the journal an operator posted, if any
  unique (run_id, boundary, external_key)
```

**`evidence` is the point.** A verdict without the two rows that produced it
sends somebody back to the database to reconstruct the comparison, which is
what made the old drift investigation take a code audit. Here the row carries
both sides as they were at comparison time.

**`resolution_journal_id` is a pointer, never a cause.** An operator explains
a mismatch by *posting a journal* and then linking it. The reconciler does not
post it. Writing the link does not change any balance.

---

## 5. Zero tolerance, and what that means

RCN-01 in the PRD asks for zero tolerance. Taken literally that would flag
every provider fee rounding difference, and an alert that fires daily is an
alert nobody reads.

What zero tolerance means here:

- **Variance thresholds are per boundary and are configuration, not code.**
- **Boundary ③ has a true zero tolerance.** A contribution and its ledger
  entries are both ours; any difference is a bug, not a rounding artefact.
- **Boundaries ② and ④ tolerate the provider's own fee rounding** — a
  documented, bounded number of kobo — and nothing else.
- **A tolerated variance is still recorded**, as `matched` with a non-zero
  `variance_kobo`. It is visible and trendable; it just does not page anybody.

The distinction matters: "we did not notice" and "we noticed and it was within
the agreed band" look identical in a system that only records exceptions.

---

## 6. Schedule

| Boundary | Cadence | Why |
|---|---|---|
| ① provider ↔ events | hourly | a missed event is time-critical; the sooner it is swept, the sooner the money is recorded |
| ② transactions ↔ attempts | continuous, on every capture | it is the same transaction; comparing it later means acting on it later |
| ③ contributions ↔ ledger | daily, plus on demand | both sides are ours; a break is a bug and should be loud |
| ④ settlements ↔ transactions | on each settlement announcement | the provider tells us when |
| ⑤ withdrawals ↔ ledger | daily | slow-moving |
| ⑥ payouts ↔ withdrawals | daily, plus on every payout result | a stuck `unknown` payout must not sit for a day |

All six are **idempotent** on `(run_id, boundary, external_key)`, so a run may
be repeated over the same period without duplicating verdicts.

---

## 7. Investigating without touching truth

The operator's path, and the guarantee at each step:

```
1. open the reconciliation inbox         reads reconciliation_records
2. read the verdict and its evidence     reads the jsonb; no joins needed
3. pull the raw provider payload         reads provider_events  (staff role)
4. re-run verify() against the provider  a READ at the provider
5. decide
     ├── it is explained  ──► write resolution_reason. No journal. Balances unchanged.
     ├── our books are wrong ──► post a correcting journal, then link it
     └── the provider is wrong ──► raise it with the provider; mark disputed
6. the record keeps its history          resolved_at, resolved_by, reason
```

**Nothing in steps 1–4 can change a balance.** Step 5 can, and only by posting
a journal through the normal `app.*` function with the normal permission
(`payment.resolve` or `refund.initiate`), the normal audit row, and the normal
requirement that the journal balances. There is no reconciliation-specific
write path, which means there is no second writer of financial truth.

**Re-running reconciliation never un-resolves anything.** A resolved record
keeps its resolution; a new run produces a new record under a new `run_id`. A
mismatch that persists across runs is therefore *visible as persisting*, which
is the signal that matters.

---

## 8. What the old system's 48-collection drift would look like here

Worth tracing, because it is the concrete test of whether this design is an
improvement.

| Old root cause | Here |
|---|---|
| **R1** two "net" formulas | cannot occur: one fee function, one call site, enforced by an invariant script. If it somehow did, boundary ③ has zero tolerance and would name the contribution. |
| **R2** settlement staleness | cannot occur: availability is a `balance_release` journal, not a comparison against `now()`. No release, no available money, and the absence is on screen. |
| **R3** negative balance from `wallet += delta` | cannot occur: there is no balance column to increment. A balance is a sum over immutable entries and a negative liability balance is caught by boundary ③. |
| **R4** missing or duplicate wallet row | cannot occur: there are no wallet rows. An account is created on first use, `unique (community_id, code)`. |
| **R5** historical grosses at current rates | cannot occur: every journal stores `fee_schedule_version`, and a schedule is replaced, never edited. |

All five of the old drift causes are **structurally absent** rather than
fixed — which is the only version of "fixed" worth reporting.

---

## 9. What reconciliation cannot do

Stated so it is not assumed:

1. **It cannot find money the provider never told us about and never shows in
   its API.** Boundary ① compares against the provider's own list; if the
   provider's list is wrong, so is the comparison.
2. **It cannot attribute a payment whose metadata is gone.** It can say
   `unmatched` and hold the money in `suspense`. Attribution is a human
   judgement, and one the old ₦19.8m matter shows must never be guessed.
3. **It cannot decide policy.** Whether a ₦3 variance is acceptable, how fast
   `suspense` must be cleared, and who is paged for a `missing_internal` are
   operational decisions
   ([open decisions](2026-09-22-phase4-open-decisions.md), DEC-P6).
4. **It cannot run before there is anything to reconcile.** Boundary ③ is
   testable from day one of implementation; ① and ④ need a live provider.
