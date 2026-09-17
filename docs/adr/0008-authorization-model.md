# 0008 — Authorization is RLS plus `has_permission`, enforced twice

**Status:** Accepted · 2026-09-17

## Context

Authorization in the previous system was `auth.uid() = collections.user_id`,
written inline in roughly twenty RLS policies, with no role model at all. The
only gradation was a `collection_access_grants` row carrying
`can_view_contributors` and `can_view_earnings` booleans.

Three specific failures came out of it:

- **Policies and grants disagreed.** `contributions` carried a policy called
  "Anyone can insert contributions" for role `public` with `WITH CHECK (true)`.
  It was inert only because the table grant withheld `INSERT` — one `GRANT`
  statement away from letting anyone fabricate a contribution. `wallets` and
  `payment_admin_actions` carried equivalents.
- **`profiles.role` was self-editable.** Two overlapping permissive UPDATE
  policies existed; the weaker had no `WITH CHECK`, so it defeated the
  stricter one's role-immutability guard. Nothing authorized on that column, so
  it was a landmine rather than a live breach — but it was one feature away.
- **Seven SECURITY DEFINER views and three SECURITY DEFINER functions were
  granted to `anon`,** bypassing RLS entirely and exposing cross-tenant payment
  data and contributor names and emails.

## Decision

Permissions are named strings. Roles map to permissions in `role_permissions`.
A single SQL helper answers every question:

```sql
app.has_permission(p_community_id uuid, p_permission text) returns boolean
```

It reads the caller's **active** officer terms — `ended_at IS NULL` and
`started_at` in the past — joins `role_permissions`, and applies collector
scope. It is used in every RLS policy and re-checked in every server function.

Every permission is therefore enforced **twice on the server**: once by Postgres
RLS, once by the server function performing the action (SEC-13, SEC-17). The UI
only hides what the server would refuse.

## Rules

1. **Never authorize on user-editable data.** There is no `role` column on a
   user profile. Authority comes from `officer_terms`, which only an owner can
   write, and every grant, change and removal is audited (ROLE-04).
2. **Policies and grants must agree.** A pgTAP test asserts the grant matrix:
   `anon` and `authenticated` hold `SELECT` on a named allowlist and nothing
   else. A policy granting a write the grant withholds is a bug, not a safety
   net.
3. **Money tables are not writable by client roles at all** (SEC-14).
4. **Public access goes through security-definer functions returning whitelisted
   fields** (SEC-12). No anonymous table reads, and no SECURITY DEFINER views.
5. **Object IDs from a client never imply tenancy** (SEC-18). The community is
   re-derived from the object every time.
6. **Permission checks run per request** and are never cached in a token for
   longer than five minutes, so an officer who loses a role at handover loses
   access immediately (HND-02).

## The role model

Five officer roles, from the PRD's permission matrix (section 2.2): `owner`,
`admin`, `treasurer`, `collector`, `viewer`. Plus two non-officer participant
types that hold no officer permissions at all: `member` and `contributor`.

A person holds **one officer role per community at a time** (ROLE-01) and may
hold roles in many communities. A community can never drop below one active
owner (ROLE-02), enforced by a constraint trigger rather than by application
code.

## Consequences

- RLS is testable, and tested: pgTAP asserts allowed and denied reads and writes
  for every role against every table (SEC-16).
- Adding a role is a data change in `role_permissions`, not a policy rewrite.
- Collector scope — a list of collections or member groups — is enforced in RLS
  by joining through the officer's scope, not by filtering in the application.
- Because authority is time-bounded, leadership handover is a data operation
  rather than a migration of ownership, which is what makes it shippable in MVP.
