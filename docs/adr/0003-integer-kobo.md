# 0003 — All money is `bigint` kobo, end to end

**Status:** Accepted · 2026-09-17

## Context

The previous system stored money as `numeric(12,2)` and `numeric(14,2)` — exact
decimal, and safe at rest. The arithmetic was not. Every value in
`kolekto-shared-financial` passed through:

```ts
export function roundCurrency(value: unknown): number {
  return Number((Number(value) || 0).toFixed(2));
}
```

Money was a JavaScript IEEE-754 double throughout. Two consequences followed.

`toFixed` does not implement half-up rounding on binary floats — `(1.005).toFixed(2)`
is `"1.00"` — so fee calculations at kobo boundaries rounded the wrong way,
non-deterministically with respect to the decimal value a human would reason
about. And `computeWalletBalances` summed a collection's entire contribution
history in floating point, so error accumulated with volume.

Measured on production, 2026-09-17: `sum(wallets.net_payment)` was
₦46,060,692.94 against `sum(contributions.amount where paid)` of
₦46,060,689.35 — **₦3.59 apart**, with no explanation available because there
was no ledger. The PRD's tolerance (RCN-01) is zero kobo.

## Decision

Every monetary value is an integer number of kobo.

- **Database:** `bigint`, with `CHECK (amount >= 0)` outside ledger direction
  handling. Never `numeric`, never `float`, never `money`.
- **TypeScript:** a branded `Kobo` type over `bigint`. Not `number` — a
  JavaScript `number` cannot represent every `bigint` exactly, and allowing the
  two to mix is how the previous system's discipline eroded.
- **JSON boundaries:** kobo serialise as strings, never as JSON numbers.
- **Display:** conversion to naira happens in one formatting function, at the
  edge, for humans only.

Rounding, where a rate produces a fraction of a kobo, is **half-up on the
integer**, implemented once in `packages/domain/src/money.ts` and covered by
golden vectors at every boundary.

## Consequences

- `packages/domain` is dependency-free and pure, inheriting the shape of
  `kolekto-shared-financial` — which was the best-engineered artefact in the
  old estate — while replacing its number type.
- The golden-vector suite, Node/Deno/SQL parity harness idea and the CI
  duplication guard are kept. The vectors are rewritten in kobo.
- A CI gate (`scripts/invariants/no-float-money.mjs`) fails the build on
  `toFixed`, `parseFloat`, `Number(`, `numeric(`, `float` or `double precision`
  in a money path.
- Existing production data is `numeric(x,2)`. The migration multiplies by 100
  and asserts the result is integral; any row that is not is a reconciliation
  item, not a rounding decision.
