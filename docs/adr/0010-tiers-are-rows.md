# 0010 — Tiers are rows with identity; an amount is never an identifier

**Status:** Accepted · 2026-09-17

## Context

On 2026-08-06 a tiered collection charged every contributor the same amount
regardless of which tier they selected. The post-mortem
(`docs/history/incident_2026-08-06_tiered-payment-amount-regression.md`) names
the mechanism precisely. Tiers lived in a `price_tiers` JSONB column, and the
code that resolved one looked like this:

```ts
return (
  tiers.find((tier) => {
    if (requestedTierId && tier.tierId === requestedTierId) return true;
    if (requestedTierName && tier.tierName === requestedTierName) return true;
    return false;
  }) || null
);
```

A single `.find()` matching on ID **or** name. When two tiers shared a display
name — the commit message cites a real example, "UI/UX — first payment" versus
"UI/UX — full payment" — the first tier in array order won regardless of which
ID was actually selected, so every selection collapsed to one tier's price.

Two things kept it alive. Nothing in the database prevented duplicate tier
names, because a JSONB array has no constraints. And when metadata was missing,
the verification path fell back to inferring the tier from the amount charged —
which is why an `overrideSelectedTierId` admin parameter exists, with a comment
explaining it is for the case where "two or more tiers happen to cost the same
`totalPayable`".

As of 2026-09-17, **five collections in production still have duplicate tier
names.** A view, `v_collections_with_duplicate_tier_names`, monitors the
condition. Nothing prevents it.

## Decision

Tiers are rows in `collection_tiers` with a real primary key.

- `UNIQUE (collection_id, name)` — duplicate display names cannot exist.
- `payment_attempts.tier_id` is a foreign key, `NOT NULL` for tiered
  collections. What the contributor bought is recorded at the moment they
  choose it, before any money moves.
- **An amount is never used to infer which tier was purchased.** Not in
  verification, not in recovery, not in reconciliation, not by an admin tool.
  If the tier is unknown, the payment is an operations exception with an
  explicit resolution, not a guess.
- Price, tier and quantity are fixed on the attempt when it is created, and an
  installment plan keeps them for its lifetime even if the host later edits the
  collection (INS-09).

## Consequences

- Removing a tier from a live collection becomes hiding it (`hidden = true`),
  because sold tiers must remain in the record (PRD section 4.7).
- Quantity limits become enforceable with a real row lock rather than a JSONB
  rewrite, which is what makes tier stock and seat reservation safe under
  concurrency.
- Migrating the old data requires normalising `price_tiers` into rows, and the
  five collections with duplicate names need a human to decide what each tier
  was actually called before they can be imported.

## The general rule behind this ADR

**An identifier identifies; a price describes.** Wherever the old system used a
value to work out which thing a payment referred to, the new one carries the
thing's identity explicitly from the first moment it is known. That applies to
tiers, to obligations, to installment plans and to collections.
