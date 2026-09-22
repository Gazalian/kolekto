# Phase 4 — money core architecture

**Date:** 2026-09-22
**Status:** Architecture gate. **Nothing in this document is implemented.**
**Base:** `m7.6-collection-operations` at `2464c55`

Companions:
[state machines](2026-09-22-phase4-state-machines.md) ·
[reconciliation](2026-09-22-phase4-reconciliation-design.md) ·
[test matrix](2026-09-22-phase4-test-matrix.md) ·
[open decisions](2026-09-22-phase4-open-decisions.md)

No Paystack, webhook, ledger, wallet, withdrawal, payout or settlement code
was written. No migration was applied. No production system was touched.

---

## 1. What was inspected

**This repository, in full:** all 70 migrations; the `app.kobo` domain; RLS
and the grant allowlist; `collections`, `collection_tiers`,
`collection_items`, `collection_fields`, `collection_recurrences`,
`collection_cycles`, `collection_audience_*`, `obligations`,
`contributor_references`, `collection_code_sequences`, `event_check_ins`,
`audit_logs`, `members`, `communities`, `officer_terms`, `permissions`,
`role_permissions`; the `migration` schema (`import_runs`, `legacy_collection`,
`legacy_profile`, `legacy_deposit`, `legacy_contribution`,
`unattributed_payments`) and `public.legacy_links`; every `app.*` write
function; `packages/domain` (`money.ts`, `fees.ts`, `contribution.ts`,
`csv.ts`, `reference.ts`, `report.ts`); `packages/adapters`
(`settlement-provider.ts`); `packages/db` (`write.ts`, `public-read.ts`);
`packages/validation`; `apps/web`'s server actions; the four invariant
scripts; all 17 pgTAP files; and ADRs 0001–0014, especially
[0003 integer kobo](../adr/0003-integer-kobo.md),
[0006 ledger deferred](../adr/0006-ledger-deferred.md),
[0008 authorization](../adr/0008-authorization-model.md),
[0010 tiers are rows](../adr/0010-tiers-are-rows.md) and
[0012 the money boundary](../adr/0012-collections-stop-at-the-money-boundary.md),
plus [`docs/target-schema.md`](../target-schema.md).

**The legacy estate, read-only:** `kolekto-be-old`
(`controllers/deposit.js`, `controllers/withdrawal.js`, `utils/financial.js`,
`utils/contributionNormalize.js`, `utils/financialReconcile.js`,
`services/paymentService.js`, `services/pricingService.js`,
`services/settlementService.js`, `jobs/paymentSettlement.js`, and the
`database/*.sql` migration set including
`payment_capture_ledger_2026-08-07.sql`, `g2_atomic_withdrawal_request.sql`,
`j2_atomic_withdrawal_approval.sql`,
`j3_settlement_overwithdrawn_monitoring.sql`); `kolekto-fe-old`
(`ContributeFlow.tsx`, `supabase/functions/initiate-paystack-payment`,
`supabase/functions/verify-paystack-payment`); and this repository's own
preserved forensics: `FINAL_PAYMENT_INTEGRITY_REPORT_2026-08-07.md`,
`FINANCIAL_DRIFT_ROOT_CAUSE_REPORT.md`,
`PHASE3_PAYMENT_CAPTURE_LEDGER_2026-08-07.md`,
`PAYMENT_RESILIENCE_AUDIT_2026-08-07.md`,
`PAYMENT_OPERATIONS_RUNBOOK.md`, `KOLEKTO_FINAL_FINANCIAL_FORENSICS.md` and
the two incident reports.

The ₦19.8m unattributed-payment matter was **not** reopened. It appears here
only where §11 states what its preserved rows may never become.

---

## 2. What the old system got right

Worth stating first, because the temptation in a rebuild is to assume
everything before it was wrong. By its last months the old system had reasoned
its way to several properties this architecture keeps:

1. **Capture is recorded before anything can reject it.** The write happened
   at the earliest point Paystack's success was known — before metadata
   parsing, before collection resolution, before every validation. Keep.
2. **Validation failure parks money, it does not discard it.** Seventeen
   rejection paths were changed from `4xx` to `needs_review` + `200`. The
   line that had lost ₦520,200 was an amount-mismatch `4xx`. Keep, and make
   it structural rather than a matter of which status code somebody typed.
3. **Duplicate credit was impossible at the database level**, not at the
   application level. Keep, and widen.
4. **Wallets were recomputed from source, never incremented.** The
   `wallet += delta` code that preceded it is the documented source of
   negative stored balances. Keep the direction; remove the wallet.
5. **Claiming contributions was atomic and idempotent** —
   `claim_payment_contributions` used `FOR UPDATE` plus an existence check and
   returned `'idempotent'` rather than raising. Keep.
6. **The contributor-facing amount was re-derived server-side** from the
   collection, never taken from the client. Keep, and extend it to every
   input.

## 3. What the old system got wrong, and what each mistake forces here

| # | What happened | Evidence | What this architecture does instead |
|---|---|---|---|
| L1 | **No ledger.** `wallets` held five mutable numbers per collection; `ledger_balance` was a cache with no entries behind it. Nothing recorded *why* a balance changed. | ADR 0006; drift report §0 | Double-entry journal. A balance is a `sum()` over entries, never a column. |
| L2 | **Balances recomputed against *current* fee constants.** Changing a rate silently restated every historical balance. | Drift report R5 | Every money row stores `fee_schedule_version`. A schedule is replaced wholesale, never edited. |
| L3 | **Two implementations of "net".** The live Edge writer summed raw amounts; the Node writers deducted fees for organiser-borne. Drift = the fees. | Drift report R1 | One fee function (`packages/domain/fees.ts`), already written and deliberately wired to nothing. An invariant script forbids a second. |
| L4 | **Settlement was time-based with no reliable executor.** Two or three executors, one gated on an env var, one a DB function not in the repository. | Drift report §6 | Settlement is an **event** that writes a row (`balance_releases`), not a comparison against `now()`. If the job has not run, nothing is available — and that is visible rather than inferred. |
| L5 | **Wallet refresh could silently no-op.** Missing wallet row → `console.warn` and early return. No throw, no retry, no alert. | Drift report §5 | No cache to refresh. A projection is a view or a materialised view rebuilt from entries, and its staleness is a property of the view, not of whether a handler remembered. |
| L6 | **Financial writes lived in ungoverned Edge Functions**, deployed manually with no CI, editable in a web console. A fix that was merged to git was still not live three weeks later. | Tiered-amount incident | [ADR 0005](../adr/0005-no-edge-functions.md): no edge functions. [ADR 0011](../adr/0011-application-writes-via-direct-connection.md): writes go through `app.*` functions in migrations, which are reviewed and versioned. |
| L7 | **Tiers were a `jsonb` array resolved by `.find()` on id *or* name.** Two tiers sharing a display name collapsed every selection onto one price. | Tiered-amount incident | [ADR 0010](../adr/0010-tiers-are-rows.md): tiers are rows; `unique (collection_id, lower(name))`; a payment attempt carries `tier_id` as a real FK. |
| L8 | **No stored provider events.** A webhook that failed past Paystack's retries was simply gone. | `target-schema.md`; NFR-11 | `provider_events` is written **before** the 200, unique on the provider's own event id, and replayable for ever. |
| L9 | **No refund path existed at all**, so an overpayment had no remedy. | `target-schema.md` | `refunds` is designed here, gated on DEC-08. Until it exists, overpayment is a *recorded, visible* state rather than an invisible one. |
| L10 | **Withdrawals were manual bank transfers with synthetic `MAN_*` references.** | `target-schema.md`; settlement-provider header | A withdrawal is a request; a payout is an execution with a provider reference. Idempotent on the Kolekto reference (WDR-05). |
| L11 | **A withdrawal TOCTOU race could over-reserve.** Guarded late, by `g2_atomic_withdrawal_request.sql`. | Drift report §7 | Availability is asserted **inside** the transaction that posts the withdrawal journal, against the ledger, with the community's balance row locked. |

---

## 4. The domain model

Fourteen concepts. **Not fourteen tables** — §5 gives the boundaries and says
which concepts are columns, which are rows, and which are views.

The organising idea: **separate what somebody intended, what the provider
says happened, what Kolekto asserts is financially true, and what is merely
computed for a screen.** The old system mixed all four into `wallets`, and
could not then answer which of them was wrong.

| Layer | Meaning | Mutable? | Authoritative for |
|---|---|---|---|
| **Intent** | What a contributor set out to do | Yes, until it resolves | Nothing financial |
| **External fact** | What the provider reports | Never (append a correction) | What the provider believes |
| **Internal truth** | What Kolekto asserts about money | Never (reverse, don't edit) | Every naira |
| **Projection** | A number computed for a screen | Rebuilt at will | Nothing |

### A. Contribution Intent — *intent*

**Purpose:** what a contributor chose before any money moved — this
collection, this tier or basket, this quantity, these answers, this amount as
**the server resolved it**.
**Owner:** the contributor's session; no member identity required for a public
collection.
**Immutable once a payment attempt references it:** `collection_id`,
`amount_kobo`, `fee_schedule_version`, the resolved line items.
**Mutable before that:** everything.
**Identifier:** `intent_id` (uuidv7).
**Idempotency:** none needed — a new intent is cheap and harmless.
**Audit:** not audited. An abandoned intent is not an event anybody needs.
**Boundary note:** this is the row [ADR 0012](../adr/0012-collections-stop-at-the-money-boundary.md)
refused to create in M7 — correctly, because in M7 it would have been a
pending contribution that never resolved. It becomes legitimate the moment a
payment attempt can resolve it.

### B. Payment Attempt — *intent, hardening into fact*

**Purpose:** one attempt to pay one intent through one provider. **The amount
lock** (COL-10): the figure sent to the provider, frozen here, server-derived.
**Immutable:** `reference` (Kolekto's own, the idempotency key),
`collection_id`, `amount_kobo`, `fee_breakdown`, `fee_schedule_version`,
`tier_id`, the item lines, `provider`, `created_at`.
**Mutable:** `state`, `provider_reference`, `captured_at`, `failure_reason`,
`next_retry_at`, `review_reason`.
**Identifier:** `reference` — unique, Kolekto-generated, used *as* the
provider reference so both sides share one key.
**Uniqueness:** `unique (reference)`; `unique (provider, provider_reference)`
where the provider issues its own.
**Audit:** every state transition.

### C. Provider Transaction — *external fact*

**Purpose:** a faithful mirror of what the provider says about one
transaction: its id, its reference, its status, its amount, its currency, its
fee, its channel, its timestamps, its authorization.
**Immutable:** everything. A provider correction is a **new row**, not an
edit.
**Identifier:** `(provider, provider_transaction_id)`.
**Audit:** creation only; it cannot change.
**Why separate from B:** an attempt is Kolekto's intent to be paid; a provider
transaction is somebody else's statement of fact. Conflating them is how
"amount mismatch" becomes unanswerable — you need both numbers to notice they
differ.

### D. Contribution — *internal truth*

**Purpose:** money Kolekto asserts arrived and applies to a collection. **The
unit of application**, not the unit of payment: one payment may create several
(a person paying for three members, an item basket, three tickets).
**Immutable:** everything. A mistake is a reversal.
**Identifier:** `contribution_id`; `unique (payment_reference, line_index)` —
the partial unique index that worked in the old system, carried across.
**Links:** `collection_id`, optional `obligation_id`, optional `member_id`,
optional `tier_id`, optional `contributor_reference_id`, the payment attempt,
the provider transaction.
**Audit:** creation, and any reversal that later points at it.

### E. Transaction — **not a separate table**

The old schema had `deposits` and `transactions` as near-duplicates. Here,
"transaction" is precisely C (the provider's) plus B (Kolekto's). A third
table with both meanings is how "which amount is right?" became unanswerable.
**Decision: folded into B and C.**

### F. Ledger Entry — *internal truth*

**Purpose:** one debit or one credit against one account. The only thing a
balance is ever computed from.
**Immutable:** everything, enforced by revoked `UPDATE`/`DELETE` and a
blocking trigger (DAT-02).
**Grouped by:** a `ledger_journal`, which must balance to zero. A deferred
constraint trigger asserts it at commit.
**Identifier:** `entry_id`; the journal carries `unique (idempotency_key)`.
**Audit:** the journal *is* the audit. It carries `reason`, `actor`,
`source_type`, `source_id`.

### G. Settlement — *external fact, then internal truth*

Two things the old system ran together:

- **Provider settlement:** the provider moved money to Kolekto's bank. An
  external fact, mirrored like C.
- **Balance release:** Kolekto decides a community's pending money is now
  available. An internal truth, and a journal.

**Decision: two tables.** `provider_settlements` and `balance_releases`. The
second must never be inferred from a clock (L4).

### H. Available Balance — **a projection, and never a table**

A `view` over `ledger_entries`, or a materialised view rebuilt from them. It
is never written to, never incremented, and never the thing a withdrawal
checks — a withdrawal checks the ledger, inside its own transaction, with the
community's account row locked. If a cached figure is ever introduced for
speed, it is named `*_projection`, carries `computed_at`, and no code path may
authorise money against it.

### I. Withdrawal Request — *intent, then internal truth*

**Purpose:** a community asking for its available balance. Carries requester,
approver, destination account, amount, fee, and the Kolekto reference that
makes a retry safe.
**Immutable once approved:** `amount_kobo`, `destination_account_id`,
`reference`.
**Idempotency:** `unique (reference)` (WDR-05).

### J. Payout — *external fact*

**Purpose:** the provider transfer that executes I. Separate because a
withdrawal may be retried across several payouts after a failure, and each
attempt is its own external fact.
**Identifier:** `(provider, provider_transfer_id)`.

### K. Refund — *internal truth, mirroring an external fact*

**Purpose:** money returned to a contributor. Never a deletion of D. Partial
refunds are first-class. A refund voids the contributor reference it
refunds (CODE-07) without withdrawing the number.

### L. Reversal — *internal truth*

**Purpose:** a correction inside the ledger. A reversing journal that points
at the journal it reverses. **The only correction mechanism.** Nothing is ever
deleted, and no entry is ever edited.
**Not the same as K:** a refund moves money outward; a reversal corrects a
bookkeeping mistake. Both exist.

### M. Reconciliation Record — *projection of a comparison*

**Purpose:** the output of comparing two sides. Holds a verdict and evidence,
never a correction. An operator reads it and then acts through a journal.
See [the reconciliation design](2026-09-22-phase4-reconciliation-design.md).

### N. Provider Webhook Event — *external fact*

**Purpose:** the raw, signed payload, stored **before** the 200 is returned.
**Immutable:** everything.
**Identifier:** `(provider, provider_event_id)`, unique. That uniqueness *is*
webhook idempotency.

---

## 5. The boundaries

Fourteen concepts become **twelve tables, one view and two folds**.

```
                          ┌──────────────────────┐
  contributor  ───────────│ contribution_intents │   intent
                          └──────────┬───────────┘
                                     │
                          ┌──────────▼───────────┐
                          │   payment_attempts   │   intent → fact
                          └──────────┬───────────┘
                                     │  reference
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
┌────────▼─────────┐      ┌──────────▼───────────┐    ┌──────────▼─────────┐
│ provider_events  │      │ provider_transactions│    │   contributions    │
│  external fact   │─────▶│    external fact     │───▶│  internal truth    │
└──────────────────┘      └──────────────────────┘    └──────────┬─────────┘
                                                                 │
                                              ┌──────────────────▼─────────┐
                                              │  ledger_journals           │
                                              │    └ ledger_entries        │  internal truth
                                              └──────────────────┬─────────┘
                                                                 │
   ┌──────────────────────┬────────────────────┬─────────────────┴──────┐
   │                      │                    │                        │
┌──▼───────────────┐ ┌────▼─────────────┐ ┌────▼──────────┐ ┌───────────▼────┐
│provider_settlements│ │ balance_releases│ │   refunds     │ │  withdrawals   │
│  external fact   │ │ internal truth   │ │internal truth │ │    intent      │
└──────────────────┘ └──────────────────┘ └───────────────┘ └───────┬────────┘
                                                                     │
                                                            ┌────────▼───────┐
                                                            │    payouts     │  external fact
                                                            └────────────────┘

  v_community_balance          ← a VIEW over ledger_entries. Never written.
  reconciliation_records       ← verdicts and evidence. Never a correction.
  fee_schedules                ← versioned. Replaced, never edited.
```

Two folds, stated so nobody adds them back:

- **"Transaction" is not a table.** It is B (ours) and C (theirs).
- **"Available balance" is not a table.** It is a view over F.

---

## 6. Financial source of truth

> **What rows reconstruct every naira Kolekto owes or has received?**

**`ledger_journals` + `ledger_entries`, and nothing else.**

Every other financial table is either an *input* to a journal (a provider
transaction, a contribution) or an *output* of one (a payout). Delete every
projection in the system and every balance is still recoverable by summing
entries. That is the test of a source of truth, and the old `wallets` table
failed it.

```
immutable financial events    provider_events, provider_transactions,
                              contributions, refunds, payouts,
                              provider_settlements
                                        │  each posts
                                        ▼
ledger source of truth        ledger_journals ──< ledger_entries
                                        │  each summed
                                        ▼
derived balances              v_community_balance, v_collection_raised,
                              v_platform_position          (views)
```

**Proposed chart of accounts** — the twelve-account chart of PRD 9.7, which
assumes the balance model. Under the subaccount fallback (DEC-01/DEC-03) the
`paystack_*` and `community_withdraw*` accounts do not exist and the Money
screen becomes read-only. **Both charts are listed so the decision is visible
rather than assumed:**

| Account | Type | Balance model | Subaccount model |
|---|---|---|---|
| `paystack_balance` | asset | yes | — |
| `paystack_receivable` | asset | yes | — |
| `community_locked` | liability | yes | — |
| `community_pending` | liability | yes | yes |
| `community_available` | liability | yes | — |
| `community_on_hold` | liability | yes | yes |
| `community_withdrawing` | liability | yes | — |
| `community_withdrawn` | liability | yes | — |
| `platform_fee_income` | income | yes | yes |
| `gateway_fee_expense` | expense | yes | yes |
| `refund_reserve` | liability | yes | yes |
| `suspense` | liability | yes | yes |

`suspense` is where captured money with no resolvable collection goes. It
exists so that **capture never waits for attribution** (L-keep-1), and its
balance is a number somebody is accountable for driving to zero.

---

## 7. Money representation

Integer minor units throughout — already true and already enforced.
`app.kobo` is a domain over `bigint`; invariant 1 greps every migration;
`packages/domain/money.ts` has no float anywhere and `applyRate` rounds half
away from zero **exactly once per fee**.

| Term | Meaning | Where it lives |
|---|---|---|
| `amount_kobo` | what the collection is credited with | contribution |
| `gross_amount_kobo` | what the contributor was charged | payment attempt, provider transaction |
| `gateway_fee_kobo` | the provider's fee — an **estimate** on the attempt, the **fact** on the provider transaction | both, and they are compared |
| `platform_fee_kobo` | Kolekto's fee | payment attempt, contribution |
| `net_amount_kobo` | what the community ends up with | derived; asserted, not stored twice |
| `refund_amount_kobo` | returned to the contributor | refund |
| `payout_amount_kobo` | sent to a bank | withdrawal, payout |
| `settlement_amount_kobo` | what the provider moved to Kolekto's bank | provider settlement |

**One authoritative fee path:** `packages/domain/src/fees.ts`,
`calculateFees()`. It is already written, already golden-vector tested, and
deliberately wired to nothing. Phase 4 wires it in **one** place — the server
action that creates a payment attempt — and stores the breakdown on the
attempt. The webhook, the ledger, the receipt and reconciliation all read the
**stored** breakdown; none of them recalculates. That is the direct fix for
L3, and a fifth invariant script should enforce it:

> `calculateFees` may be called from exactly one module. A second call site
> fails the invariant gate.

The provider's reported fee is **never** overwritten onto the estimate. Both
are kept; the difference is a reconciliation input, not an error.

---

## 8. Provider abstraction

The seam already exists for settlement (`packages/adapters/settlement-provider.ts`).
Phase 4 adds a sibling for collection. **Contract only — no implementation.**

```ts
interface PaymentProvider {
  readonly name: "paystack" | string;

  /** Never sees a client-supplied amount. Takes a payment attempt. */
  initialize(attempt: PaymentAttemptSnapshot): Promise<ProviderInitResult>;

  /** The only way a payment is believed. Called by verify, by webhook, and by the sweep. */
  verify(reference: string): Promise<ProviderTransactionSnapshot | null>;

  /** Signature check. Returns the provider's own event id, or throws. */
  authenticateWebhook(rawBody: Buffer, headers: Headers): ProviderEventIdentity;

  parseWebhook(rawBody: Buffer): ProviderTransactionSnapshot | ProviderTransferSnapshot;
}
```

The provider-neutral vocabulary, defined once:

| Field | Meaning | Notes |
|---|---|---|
| `provider` | which gateway | part of every unique key |
| `provider_transaction_id` | the gateway's own id | may be numeric; stored as text |
| `provider_reference` | the reference the gateway echoes | Kolekto supplies this at initialize |
| `authorization_reference` | the reusable card token, if any | stored hashed unless DEC-02 says otherwise |
| `provider_event_id` | the webhook's own id | **the webhook idempotency key** |
| `provider_status` | the gateway's word | kept raw *and* mapped |
| `provider_amount_minor` | the gateway's amount, minor units | compared, never trusted over ours |
| `provider_currency` | ISO code | a mismatch is `needs_review`, never a silent accept |
| `provider_fee_minor` | the gateway's fee | the authoritative fee (P9) |
| `provider_paid_at` / `provider_created_at` | the gateway's clocks | stored as given, displayed WAT |
| raw payload | the whole thing | **stored**, see below |

**Raw payload policy.** Stored in full on `provider_events`, because a
reconciliation two years later needs the bytes and not somebody's mapping of
them. Card numbers never reach Kolekto (the provider tokenises), but the
payload may carry an email, a phone number and a name — so the row is
`authenticated`-invisible, readable only through an `app.*` function that
requires a staff role (ADR 0009), and redacted in any export. Retention is
DEC-13's to set.

**Verification mechanism.** A payment is believed **only** after a server-side
`verify(reference)` against the provider. A webhook is a *trigger to verify*,
never evidence on its own. This is not belt-and-braces: a webhook body is
attacker-supplied until the signature is checked, and even a valid signature
tells you what the provider *sent*, not what it currently *holds*.

---

## 9. Idempotency

Every operation, and what happens on a second execution.

| # | Operation | Key | Second execution does | Concurrency |
|---|---|---|---|---|
| 1 | initiate payment | `payment_attempts.reference`, generated server-side | returns the same attempt and the same provider URL | `unique (reference)`; a retry with a *new* reference is a new attempt, which is correct |
| 2 | verify payment | `(provider, provider_transaction_id)` | re-reads, asserts equality, writes nothing new | `insert … on conflict do nothing`, then read back |
| 3 | webhook ingest | `(provider, provider_event_id)` | stores nothing, returns 200 | `unique` index; the insert *is* the dedupe |
| 4 | create contributions | `(payment_reference, line_index)` | returns the existing rows, reports `idempotent` | `insert … on conflict do nothing` inside the claiming transaction, with the attempt row locked `FOR UPDATE` |
| 5 | post a journal | `ledger_journals.idempotency_key` | posts nothing | `unique`; a duplicate is a no-op, not an error |
| 6 | balance release | `(community_id, release_date)` | releases nothing | `unique`; makes the T+1 job safe to run twice |
| 7 | withdrawal request | `withdrawals.reference` | returns the existing request | `unique`; availability re-checked against the ledger with the account locked |
| 8 | payout execution | `(withdrawal_id, attempt_no)` + provider reference | returns the existing payout | provider transfers are idempotent on our reference; we rely on ours too |
| 9 | refund | `(contribution_id, provider_refund_id)` | returns the existing refund | `unique` |
| 10 | reconciliation run | `(run_id, side, external_key)` | overwrites the verdict for that key only | a verdict is a projection; recomputing is always safe |

**The rule that makes all ten work:** *an idempotency key is a unique index,
not a lookup-then-insert.* Every "check if it exists, then insert" in the old
code was a race. Here, the insert is attempted and the conflict is the answer.

**Transaction boundaries.** Capture (§2 of the old lessons) is its own
transaction and commits before anything can reject it. Claiming contributions
and posting their journal are **one** transaction — a contribution without its
ledger entries is exactly the drift L1 describes.

---

## 10. Contribution → collection

```
community → collection → [audience] → obligation → member
                │                         │
                │                         └─→ contributor_reference
                ▼
     contribution_intent → payment_attempt → provider_transaction
                                    │
                                    └─→ contribution  ──┬─→ obligation (managed)
                                                        ├─→ tier (tiered / ticketed)
                                                        ├─→ item lines (items)
                                                        └─→ none (open public)
```

**The authoritative amount, by collection type.** Resolved by the server, in
the database, at attempt time. `packages/domain/contribution.ts` already does
most of this and is already tested:

| Type | Amount resolved from | Already implemented |
|---|---|---|
| fixed | `collections.fixed_amount_kobo` | yes |
| open amount | contributor's figure, clamped to `min`/`max` | yes |
| per member | that member's `obligations.expected_amount_kobo` less waivers | yes |
| tiered | `collection_tiers.price_kobo` by `tier_id` | yes |
| tiered, multiple | `resolveTierBasket()` — sum of price × quantity, stock and per-order limits enforced | yes |
| items | `resolveItemBasket()` — same | yes |
| ticketing | tiers, with `collect_attendee_details` | yes |
| fundraising | open amount with suggestions | yes |
| recurring | the open cycle's obligation | yes |

**Never trusted from the client**, and each already has a server-side
resolution in M7.6: amount, tier price, item price, quantity limits, stock,
fee, member eligibility, collection ownership. The one addition Phase 4 makes
is to **freeze** the resolution onto the payment attempt, so the amount that
was charged can be proven later without re-deriving it from configuration
that may since have changed.

**Public collections.** No obligation, no member, no reference — today. A
contribution from a public collection carries `obligation_id = null` and a
contributor snapshot (name, and an email or a phone). It may be issued a
contributor reference at that point, which is the extension
`contributor_references` was shaped for: a nullable `contribution_id` beside
`obligation_id` and a `CHECK` that exactly one is set.

---

## 11. Items and tickets

**Items.** A contribution may carry several lines. Each line **snapshots** the
price and the name:

```
contribution_lines
  contribution_id, line_index
  item_id            FK, on delete restrict
  item_name_snapshot text      -- the name at the time
  unit_price_kobo    app.kobo  -- the price at the time
  quantity           integer
  subtotal_kobo      app.kobo  -- asserted = unit_price × quantity
  unique (contribution_id, line_index)
```

The snapshot is not redundancy. Reconstructing a 2026 order from a 2028 price
list is the failure this prevents, and it is the same class of mistake as L2.
The FK is kept **as well**, so "which item was this?" and "what did it cost
then?" are both answerable.

**Tickets.** A ticket is not an obligation. M7.5 attached check-in to
obligations because that was the only participation that existed — honestly,
and with the limitation written down. Phase 4 gives tickets their own entity:

```
tickets
  id, community_id, collection_id
  contribution_id    FK   -- what paid for it
  tier_id            FK   -- which ticket type
  attendee_name      text -- optional, per collect_attendee_details
  contributor_reference_id FK  -- VIP-0021
  unique (contribution_id, ticket_index)
```

One row per **admitted unit**, because that is what a door admits. `event_check_ins`
gains a nullable `ticket_id` beside its `obligation_id`, with a `CHECK` that
exactly one is set — the same extension shape as everywhere else in this
architecture. The check-in function, its permission and its audit trail do not
change.

---

## 12. Recurring collections

Answers, explicitly:

| Question | Answer |
|---|---|
| One obligation per member per cycle? | **Yes.** `obligations_unique_member_cycle` already enforces it, `nulls not distinct`. |
| One contribution per payment? | **No.** One payment may create several contributions. |
| Partial payment? | **Yes**, first-class. §13. |
| Several payments toward one obligation? | **Yes.** Several contributions point at one `obligation_id`. |
| Overpayment? | Recorded in full. The excess posts to `community_pending` like any other money and the obligation shows as over-settled. It is **never** silently applied to the next cycle — that is a product decision (DEC-P3). |
| Underpayment? | The obligation stays open with a remaining amount. Nothing is written back to it. |
| Missed cycle? | The obligation stays open. Cycles do not cascade; October is not settled by paying November. |
| Late payment? | Applies to the cycle it names, not to the current one. |
| Duplicate cycle payment? | Both contributions exist. The second is an overpayment of that cycle, visible as such. |
| Refund of one cycle? | A refund points at a **contribution**, which points at one cycle's obligation. Cycles are independently refundable because they are independently paid. |
| Future cycle? | Allowed only for a cycle that exists and is open. Paying a cycle that has not been opened is refused at attempt time. |

**No automated card charging.** Recurring here means recurring *obligations*,
not recurring *charges*. Stored-card recurring billing is a separate product
decision (DEC-P5) with its own consent, mandate and regulatory questions.

---

## 13. Partial payments

First-class, and **never a mutable `amount_paid`.**

```
required   = obligations.expected_amount_kobo − waived_amount_kobo
paid       = Σ contributions.amount_kobo  where obligation_id = … and not reversed
refunded   = Σ refunds.amount_kobo        where contribution.obligation_id = …
settled    = paid − refunded
remaining  = max(required − settled, 0)
excess     = max(settled − required, 0)
```

All five are **derived**, in a view. `obligations` gains no `amount_paid`
column, ever — ADR 0006 says so and this architecture keeps it. The status an
officer sees is a function of the same arithmetic:

| Derived status | Condition |
|---|---|
| `unpaid` | `settled = 0` |
| `part_paid` | `0 < settled < required` |
| `settled` | `settled = required` |
| `over_settled` | `settled > required` |
| `exempt` | the officer exempted it (already exists) |
| `cancelled` | the officer cancelled it (already exists) |

`obligations.status` keeps its current values and keeps its
`block_manual_paid_status` trigger. The *payment-derived* status is a separate,
computed column in the view — because a stored status and a computed one that
disagree is exactly the class of bug this whole document is about.

**The sequence**, each step a contribution and a journal, nothing overwritten:
first partial → second partial → final → (overpayment) → (refund) →
(cancellation, which does not delete the contributions already applied).

---

## 14. Ledger design

Double entry. Twelve accounts (§6). Three tables.

```
ledger_accounts     id, community_id (nullable for platform accounts),
                    code, type ∈ {asset, liability, income, expense, equity},
                    currency, created_at
                    unique (community_id, code) nulls not distinct

ledger_journals     id, community_id, occurred_at, posted_at,
                    source_type, source_id, reason,
                    actor_type, actor_user_id, actor_name_snapshot,
                    fee_schedule_version,
                    idempotency_key   unique,
                    reverses_journal_id  FK nullable

ledger_entries      id, journal_id FK, account_id FK,
                    direction ∈ {debit, credit},
                    amount_kobo app.kobo  check (amount_kobo > 0),
                    currency,
                    created_at
```

**Every journal balances.** A deferred constraint trigger, checked at commit,
asserts `Σ debits = Σ credits` per journal. Deferred because a journal is
written as several rows; checking per row would refuse the first one.

**Immutability.** No `UPDATE` or `DELETE` grant on either table for any client
role, plus a blocking trigger — the same pair that already protects
`audit_logs` and `contributor_references`.

**Corrections are reversals.** `reverses_journal_id` points at the journal
being corrected; the reversing journal has the same entries with directions
swapped. Both remain. "Why is this amount in this account?" is answered by
selecting the entries for that account with their journals' `reason`,
`source_type` and `source_id` — which is the query the old system could not
write, because there were no entries.

**Worked example** — ₦10,000 contribution, organiser-borne, 0.5% platform,
1.5% gateway:

| Journal | Debit | Credit | Amount |
|---|---|---|---|
| capture | `paystack_receivable` | `community_pending` | ₦10,000 |
| fees | `community_pending` | `platform_fee_income` | ₦50 |
| fees | `community_pending` | `gateway_fee_expense` | ₦150 |
| T+1 release | `community_pending` | `community_available` | ₦9,800 |
| withdrawal | `community_available` | `community_withdrawing` | ₦9,800 |
| payout ok | `community_withdrawing` | `community_withdrawn` | ₦9,800 |

Every line is explainable, every line is reversible, and no line is an update.

---

## 15. Fees

The engine exists (§7). What Phase 4 adds is the **table**, so a schedule is a
row rather than a constant:

```
fee_schedules   version text primary key, effective_from date,
                platform_rate_bps jsonb, platform_rate_default_bps integer,
                gateway_rate_bps integer, max_fee_per_component_kobo app.kobo,
                created_at, created_by
                -- append-only: a change is a new version
```

Every payment attempt, contribution and journal stores
`fee_schedule_version`. Changing a rate therefore cannot restate history (L2).

**Who bears the fee.** Three models exist; the code already supports two, and
which is *allowed* is not an engineering decision:

| Model | Contributor pays | Community receives | Status |
|---|---|---|---|
| community absorbs | ₦10,000 | ₦9,800 | implemented in `fees.ts`; the current default |
| contributor pays | ₦10,200 | ₦10,000 | implemented in `fees.ts` |
| split | some of each | the rest | **not** implemented; would need a new schedule field |

`collections.fee_mode` already carries the first two. **Whether fees may
lawfully be passed to a contributor at all is DEC-12**, a legal question, and
this document does not answer it. See
[open decisions](2026-09-22-phase4-open-decisions.md).

---

## 16. Settlement

Four distinct events, deliberately not collapsed:

```
1. provider captured    the provider took the contributor's money
2. provider settled     the provider paid Kolekto's bank         ← external fact
3. Kolekto recognises   a provider_settlement row is reconciled  ← internal truth
4. funds available      a balance_release journal is posted      ← internal truth
                        → and only now is the money withdrawable
```

**Payment success is not availability.** The old system's `pending` versus
`available` was `created_at < getSettlementCutoff()` — a comparison, not a
record — so a payment that had aged past the cutoff was available *in theory*
and pending *in the cache*, and which one an operator saw depended on whether
a refresh had happened (L4). Here, availability is a journal. If the job has
not run, nothing is available, and the absence is visible.

**Cutoff and timezone.** The T+1 job runs at 00:05 WAT and releases everything
captured before 00:00 WAT. Timestamps are stored UTC and displayed WAT
(FIN-10). **Whether "T+1" counts calendar days or Paystack business days is
DEC-25** and is not decided here — it changes what a Friday evening payment
does over a weekend, which is a promise to organisers, not a coding choice.

---

## 17. Withdrawals and payouts

Separate, because one is a decision and the other is an execution that may be
attempted several times.

**Withdrawal request.** Eligibility: `available` balance from the ledger, with
the community's account locked inside the transaction (L11); a verified
withdrawal account; no active hold; amount within DEC-06's limits. Approval is a separate act
with its own permission. Whether it *also* needs a second approver above a
threshold is DEC-06's to set: `role_permissions.requires_second_approver` is
the mechanism and it already exists — it is set today for
`refund.initiate`, `withdrawal_account.change` and
`collection.change_amount`, and **not** for `withdrawal.approve`.

**Payout.** One row per attempt. A failure does not fail the withdrawal; it
produces a failed payout and the withdrawal returns to `approved`, retryable.
Money moves back from `community_withdrawing` to `community_available` by a
reversing journal, never by an edit.

**RBAC**, using the permissions that already exist:

| Action | Permission | Roles |
|---|---|---|
| see balances | `balance.view` | owner, admin, treasurer, viewer |
| see transactions | `transaction.view` | owner, admin, treasurer, collector (scoped), viewer |
| change the bank account | `withdrawal_account.change` | owner, treasurer — **second approver required** |
| request a withdrawal | `withdrawal.request` | owner, treasurer |
| approve a withdrawal | `withdrawal.approve` | owner, treasurer |
| resolve a payment problem | `payment.resolve` | owner, treasurer |
| initiate a refund | `refund.initiate` | owner, treasurer — **second approver required** |

A **collector never touches money** and a **viewer never moves it**. No screen
decides this; `app.require_permission` does, inside the function, from the row.

---

## 18. Webhooks

```
receive ─► authenticate ─► persist ─► deduplicate ─► validate ─► process ─► 200
             signature      raw row     unique key    verify()    claim
             fail → 401     BEFORE      conflict      with the    + journal
                            the 200     → 200         provider
```

**Persist before acknowledge.** The row goes in before the 200 goes out. A
provider that has been acknowledged will not resend, so acknowledging
something you have not stored is how L8 loses an event for ever.

**Deduplicate on the provider's own event id.** The unique index *is* the
dedupe; there is no read-then-write.

**Never trust the webhook alone.** Processing calls `verify(reference)`
against the provider. The webhook says "look at this"; the provider's
verification endpoint says what is true.

**Replay is safe by construction.** Re-processing a stored event re-runs
verify, hits the `(payment_reference, line_index)` conflict on contributions
and the `idempotency_key` conflict on the journal, and writes nothing. An
operator may replay any event, at any time, as many times as they like.

**Never relied upon:** the browser redirect, a client-side success callback,
or anything the contributor's device says. The redirect is a *hint* that
triggers the same verify path — nothing more.

---

## 19. Security

| Threat | Control |
|---|---|
| IDOR on a payment attempt | the attempt carries `community_id` and `collection_id`; RLS scopes reads; every write is an `app.*` function that derives tenancy from the row (SEC-18) |
| cross-community access | already enforced for every existing table and asserted by `17_operations_rbac.sql`; the money tables join the same pattern |
| payment attached to the wrong collection | `collection_id` is frozen on the attempt at creation and compared on verify; a mismatch is `needs_review`, never a silent accept |
| forged reference | the reference is server-generated and unique; an unknown reference resolves to nothing |
| forged amount | the client never supplies an amount that is used; the attempt's amount is server-derived and frozen, and the provider's amount is compared to it |
| replay attack | every ingest path is idempotent on a unique key (§9) |
| webhook forgery | signature verified before the payload is parsed; an unsigned body is never stored as an event |
| duplicate credit | `unique (payment_reference, line_index)` and `unique (idempotency_key)` — at the database, not in the handler |
| privilege escalation | permissions are rows; `require_permission` runs inside every `SECURITY DEFINER` function; the grant-matrix test asserts nothing is executable by `PUBLIC` |
| unauthorised refund / withdrawal | `refund.initiate`, `withdrawal.request`, `withdrawal.approve`, each checked server-side, two with a second approver |
| unauthorised payout destination change | `withdrawal_account.change`, second approver, and a cooling-off period is DEC-07's to set |
| race conditions | availability is asserted inside the transaction with the account row locked; contribution claiming locks the attempt `FOR UPDATE` |
| concurrent payment processing | the webhook, the redirect and the sweep may all arrive at once; all three converge on the same conflict-based inserts, so the second and third write nothing |

---

## 20. Historical data

Unchanged from what is already built and already decided. Stated here so
Phase 4 cannot quietly reverse it:

| Old record | Becomes | Enters the ledger? |
|---|---|---|
| `deposits` | `migration.legacy_deposit` overflow + a read-only history view | **No** |
| `contributions` | `migration.legacy_contribution` overflow; the collection and member they relate to are migrated | **No** |
| `wallets` | nothing. It was a cache. | **No** |
| withdrawals | preserved as history | **No** |
| the 923 unattributed rows | `migration.unattributed_payments`, with provenance and **no `collection_id` column at all** | **No, ever** |

**No opening balances.** The new ledger starts empty and every entry in it
describes something that happened after it was built. An imported balance is
an assertion nobody can trace, which is the property this entire architecture
exists to avoid.

Historical receipts resolve through `public.legacy_links`, which maps an old
identifier to whatever it became — a read, never a posting.

The ₦19.8m matter stays closed. Its rows are preserved, and the absence of a
`collection_id` column is what makes a well-meaning future backfill
impossible.

---

## 21. Proposed schema

Full DDL is **not** included here on purpose: several column sets change
shape depending on DEC-01 and DEC-03, and writing SQL that looks applicable
invites somebody to apply it. What is fixed regardless:

- every money column is `app.kobo` and ends in `_kobo`
- every table has RLS **enabled and forced**, and is added to the grant
  allowlist explicitly (`02_grant_matrix.sql` fails otherwise)
- every financial table has a delete guard; `05_guards.sql` gains a test each
- `ledger_entries`, `ledger_journals`, `provider_events`,
  `provider_transactions`, `contributions`, `refunds` and `payouts` are
  append-only, enforced by revoked privileges **and** a blocking trigger
- every write goes through an `app.*` `SECURITY DEFINER` function that calls
  `require_permission` and derives tenancy from the row
- unique constraints carry the idempotency keys of §9
- the collection and member delete guards extend to contributions, ledger
  entries and withdrawals
- indexes exist for: reference lookup, provider id lookup, per-account entry
  sums, per-collection contribution sums, and the reconciliation joins

---

## 22. Architecture review — §23's eighteen questions

| # | Question | Answer | What makes it true |
|---|---|---|---|
| 1 | Every naira entering traced? | **Yes** | capture posts a journal before any validation; `suspense` absorbs unattributable money rather than dropping it |
| 2 | Every naira owed to an organiser explained? | **Yes** | `community_*` account balances are sums of entries, each carrying a journal with a reason and a source |
| 3 | Every payout traced to entries? | **Yes** | a payout has a withdrawal, which has journals moving `available → withdrawing → withdrawn` |
| 4 | Can a duplicate webhook credit twice? | **No** | `unique (provider, provider_event_id)`, `unique (payment_reference, line_index)`, `unique (idempotency_key)` — three independent database-level refusals |
| 5 | Can a client manipulate the amount? | **No** | the amount is server-resolved, frozen on the attempt, and compared against the provider's |
| 6 | Wrong collection? | **No** | `collection_id` frozen at attempt creation and re-compared on verify; a mismatch parks in `needs_review` |
| 7 | Cross-community financial visibility? | **No** | RLS on every money table, same pattern as the tables already asserted by `17_operations_rbac.sql` |
| 8 | Can financial history be deleted? | **No** | no `DELETE` grant, blocking triggers, delete guards on the parents |
| 9 | Can a failed payout be retried safely? | **Yes** | payouts are per-attempt rows; a failure reverses by journal and the withdrawal returns to `approved` |
| 10 | Can a payment be reconciled against Paystack later? | **Yes** | `provider_events` keeps raw payloads for ever; `provider_transactions` keeps the provider's own figures |
| 11 | Multiple providers? | **Yes** | `provider` is part of every external key; the contract in §8 is provider-neutral |
| 12 | Partial payments represented? | **Yes** | several contributions per obligation; everything derived, no `amount_paid` |
| 13 | Item baskets reconstructable? | **Yes** | `contribution_lines` snapshots name and unit price alongside the FK |
| 14 | Ticket purchases reconstructable? | **Yes** | one `tickets` row per admitted unit, with tier, attendee and reference |
| 15 | Recurring cycles reconciled independently? | **Yes** | a contribution points at one obligation, which names one `cycle_key` |
| 16 | Refunds and reversals without deleting? | **Yes** | refunds are rows; reversals are journals pointing at journals |
| 17 | Balances reconstructable from authoritative records? | **Yes** | a balance *is* a sum over entries; there is no other store |
| 18 | Can operators investigate without editing truth? | **Yes** | `reconciliation_records` hold verdicts and evidence and are never an input to a balance |

**No answer is "no".** Three carry a dependency rather than a gap, and each is
named in [open decisions](2026-09-22-phase4-open-decisions.md): the chart of
accounts depends on DEC-01/DEC-03; the fee bearer depends on DEC-12; the T+1
definition depends on DEC-25.

---

## 23. Unresolved architectural risks

1. **Total database unavailability during capture.** Inherited from the old
   system's own final report and not closeable inside Postgres: recording
   anywhere requires a write to succeed. Mitigation is a durable queue outside
   the database, which is an addition, not a fix. **Accepted, documented, not
   built.**
2. **The chart of accounts is not final** until DEC-01 and DEC-03 close. Both
   charts are written down so the choice is visible; building either first
   would be building twice.
3. **Provider fee is an estimate until the provider reports it.** Designed for
   — both numbers are kept and the difference is reconciled — but it means a
   community's net is provisional until settlement.
4. **`suspense` needs an owner.** A `suspense` balance above zero is somebody's
   job, and this architecture can only make it visible. Who watches it and how
   fast they must clear it is an operations decision (DEC-P6).
