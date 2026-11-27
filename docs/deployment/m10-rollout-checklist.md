# M10 rollout checklist — membership pass at checkout, removal locks, client IP

Written 2026-11-26 (session 67, Phase 5). Covers one release unit:

| Part | What | Where |
|---|---|---|
| M10 | checkout re-validates the membership pass | migration `20261125100000_m10_checkout_pass_revalidation.sql` + web/db code (commit `3096f45`) |
| Phase 3 | archive / restore / group removal take the member row lock checkout takes; archive revokes open passes | migration `20261126100000_member_removal_lock_hardening.sql` (no code change) |
| Phase 2 | membership-ID rate limit keyed on a trusted client IP only | `apps/web/lib/client-ip.ts`, `KOLEKTO_CLIENT_IP_SOURCE` |
| Phase 1 | Next.js `16.4.2` → `16.4.5` (security advisory) | `apps/web/package.json`, `package-lock.json` |

Nothing here changes payment amounts, fees, capture, settlement, withdrawals,
transfers, the ledger or reconciliation.

**Not part of this release:** `supabase/pending-migrations/` (A-1 plaintext
finalize, and a stale duplicate of the already-applied `20261123130000`). Never
copy either into `supabase/migrations/` as part of this rollout. The finalize
file's version (`20261123120100`) sorts before applied migrations, so pushing it
would need `--include-all`, which `staging.md` forbids; it needs a new version
number when it is approved.

## 1. Before anything is deployed

- [ ] Target identified in writing: staging (`kwolxuoeqwuedydxzncb`, Vercel) or
      production (AWS). Production stays blocked until §6 is resolved.
- [ ] `supabase migration list --linked`: every migration up to and including
      `20261123130000` is applied on the target. Stop if anything earlier is
      missing — this release assumes it.
- [ ] `supabase db push --linked --dry-run` lists exactly two migrations:
      `20261125100000` and `20261126100000`. Stop if it lists anything else.
- [ ] The two rollback scripts are at hand and reviewed:
      `docs/phase-4/m10-checkout-pass-revalidation-rollback.sql`,
      `docs/phase-4/member-removal-lock-hardening-rollback.sql`.
- [ ] Web secrets present in the host's secret store (not Git, not chat):
      `KOLEKTO_MEMBERSHIP_ID_SECRET` (unchanged; required since M9 — it keys
      both the stored membership-ID hashes and the rate-limit IP hash, so
      **rotating it invalidates every membership ID already issued**) and the new
      `KOLEKTO_CLIENT_IP_SOURCE`:
      - staging (Vercel): `vercel`
      - production (AWS): **leave unset** until `production.md` is approved
- [ ] CI green on the release commit: typecheck, lint (the known
      `MoneyPanel.tsx:422` error aside), unit tests, `npm run db:test`, build.

- [ ] Operational: every member of a community with a managed collection
      (`audience_mode <> 'public'`) has a membership ID issued before that
      collection is activated — without one a member cannot get a pass and
      checkout refuses. Organisers and support know that archiving a member now
      ends their open passes and restoring does not bring them back (the member
      re-enters their ID), and that an attempt created before a removal may
      still complete (Policy B — do not "fix" it by hand in the database).

## 2. Deployment order

The order matters because M10 changes the checkout function's argument list
(22 → 23).

1. **Migrations, both in one push:** `20261125100000` then `20261126100000`
   (`supabase db push --linked`). Each runs in its own transaction.
   - From this point until step 2 finishes, the old web code still calls with 22
     arguments; that resolves to the new function with no pass and **fails
     closed** on managed collections ("identify again"). Open collections are
     unaffected. Keep the window short.
   - `20261126100000` has no code dependency; it is safe with either web version.
2. **Web app** with `KOLEKTO_CLIENT_IP_SOURCE` already set (§1). If the variable
   is missing, every membership-ID check answers "temporarily unavailable" —
   safe, but managed checkout cannot start.
3. **Structure check** after the push: definition fingerprints vs local
   (`docs/migration/STAGING-ENVIRONMENT-VALIDATION.md` §5), including
   `app.create_payment_attempt` (23 arguments, one overload only) and the four
   Phase 3 functions.

Never run app first: the new web calls with 23 arguments and fails on every
checkout until the migration lands.

## 3. Verification after deploy (staging)

Use a harmless test collection, wrong IDs, and the fake payment provider only
(Paystack stays unconnected on staging — `staging.md` §3a).

- [ ] **Client-IP gate** — `docs/deployment/staging.md` §3a, all four steps
      (one hash for forged headers from one machine, a different hash from a
      second network, no `client_ip.unresolved` lines). Fail or inconclusive →
      stop; do not change the header or weaken the resolver.
- [ ] **M10 happy path:** member types their ID → confirm → checkout starts.
- [ ] **M10 refusal:** suspend (or rotate the ID of) that member in another tab
      after confirm, then press pay → refused, asked to identify again; no
      payment attempt row created.
- [ ] **Phase 3:** archive a member who holds a fresh pass, restore them, then
      try checkout with the old pass → refused (the pass was revoked at archive).
- [ ] No new lock waits: during the checks above,
      `select count(*) from pg_stat_activity where wait_event_type = 'Lock';`
      stays at 0 outside the moment of an intentional concurrent action.

## 4. What to watch (first 48 h)

| Signal | Normal | Act when |
|---|---|---|
| `client_ip.unresolved` log lines (reason code only) | none | any — `config_missing_or_invalid` means the variable; `header_missing` / `chain_too_short` means the proxy path differs from the documented one |
| Membership-ID "temporarily unavailable" reports | none | any |
| Checkout refusals `MEMBER_PROOF_EXPIRED` / `MEMBER_PROOF_MISMATCH` | rare (passes last 30 min) | a sustained rise — a cookie/pass handling regression |
| `membership.validation_lockout` rows in `public.audit_logs` (collection or community backstop; at most one per collection per hour) | none | any — the shared backstop is locking a whole community out |
| Long lock waits on `public.members` | none | waits over ~1 s; capture takes only the foreign-key KEY SHARE on `members`, which the new locks do not conflict with, so a wait points at an officer action vs checkout |

Logs must never contain raw membership IDs, pass tokens, cookies, JWTs, IPs or
secrets. Only hashes and reason codes are emitted by this code.

## 5. Rollback

Each part rolls back independently. No migration here writes a row, so no data
is lost by rolling back.

| Part | Steps |
|---|---|
| Phase 2 (client IP) | Unset `KOLEKTO_CLIENT_IP_SOURCE` and redeploy → fail closed. To restore the old (spoofable) behaviour, redeploy the previous web build. No database step. |
| Phase 3 | Run `docs/phase-4/member-removal-lock-hardening-rollback.sql` (it has its own `begin … commit`), then `delete from supabase_migrations.schema_migrations where version = '20261126100000';`. Verified locally 2026-11-26: definitions, comments and ACLs return to the exact pre-migration fingerprints. Passes revoked by archives while it was live stay revoked (safe direction). |
| M10 | **Web first** (previous build), **then** `docs/phase-4/m10-checkout-pass-revalidation-rollback.sql` and `delete from supabase_migrations.schema_migrations where version = '20261125100000';`. |
| Next.js | Redeploy the previous build; revert the two package files. |

Rolling back M10 does not require rolling back Phase 3, and vice versa.

## 6. Open items that block production (not staging)

1. **AWS front-end architecture** for the client IP — `production.md` §4.
   Until approved, production leaves `KOLEKTO_CLIENT_IP_SOURCE` unset and
   membership-ID checks (hence managed checkout) are unavailable there.
2. **Vercel staging gate** (§3, first bullet) has not run yet — it can only run
   on a real staging deploy.
3. **Production enablement.** Membership-ID verification and managed checkout
   must not be enabled in production until the AWS trusted-proxy configuration
   has passed `production.md` §5 (including the direct-origin test). Accepting
   these items for a PR is not approval to deploy to production.

## 7. Local evidence (itest, 2026-11-26)

- `20261126100000` applied to **local itest only** (session 73; one guarded
  transaction, recorded once, 159 migrations). After it: pgTAP 79 (47), 78 (44),
  76, 75, 07, 09, 10 pass, including Policy B (an attempt created before the
  archive still captures and is attributed to the member).
- Two-session race on the committed schema: with checkout's `FOR SHARE` held,
  `remove_member_from_group`, `set_member_groups` and `archive_member` each wait
  on the member row. Before Phase 3, `remove_member_from_group` completed inside
  that window. `restore_member` was not raced (pgTAP 79 covers it).
- The rollback script returns the four functions' definitions, comments and
  ACLs to their exact pre-migration fingerprints (checked in a rolled-back
  transaction).
- Managed-checkout browser e2e (`contributor.spec.ts`, "a managed collection")
  1/1 PASS against an itest build. It stops at the payment review: Pay/capture
  is covered by pgTAP 79 and the worker lane (49/49 `--without-smtp`), not by a
  browser.
- Not verified locally: Vercel and AWS header behaviour (only the gates in
  `staging.md` §3a and `production.md` §5 can show it).
