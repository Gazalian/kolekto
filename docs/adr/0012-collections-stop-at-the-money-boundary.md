# 0012 — Collections stop at the money boundary, and say so

**Status:** Accepted · 2026-09-19

## Context

Phase 3 builds the collection domain: an organiser configures a collection,
publishes it, shares one link, and sees who is expected to pay. A contributor
opens that link and fills in a form.

The obvious next step — taking the payment — is not available. ADR 0006 gates
`contributions`, `payment_attempts` and `transactions` on DEC-01/DEC-02/DEC-03,
none of which are closed. So the contributor flow runs into a wall that is
deliberate, and the question is what to build up against it.

Three shapes were possible:

1. **Store a pending contribution.** Add a narrow table recording who intends
   to pay what, and show the contributor "your details have been received."
2. **Stop before the form.** Build the public page as a read-only advert and
   leave contribution entirely to the payments phase.
3. **Run the form, resolve the amount, and say plainly that payment is not
   open.** Nothing is stored.

## Decision

**Option 3.** The public page, the contributor form and the server-side
resolution of what a selection costs are all built. Nothing about a contributor
is persisted, and the confirmation screen says, in those words, that nothing has
been charged and nothing has been saved.

Option 1 was rejected because a pending-contribution table is the first table of
the payment pipeline wearing a different name. It would be written by the phase
that cannot verify payments, read by the phase that can, and every row created
in between would be an intent that never became money — exactly the class of
unattributed record the previous system accumulated ₦19.8m of. If a row is going
to be reconciled against a Paystack transaction, it should be created by the
code that talks to Paystack.

Option 2 was rejected because the resolution logic — *this tier ID, therefore
this price* — is the part most worth building early and testing in isolation. It
is where the 2026-08-06 incident happened. `packages/domain/src/contribution.ts`
is pure, has no I/O, and is unit-tested against the exact duplicate-name case
that misbilled contributors in production. Phase 4 calls it; it does not
reimplement it.

Two related decisions follow the same principle:

**A published collection's amounts are locked.** `collection.change_amount`
carries `requires_second_approver` (PRD 17.5) and no approval-queue table
exists. Rather than ship a single-approver version of a two-approver permission,
`app.update_collection` refuses the change and the error says why. This mirrors
what Phase 2 did with `community.archive`. Wording, dates and visibility stay
editable, because none of them is what a contributor was asked to pay.

**No screen shows an amount received.** `display_options` already carries the
progress-bar and amount-raised toggles from PRD 4.3, and the public page ignores
every one of them in this phase. An empty progress bar is a claim about money;
a collection page that renders one before contributions exist is asserting zero
rather than declining to answer.

## Consequences

- A contributor who reaches the end of the form is told to contact the
  organiser. That is a worse experience than paying, and a better one than a
  receipt for a payment that did not happen.
- Phase 4's first task is well-defined: create the payment tables, call
  `resolveContributionAmount`, hand the result to the Paystack adapter, and
  replace the honest dead end with a checkout. No Phase 3 row needs migrating,
  because there are none.
- `obligations` rows exist from this phase onward with `status = 'unpaid'` and
  no paid path — `app.block_manual_paid_status` still rejects every attempt, and
  `03_money_invariants.sql` still asserts that no function anywhere writes that
  status.
- The public address of a collection is `/{community-slug}/{collection-slug}`,
  the shape `legacy_links` (20260918130400) was built to redirect old links
  into. The web middleware treats any two-segment path whose first segment is
  not an application route as public. A community whose slug collides with one
  of those application segments would have its public page shadowed; slug
  allocation does not exclude them yet, and that is recorded as a follow-up
  rather than fixed inside this phase.
