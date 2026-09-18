# 0011 — Application writes call `app` schema functions over a direct Postgres connection, never PostgREST RPC

**Status:** Accepted · 2026-09-18

## Context

ADR 0008 established that every write goes through a `SECURITY DEFINER`
function that re-checks `app.has_permission`, and that `authenticated` holds
no `INSERT`/`UPDATE`/`DELETE` grant on any table (20260917121100_grants.sql).
Phase 2 needed to build the functions that make that real: creating a
community, adding a member, redeeming an invite link, and the rest
(20260918140100_application_write_functions.sql).

The first version of this work put those functions in `app`, matching
`has_permission` and `get_public_collection` — and then calling one from a
Next.js server action via `supabase.rpc("create_member", …)` failed outright,
not with a permission error but a 404. `supabase/config.toml` sets
`[api] schemas = ["public"]`: PostgREST exposes `public` only. `app` is
invisible to it regardless of any `GRANT`, which is exactly what
20260917120000's own comment says about `get_public_collection` — "called by
the Next.js server, never by a browser holding a publishable key" — but that
sentence describes a *mechanism* the codebase had not yet built.

## Decision

`packages/db` holds the one direct Postgres connection in the application
(`packages/db/src/client.ts`), opened with `SUPABASE_DB_URL`
(`@kolekto/config#loadDatabaseUrl`, server-only, never a `NEXT_PUBLIC_` var).
Every call to an `app` schema write function goes through it, inside a
transaction that sets `role` and `request.jwt.claims` to impersonate the
acting user for that transaction only:

```sql
select set_config('request.jwt.claims', '{"sub":"<user id>","role":"authenticated"}', true);
set local role authenticated;
```

or `set local role anon` for the one anonymous write, `app.redeem_invite_link`
(MEM-05). This is the same impersonation `supabase/tests/*.sql` already uses
to simulate a caller — Phase 2 did not invent a new pattern, it reused the
one the test suite proved out.

`auth.uid()`, every RLS policy, and `app.has_permission` all read
`request.jwt.claims` the same way whether it arrived via a PostgREST-issued
JWT or was set directly here, so authorization behaves identically on both
paths. Ordinary reads (member lists, community details, officer terms) do
**not** go through this connection — they use the browser's own Supabase
client against `public` tables under RLS, unchanged from ADR 0008, both
because that is what lets Supabase Realtime subscribe to them (grants
migration's own stated reason for granting `authenticated` `SELECT`) and
because routing a read through a privileged connection would be strictly
more exposure for no benefit.

## Consequences

- A browser holding only the publishable key cannot reach `app.create_member`
  under any circumstance — not a missing grant away, not a policy away. The
  schema PostgREST serves is the boundary, not a grant that a future
  migration could loosen by accident (the exact failure class ADR 0008's
  grant-matrix test already guards against for tables).
- `SUPABASE_DB_URL` is a new secret with the same handling as
  `SUPABASE_SERVICE_ROLE_KEY`: server-only, asserted never to reach the
  client (`loadDatabaseUrl` throws if `window` is defined), never committed.
- Every `app.*` write function is exercised twice: once in
  `supabase/tests/07_application_write_functions.sql` by role-impersonating
  SQL, directly against the database; once through `packages/db/src/write.ts`
  by the application. Both use the same impersonation mechanism, so a pgTAP
  pass is a meaningful signal about the application path too, not a separate
  claim that happens to use similar words.
- A function created in `app` and never added to
  `20260918140200_application_write_grants.sql` is unreachable from both
  paths — PostgREST cannot see it, and `packages/db` will get a permission
  error the moment it tries to call it as `anon`/`authenticated` without
  `EXECUTE`. There is no third way to reach it that skips the grant.

## Rejected alternative

**Move the write functions to `public` and call them via `supabase.rpc()`.**
Simpler, and it is the default pattern most Supabase apps use. Rejected
because it reopens exactly what ADR 0008 closed: a function in `public` is
reachable by anyone holding the publishable key the moment it has an
`EXECUTE` grant, and the previous system's worst findings were all functions
one grant away from anonymous reach. Keeping the write surface in a schema
PostgREST cannot route to at all is a stronger guarantee than "the grant is
correct today."
