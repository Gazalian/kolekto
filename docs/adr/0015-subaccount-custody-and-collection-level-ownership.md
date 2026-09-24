# 0015 — Subaccount custody with Kolekto-controlled settlement, and financial ownership at the collection

**Status:** Accepted · 2026-09-24
**Supersedes in part:** [0006 — the ledger is designed now and built after DEC-01/DEC-03](0006-ledger-deferred.md)
**Detail:** [Phase 4 financial decisions](../phase-4/financial-decisions.md) ·
[provider assumptions](../phase-4/provider-assumptions.md)

## Context

[ADR 0006](0006-ledger-deferred.md) deferred the ledger on a specific and
correct ground: the chart of accounts is determined by the settlement model, the
two candidate models produce genuinely different charts, and building before the
choice means building twice. It named the two candidates, and
`packages/adapters/src/settlement-provider.ts` encoded them as a two-value type:

- `balance_and_withdraw` — Kolekto pools funds in its own Paystack balance and
  releases them on withdrawal. What Kolekto operates in production today: ₦46m
  across 292 withdrawals, released by manual bank transfer.
- `subaccount_auto_settle` — Paystack settles each organiser's share directly to
  their bank on Paystack's schedule. Kolekto never holds the money,
  `supportsWithdrawal = false`, and there is no withdraw button at all.

The founder has now ruled, and the ruling is neither of them. It takes the
subaccount's attribution and economics from the second and controlled release
from the first. Separately, and independently of the settlement model, it moves
financial ownership from the community to the **collection** — the 2026-09-22
architecture had assumed community scope throughout, down to
`allocateByWeights()` existing in `money.ts` specifically to spread one
withdrawal across the collections it covered.

Two decisions, in one ADR, because the chart of accounts is where both of them
land and separating them would leave a chart that satisfies neither.

## Decision

### 1. The settlement model is `subaccount_controlled_settlement`

```
Kolekto Paystack main account
        │
        ├── Kolekto economics ......... platform fee income, gateway fee expense
        │
        └── Organiser Paystack subaccount
                    │
                    └── that organiser's collection funds
```

Paystack subaccounts attribute funds to an organiser and split the economics at
the provider. Kolekto controls *when* the organiser's share settles, which is
what makes a withdrawal, a withdrawal fee, an approval threshold, a daily limit
and a T+1 availability rule meaningful rather than decorative.

`SettlementModel` gains a third value. The existing two stay: the first
describes what production does today and the second remains the fallback if
counsel or the provider rejects this one.

### 2. Financial ownership is the collection, and never the community

Every naira is attributable to one collection. There is no community wallet,
there will be no `communities.balance`, and no community-level figure may ever
authorise money. A community-level reporting projection may exist later; it may
never be the record a withdrawal is checked against.

### 3. The chart of accounts is therefore collection-scoped

`ledger_accounts` carries a nullable `collection_id` alongside its nullable
`community_id`, with uniqueness on `(community_id, collection_id, code)`,
`nulls not distinct`. Three scopes result:

| Scope | `community_id` | `collection_id` | Example |
|---|---|---|---|
| platform | null | null | `platform_fee_income`, `gateway_fee_expense`, `suspense` |
| community | set | null | accounts about an organiser rather than one collection |
| collection | set | set | `collection_pending`, `collection_available`, … |

Every journal that moves organiser money names its collection, enforced by a
database `CHECK`. This is the structural reason the new architecture cannot
produce a second ₦19.8m unattributed set: money cannot be recorded as an
organiser's without naming whose collection it is.

## Why this does not reintroduce ADR 0006's risk

0006's argument was that building the ledger before the settlement model is
chosen means building it twice. That argument is satisfied, not evaded:

**The model is now chosen.** D-01 closes DEC-01. The chart of accounts follows
from it, so the thing 0006 was waiting for has arrived.

**And the chart survives the one thing still unverified.** Whether Paystack
subaccount settlement timing is genuinely controllable is
[PA-04](../phase-4/provider-assumptions.md#pa-04--subaccount-settlement-timing-is-controllable),
**UNVERIFIED**, and it is the assumption D-01 rests on. If it turns out false,
Kolekto falls back to `subaccount_auto_settle` — and *the ledger does not
change*. A chart that records `pending → available → withdrawing → withdrawn` at
collection scope also records `pending → settled-by-provider`: the second is the
first with two states never reached. What would change is the withdrawal flow,
which this milestone does not build.

So the risk 0006 guarded against — building a chart of accounts twice — is not
present, while the risk it did not anticipate (building the withdrawal flow
against an unverified provider capability) is handled by not building it yet.

**What 0006 still governs, unchanged:** DEC-03 — whether Kolekto may lawfully
hold or control the timing of third-party funds, and whether that needs a
licence — is open, is counsel's, and gates **going live with real money**. It
does not gate building the ledger, because the answer does not change the
ledger's shape. It is tracked as O-1.

## Consequences

- `ledger_accounts`, `ledger_journals` and `ledger_entries` are built now,
  append-only, with `Σ debits = Σ credits` asserted by a deferred constraint
  trigger at commit. Corrections are reversing journals; nothing is ever edited
  or deleted.
- A balance is a **view** over entries, scoped to a collection. There is no
  balance column anywhere, so there is nothing to increment, nothing to refresh,
  and nothing that can silently disagree with the entries behind it.
- Withdrawal eligibility is asserted inside the transaction that posts the
  withdrawal journal, against the ledger, with the **collection's** account rows
  locked — not the community's.
- WDR-06, allocating one withdrawal across several collections, is dropped.
  `allocateByWeights()` stays in `money.ts`: it is correct, tested, and costs
  nothing unused.
- Provider-side attribution is per-organiser and therefore permanently coarser
  than Kolekto's per-collection attribution. That is a standing reconciliation
  boundary, and it makes capture-time collection attribution a hard requirement:
  it can never be reconstructed from Paystack afterwards.
- The `SettlementProvider` seam keeps its purpose. `createSettlementProvider()`
  still throws, and still will until the withdrawal milestone.
