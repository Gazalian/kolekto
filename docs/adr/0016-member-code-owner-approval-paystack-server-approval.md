# 0016 — Kolekto-held balance with two-party withdrawal authorisation and Paystack server approval

**Status:** Accepted · 2026-11-19 (owner)
**Supersedes in part:** [0015 — subaccount custody](0015-subaccount-custody-and-collection-level-ownership.md)
(the custody half; financial ownership at the collection stands)
**Detail:** [financial decisions §22](../phase-4/financial-decisions.md) ·
[implementation and evidence](../phase-4/withdrawal-otp-owner-approval-2026-11-19.md)

## Context

ADR 0015 chose Paystack subaccounts with Kolekto-controlled settlement. That depended on PA-04 (a
subaccount's settlement can be held until Kolekto releases it), which was never verified. Meanwhile the
withdrawal path was built on the other model: funds in Kolekto's Paystack balance, attributed to collections
in the ledger, paid out by Kolekto-initiated Paystack transfers to a saved, name-matched bank account.

The 2026-11-19 review found that Paystack's transfer OTP is sent to the Paystack business owner (Kolekto),
never to a community member, so it cannot express "the member asked for this" or "the community owner agreed".

## Decision

1. **Custody:** Kolekto's Paystack balance, collection-level attribution, Kolekto-controlled transfers. No
   organiser subaccounts. PA-04 is not applicable.
2. **Two independent authorisations, both recorded in the database before any transfer:**
   the requesting member confirms the request with a Kolekto one-time code sent to their confirmed email, and
   the community owner approves it. A treasurer's `withdrawal.approve` does not substitute for the owner.
3. **Destination:** the requesting member's own verified, name-matched account, re-checked at approval, at
   claim and at Paystack's approval request.
4. **Paystack server approval (approval URL)** is the provider-side check, replacing the per-transfer dashboard
   OTP once the owner approves that dashboard change. Kolekto answers 200 only when the transfer matches a fully
   authorised, still-reserved withdrawal; anything else is 400.
5. **Ambiguity is never resolved by releasing or resending blindly:** leased claims, a versioned backoff
   policy, escalation to manual reconciliation, and a read-only reconciliation report against Paystack's
   transfer list (PA-08 / PA-09).

## Consequences

- Neither authorisation is payment; only a verified Paystack success posts the payout journal.
- Until the dashboard change is approved and made, every transfer parks at Paystack's `otp` and is escalated
  after two hours; funds stay reserved.
- A withdrawal already `approved` without a member code (none exist on dev) is no longer claimed; it is failed
  or cancelled, releasing the hold.
- The owner approving their own request is a separate audited step (`owner_self_approved`); whether a second
  approver is required is an open owner question.
  *Amended 2026-11-20 (`20261120100000`):* answered — a second approver is required. Nobody approves their own
  withdrawal; an owner's request is approved by an owner-designated admin/owner (`approved_as =
  'second_approver'`), never by the treasurer role alone. The approval URL also checks the parsed Paystack
  payload (currency, transfer code, `payload_*` refusals). See the implementation doc §3 and §5.2 updates.
- O-1 (legal authority to hold third-party funds) is unchanged and still blocks real money.
- *Amended 2026-11-20 (session 41):* the owner screen for designating, replacing and removing the second approver
  exists (`20261120140000`) and was verified in a browser on the itest database. The TEST domain now runs with
  transfer OTP off and the approval URL on, so Decision 4 is in effect for TEST; LIVE has neither transfer OTP nor
  the approval URL and must not send payouts until the approval URL is registered for LIVE. Residual risks of this
  decision (unsigned approval requests accepted, second-approver designation controls, payout role privilege) are
  tracked in the [risk register](../security/risk-register-2026-11-20.md) (SR-02, SR-06, SR-08, SR-09).
