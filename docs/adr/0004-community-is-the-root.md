# 0004 — Community is the root aggregate

**Status:** Accepted · 2026-09-17

## Context

The previous schema's rule was `collections.user_id` — a person owns a
collection, and every wallet, withdrawal and contribution hangs off that
collection. Every RLS policy was a variant of `auth.uid() = collections.user_id`,
repeated inline roughly twenty times.

The PRD's founding principle (OWN-01) is the opposite: *no financial object
references a person as its owner.* The product promise — "the community owns
the record, not the treasurer" — is this schema rule and nothing else. If a
collection belongs to a user, then a treasurer graduating takes the community's
financial history with them, which is precisely the problem Kolekto exists to
solve.

A partial attempt existed: `workspaces`, `workspace_members` and
`workspace_invites` were built and tested (176 workspaces in the test project)
and **never shipped to production**. It was layered *over* collection-owned-by-user
rather than replacing it.

## Decision

`communities` is the root aggregate. `community_id` sits on almost every row
and is the tenancy key for RLS.

- Every user gets a **personal community** at sign-up (COM-01), so there is no
  second, weaker ownership path for informal collections.
- `users` hold logins. They appear on financial rows only as actors —
  `created_by`, `requested_by`, `approved_by` — never as owners.
- Authority comes from `officer_terms`: a person holds a role in a community
  for a period, with a start and an end. Removing an officer ends a term; it
  deletes nothing.
- `members` are records owned by the community, not user accounts. A member
  needs no password and may never log in.

## Consequences

- There is no refactoring path from the old schema. This is the single largest
  reason for a new repository (ADR 0001).
- A CI gate rejects a `user_id` column on any financial table.
- Leadership handover becomes a data operation on `officer_terms` rather than a
  migration of ownership, which is what makes it shippable in MVP.
- Migration of old data requires a human decision per collection: which
  community does it belong to, and who are its officers. For most, the answer
  is a personal community with one owner.
