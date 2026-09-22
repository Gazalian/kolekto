# Phase 4 — money state machines

**Date:** 2026-09-22
**Status:** Architecture gate. **Nothing here is implemented.**
Companion to [the money architecture](2026-09-22-phase4-money-architecture.md).

Eight machines. For each: what every state means, which transitions are
allowed, which are forbidden and why, who may cause each one, whether it can
be undone, and what audit row it writes.

Two rules govern all eight.

**Rule 1 — a state is a column with a `CHECK` and a trigger, never a free
string.** The old system's `pending_payment_context.state` proved this works:
its `ppc_enforce_state_machine()` trigger rejected any transition not in an
explicit allow-list, and that trigger is the single best thing in the legacy
codebase. It is kept, generalised, and applied to all eight.

**Rule 2 — once money is known to exist, no state may hide it.** Every machine
below has the property that from the moment capture is recorded, there is no
path to a terminal state that means "nothing happened". `failed` is reachable
only *before* capture. This is the structural form of the lesson that cost
₦520,200 to an amount-mismatch `4xx`.

---

## 1. Payment Attempt

The central machine. Deliberately close to the legacy
`pending_payment_context` machine, with three changes noted at the end.

```
                    ┌──────────────┐
                    │   created    │  the attempt exists; nothing sent yet
                    └──────┬───────┘
                           │ provider accepted initialization
                    ┌──────▼───────┐
             ┌──────│ initialized  │──────┐  contributor has a checkout URL
             │      └──────┬───────┘      │
   abandoned │             │ verify says  │ verify/webhook says
   (swept)   │             │ success      │ failed or abandoned
        ┌────▼─────┐  ┌────▼─────┐   ┌────▼─────┐
        │ expired  │  │ captured │   │  failed  │
        └──────────┘  └────┬─────┘   └────┬─────┘
                           │              │ late capture wins
                           │◄─────────────┘
                    ┌──────▼───────┐
                    │  processing  │  claiming contributions + posting journals
                    └──┬────────┬──┘
                       │        │ any validation refused it
                       │   ┌────▼─────────┐
                       │   │ needs_review │  MONEY IS SAFE. Retried for ever.
                       │   └────┬─────────┘
                       │        │ operator or retry resolved it
                    ┌──▼────────▼──┐
                    │  completed   │  contributions exist; journals posted
                    └──────┬───────┘
                           │ a later problem is found
                    ┌──────▼───────┐
                    │ needs_review │  (completed → needs_review is allowed)
                    └──────────────┘
```

### States

| State | Means | Money exists? |
|---|---|---|
| `created` | the row exists; the provider has not been called | no |
| `initialized` | the provider accepted it; the contributor has a checkout URL | no |
| `expired` | nobody paid and the sweep gave up | no |
| `failed` | the provider says it failed or was abandoned | no |
| `captured` | **the provider confirms money was taken.** Recorded before any validation | **yes** |
| `processing` | contributions are being claimed and journals posted | yes |
| `needs_review` | captured, but something is wrong. Parked, visible, retried | yes |
| `completed` | contributions exist and their journals are posted | yes |

### Transitions

| From | To | Caused by | Reversible | Audit |
|---|---|---|---|---|
| `created` | `initialized` | server, on provider ack | no | `payment.initialized` |
| `created` | `failed` | server, provider refused | no | `payment.failed` |
| `initialized` | `captured` | server, after `verify()` says success | no | `payment.captured` |
| `initialized` | `failed` | server, after `verify()` says failed | **yes → `captured`** | `payment.failed` |
| `initialized` | `expired` | sweep, after the window | **yes → `captured`** | `payment.expired` |
| `failed` | `captured` | late verification | n/a | `payment.captured` |
| `expired` | `captured` | late verification | n/a | `payment.captured` |
| `captured` | `processing` | server | no | — (the next row covers it) |
| `captured` | `needs_review` | server, validation refused | yes | `payment.needs_review` |
| `processing` | `completed` | server, after journals post | no | `payment.completed` |
| `processing` | `needs_review` | server, validation refused | yes | `payment.needs_review` |
| `needs_review` | `processing` | operator retry, or the backoff sweep | yes | `payment.retry` |
| `needs_review` | `completed` | server, once it resolves | yes | `payment.completed` |
| `completed` | `needs_review` | operator, a problem found later | yes | `payment.needs_review` |

### Forbidden, and why

| Forbidden | Why |
|---|---|
| `captured → failed` | money exists. Saying it does not is the ₦520,200 line. |
| `captured → expired` | same. |
| `captured → created` / `initialized` | capture is a ratchet. |
| `completed → failed` / `expired` | the contributions and journals exist. |
| any → `created` | `created` is an origin, not a destination. |
| clearing `captured_at` or changing `amount_kobo` after capture | write-once per field, by trigger. |

### What changed from the legacy machine

1. **`created` and `expired` are new.** The old machine started at
   `initialized` and had no state for "nobody ever paid", so abandoned
   attempts sat in `initialized` for ever and were indistinguishable from
   attempts still in flight.
2. **`reconciling` and `reconciled` are gone.** Reconciliation is a *verdict
   about* a payment, not a *state of* one — a payment being examined has not
   changed. They move to `reconciliation_records`
   ([design](2026-09-22-phase4-reconciliation-design.md)).
3. **`pending_capture` is gone.** It meant "we think it might have worked",
   which is not a fact about money. `verify()` either says success or it does
   not.

---

## 2. Provider Transaction

Barely a machine, and that is the point: it mirrors somebody else's fact.

```
  (row created)  ──►  recorded  ──►  superseded
                                     (a newer mirror of the same transaction)
```

| State | Means |
|---|---|
| `recorded` | this is what the provider said, at the time given |
| `superseded` | a later fetch of the same transaction returned different values; a new row supersedes this one |

**Nothing is edited, ever.** A provider that revises a fee or a status
produces a **new row** with `supersedes_id` pointing at the previous one. The
current view of a provider transaction is the row with no successor.

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| → `recorded` | server, on verify or webhook | no | `provider.transaction_recorded` |
| `recorded` → `superseded` | server, inserting the successor | no | `provider.transaction_superseded` |

**Forbidden:** updating any provider-reported field. Enforced by an
append-only trigger, not by convention.

---

## 3. Contribution

The narrowest machine in the system, deliberately.

```
    applied  ──────►  reversed
       │
       └───────────►  refunded  (fully)
       └───────────►  part_refunded
```

| State | Means |
|---|---|
| `applied` | money arrived and was applied to this collection |
| `part_refunded` | some of it has been returned |
| `refunded` | all of it has been returned |
| `reversed` | it should never have been applied; a reversing journal exists |

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| `applied` → `part_refunded` | refund, `refund.initiate` + second approver | no | `contribution.part_refunded` |
| `part_refunded` → `refunded` | further refunds reaching the full amount | no | `contribution.refunded` |
| `applied` → `refunded` | a full refund | no | `contribution.refunded` |
| `applied` → `reversed` | operator, `payment.resolve`, with a reason | no | `contribution.reversed` |

**Forbidden:** any transition *back* to `applied`; any change to
`amount_kobo`; deletion. A contribution applied in error is reversed and a
correct one is created — two rows, both explicable.

**Note on `reversed` versus `refunded`:** a refund returns money to a human. A
reversal corrects Kolekto's books. Money that was never really Kolekto's to
apply gets reversed; money that was, and is being given back, gets refunded.

---

## 4. Settlement

Two machines, because §16 of the architecture separates two events.

### 4a. Provider settlement — *external fact*

```
  announced ──► reconciled
       │
       └──────► disputed
```

| State | Means |
|---|---|
| `announced` | the provider says it paid Kolekto's bank | 
| `reconciled` | the sum of the transactions it claims to cover matches our figures |
| `disputed` | it does not match, and somebody is looking |

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| `announced` → `reconciled` | reconciliation run, zero variance | yes | `settlement.reconciled` |
| `announced` → `disputed` | reconciliation run, variance | yes | `settlement.disputed` |
| `disputed` → `reconciled` | operator, after investigation, with a reason | yes | `settlement.reconciled` |

### 4b. Balance release — *internal truth*

```
  scheduled ──► released
       │
       └──────► held
```

| State | Means |
|---|---|
| `scheduled` | the T+1 job has identified money due for release |
| `released` | the journal moving `pending → available` is posted |
| `held` | a risk or dispute hold stopped it (TRU-05) |

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| `scheduled` → `released` | the T+1 job | by reversing journal | `balance.released` |
| `scheduled` → `held` | a hold, automatic or by staff | yes | `balance.held` |
| `held` → `released` | staff clearing the hold, with a reason | yes | `balance.released` |

**Forbidden:** `released → scheduled`. The journal exists; to undo it you post
a reversal, which is a new event, not a rewind.

**The rule L4 exists to enforce:** nothing may infer availability from a clock.
No `released` row, no available money.

---

## 5. Withdrawal

```
  requested ──► approved ──► executing ──► completed
      │            │             │
      │            │             └──► failed ──┐
      │            │                           │ retry
      │            │              ◄────────────┘
      │            └──► rejected
      └──► cancelled
```

| State | Means |
|---|---|
| `requested` | an officer asked; funds are **not** yet moved |
| `approved` | an approver agreed; funds move `available → withdrawing` |
| `executing` | a payout attempt is with the provider |
| `completed` | the provider confirms the transfer landed |
| `failed` | the last payout attempt failed; the withdrawal is retryable |
| `rejected` | an approver refused |
| `cancelled` | the requester withdrew it before approval |

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| `requested` → `approved` | `withdrawal.approve`, second approver above threshold | no | `withdrawal.approved` |
| `requested` → `rejected` | `withdrawal.approve` holder, with a reason | no | `withdrawal.rejected` |
| `requested` → `cancelled` | requester | no | `withdrawal.cancelled` |
| `approved` → `executing` | server, on payout creation | no | `withdrawal.executing` |
| `executing` → `completed` | payout success | no | `withdrawal.completed` |
| `executing` → `failed` | payout failure | yes | `withdrawal.failed` |
| `failed` → `executing` | retry, by `withdrawal.request` holder | yes | `withdrawal.retry` |

**Forbidden:** `completed → anything`. Money has left the building; a mistake
after that is a separate inbound event, not a state change.

**Where the money is at each state** — and note that the ledger, not the
state column, is what says so:

| State | Ledger position |
|---|---|
| `requested` | still `community_available` |
| `approved`, `executing`, `failed` | `community_withdrawing` |
| `completed` | `community_withdrawn` |
| `rejected`, `cancelled` | back in `community_available`, by reversing journal |

---

## 6. Payout

One row per attempt. Not the same machine as the withdrawal that owns it.

```
  submitted ──► succeeded
      │
      └──────► failed
      │
      └──────► unknown ──► succeeded
                   │
                   └─────► failed
```

| State | Means |
|---|---|
| `submitted` | sent to the provider; no result yet |
| `succeeded` | the provider confirms the transfer |
| `failed` | the provider reports a failure |
| `unknown` | the call timed out or errored; **we do not know** |

**`unknown` is the important state.** A timeout on a transfer is not a
failure; the money may well have moved. The old system had no such state, so a
timeout looked like a failure and a retry could pay a bank twice. Here,
`unknown` blocks retry until a provider query resolves it, and the Kolekto
reference makes even a double submission idempotent at the provider.

| Transition | Caused by | Reversible | Audit |
|---|---|---|---|
| → `submitted` | server | no | `payout.submitted` |
| `submitted` → `succeeded` | provider webhook or query | no | `payout.succeeded` |
| `submitted` → `failed` | provider webhook or query | no | `payout.failed` |
| `submitted` → `unknown` | timeout or transport error | yes | `payout.unknown` |
| `unknown` → `succeeded` / `failed` | a provider query resolving it | no | as above |

**Forbidden:** `unknown → retry` without a resolving query. That is the rule
that stops a bank being paid twice.

---

## 7. Refund

```
  requested ──► approved ──► submitted ──► succeeded
      │             │             │
      │             │             └──► failed ──► (retry as a new refund)
      │             └──► rejected
      └──► cancelled
```

| State | Means |
|---|---|
| `requested` | somebody asked for money to go back |
| `approved` | `refund.initiate` + second approver agreed |
| `submitted` | with the provider |
| `succeeded` | the provider confirms |
| `failed` | the provider refused; a new refund may be raised |
| `rejected` / `cancelled` | it will not happen |

On `succeeded`: the contribution moves to `part_refunded` or `refunded`; a
journal moves the amount out of the community's position into
`refund_reserve`; and the contributor reference, if any, is **voided** —
marked, not deleted, and its number never reissued (CODE-04, CODE-07).

**Forbidden:** refunding more than the contribution, in total across refunds.
A `CHECK` against the sum, asserted in the posting function.

---

## 8. Reversal

Not a lifecycle — a single act with a precondition.

```
  (a journal exists)  ──►  reversing journal posted  ──►  both immutable for ever
```

| Rule | Enforcement |
|---|---|
| a reversal points at exactly one journal | `reverses_journal_id` FK |
| a journal may be reversed **once** | `unique (reverses_journal_id)` |
| a reversal may not itself be reversed | `CHECK (reverses_journal_id is null or not exists a reversal of this one)`, asserted in the posting function |
| the entries are the original's, directions swapped | asserted by the posting function, and by the balancing trigger |
| a reason is mandatory | `CHECK (reason is not null)` on any journal with `reverses_journal_id` |
| who did it is recorded | `actor_user_id` + `actor_name_snapshot`, as `audit_logs` already does |

**Who may cause one:** `payment.resolve` for an operational correction;
`refund.initiate` + second approver where money moves outward. Never
automatic, except for the two mechanical cases — a failed payout returning
funds to `available`, and a rejected withdrawal doing the same.

---

## 9. The awkward cases, and what each machine does

The brief names fifteen. Each one, and where it lands:

| Case | What happens |
|---|---|
| **initiated but abandoned** | attempt sits `initialized`; the sweep moves it to `expired` after the window. Reversible if a late capture arrives. |
| **success but delayed webhook** | the sweep's `verify()` finds it first and captures. The webhook then arrives, dedupes on its event id, re-verifies, hits the contribution conflict, writes nothing. |
| **webhook before redirect** | normal. The webhook captures; the redirect finds the attempt already `completed` and shows the receipt. |
| **redirect before webhook** | also normal. The redirect triggers `verify()` and captures; the webhook later writes nothing. |
| **duplicate webhook** | `unique (provider, provider_event_id)` — the second insert conflicts and returns 200. |
| **repeated verification** | `verify()` is a read at the provider; locally it conflicts on `(provider, provider_transaction_id)` and writes nothing. |
| **provider reference collision** | impossible for ours (`unique (reference)`, server-generated). A *provider* id colliding across providers is why every external key is `(provider, id)`. |
| **amount mismatch** | captured, then `needs_review` with the two figures recorded. Never a `4xx`. Never silently accepted. |
| **currency mismatch** | same: captured, `needs_review`. A non-NGN transaction is never converted automatically. |
| **collection mismatch** | captured, then `needs_review`. The money posts to `suspense` so it is on the books while somebody works out where it belongs. |
| **tier mismatch** | captured, `needs_review`. The tier on the attempt is authoritative; a provider payload claiming otherwise is evidence of tampering, not an instruction. |
| **contributor mismatch** | captured, `needs_review`. A contribution is never re-pointed at a different member automatically. |
| **already-credited payment** | the conflict-based insert reports `idempotent`; the attempt goes to `completed` if it was not already. No second credit is possible. |
| **needing manual review** | `needs_review` is a first-class state with a reason, a backoff, an inbox and unlimited retries. It is never terminal and never invisible. |
| **refunded payment** | contribution → `part_refunded`/`refunded`; refund machine §7; reference voided. |
| **reversed payment** | reversing journal; contribution → `reversed`. Both rows stay. |
| **payout failure** | payout → `failed`; withdrawal → `failed`; funds return to `available` by reversing journal; retryable. |
| **payout retry** | a new payout row under the same withdrawal, same Kolekto reference. Blocked while the previous attempt is `unknown`. |

---

## 10. How these are enforced

Not in TypeScript. In the database, in the same shape the legacy
`ppc_enforce_state_machine()` used and the current schema already uses for
obligations and references:

```sql
create or replace function app.assert_payment_attempt_transition()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = old.state then return new; end if;

  -- Capture is a ratchet: write-once per field, and no path back.
  if old.captured_at is not null then
    if new.captured_at is distinct from old.captured_at
       or new.amount_kobo is distinct from old.amount_kobo
       or new.collection_id is distinct from old.collection_id then
      raise exception 'CAPTURE_IS_IMMUTABLE: … ' using errcode = 'P0001';
    end if;
    if new.state in ('created','initialized','failed','expired') then
      raise exception 'MONEY_EXISTS: a captured payment cannot become %', new.state
        using errcode = 'P0001',
              hint = 'Park it in needs_review. Money that exists is never un-recorded.';
    end if;
  end if;

  if not (new.state = any (case old.state
      when 'created'      then array['initialized','failed']
      when 'initialized'  then array['captured','failed','expired']
      when 'failed'       then array['captured']
      when 'expired'      then array['captured']
      when 'captured'     then array['processing','needs_review']
      when 'processing'   then array['completed','needs_review']
      when 'needs_review' then array['processing','completed']
      when 'completed'    then array['needs_review']
      else array[]::text[] end)) then
    raise exception 'INVALID_TRANSITION: % → % is not allowed', old.state, new.state
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
```

One such trigger per machine. Each transition also writes an `audit_logs` row
through `app.write_audit_log`, whose action names fit the existing
`^[a-z_]+\.[a-z_]+$` constraint — `payment.captured`, `withdrawal.approved`,
`contribution.reversed`, and the rest named in the tables above.
