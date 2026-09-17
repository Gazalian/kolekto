# 0006 — The ledger is designed now and built after DEC-01/DEC-03

**Status:** Accepted · 2026-09-17

## Context

The previous system has no ledger. `wallets` holds five mutable numbers per
collection — `gross_payment`, `net_payment`, `ledger_balance`,
`available_balance`, `pending_balance` — and `settlement_recompute_wallets()`
rewrites all 245 rows nightly at 04:00 by recomputing from contribution
history. The identifier `ledger_balance` is a derived cache with no entries
behind it. Nothing records why a balance changed, when, or because of what.

Recomputation also means a balance depends on the *current* fee constants
rather than the schedule in force when the payment was taken. Change a rate and
every historical balance silently restates.

The PRD requires an append-only double-entry ledger (LED-01 to LED-05) with a
twelve-account chart (section 9.7).

## Decision

**Design the ledger now. Do not build it until DEC-01 and DEC-03 are closed.**

The chart of accounts is determined by the settlement model:

- If funds accumulate in Kolekto's Paystack balance and communities withdraw on
  T+1 (the founder's stated choice), the chart needs `paystack_balance`,
  `paystack_receivable`, `community_locked`, `community_pending`,
  `community_available`, `community_on_hold`, `community_withdrawing`,
  `community_withdrawn`, `refund_reserve` and the rest of section 9.7.
- If counsel rejects that model and Kolekto falls back to Paystack subaccounts
  settling directly to each community's bank (FIN-02), then Kolekto never holds
  the money, several of those accounts do not exist, and the Money screen
  becomes a read-only settlement history with no withdraw button.

These are not the same ledger. Building before the decision means building
twice, and a half-built ledger is worse than none because it invites code to
depend on its shape.

## What is built now

- `packages/domain` money primitives and the fee engine, in integer kobo,
  golden-vector tested and **wired to nothing**.
- The `SettlementProvider` interface with both implementations stubbed, so the
  choice is a one-file change (FIN-02).
- Schema for communities, members, officers, collections, tiers and obligations
  — none of which moves money.

## What is not built, and the gate on each

| Not built | Gated on |
|---|---|
| `ledger_accounts`, `ledger_journals`, `ledger_entries` | DEC-01, DEC-03 |
| `payment_attempts`, `transactions`, `contributions` | DEC-01, DEC-02 |
| `installment_plans` and the locked balance | DEC-23 — the unfinished-plan rule is stored on the plan at creation |
| `withdrawals`, `withdrawal_accounts`, `balance_releases` | DEC-01, DEC-06, DEC-07 |
| `refunds`, `disputes` | DEC-08, DEC-09 |
| Paystack adapter implementation | DEC-02 — checklist P1 to P11 answered in writing |
| Notification providers | DEC-17 |

## Consequences

- Phases 1 and 2 of the PRD proceed in full without any of these decisions.
- Phase 3 cannot start in production until they close. This is the PRD's own
  rule (section 24); this ADR makes it structural rather than a note.
- When the ledger is built, it is append-only with no `UPDATE` or `DELETE`
  grant for any application role, enforced both by revoked privileges and by a
  blocking trigger (DAT-02). Corrections are reversing journals.
- `obligations` therefore has no `amount_paid` column in this phase. It is
  derived from contributions when contributions exist, never stored and edited.
