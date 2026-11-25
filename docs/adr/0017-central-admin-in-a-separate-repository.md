# 0017 — The central Kolekto admin lives in a separate private repository

**Status:** Proposed · 2026-11-22 (not accepted; needs the owner's approval)

Supersedes, if accepted: the admin part of [0001](0001-one-repository-one-deployable.md) ("the Kolekto staff
console is a route group inside `apps/web`") and the same sentence in [0009](0009-staff-realm-separation.md).
Everything else in 0001 and 0009 stands.

## Context

ADR 0001 kept the staff console inside `apps/web` because the previous system's split let the admin's
authorization model drift from the product's. Product decision D-O (2026-11-22) moved the console to `apps/admin` in
this monorepo without a superseding ADR. The owner now prefers a separate private repository, `kolekto-admin`, so the
console has its own codebase, release cycle, deployment pipeline and access list. The console will handle KYC,
community verification, bank-account review, withdrawal monitoring, reconciliation, platform settings and admin
management.

A separate repository is not a security control in itself. The real controls are in the database and in the
connection the admin server uses.

## Decision (proposed)

1. The admin UI and its thin server live in `kolekto-admin`, private.
2. **One source of truth stays here.** Schema, migrations, permissions and every admin database function (`admin.*`)
   live in the `kolekto` repository with their pgTAP tests. `kolekto-admin` has no migrations and no business logic;
   it never computes money.
3. The admin server connects with its own Postgres role, which can only execute `admin.*` functions. Those functions
   are not executable by `anon`, `authenticated` or the web app's role. Each one checks platform permission, `aal2`,
   step-up freshness for sensitive actions, and a reason, and writes an append-only audit row.
4. Shared types come from the deployed schema (generated) and a small published contract package (permission keys,
   enums, input/output schemas, error codes) — no copied logic.
5. Kept from ADR 0009: a staff identity separate from community roles, mandatory MFA, shorter sessions, IP
   allow-listing, a reason on every staff action, audited reads, and staff access visible to the affected community.
   The table proposed in 0009 as `staff_users` is named `platform_admins` (product doc C6).

## Consequences

- Two repositories, two pipelines, two sets of secrets. The admin never receives the web app's secrets.
- The drift risk named in 0001 is handled by keeping schema and permissions in one place and by a contract test in
  this repository's CI.
- The separation only holds if the web app's database role cannot reach the admin role. That must be verified per
  environment before the admin foundation migration (product doc F3.4, Q13).

## Rejected alternatives

- **`apps/admin` in this monorepo (D-O).** Simpler sharing, but the owner wants separate access control and release
  lifecycle for the most sensitive operations.
- **Extending the legacy admin panel.** Bound to the legacy database and API (product doc C2).
