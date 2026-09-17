# 0001 — One repository, one deployable application

**Status:** Accepted · 2026-09-17

## Context

Kolekto's previous incarnation spanned five Git repositories. Three were live:
a Vite SPA (`kolekto-fe-old`), an Express API (`kolekto-be-old`) and an admin
SPA (`kolekto-admin-control-panel-1`). Two were dead (`kelekto-admin`, a stale
duplicate of the admin panel; `kolekto-africa-pay`, a 2025 prototype).

The money path did not live in any one of them. Payment initialization was in
the Express backend; payment *verification* was a 1,073-line Deno edge function
inside the **frontend** repository; the webhook was in the backend; settlement
was a Postgres function on a `pg_cron` schedule; withdrawals were in the
backend but executed by hand. Paystack was called from five separate sites
across three runtimes. Fee arithmetic existed as one TypeScript source vendored
by copy into two other runtimes, held together by a CI conformance job.

On 2026-08-06 a tiered collection charged every contributor the same amount
regardless of the tier they selected. The fix had been committed to Git on
2026-08-01. Production ran the pre-fix code for five more days because nothing
compared deployed edge-function source to committed source; the deployed
function was 867 lines behind `HEAD`. The post-mortem names the root cause as
"edge functions being an ungoverned, git-independent write path".

## Decision

One repository. One deployable application (`apps/web`), plus one long-lived
worker process (`apps/worker`) that shares its code. Internal packages for
domain logic, adapters, UI and validation.

The Kolekto staff console is a **route group inside `apps/web`**, not a
separate application — while holding its own identity realm (ADR 0009).

## Consequences

- There is exactly one place where money is written, one authorization
  codebase, one deploy pipeline and one set of secrets.
- The fee engine exists once. It is imported, never vendored.
- A second deployable would have to justify itself against this ADR. At the
  PRD's launch capacity (2,000 communities, 500,000 members, 50 payments per
  second — NFR-23) nothing does.
- The old repositories are frozen to security and reconciliation work, then
  archived. `kelekto-admin` is deleted; `kolekto-africa-pay` is archived now.

## Rejected alternatives

**Refactor `kolekto-fe-old`.** It is a client-rendered SPA whose `vercel.json`
rewrites every route to `index.html`. The PRD requires server-rendered public
pages with Open Graph tags (CON-03) because WhatsApp is the primary
distribution channel and its crawler does not execute JavaScript. That is not
a tuning problem; it is the wrong rendering model.

**Refactor `kolekto-be-old`.** The best-structured of the three, but it holds
only part of the money path, and its domain model is built on
`collections.user_id` (ADR 0004). Refactoring it still leaves a frontend to
rewrite.

**A monorepo preserving `apps/web` + `apps/admin` + `services/api`.** Preserves
the split that caused the incident, and lets the admin authorization model
drift away from the product's — which is exactly what happened before.

**Microservices with a separate ledger service.** Nothing in the PRD justifies
it; PRD section 41 explicitly forbids it.
