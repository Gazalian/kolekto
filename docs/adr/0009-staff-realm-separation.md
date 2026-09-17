# 0009 — Kolekto staff hold a separate identity realm

**Status:** Accepted · 2026-09-17

## Context

In the previous system, staff and community users shared one authentication
realm. A Kolekto admin signed in with `supabase.auth.signInWithPassword`
against the same project, received the same `authenticated` role, and carried
the same kind of JWT as any contributor. The only thing separating a staff
member from an organizer was a row in `admin_users` matched on JWT email.

That allowlist was itself well built — database-backed, failing closed when the
table was unreachable, and never reading a user-editable field. The problem is
what sat behind it. `ReconcilePaymentPage` let a human decide which collection a
stranded payment belonged to and which tier it bought, by passing
`overrideCollectionId` and `overrideSelectedTierId` into the verification path.
`WithdrawalDetailPage` was the screen staff read bank details off to move real
money by hand.

Those are the two most sensitive actions in the company, and across 623
accounts there were **zero enrolled MFA factors**, with leaked-password
protection disabled.

## Decision

Kolekto staff hold a separate identity realm from community users.

- A `staff_users` table, distinct from any community role, with its own
  permission set. Membership is granted by another staff member with the
  `staff.manage` permission and is audited.
- **MFA is mandatory** for every staff account — enrolment is a precondition of
  the account working, not a setting.
- The staff console is a route group inside `apps/web` (ADR 0001), but its
  session is established separately, is shorter-lived than an officer session,
  and is IP-allow-listed.
- **Every staff action requires a reason string** and writes an audit row
  (SEC-27). Read access to a community's data is audited too.
- **The community can see it.** A community's owners see "Kolekto support
  viewed your members list on …" in their own audit log (AUD-03).

## Consequences

- A compromised community account cannot reach the internal console, and a
  compromised staff account cannot silently act — every action leaves a row the
  affected community can read.
- There is no staff action that marks an obligation paid without a Paystack
  transaction, and a pgTAP test asserts no such function exists (SEC-20a,
  CASH-02). Staff can investigate and correct through reversals; they cannot
  invent money.
- Support tooling costs more to build than reusing the officer app. That cost is
  accepted: the audit found that the cheaper path put payout authority behind a
  password on a shared realm.

## Not yet decided

Whether staff MFA is TOTP-only or also allows a registered-device check depends
on how the support team actually works, and on DEC-04's conclusions about
identity verification. The table and the mandatory-enrolment rule do not depend
on that answer.
