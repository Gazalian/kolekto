# Phase 4 — provider assumptions

**Status:** Living document. Every entry is a belief about Paystack, labelled by
how well it is established.
**Opened:** 2026-09-24 (M8.1)
**Companion:** [financial decisions](financial-decisions.md)
**Prior art:** [open decisions §C](../history/2026-09-22-phase4-open-decisions.md)
(C1–C12) and the [M7.9 gate report](../history/2026-09-24-m7.9-qa-closure-and-financial-gate-report.md) §14,
both of which asked these questions. This document is where the answers land.

---

## The rule this document exists to enforce

**A provider assumption is never presented as a fact.** Where Paystack's
behaviour is unknown, Kolekto is designed defensively and the assumption is
written down with a verification route. The old estate's payment code contained
several beliefs about Paystack that nobody had checked, and the only way to tell
them apart from verified behaviour was to read the provider's documentation
afresh.

Three labels:

| Label | Means |
|---|---|
| **ESTABLISHED** | Confirmed from Paystack's own documentation or dashboard, and the source is named. |
| **UNVERIFIED** | Believed, plausible, not confirmed. Design must not depend on it being true. |
| **UNKNOWN** | No basis for a belief either way. Design must tolerate any answer. |

Nothing here may be promoted to **ESTABLISHED** by reasoning. Only by a named
source, in writing, recorded with a date.

---

## Established

### PA-01 · Webhook signature scheme — **ESTABLISHED**

Paystack sends an `x-paystack-signature` header containing an **HMAC SHA-512**
hash of the **raw** event payload, keyed with the secret key.

*Answers C1.*

**What Kolekto does with it:** the signature is verified **before the payload is
parsed**, against the raw bytes exactly as received — not a re-serialised body,
which would change the bytes and break the hash. An unsigned or wrongly-signed
body is never stored as an event.

### PA-02 · Webhook retry behaviour — **ESTABLISHED**

If Paystack does not receive an HTTP 200, the delivery is treated as failed and
may be retried: **every 3 minutes for the first 4 attempts, then hourly, for up
to 72 hours** (live mode).

*Answers C3.*

**What Kolekto does with it:** webhook delivery is treated as **at-least-once**.
Exactly-once is never assumed. The same event arriving twice, five times, or
after a timeout produces exactly one financial effect, enforced by a unique
index rather than by handler logic (D-25, D-26).

### PA-03 · Events carry ids and are replayable — **ESTABLISHED**

Paystack records webhook events, gives them ids, and they can be listed, viewed
and resent from the webhook history in the dashboard.

*Answers C2 in part — see PA-08 for the part that is not established.*

**What Kolekto does with it:** the provider's own event id is the webhook
idempotency key, held by a unique index. Because Paystack can resend, and an
operator can resend deliberately, replay must be free of consequence — and it
is, because every ingest path converges on a conflict rather than an insert.

---

## Unverified

### PA-04 · Subaccount settlement timing is controllable

**This is the most consequential unverified assumption in Phase 4.**

**The assumption:** that a Paystack subaccount can be operated so that the
organiser's share does **not** settle automatically to the organiser's bank on
Paystack's own schedule, but instead settles when Kolekto initiates it.

**Why it matters:** [D-01](financial-decisions.md#1--money-custody-and-settlement--closed)
depends on it. If a subaccount's share always auto-settles to the organiser's
bank on Paystack's schedule, then withdrawal, withdrawal fees, daily withdrawal
limits, approval thresholds, the 24-hour processing target and the 48-hour bank
cooling-off period have nothing to act on, because Paystack has already paid the
organiser. That is precisely the `subaccount_auto_settle` model the repository
already described, in which `supportsWithdrawal = false`.

**Why M8.1 proceeds anyway:** the ledger does not change if this turns out to be
false. A chart of accounts that records *pending → available → withdrawing →
withdrawn* at collection scope also records *pending → settled-by-provider* — the
second is the first with two states never reached. What would change is the
withdrawal flow, which M8.1 does not build. See ADR 0015 §4.

**Verification route:** Paystack sandbox, plus the subaccount settlement-schedule
configuration in the dashboard, plus written confirmation from Paystack support
that the chosen schedule behaves as configured for split payments. Needed
**before** any withdrawal work begins.

### PA-05 · Verify returns the settled fee, not an estimate

**The assumption:** the `fees` figure on a transaction verification response is
Paystack's actual charge, not a projection.

*Answers C4, unverified.*

**Why it matters:** D-11 makes Paystack's reported fee the financial truth. If
that figure is itself an estimate at verification time and is restated at
settlement, then the "actual" fee has two versions and the later one wins.

**Why the design tolerates either answer:** `estimated_provider_fee_kobo` and
`actual_provider_fee_kobo` are separate fields, and a provider correction is a
**new row** rather than an edit. A restated fee is therefore representable
without rewriting anything.

**Verification route:** compare a verification response's `fees` against the same
transaction in a settlement report, in sandbox and then on the first live
transactions.

### PA-06 · Subaccount split and fee treatment

**The assumption:** that a split payment's fee bearer can be configured, and that
the resulting division between Kolekto's main account and the organiser's
subaccount is what Kolekto models.

*Answers C10, unverified.*

**Why it matters:** if Paystack's split arithmetic differs from
`calculateFees()`, Kolekto's ledger and Paystack's settlement disagree on every
transaction — a systematic reconciliation variance rather than an occasional one.

**Verification route:** sandbox transactions across both fee-bearer modes, with
the resulting splits compared against `calculateFees()` output. Do not build the
adapter until this matches.

### PA-07 · Provider-side attribution granularity

**The assumption:** that a subaccount is per-organiser and cannot be
per-collection, so provider-side attribution is permanently coarser than
Kolekto's.

**Why it matters:** [D-02](financial-decisions.md#2--financial-ownership-is-the-collection--closed)
requires collection-level attribution. If it can only come from Kolekto's own
records, then it must be recorded at capture time and can never be reconstructed
from Paystack — which makes capture-time attribution a hard requirement rather
than a convenience.

**Verification route:** Paystack subaccount documentation and limits. Note that
even if per-collection subaccounts were possible, creating one per collection
would be operationally unreasonable, so the design assumes the coarse case
regardless.

---

## Unknown

### PA-08 · Transfer idempotency

**What is not known:** whether Paystack transfers accept an idempotency key, and
whether a transfer request is idempotent on a reference Kolekto supplies. The
documentation available to us does not clearly establish either.

*C5, and the answer is "we do not know".*

**How Kolekto is designed for it:** Kolekto generates its **own** unique
payout/transfer reference and treats provider transfer calls as **not**
exactly-once. The withdrawal is idempotent on Kolekto's reference regardless of
what Paystack does with it.

**This is deliberately pessimistic.** A wrong optimistic assumption here pays a
bank twice.

### PA-09 · Transfer timeout semantics

**What is not known:** what a transfer request returns on timeout, and precisely
how to establish what actually happened.

*C6, and the answer is "we do not know".*

**How Kolekto is designed for it — the rule, not a preference:**

> **TIMEOUT ≠ FAILED.** A timed-out transfer is `unknown`. `unknown` blocks
> retry. It is resolved by **querying** Paystack — by transfer id, code or
> reference — never by retrying.

Transfers can be queried by id, code or reference, which is what makes this
resolvable at all, and is why Kolekto generates its own reference (PA-08).

### PA-10 · Settlement report contents

**What is not known:** whether a settlement batch lists the individual
transactions it covers.

*C7.*

**Why it matters:** it is reconciliation boundary ④ in the
[reconciliation design](../history/2026-09-22-phase4-reconciliation-design.md).
If a settlement cannot be decomposed into its transactions, the boundary can
only be reconciled in aggregate, and a per-transaction variance becomes
invisible.

### PA-11 · Transaction list pagination over an arbitrary period

**What is not known:** whether the transaction list API can be paged over any
period Kolekto chooses.

*C8. Boundary ① of reconciliation depends on it.*

### PA-12 · API rate limits

**What is not known:** the rate limits on verification and on the transaction
list.

*C12.*

**Why it matters:** it bounds how aggressively a reconciliation sweep may run,
and a sweep that trips a rate limit fails in a way that looks like a provider
outage.

### PA-13 · Refund fee economics

**What is not known:** how fees are treated on a full or partial refund — whether
the provider fee is returned, retained, or charged again.

*C9.*

**Status:** this is a principal reason refunds are **DEFERRED**
([D-18](financial-decisions.md#7--refunds--deferred)). Paystack supports full and
partial refunds; what they cost is not clear enough to design a policy on.

### PA-14 · Dispute and chargeback operations

**What is not known:** the detail of Paystack's dispute events, evidence
submission, and timelines.

**Status:** Paystack has dispute and chargeback events. Integration is later
work. The initial operational policy is
[D-20](financial-decisions.md#9--disputes-and-chargebacks--initial-operational-policy-closed-as); M8.1
only refrains from making it impossible.

### PA-15 · Currency handling

**What is not known:** what a non-NGN transaction looks like in practice.

*C11.*

**How Kolekto is designed for it:** a currency mismatch between a payment attempt
and the provider's reported transaction is `needs_review`. It is never a silent
accept.

---

## Summary

| # | Subject | Label | Blocks |
|---|---|---|---|
| PA-01 | Webhook signature (HMAC SHA-512, raw body) | ESTABLISHED | — |
| PA-02 | Retry schedule, 72-hour window | ESTABLISHED | — |
| PA-03 | Event ids, listable and resendable | ESTABLISHED | — |
| PA-04 | Subaccount settlement timing is controllable | **UNVERIFIED** | **all withdrawal work** |
| PA-05 | Verify returns the settled fee | UNVERIFIED | fee reconciliation confidence |
| PA-06 | Split and fee treatment matches our model | UNVERIFIED | the Paystack adapter |
| PA-07 | Attribution is per-organiser, not per-collection | UNVERIFIED | nothing — assumed coarse either way |
| PA-08 | Transfer idempotency | UNKNOWN | payout execution |
| PA-09 | Transfer timeout semantics | UNKNOWN | payout retry |
| PA-10 | Settlement report decomposition | UNKNOWN | reconciliation boundary ④ |
| PA-11 | Transaction list pagination | UNKNOWN | reconciliation boundary ① |
| PA-12 | API rate limits | UNKNOWN | sweep frequency |
| PA-13 | Refund fee economics | UNKNOWN | refunds (already deferred) |
| PA-14 | Dispute operations | UNKNOWN | dispute processing |
| PA-15 | Non-NGN transactions | UNKNOWN | multi-currency |

**None of these blocks M8.1**, which builds no provider integration at all. PA-04
blocks the withdrawal milestone and should be verified first, because it is the
one that could invalidate a product decision rather than an implementation
detail.
