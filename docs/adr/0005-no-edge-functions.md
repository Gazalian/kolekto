# 0005 — No Supabase Edge Functions

**Status:** Accepted · 2026-09-17

## Context

The previous system ran thirteen deployed edge functions. Eight had
`verify_jwt: false`, including `create-collection`, `update-collection`,
`delete-collection`, `initiate-paystack-payment` and `verify-paystack-payment`.
Each parsed the `Authorization` header itself, so authorization was delegated
to hand-rolled code in every function rather than enforced by the platform.

They were deployed by hand. The workflow that checks them says so:

> deploys stay a human-run CLI command per the existing manual runbook, which
> moved deploys to manual-only after two prior incidents of bad
> automated/agent-driven deploys.

That is how production ran payment-initialization code 867 lines behind `HEAD`
for five days in August 2026. The remedy already begun by the previous team was
to move payment initialization *out* of the edge function and into the backend,
described in their own post-mortem as "structurally eliminating the root
cause — edge functions being an ungoverned, git-independent write path."

They also forced the fee engine to be **vendored by copy** into Deno, creating
a third copy of money arithmetic that a CI conformance job had to police.

## Decision

No Supabase Edge Functions. Not for webhooks, not as cron targets, not for
anything.

- Webhooks are route handlers in `apps/web`.
- `pg_cron` jobs call authenticated route handlers, not functions.
- Background work runs in `apps/worker`, which imports `packages/domain`
  directly and therefore cannot drift from the app.

## Consequences

- Everything server-side deploys through one CI pipeline. No artefact can reach
  production by hand, which closes the August 2026 incident class permanently.
- The fee engine is imported, never vendored. The duplication guard remains as
  a second line of defence.
- Cold-start latency on the webhook path moves from Deno to Node. At the PRD's
  target of 50 payments/second (NFR-23) this is not a constraint, and the
  webhook does almost nothing anyway: verify the signature, store the raw
  event, acknowledge, enqueue.

## What replaces the one thing edge functions were good at

`pg_cron` calling a function inside the database, with no network hop, was
genuinely convenient. It is replaced by `pg_cron` + `pg_net` calling a route
handler authenticated with a shared secret held in the database's vault — the
same pattern the old `scheduled-payment-recovery` job used, minus the
unauthenticated endpoint.
