# Architecture decision records

One file per decision, numbered, never edited after acceptance — a decision
that changes gets a new ADR that supersedes the old one, and the old one stays
so the reasoning survives.

| # | Decision | Status |
|---|---|---|
| [0001](0001-one-repository-one-deployable.md) | One repository, one deployable application | Accepted |
| [0002](0002-supabase-as-system-of-record.md) | Supabase Postgres as the system of record | Accepted |
| [0003](0003-integer-kobo.md) | All money is `bigint` kobo, end to end | Accepted |
| [0004](0004-community-is-the-root.md) | Community is the root aggregate; no financial object references a person | Accepted |
| [0005](0005-no-edge-functions.md) | No Supabase Edge Functions | Accepted |
| [0006](0006-ledger-deferred.md) | The ledger is designed now and built after DEC-01/DEC-03 | Accepted |
| [0007](0007-environment-isolation.md) | Three environments, migration-only schema changes | Accepted |
| [0008](0008-authorization-model.md) | Authorization is RLS + `has_permission`, enforced twice | Accepted |
| [0009](0009-staff-realm-separation.md) | Kolekto staff hold a separate identity realm | Accepted |
| [0010](0010-tiers-are-rows.md) | Tiers are rows with identity; an amount is never an identifier | Accepted |
| [0011](0011-application-writes-via-direct-connection.md) | Application writes call `app` schema functions over a direct Postgres connection, never PostgREST RPC | Accepted |
| [0012](0012-collections-stop-at-the-money-boundary.md) | Collections stop at the money boundary, and say so | Accepted |
