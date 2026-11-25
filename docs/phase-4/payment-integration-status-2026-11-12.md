# Payment integration — status and next steps

**Date:** 2026-11-12  
**Branch:** `feat/payment-receipts-alarms` (sessions 20–24 committed, session 25 uncommitted; cut from `main`, which holds PR #33 merged 2026-11-14)  
**Last commits** (on `main` after the merge):

- `b99660d` Merge pull request #33 from Gazalian/feat/payments-foundation
- `92fe539` docs(payments): status after sessions 14-18
- `8f932bb` fix(itest): itest:reset waits for storage like itest:up
- `a868fc2` feat(payments): local Paystack test opt-in and sandbox runner
- `ae2c215` feat(payments): abandoned checkout waits for its hold
- `771a1a0` fix(adapters): read Paystack webhook id from data.id
- `4063739` docs(payments): correct session 12 status — PR #31 already merged
- `3668131` feat(payments): create member obligation on capture for all-members/groups
- `46b6e16` feat(domain): M8.3b resolver hardening — stock, applied, status, ceiling

**Authoritative docs** (read these before changing anything):

- [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) — full architecture, blueprints, security report, roadmap
- [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — decision register (authoritative for all financial choices)
- [`docs/phase-4/pre-integration-readiness-2026-11-10.md`](pre-integration-readiness-2026-11-10.md) — readiness checklist

---

## Latest report — read this first

> Updated at the end of every work session. Replace this whole section each time; older detail lives in the sections below.

**Last updated:** 2026-11-25, session 61 — **M10 applied on local itest AND local dev (owner approved both). Staging and production NOT applied. Nothing committed.**

### Session 61 (end) — local dev synchronised and M10 applied (owner approved; nothing committed)

- Method: `docker exec supabase_db_kolekto psql -1 -v ON_ERROR_STOP=1`, one file per transaction, each file's
  `schema_migrations` row inserted inside that same transaction (recorded only if the whole file succeeded;
  `statements` = the file text). Session-only `lock_timeout 15s`. Not `supabase migration up`; the CLI link in
  `supabase/.temp` was not read or changed. Before each file: dev cluster `system_identifier`, no itest marker,
  expected predecessor is latest, target and finalize unrecorded, per-file preconditions — all true.
- Applied, in order, all succeeded: `20261122130000` (1.5 s), `20261122140000` (7.3 s), `20261123100000` (2.5 s, own
  committed transaction), `20261123100100` (2.1 s), `20261123120000` (0.9 s), `20261123130000` (1.5 s), `20261125100000`
  M10 (0.6 s). After the six, dev's schema matched itest except M10 and the known pre-existing drift
  (`claim_withdrawal_transfers` comment, `notification_send_limits` local limits, `reserve_email_attempt` null check,
  auth `factor_type`, itest-only worker policies).
- Not applied / not recorded: finalize `20261123120100`; the six 18–20 Nov financial migrations (objects present,
  history still missing — separate decision).
- Verified: 152 migrations, latest 20261125100000, each approved version recorded once; one `create_payment_attempt`
  (23 args, 1 default, SECURITY DEFINER, `search_path=""`, ACL postgres only; anon/authenticated/service_role cannot
  execute). 23 data fingerprints of pre-existing tables (users, communities, members, collections, obligations,
  intents, attempts, contributions, ledger, settlements, withdrawals, transfers, bank accounts, officer terms, audit,
  permissions, role_permissions, buckets, migration history) identical before/after. New rows only: 4 permissions,
  4 owner role_permissions, `profile-avatars` bucket. Membership tables empty.
- Smoke (rolled back, fake provider): open collection, no proof → accepted, no member; stray token or member →
  MEMBER_NOT_EXPECTED; managed, no pass → MEMBER_PROOF_EXPIRED; unknown token → MEMBER_PROOF_EXPIRED; fresh test
  pass → accepted with the identified member; pass not consumed. Nothing persisted.
- Effect: dev has 0 membership IDs, so managed checkout on dev needs an officer to configure and issue IDs first.

Session 60 and earlier detail below unchanged.

### Session 61 — M10 implementation preparation (owner approved D1–D7; nothing applied or committed)

**Done.**
- Migration staged: `supabase/pending-migrations/20261125100000_m10_checkout_pass_revalidation.sql`. Drops the
  22-arg `app.create_payment_attempt`, recreates it with a 23rd arg `p_access_token text default null`, re-revokes
  EXECUTE from public/anon/authenticated, updates the function and `membership_access_grants` comments. Managed
  branch order: `members` row FOR SHARE → eligibility (`get_collection_member_context`, unchanged message) →
  `resolve_membership_access_grant` (null → MEMBER_PROOF_EXPIRED) → must equal `p_member_id` (else
  MEMBER_PROOF_MISMATCH). Only the pass-resolved member id is written. Open collections refuse any member or
  token (MEMBER_NOT_EXPECTED). The grant is not consumed. Fee, amount, idempotency and stock logic unchanged
  (body diffed against `20261111100100:259-651`: only the intended lines differ).
- Rollback SQL (not a migration): `docs/phase-4/m10-checkout-pass-revalidation-rollback.sql` (verbatim 22-arg body,
  original comments, schema_migrations delete). Revert code first.
- Code: `packages/db/src/payments.ts` and `packages/payments/src/orchestrator.ts` forward `accessToken`;
  `membership-pass-helpers.ts` keeps the pass after confirm (D5); `actions.ts` reads the token only from the
  pass cookie, refuses before checkout without it, maps PROOF codes to one generic message, clears both cookies
  and asks to re-identify; mismatch logs collectionId only. `ContributeForm.tsx` returns to the ID step with the
  error shown.
- Tests: new pgTAP `78_checkout_pass_revalidation.sql` (44); fixture helper `pg_temp.pass_for` in 52/53/56/60/61
  (no assertion lines changed); new vitest `checkout-membership-pass.test.ts`; worker fixture
  `issueMembershipPass` used by the orchestrator integration test and the Paystack sandbox script.

**Verified.**
- tsc --build + web/worker `tsc --noEmit` PASS; ESLint on changed web files PASS; web vitest 27 files / 391 PASS;
  packages/payments 64/64 PASS; worker unit 825/825 PASS; packages/db 6/7 (one pre-existing harness failure:
  `membership-pass.test.ts` needs `--experimental-test-module-mocks`; passes 18/18 with it; file not touched).
- itest dry-run (each pgTAP file in one transaction: begin; M10; test body; rollback): 78 PASS 44/44; negative
  control (78 without M10) FAILS as expected (23-arg function missing). Full suite 77 files: 68 PASS, 9 FAIL —
  14, 18, 20, 23, 57, 58, 62, 63, 65 — and the same assertions fail identically WITHOUT M10 (pre-existing itest
  data state: accumulated ledger/settlement rows; not caused by M10).
- Lock check (two sessions, rolled back): with M10 a checkout waits behind an in-flight member UPDATE and vice
  versa (both hit a 3 s lock_timeout); without M10 neither waits. No deadlock.
- After the dry-run: schema_migrations 157 / latest 20261123130000, function definitions hash, column hash,
  grants table comment, ACL and row counts byte-identical to the pre-run snapshot; no open probe sessions, no
  prepared transactions. Dev stack, staging and production not touched.

**NOT RUN.** Worker itest integration lane and browser e2e (host memory; lane needs its own approval).

**Residual risks.** Capture does not re-check the member; group-audience removal is not serialised with
checkout; the pass cookie is signed, not encrypted; one pass cookie per browser (a second collection overwrites
it → re-identify); deploy order for later environments is function first, then code (old code → new function
works for open collections only; managed checkout would refuse until the code ships).

**Applied on itest (owner approved 2026-11-25, same session).**
- Pre-checks: itest migrations copy byte-identical to `supabase/migrations/` (SHA-256 per file); no link artifacts in
  `supabase-itest/supabase/.temp`; itest state identical to the pre-dry-run snapshot; `migration list` showed only
  20261125100000 pending.
- Moved the file from `supabase/pending-migrations/` to `supabase/migrations/` (SHA-256 unchanged) and copied it to the
  git-ignored itest copy. Applied with `npx supabase migration up --local --workdir supabase-itest` (exit 0). No reset.
- After: schema_migrations 158, latest 20261125100000; A-1 finalize 20261123120100 still NOT applied (still in
  pending-migrations). One overload, 23 args, 1 default, SECURITY DEFINER, `search_path=""`; anon / authenticated /
  service_role cannot EXECUTE (ACL unchanged: postgres only). Columns, row counts and grant fingerprint unchanged; only
  the function hash and the grants table comment changed.
- Full pgTAP on the applied schema: 68/77 PASS (01, 02, 03, 52, 53, 56, 60, 61, 78 all PASS); the 9 known failures
  (14, 18, 20, 23, 57, 58, 62, 63, 65) are assertion-for-assertion identical to the pre-M10 run. Suite left no rows.
- NOT RUN: worker itest integration lane and browser e2e — host had 0.22 GiB physical memory free (27.4/31.9 GiB
  committed). Not attempted.
- Rollback on itest (needs approval): revert code first, then run `docs/phase-4/m10-checkout-pass-revalidation-rollback.sql`.
- Dev database: NOT applied. The working-tree code now calls the 23-arg function, so any web server running this
  code against the dev DB (which still has only the 22-arg function) will fail EVERY checkout, open and managed, with
  "function does not exist". Code at HEAD is unaffected. Applying M10 to dev needs its own approval.

**Dev apply — STOPPED before any change (owner approved dev-only apply, 2026-11-25).** Read-only checks found two blockers:
1. `supabase/.temp` (the dev workdir) contains `project-ref`, `linked-project.json` and `pooler-url` (dated 2026-09-28):
   the CLI considers the main project linked to a hosted Supabase project. The owner's condition "not linked" fails.
2. The dev DB (container `supabase_db_kolekto`, port 54322) is at 145 migrations, latest `20261122120000`. Six migrations
   between it and M10 are not applied (`20261122130000`, `20261122140000`, `20261123100000`, `20261123100100`,
   `20261123120000`, `20261123130000`), and M10 depends on them (`membership_access_grants` and
   `app.resolve_membership_access_grant` do not exist on dev). `migration up` would apply all seven; M10 alone would fail.
Nothing was applied; the dev DB still has the 22-arg function.

**Next (needs the owner).** (1) Decide on the dev link (inspect and unlink deliberately, or apply with a direct local
DB URL that bypasses the link). (2) Decide whether dev should receive the six prerequisite migrations (includes A-1
`20261123120000`, which on itest needed the plaintext backfill — dev has no `membership_ids` rows, so no backfill) before
M10. (3) Free memory, then run the worker integration lane and `contributor.spec` managed on itest. (4) Commit when ready.

**Paste-ready prompt for the next session:**

> Session 62. Read the session 61 block in docs/phase-4/payment-integration-status-2026-11-12.md. M10 is applied on
> local itest only. If host memory allows (check free physical memory first; stop if under ~2 GiB), run the worker
> itest integration lane and contributor.spec managed once each, no retries on environment failures. [Owner: say whether
> to apply M10 to the local dev database.] Fake payments only; no staging/production; no reset; no commit, push or deploy.

### Session 60 — M10 discovery and plan review (read-only; nothing changed except this doc)

**Done.** Read the M10 proposal, the 2026-11-22 non-member design §3.3, and the live code: `membership-pass.ts`,
`membership-pass-helpers.ts`, `contributor-session.ts`, `actions.ts` (submit path), `packages/payments`
orchestrator, `packages/db/src/payments.ts`, `app.create_payment_attempt` (only definition:
`20261111100100_payment_functions.sql:259`), `app.resolve_membership_access_grant`, the revoke / rotate /
suspend functions, the 14 pgTAP callers, the worker fixtures, `02_grant_matrix`, `03_money_invariants`,
`scripts/itest/itest.mjs`, `redact.mjs`. No DB connection was opened.

**Proposal confirmed.** The gap is real: `completeMembershipPass` clears the pass (`membership-pass-helpers.ts:79`);
checkout trusts only the 1-hour session cookie (`actions.ts:371`) and SQL re-checks only
`get_collection_member_context` (`20261111100100:367-381`). A revoked or rotated membership ID, a revoked
grant, or an expired 30-minute pass does not stop checkout today. There is exactly one production caller.

**Corrections to the proposal (found this session).**
1. *Deadlock.* The proposed `for share` on the grant row is taken before any member-row lock. Suspend,
   revoke and rotate lock `members` FOR UPDATE and then update grants. Checkout's later inserts into
   `contribution_intents` / `payment_attempts` take FOR KEY SHARE on `members` (FK). That is a lock-order
   cycle (Postgres would abort one side). Fix: lock the session member's `members` row FOR SHARE first,
   which is the order the revokers use, and drop the grant-row lock. All five grant-revoking paths and
   archive/merge update the member row, so they serialise on it.
2. *Assertion changes.* With the proposal's check order, `52_payments.sql:372` and
   `53_obligation_on_capture.sql:329` would change from MEMBER_NOT_ELIGIBLE to MEMBER_PROOF_EXPIRED. Keep
   today's eligibility check first, then the pass check, and both assertions stay unchanged.
3. *Rollback file location.* A `…_m10_….rollback.sql` file inside `supabase/migrations/` would be read
   by the CLI as a migration. Use the repo convention instead: rollback SQL in the migration header, and
   the full 22-argument body in a file outside `migrations/`.
4. *Staging convention + a missed fixture.* Sessions 51 and 52 wrote the migration in
   `supabase/pending-migrations/`, dry-ran it on itest in a rolled-back transaction, and moved it only
   after approval. `itest:reset` is the only scripted apply path and is not allowed. The proposal also
   missed `apps/worker/test/support/itest-payment-flows.ts`, which must create grants for managed flows.

**Next (needs the owner).** Answer decisions D1–D7 in the session 60 chat report. On approval: write the
migration in pending-migrations, make the code and test changes, and dry-run on itest (rolled back). A
separate approval is needed to move the migration into `migrations/` and apply it on itest.

**Paste-ready prompt for the next session:**

> Session 61. Read the session 60 block and docs/phase-4/m10-checkout-pass-revalidation-proposal-2026-11-24.md.
> [Owner: state D1–D7.] Implement M10 as revised in session 60 (member-row FOR SHARE lock, eligibility check before
> pass check, rollback outside migrations/). Migration in supabase/pending-migrations/20261125100000_m10_checkout_pass_revalidation.sql;
> dry-run on local itest in a rolled-back transaction only (no itest:reset, no apply). Code: packages/db, packages/payments,
> membership-pass-helpers, actions.ts, ContributeForm. Tests: pgTAP 78 + fixture helpers in 52/53/56/60/61, vitest, tsc,
> eslint. Worker fixture update (typecheck only unless the itest lane is approved). Fake payments only, no commit.

### Session 59 — A2.6 close-out, token incident, M10 proposal (nothing committed)

**A2.6 outcome (closed by the owner, 2026-11-24).**
- Verified: browser QA scenarios A–F all PASS (session 57: generic errors for unknown/revoked/suspended/
  outside-audience IDs, masking, no ID/UUID/full contact in DOM/URL/storage/logs, httpOnly Lax cookies,
  reject clears pass, cross-collection pass and session refused, mobile). payments.spec 9/9 on itest
  (fixed flaky once, slow server). DB: managed fake captures 3 → 3 contributions all attributed to the
  right member; public 5 → 5 with no member; failed/declined/cancelled → 0; 0 non-fake attempts.
  forge test PASSED (session 57); managed test passed every ID assertion (session 57).
- BLOCKED by Docker/host memory (environment, NOT product bugs): contributor.spec managed / forge / group /
  recurring / open and collections.spec golden path / tiered in a full green run. Every recent failure
  is `signInAsNewUser` → itest Auth 504 "context deadline exceeded" before any membership-ID step (host
  0.31 GiB free, 27.5/31.9 GiB committed). Not retried further; dev stack not stopped (owner decision).
- Test changes kept (uncommitted): `tests/e2e/helpers/membership-id.ts`, `helpers/nav.ts`
  (`sidebarLink`), `helpers/wizard.ts`, `helpers/payments.ts` (`seedMembershipId`), contributor /
  collections / payments specs; launch config `kolekto-web-e2e-itest`.
- Legacy specs still on the old "+ New community" label (fail at `createCommunity` after the uncommitted
  communities redesign): audience, auth-community-member, collection-creation, collection-types,
  field-deletion-safety, groups, invitations. Also: stale "Find yourself on the list…" server copy;
  officer member page hydration mismatch (relative time).

**Token incident — resolved.** During a diagnostic curl signup on itest, an ad-hoc `sed` redaction did
not match and the first 140 of 931 characters of a throwaway itest user's access token (JWT header +
part of the payload; no signature, no refresh token) were printed into the session transcript. Not a
usable credential. Follow-up: token issuer confirmed `127.0.0.1:55421` (itest only); its session was
still live (expiry 16:35 UTC), so the probe user's session was revoked in itest (`auth.sessions` row
deleted → refresh token gone); verified refresh → HTTP 400 and `/auth/v1/user` → HTTP 403. The local
response file holding full tokens (`%TEMP%su.json`) was deleted. Searched the repo (incl. git-tracked
files), scratchpad, session transcripts and itest Auth/Kong/REST/DB container logs for the signature
and refresh token: no hits. The 140-character fragment remains in the local transcript file only.
Fix: new `scripts/itest/redact.mjs` (stdin filter, fails closed: JSON credential keys replaced at any
depth; JWT / `sb_*` / Paystack keys / Bearer / postgres URLs masked; any line still credential-like
dropped whole; never prints a prefix). Tested with fake tokens: 0 token characters in output. Rule:
auth responses go to a file and only status/metadata is printed, piped through `redact.mjs`.
QA data from this session: one auth user `probe-<timestamp>@example.test` in itest (session revoked).

**M10 proposal (approved for planning only).** `docs/phase-4/m10-checkout-pass-revalidation-proposal-2026-11-24.md`:
`p_access_token text default null` added to `app.create_payment_attempt` (drop + create, revoke
re-applied); on managed collections SQL resolves the pass itself with
`app.resolve_membership_access_grant` (grant row share-locked), requires it to equal the session's
member (`MEMBER_PROOF_MISMATCH`), and writes only the pass-resolved member; expired/revoked/suspended/
other-collection/invalid → `MEMBER_PROOF_EXPIRED` (one generic message in the UI). Web keeps the pass
cookie until checkout instead of clearing it on confirm. Public collections unchanged. No capture,
settlement, ledger, withdrawal, transfer or reconciliation change; no guests; no new columns.
Five pgTAP files need a grant-minting fixture helper (no assertion changes).

**Not run this session.** No migration written/applied; no checkout code changed; no unit/e2e run after
the redaction script (it is a standalone script, tested by hand). Checkout attribution is still NOT
fully secured until M10 is implemented and verified.

**Next (needs the owner).** Review the M10 proposal §13 decisions. On explicit approval: implement on
itest only, acceptance = proposal §9 tests.

**Paste-ready prompt for the next session:**

> Session 60. Read the session 59 block and docs/phase-4/m10-checkout-pass-revalidation-proposal-2026-11-24.md.
> [Owner: state decisions 1–4 from §13.] Implement M10 on local itest only as proposed: migration (not on
> dev/staging/prod), packages/db + packages/payments passthrough, web pass-cookie + error mapping, pgTAP
> 78 + fixture helpers in 52/53/56/60/61, unit tests. Run pgTAP 03, 40–78, vitest, tsc. Fake payments only.
> No guests, no capture/settlement/ledger change, no A-1 finalize, no commit.

### Session 58 — A2.6 final verification (nothing committed)

**Environment.** Branch `feat/payment-receipts-alarms`; itest healthy (157/157 migrations identical,
email pause on). Docker NOT enlarged: 4 CPUs / 3.77 GiB, dev stack (9 containers) + itest (7) both up.
Real bottleneck is the HOST: 4 logical CPUs, 7.9 GiB RAM, 0.4–0.7 GiB free, 23.9/31.9 GiB committed;
WSL VM only ~746 MB resident (paged out). itest Auth→DB `dial tcp … i/o timeout` during load; signup
(bcrypt, heaviest call) fails 7–23 s. Postgres connections fine (24/100). `.next-e2e` build current
(no source newer than BUILD_ID), bakes itest URL only; `kolekto-web-e2e-itest` sets fake provider.

**Selectors (semantic, replacing session 57b `.first()`).** New `tests/e2e/helpers/nav.ts`
`sidebarLink(page, name)` = `complementary` → `navigation` → link (AppShell `<aside><nav>`; the only
`<aside>` in the app). Used for "Members"/"Collections" in contributor + collections specs and in
`openWizard`. "New collection" = `main` link, only after URL is `/c/{slug}/collections` (overview
shortcuts at `page.tsx:90` / `overview-parts.tsx:311` are deliberate, not defects). Contributor spec
recurring/open tests now call `openWizard`. `issueMembershipId` row click targets
`a[href^="/c/{slug}/members/"]`. Pre-existing `.first()` on "Add member"/"Close" (in HEAD) untouched.

**E2E results (itest, fake only).**
- payments.spec (120 s budget): 9/9 pass — fixed (flaky: 1st attempt confirm request still pending
  after 30 s, buttons correctly disabled; retry passed 41.8 s; alone earlier 25.9 s), open, tiered,
  items, ticketing, fundraiser, recurring, declined, cancelled. Tests assert contribution.member_id =
  seeded member, obligation paid, no 2nd contribution on callback reload.
- DB check (last 90 min): managed completed 3 attempts → 3 contributions, all with member, 0 mismatch
  vs attempt member, max 1 per attempt; public completed 5 → 5, none with member; failed/initialized
  → 0 contributions. 0 non-fake attempts in 12 h.
- contributor.spec + collections.spec: every attempt (managed ×5, forge ×1 this session) failed in
  `signInAsNewUser` / `addMember` on itest Auth 504/500 before any membership-ID step. NOT verified
  this session: managed (480 s), group, recurring, open contributor tests; collections golden path +
  tiered. (Session 57: forge PASSED; managed passed every ID assertion before old 300 s budget.)

**Gates.** apps/web tsc clean; vitest 26 files / 379 tests pass; ESLint on changed web files clean;
strict tsc of e2e specs + all helpers clean.

**Unrelated, recorded not fixed.** 7 specs still use "+ New community" (audience,
auth-community-member, collection-creation, collection-types, field-deletion-safety, groups,
invitations). Officer member page hydration mismatch (relative time).

**M10 (unchanged).** Checkout trusts the contributor-session cookie alone; M10 must revalidate the
membership pass and check it resolves to the same member. Checkout attribution is NOT fully secured.

**Next (needs the owner).** Free host RAM (close Chrome/VS Code/other apps, or more RAM), then run
contributor.spec + collections.spec. Then review A2.6; M10 only on separate approval.

**Paste-ready prompt for the next session:**

> Session 59. Read the session 58 block. I have freed host memory. Finish A2.6 only: start launch config
> `kolekto-web-e2e-itest`, run contributor.spec.ts then collections.spec.ts (retries 1) with
> MAILPIT_URL=http://127.0.0.1:55424, SUPABASE_DB_URL/DATABASE_URL on 55422, blank PAYSTACK_*; then one
> full regression of contributor + collections + payments. Report per test. Itest only, fake payments,
> no reset, no M10, no commit.

### Session 57 — A2.6 browser verification + e2e rewrite (nothing committed)

**Done (browser, itest only, fake provider, all PASS).** QA community `qa-membership-2026-11` with
`qa-fixed-dues` (all members, fixed ₦2,000) and `qa-core-gift` (Core group, open ≥ ₦500). Unknown,
revoked, suspended, outside-audience IDs → identical server body + generic UI message. Lower case,
space, dash, dot, underscore separators all accepted. Masked confirm (name, `a•••@…`, `+234 ••• ••• •NNN`,
"Not on record"); no full email/phone/UUID/ID in DOM, URL or storage. Reject clears pass. Pass issued on
one collection is "expired" on another; contributor session from one collection refused on another (no
row). Name prefilled, email/phone empty; below-min refused; review reached (Pay never pressed). Mobile
375px OK. No IDs in server logs.

**Findings.** Refresh after confirm returns to Screen 1 but contributor cookie stays valid ≤1h
(pre-existing, old UI same). Both cookies signed not encrypted (pre-existing). Stale server copy "Find
yourself on the list…". Unrelated hydration mismatch on officer member page (relative time).

**QA data added to itest:** collection `qa-core-gift`; 3 fake `initialized` attempts (2 on
`qa-fixed-dues`, 1 on `qa-core-gift`); e2e run users/communities named `e2e-…`/`E2E …`.

**Playwright.** New `tests/e2e/helpers/membership-id.ts`; rewrote old flow in `contributor.spec.ts`,
`collections.spec.ts`, `payments.spec.ts` (seed now issues a `PAY/…` ID in the seed transaction).
Strict ad-hoc tsc of these files clean. Launch config `kolekto-web-e2e-itest` (prebuilt `.next-e2e`, port 3010).
NOT green: (1) the uncommitted communities-page redesign renamed "+ New community" → "New community",
breaking every spec's `createCommunity` (fixed only in the two specs above; 7 other specs still use the
old label); (2) latest run: signup on 3010 shows "Something went wrong" (not diagnosed).

**Gates.** apps/web `tsc --noEmit` clean; vitest 379/379; ESLint on all changed web files clean.
Strict ad-hoc tsc of changed e2e files clean.

**Session 57b (continuation).**
- Signup "Something went wrong" diagnosed: itest Auth logs show 504s — `failed to connect to
  supabase_db_kolekto-itest … i/o timeout` and `hostname resolving error … i/o timeout`. Cause: the
  Docker VM (4 CPUs, 4 GiB) runs BOTH the itest and the local `kolekto` dev Supabase stacks plus the
  Next server and Chromium. Not a product bug. Local dev stack left running (not ours to stop).
- More drift from the uncommitted page redesigns fixed in the touched specs only: "+ New community" →
  `/^(\+ )?New community$/`; "Members", "Collections", "New collection" now `.first()` (sidebar /
  header link; overview has 3 "Members" links, empty collections page 2 "New collection"); same
  `.first()` in `helpers/wizard.ts` `openWizard`. Budgets: managed contributor test 480 s,
  `payments.spec.ts` 120 s (ID step adds three round trips).
- e2e results on itest (fake provider only; 14 attempts today all `fake`):
  - PASS: contributor "identification cannot be forged" (issued ID → identify → httpOnly/Lax cookies
    not in `document.cookie` → cookies cleared → server refuses).
  - PASS: payments open, tiered, items, ticketing, fundraiser, **recurring (managed, seeded
    membership ID → paid → exactly one contribution)**, declined card, cancelled payment.
  - Managed contributor test: first attempt passed EVERY membership-ID assertion and rendered the
    review (₦5,000 + ₦75 + ₦25 = ₦5,100) then hit the old 300 s budget; later attempts died at signup.
  - payments fixed: identified with seeded ID and reached the fake checkout page, then hit the old
    60 s budget (now 120 s, not re-run).
  - NOT RUN to completion (signup 504s): collections golden path + tiered, contributor group,
    recurring, open.
- 7 other e2e specs still use the old "+ New community" label (pre-existing redesign drift, not
  A2.6 scope): audience, auth-community-member, collection-creation, collection-types,
  field-deletion-safety, groups, invitations.

**M10 (unchanged).** Checkout still attributes from the contributor-session cookie only; checkout
attribution is NOT fully secured until M10.

**Next (needs the owner).** Free Docker resources (stop the local `kolekto` dev stack for the run,
or raise Docker Desktop memory), then re-run the three specs. Then review A2.6 and approve M10.

**Paste-ready prompt for the next session:**

> Session 58. Read the session 57 and 57b blocks. I have freed Docker resources. Finish A2.6 only:
> start launch config `kolekto-web-e2e-itest` (port 3010, prebuilt .next-e2e on itest), then run
> payments, contributor and collections specs with MAILPIT_URL=http://127.0.0.1:55424 and
> SUPABASE_DB_URL/DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres, blank
> PAYSTACK_* vars. Report pass/fail per test. Itest only, fake payments, no reset, no M10, no commit.

### Session 56 — A2.5 contributor membership-ID identification UI (nothing committed)

**Done.**
- Rewrote `apps/web/app/[communitySlug]/[collectionSlug]/FindYourself.tsx` (file and export name
  kept so `ContributeForm` import is unchanged). Two screens:
  - Screen 1 "Identify yourself": labelled "Membership ID" input (upper-cased as typed, autocomplete
    off, `autoCapitalize=characters`, max 32), Continue disabled until the canonical form is ≥ 7
    characters (2-char prefix + 5-char suffix), loading state "Checking…", input read-only while
    pending. Every invalid result shows one sentence: "We couldn't find a member with this ID. Please
    check and try again." — the server's own reason is never shown.
  - Screen 2 "Are these your details?": full name, masked email, masked phone ("Not on record" when
    null), "Yes, continue" / "No, that's not me". Both disabled while a request is in flight.
  - Focus moves to the new screen's heading on each step change. Nothing stored in browser storage;
    refresh returns to Screen 1.
- New `membership-id-flow.ts` (client-safe, no React/node imports): input normalisation, the step
  logic (`submitMembershipId`, `confirmIdentity`, `rejectIdentity`) with the A2.4 actions injected,
  a whitelist of the three summary fields, `createSingleFlight` (drops a second request while one is
  running), `payerDetailsAfterIdentification` (name prefilled, email/phone empty).
- `ContributeForm.tsx`: on confirmation sets the member and prefills only Full name; email and phone
  set to "". "Not you?" now also clears the prefilled name. No amount, pricing, field or payment
  code touched.
- `actions.ts`: removed the dead `findMemberAction` stub and the `MemberLookupResult` type.
  The four A2.4 actions are unchanged. `confirmMemberAction` left in place (now unused by the UI).
- `CollectionView.tsx`: audience line now says "You will be asked for your membership ID."
- `vitest.config.ts`: added `oxc: { jsx: { runtime: "automatic" } }` so tests can render `.tsx`
  (tsconfig keeps `jsx: preserve` for Next).
- Tests: `membership-id-flow.test.ts` (27) + `FindYourself.render.test.ts` (11, static markup via
  `react-dom/server` — no jsdom in the repo). All 38 pass. Full apps/web: 379/379 on six of seven
  runs; ONE run had 1 failure that could not be reproduced or identified (new tests use no timers).
- `tsc --noEmit` (apps/web): clean. ESLint on changed files: clean. `eslint .` reports one
  pre-existing error in `MoneyPanel.tsx:422` (committed in 9f05892, not touched) and one
  pre-existing warning in `VerifyForm.tsx`.
- No migrations, payment/checkout, settlement, ledger or Paystack code changed. Itest DB not
  touched this session. Dev, staging and production untouched.

**Not done / known gaps.**
- No interactive DOM test (no jsdom/testing-library installed); click/keyboard paths covered via the
  extracted flow functions, not a rendered component. Not checked in a browser — that is A2.6.
- `tests/e2e/contributor.spec.ts` and `collections.spec.ts` still drive the old "Find yourself on
  the list" / "Find me" UI; they have been broken since A2.2 and need rewriting in A2.6.
- Server copy still says "Find yourself on the list before continuing." (`submitContributionAction`
  and `MEMBER_REQUIRED`) — left alone because it lives in the checkout path.
- If the contributor-session cookie expires while the form is open, the form shows that error and the
  user must press "Not you?" to get back to Screen 1 (pre-existing behaviour).

**M10 dependency (unchanged).** `submitContributionAction` still attributes the payment from the
contributor-session cookie only. M10 must add `p_access_token` to `app.create_payment_attempt` and
re-check the membership pass/grant at checkout, so a UI confirmation is NOT a checkout-level
revalidation yet.

**Next (needs the owner).** Review A2.5, then approve A2.6 (browser verification on itest + e2e spec
rewrite) or M10.

**Paste-ready prompt for the next session:**

> Session 57. Read the session 56 block. A2.2–A2.5 are done (DB wrappers, helpers, cookies, server
> actions, membership-ID UI in FindYourself.tsx + membership-id-flow.ts). Do A2.6 only: verify the
> contributor flow in a browser against local itest with a real membership ID (ID entry → masked
> confirm → yes → form with name prefilled, email/phone empty; no → back to entry; invalid ID →
> generic message), and rewrite the old "Find me" steps in tests/e2e/contributor.spec.ts and
> collections.spec.ts. Do not start M10. Itest only, no reset, no commit.

### Session 55 — A2.4 server actions (nothing committed)

**Done.**
- Added four new server actions to `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`:
  - `validateMembershipIdAction(communitySlug, collectionSlug, typedId)` — validates empty input,
    resolves collection from slugs, calls `startMembershipPass`. Returns `{valid, error?}` with a
    generic error message on failure (never reveals what went wrong).
  - `membershipPassSummaryAction(communitySlug, collectionSlug)` — resolves collection, calls
    `loadMembershipPassSummary`. Returns `{summary?, error?}` with masked name/email/phone.
  - `confirmMembershipPassAction(communitySlug, collectionSlug)` — resolves collection, calls
    `completeMembershipPass` (sets contributor-session cookie), then loads member context via
    `getCollectionMemberContext`. Returns `MemberContextResult` (same shape as `confirmMemberAction`).
  - `rejectMembershipPassAction()` — calls `rejectMembershipPass` (clears the pass cookie).
- Added `MembershipPassValidationResult` and `MembershipPassSummaryResult` interfaces.
- Updated `forgetMemberAction` to clear BOTH the contributor-session cookie AND the membership pass
  cookie (was contributor-session only).
- Added 14 unit tests in `app/[communitySlug]/[collectionSlug]/membership-pass-actions.test.ts`:
  validateMembershipIdAction (valid, invalid, empty, whitespace, no collection),
  membershipPassSummaryAction (valid, expired, no collection), confirmMembershipPassAction
  (success, expired, ineligible clears session, no collection), rejectMembershipPassAction
  (delegates), forgetMemberAction (clears both cookies). All 14 pass.
- TypeScript check: `packages/db` and `apps/web` both pass with no errors.
- ESLint: actions.ts passes.
- Full apps/web test suite: all 341 tests pass (24 suites), zero regressions.
- `submitContributionAction` unchanged — the checkout pass re-check requires M10's
  `p_access_token` parameter on `create_payment_attempt`, which hasn't been migrated.
- No database migrations changed. No financial logic touched. No UI changed.
  Dev, staging and production untouched.

**Not done.** A2.5–A2.6 not started. Guest path not designed. Finalize not applied. Nothing committed.

**Next (needs the owner).** Review A2.4, then approve proceeding to A2.5 (UI changes: replace
FindYourself component with membership ID input → confirmation → payment flow).

**Paste-ready prompt for the next session:**

> Session 56. Read the session 55 block. A2.2–A2.4 are done: DB wrappers, server helpers, cookies,
> and server actions all exist. Build A2.5: replace FindYourself.tsx with the membership ID
> identification flow (ID input box → confirmation screen showing masked name/email/phone →
> "yes" proceeds to payment form, "no" clears and restarts). The actions to call are
> `validateMembershipIdAction`, `membershipPassSummaryAction`, `confirmMembershipPassAction`,
> `rejectMembershipPassAction`. Do not change server actions or helpers. Itest only, no commit.

### Session 54 — A2.3 server helpers & membership-pass cookies (nothing committed)

**Done.**
- Created `apps/web/lib/membership-pass.ts` — the membership pass cookie module. Stores the
  30-minute access grant token in a separate httpOnly signed cookie (`kolekto_member_pass`), distinct
  from the contributor-session cookie (`kolekto_contributor`). Same signing pattern: HMAC-SHA256 with
  `loadSessionSecret()`. Scoped to one collection. 30-minute TTL matching the SQL access grant.
  Exports: `setMembershipPass`, `readMembershipPass`, `clearMembershipPass`.
- Created `apps/web/lib/membership-pass-helpers.ts` — four server helpers bridging the DB wrappers
  to the cookie layer:
  - `startMembershipPass(collectionId, typedMembershipId)` — validates the typed ID via
    `validateMembershipId` (with hashed client IP), stores the access token in the pass cookie.
  - `loadMembershipPassSummary(collectionId)` — reads token from cookie, calls
    `membershipPassSummary` from `@kolekto/db`, returns masked name/email/phone or null.
  - `completeMembershipPass(collectionId)` — reads token from cookie, calls
    `confirmMembershipPass` from `@kolekto/db`, on success sets the contributor-session cookie
    and clears the pass cookie. Returns member UUID for server-side use.
  - `rejectMembershipPass()` — clears the pass cookie ("no, that's not me").
- Added 9 unit tests in `apps/web/lib/membership-pass.test.ts`: round-trip, no cookie, wrong
  collection, tampered cookie, expired TTL, within TTL, garbage value, clear, cookie options.
- Added 11 unit tests in `apps/web/lib/membership-pass-helpers.test.ts`: startMembershipPass
  (valid, invalid, no token), loadMembershipPassSummary (valid, no cookie, no summary),
  completeMembershipPass (success, no cookie, DB reject, no session on reject),
  rejectMembershipPass (clears cookie). All 20 new tests pass.
- TypeScript check: `packages/db` and `apps/web` both pass with no errors.
- ESLint: all new files pass.
- Full apps/web test suite: all 327 tests pass (23 suites), zero regressions.
- No database migrations changed. No financial logic touched. No server actions changed.
  No UI changed. Dev, staging and production untouched.

### Session 53 — A2.2 DB package implementation (nothing committed)

**Done.**
- Added `membershipPassSummary(collectionId, token)` to `packages/db/src/membership.ts`. Returns
  `{fullName, emailMasked, phoneMasked} | null`. Calls `app.membership_pass_summary` as ANONYMOUS.
  Full email and phone never leave the database — masking is in SQL.
- Added `confirmMembershipPass(collectionId, token)` to `packages/db/src/membership.ts`. Returns
  `string | null` (member UUID). Calls `app.confirm_membership_pass` as ANONYMOUS. The member UUID
  is for trusted server-side code only; the wrapper JSDoc states this.
- Added `MembershipPassSummary` interface (exported through `@kolekto/db`).
- Removed `findCollectionMember` function and `CollectionMemberMatch` interface from
  `packages/db/src/public-read.ts` (M9b3 revoked anon/authenticated execution).
- Updated `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`: removed `findCollectionMember`
  import, removed unused `setContributorSession` and `allowLookup` imports, stubbed `findMemberAction`
  to return an error ("Use your membership ID instead"). UI will be replaced in A2.5.
- Added 18 unit tests in `packages/db/test/membership-pass.test.ts`: 8 for `membershipPassSummary`
  (valid token, invalid, expired/revoked, wrong collection, DB error, no unmasked data, null
  email/phone, anonymous context), 8 for `confirmMembershipPass` (valid, invalid, expired/revoked,
  wrong collection, DB error, return type, no rows, anonymous context), 2 for `findCollectionMember`
  removal verification. All 18 pass.
- TypeScript check: `packages/db` and `apps/web` both pass with no errors.
- ESLint: all changed files pass.
- Existing `retry.test.ts` (6 tests): all pass, no regression.
- No database migrations changed. No financial logic touched. Dev, staging and production untouched.

### Session 52 — M9b3 applied on itest; full pgTAP suite passed (nothing committed)

**Paste-ready prompt for the next session:**

> Session 53. Read the session 52 block. M9b3 is applied on itest. Build the A-2 web member path per the session 51
> plan (stages A2.2–A2.6), create qa-membership-2026-11 on itest for browser tests, update the 3 e2e specs. Do not
> apply finalize. Itest only, fake payments, no commit.

### Session 51 — M9b3 written and dry-run; waiting on approval (nothing applied or committed)

**Owner decisions (2026-11-23):** A-2 flow approved. Paystack Option 2: the payer types the receipt email; the
member's stored email and phone are never sent to Paystack. Guests (fixed, tiers, items, open_amount; never
per_member; only with `allow_non_members`) come later as a separate migration. Recovery is deferred to Phase E.

**Done.**
- Re-verified itest: unchanged since session 50.
- Wrote `supabase/pending-migrations/20261123130000_member_id_lookup.sql` (M9b3). It is kept out of
  `supabase/migrations` until approval. It adds `app.mask_email`, `app.mask_phone` (internal),
  `app.membership_pass_summary` and `app.confirm_membership_pass` (anon/authenticated), and revokes anon and
  authenticated EXECUTE on `app.find_collection_member`. No table, column or row changes. No payment function
  changes.
- New pgTAP `77_member_id_lookup.sql` (41 assertions).
- `02_grant_matrix`: the anon allowlist is updated, with a dated comment.
- `14_contributor_identification`: the grant is restored inside its own rolled-back transaction, so its matching
  tests still run.

**Found.**
- Paystack's initialize call receives only the email, reference, amount and collection ID. Name and phone are stored
  on the attempt only. Option 2 therefore needs no payments-package change.
- No stored phone or email is needed at checkout, so the proposed `membership_pass_contact` function was dropped.

**Tested (dry run: migration + test in one transaction, rolled back).**
- 77: 41/41. 02: 7/7. 14: 35/35. 76: 41/41. 75: 71/71. 01: 4/4. 27: 25/25.
- Negative control without the migration: 02 fails 1; 77 errors. This shows the tests detect the change.
- After the runs: no new functions on itest; anon still has `find_collection_member`; no fixtures and no audit rows
  persisted.

**Not done.** M9b3 not applied. Web member path not built. Guest path not designed. Finalize not applied. Nothing
committed.

**Next (needs the owner).** Approve M9b3 apply on itest plus the A-2 web plan in the session 51 chat report.

**Paste-ready prompt for the next session:**

> Session 52. Read the session 51 block. Approved: move 20261123130000_member_id_lookup.sql into supabase/migrations
> and apply it to itest only; then build the A-2 web member path per the session 51 plan (stages A2.2–A2.6), create
> qa-membership-2026-11 on itest for browser tests, update the 3 e2e specs. Do not apply finalize. Itest only, fake
> payments, no commit.

### Session 50 — A-1 browser check passed; A-2 plan revised (nothing built, applied or committed)

**Done.**
- Re-verified itest: latest migration `20261123120000`; 5 live IDs with plaintext and correct canonical form (hash
  and ciphertext still present); 2 revoked legacy rows with fingerprint only; 5 masked backfill audit rows, 0 audit
  rows containing a full ID. Finalize not applied (`id_ciphertext` still exists; file only in
  `supabase/pending-migrations/`). Dev DB latest is `20261122120000` with no `membership_ids` table.
- The 3002 server was the desktop-app preview of `kolekto-web-itest`, started 10:25. The code changed at 11:52, so it
  was stale. I stopped only that process tree (cmd → npm → next) and restarted it from `.claude/launch.json`. Ports
  3000, 3001 and the Supabase stacks were not touched.
- Browser D5 check **PASS**. See strategy doc §6, last row.
- Sign-in method used: the email sign-in link from the local itest mailbox (55424), with the PKCE code passed to
  `localhost:3002/auth/callback`. No passwords were changed. The owner session in the browser pane was restored
  afterwards.

**Found.**
- `app.find_collection_member` (search by name, email or phone) is still EXECUTE for `anon` and `authenticated` on
  itest. A-2 removes this.
- `app.get_collection_member_context` is also anon-executable. It needs a member UUID (v7, not practical to guess).
  It is noted, but not changed in A-2.
- `qa-membership-2026-11` does not exist yet. itest has no managed collection.
- The itest magic-link template has no 6-digit code, and its redirect goes to `:3000`. This affects test tooling
  only.

**Not done.** A-2 not built. Guest path (A-2b) not designed in detail. Finalize not applied. Nothing committed.

**Next (needs the owner).** Approve the revised A-2 plan given in the session 50 chat report: M9b3 on itest, the web
member path and creating the QA community. Then I build it and report again before applying anything.

**Paste-ready prompt for the next session:**

> Session 51. Read docs/phase-4/phase-a-migration-strategy-2026-11-23.md §6–§7 and the session 50 block. Approved:
> build A-2 (M9b3 + member path) per the session 50 revised plan; payer-typed receipt email to Paystack, member name
> + server-side phone; create qa-membership-2026-11 on itest for browser tests. Present the final migration text
> before applying it. Do not apply finalize. Itest only, no settlement/ledger/capture change, no commit.

### Session 49 — A-1 applied on itest + verified; A-2 revised plan (nothing committed)

**Done.** Applied `20261123120000_membership_id_plaintext.sql` to **itest only** (dev not touched; it has no
`membership_ids` table). Ran the backfill `--apply`: 5 live IDs got plaintext in one transaction. The 2 legacy IDs
stay reserved as fingerprints (D1). Finalize `20261123120100` was **not** applied; it is still in
`supabase/pending-migrations/`. Rewrote A-2 per the owner's 2026-11-23 instruction (no OTP, challenge, worker or new
auth) in strategy doc §7.

**Tested.** All results are in strategy doc §6.
- SQL checks all pass: plaintext and canonical form on 5 rows; legacy rows unchanged; 5 masked audit rows; 0 leaks
  in audit or notification payloads.
- Rolled-back behaviour checks pass: 5/5 IDs validate, including when typed carelessly; legacy fingerprint →
  collision; owner sees full IDs; viewer `FORBIDDEN` and masked only.
- Full pgTAP on itest: the known 18/20/23 failures, plus 57/62/63/65 failing one assertion each. Those four are
  environmental: 2 demo settlements became due for T+1 release at 05:00 WAT today and those tests count them. They
  are unrelated, and the tests roll back. 75 71/71, 76 41/41.
- The browser check is **not done**. The 3002 dev server (started 10:25, before the rewrite) serves a stale module:
  the owner sees the masked ID. A fresh process returns the full ID. Restarting that server was not permitted in
  the session.

**Why.** Owner approval of the A-1 apply (session 48 → 49); owner simplification of A-2.

**Not done.** Browser D5 check (needs a 3002 restart). A-2 not built (waiting on strategy §7.9). Finalize not
applied. Phases B–G not started. Nothing committed.

**Next (needs the owner).**
1. Restart the `kolekto-web-itest` server on 3002, or allow me to, so the D5 check can run.
2. Answer strategy §7.9:
   - Approve M9b3 + the member path.
   - Choose Option 1 or 2 for the email sent to Paystack.
   - Guests as a separate A-2b, and whether `open_amount` allows guests.
   - Recovery built with the Phase E email.
3. Later, separately: the finalize migration.

**Paste-ready prompt for the next session:**

> Session 50. Read docs/phase-4/phase-a-migration-strategy-2026-11-23.md §6–§7. I restarted the itest server on
> 3002 [or: you may restart it]: run the D5 browser check (owner full ID + Copy; viewer masked). A-2 §7.9:
> (1) [approve/change] M9b3 + member path on itest; (2) Paystack email Option [1/2]; (3) guests A-2b later, open_amount
> guests [yes/no]; (4) recovery with Phase E [yes/no]. Do not apply the finalize migration. Itest only, no payment
> settlement/ledger change, no commit.

### Session 48 — Phase A-1 plaintext IDs built + dry-run; A-2 designed (nothing applied or committed)

**Done.** Owner decisions D1–D9 folded in. Wrote migration `20261123120000_membership_id_plaintext.sql` (M9b2a),
the pending finalize `supabase/pending-migrations/20261123120100_…` (M9b2b; kept out of `supabase/migrations` until
approved), and the backfill script `scripts/itest/membership-id-plaintext-backfill.mjs`. Updated the web and DB code
(no encryption; D5 full ID only for `membership.issue_ids`) and pgTAP 75 (71) / 76 (41). Full strategy:
[`phase-a-migration-strategy-2026-11-23.md`](phase-a-migration-strategy-2026-11-23.md).

**Tested.** Dry run on itest (rolled back): 01 4/4, 02 7/7, 27 25/25, 75 71/71, 76 41/41; finalize-too-early
refused; nothing persisted. Backfill dry run: 5/5 live IDs decrypt and match their stored HMAC; 2 legacy rows left
alone. `tsc --build` and web `tsc --noEmit` clean; web vitest 307/307; eslint clean on changed web files. Browser not
run (the code needs the migration applied).

**Why.** Owner decision A1 (plaintext), D1/D2 (reserved and kept IDs), D5 (who sees the full ID).

**Not done.** M9b2a not applied; backfill not run; finalize not applied; A-2 (D4 lookup) not built and waiting on
owner confirmation of the flow (strategy doc §7.6); Phases B–G not started. Nothing committed.

**Next (needs the owner).** (1) Approve applying M9b2a + backfill on itest (strategy §4). (2) Confirm A-2 §7.6 items
1–3. (3) Later, a separate approval for finalize M9b2b (it drops two columns).

**Paste-ready prompt for the next session:**

> Session 49. Read docs/phase-4/phase-a-migration-strategy-2026-11-23.md. Approved: apply 20261123120000 to itest
> only and run the backfill with --apply, then do the §6 post-apply verification and report. A-2: [approve / change]
> §7.6 items 1–3. Do not apply the finalize migration, do not touch dev/staging/production, no payment-path change,
> no commit.

### Session 47 — Phase 0 read-only reconciliation (docs only, nothing applied or committed)

**Done.** Owner directive "Consolidated Engineering Review…" (Parts A–L). I read the M9a/M9b code, the membership
web code, `find_collection_member` and its caller, the permission catalogue, Settings/Team, the collection wizard,
the payment design doc, the notification worker and the WhatsApp references, and ran read-only SQL on itest. The
full report and phased plan are in
[`community-experience-phase-0-reconciliation-2026-11-23.md`](community-experience-phase-0-reconciliation-2026-11-23.md).

**Why.** The directive requires Phase 0 before any code (switching to plaintext ID storage, the enumeration fix,
Team permissions, settings IA, notifications, guest payments).

**Key findings.** (1) Two revoked itest IDs (UAL/…YM, UAL/…3F) cannot be recovered to plaintext: their ciphertext
was erased by design and only the hash remains. The five live IDs can be recovered. (2) An `invite.approve` grant on
the unilag `viewer` is still active; session 46 under-reported it. (3) itest has no managed collection. (4) "Members
only" in the brief means the managed audience, not the `members_only` visibility. (5) `find_collection_member` also
leaks a name for an email or a 7-digit phone suffix. (6) The existing member-added email calls the member number
"member ID". (7) `03_money_invariants.sql` already differs from HEAD (one allowlist name, from session 43d).

**Not done.** No code, migration, test run or DB write. pgTAP, tsc and vitest were not re-run.

**Next (needs the owner).** Answer D1–D9 in report §9 (D1 and D4 block Phase A). Then approve Phase A.

**Paste-ready prompt for the next session:**

> Session 48. Read docs/phase-4/community-experience-phase-0-reconciliation-2026-11-23.md. Decisions: D1 …, D2 …,
> D3 …, D4 …, D5 …, D6 …, D7 …, D8 …, D9 …. Approved: Phase A only (M9b2 plaintext storage + itest backfill of the
> five live IDs + DB-backed lookup limiter + find_collection_member change) on itest, with a disposable test
> community. Show me the backfill SQL before running it. No dev/staging/production, no payment-path change, no
> commit.

### Session 46 — Phase 2a + Phase 2: membership foundation on itest (uncommitted)

**Done.** Owner review approved Phase 2a and Phase 2 on itest only (decisions Q1, Q2, Q8, Q9, Q10, Q12, Q13, Q14 —
product doc F15). Built: hide `members_only` (Phase 2a); migrations `20261123100000_member_status_suspended.sql`
(M9a) and `20261123100100_membership_foundation.sql` (M9b) applied to **itest only**; delegable officer permissions;
membership ID format settings with preview; issue / replace / revoke; suspend / reinstate; anonymous validation with
database rate limits and 30-minute access grants; audit; settings and member-page UI. Owner changed Q10 mid-phase: the
full ID is stored AES-256-GCM-encrypted (key on the web server only) so officers with `member.view_contact` can always
show it (F16.2). Full record: product doc F16. Q9 review of `find_collection_member`: F17 (no behaviour changed).
Non-member payment-path design for review: `docs/phase-4/non-member-contributions-payment-path-design-2026-11-22.md`.

**Tested.** pgTAP `75_membership_ids.sql` 58/58, `76_membership_access.sql` 40/40; full suite on itest after all
changes: 75 files, 2,535 ok; failures only in the known files 18 (1 not ok), 20 (aborts, 10 ok then errors) and 23
(3 not ok) — demo ledger data, unchanged since session 40. Intended-set lists updated
with dated comments: `01_rls_coverage.sql`, `02_grant_matrix.sql`, `27_truncate_guards.sql`. Root `tsc --build`
clean; web vitest 308/308 (incl. 14 new); eslint clean on changed files (one pre-existing error in `MoneyPanel.tsx`,
not touched). Browser on itest (port 3002, `demo-unilag-alumni` owner): reserved prefix refused; format saved;
bulk issue 5; full ID shown; replace; suspend → validation refused; reinstate → same ID valid; revoke; single issue;
grant and remove a delegated permission. End-to-end hash check run in a rolled-back transaction.

**Why.** Membership IDs are the proof step members-only collections need; Q2 delegation and suspension are
prerequisites the owner approved together.

**Not done.** Email delivery of IDs; applications setting/flow; members-only page; M9c; payment path (M10); linking
(M11); admin. Known gap: payment reminders still include suspended members (F16.4). Nothing on dev, staging or
production. No LIVE payment or payout. Nothing committed.

**Itest data note.** Browser verification wrote real rows to the itest demo community `demo-unilag-alumni`: 7
membership ID rows (5 bulk-issued, 1 replacement, 1 re-issue after a revoke; 2 of them now revoked), one suspend + reinstate (member back to `active`), one permission grant
+ revoke, settings `UAL` / `/` / 5 / on, and their audit rows. `membership_ids` rows cannot be deleted (by design).
Itest-only secret for the dev server: `.claude/itest-membership-secret.local` (git-ignored), read by the
`kolekto-web-itest` launch entry.

**Next (each needs owner approval).** (1) Owner confirms the Q10 change (encrypted storage) and the suspension
semantics (suspend blocks, reinstate restores the same ID). (2) Review the non-member payment-path design.
(3) Next membership phase: email delivery of IDs, applications, M9c, members-only page. (4) Decide the reminders gap.
(5) Commit when approved.

**Paste-ready prompt for the next session:**

> Session 47. Read the "Latest report" (session 46 block) in docs/phase-4/payment-integration-status-2026-11-12.md,
> product doc Part F sections F15–F17, and docs/phase-4/non-member-contributions-payment-path-design-2026-11-22.md.
> The membership foundation (M9a, M9b) is on itest only and uncommitted. Do not apply it to dev, staging or
> production, do not change the payment path, LIVE Paystack, withdrawals, settlement, ledger or reconciliation, do not
> reset itest, and do not commit or push without my approval. Wait for my decisions on the session 46 "Next" list
> before building anything.

### Session 45 — Phase 0 audit + Phase 1 spec: configurable membership IDs, non-member contributions, separate admin repo (docs only, nothing committed)

**Done.** Owner brief "Membership system, configurable membership IDs, non-member contributions & central admin
architecture". Read-only audit of git state, docs, ADRs, membership/collection/payment SQL and web code, and the
migration state of dev and itest. Wrote product doc **Part F** (F0–F14) and drafted
`docs/adr/0017-central-admin-in-a-separate-repository.md` (**Proposed**; README row added). No code, migration, test,
DB, commit, push or deploy.

**Why.** The brief limits this pass to Phase 0 and Phase 1; implementation waits for review.

**Findings (details in Part F §F1):** (1) `collections.allow_non_members` is stored but never enforced —
`create_payment_attempt` requires a member on every managed collection; enabling non-members is a payment-path change.
(2) Members are almost never `active` (add/approve → `unclaimed`), so "IDs valid only for active members" would lock
out most members (Q8). (3) `member_code` is already called "membership ID" and has the same `PREFIX/…` shape (Q10).
(4) Permissions are role-only; owner→officer delegation needs a new mechanism (Q2). (5) Showing the last 4 of a
5-character ID leaves 32 guesses → show last 2. (6) Web DB connection sets its own claims; admin isolation depends on
the web role not reaching the admin role (Q13). (7) ADR 0001/0009 still say the staff console is inside `apps/web` →
ADR 0017. (8) `members_only` still selectable in `SettingsPanel` (E4.1). (9) Dev `schema_migrations` still lacks 6
hand-applied rows (known #12); 130000/140000 still not on dev.

**Not done:** everything in Part F is DESIGNED only; no item approved for implementation; itest reset not run.

**Next (needs the owner):** answer Q1, Q2, Q8, Q9, Q10, Q12, Q13, Q14 (Part F §F13); approve Phase 2a (hide
`members_only`) and Phase 2 (M9a + M9b on itest).

**Paste-ready prompt:** "Read COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md Part F. Decisions: Q1 …, Q2 …, Q8 …, Q9 …,
Q10 …, Q14 …. Approved: Phase 2a (hide members_only in SettingsPanel) and Phase 2 (M9a + M9b membership foundation,
settings UI with preview, issue/rotate/revoke, suspend, validation + rate limits + grants) on itest only, with pgTAP
75–77. No payment-path change, no dev/staging/production migration, no commit."

### Session 43d — avatar + public community page built (itest); membership/admin/KYC/payout designed (nothing committed)

**Done.** Owner brief "Final product decisions and next implementation phase". Implemented and tested on itest only:
profile photo upload (`20261122130000`: bucket `profile-avatars` with no client policies, `app.set_my_avatar` pins the
URL to the caller's own folder; magic-byte check server-side) and the public community page `/[communitySlug]`
(`20261122140000`: owner-only publish switch, anon reads of whitelisted fields and `public` collections only;
"Not yet verified" badge). New pgTAP `74_public_community_and_avatar.sql` 35/35; `02_grant_matrix` anon allowlist +2
(dated comment), 7/7; full pgTAP 73 files / 2,436 ok, failures only 18/20/23 (demo ledger data, itest reset
unapproved). Browser checks on itest preview (port 3002) pass. Designed only (product doc Parts D–E): standalone
membership + membership IDs, members-only journey, applications, admin panel `apps/admin`, KYC preparation, community
payout architecture (E7, for review). itest demo state changed: `demo-unilag-alumni` published,
`annual-dues-2026` set to public.

**Why.** Owner's implementation order steps 1–11.

**Not done:** migrations 130000/140000 not applied to dev; M9 membership migration not written; no admin code; no
KYC code; payout execution untouched; no flag enabled; itest reset not run; nothing committed.

**Findings:** `members_only` is selectable in collection settings but makes the page a 404 (doc E4.1);
`find_collection_member` enumeration (D9) stands.

**Next (needs the owner's OK):** (1) apply 130000 + 140000 to the local dev DB; (2) approve M9 (members-only) build;
(3) review E7 payout architecture; (4) decide E4.1 and D9; (5) itest reset (C9).

**Paste-ready prompt:** "Approved: apply migrations 20261122130000 and 20261122140000 to the local dev DB only
(review the diff first) and check avatar + public page on port 3000. Then build M9 (members-only membership IDs,
validation, access grant, rate limit) per COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md §D3–D10 and §E8 steps 1–3,
tested on itest. Hide the members_only option until it works. No payout or capture change, no commit."

### Session 43c — dev migration applied; admin panel audit; beneficiary architecture (nothing committed)

**Done.** Owner approved applying `20261122120000` to the local dev DB only. Diff reviewed (6 read-only functions,
1 index, grants on those functions; no table/policy/DML), target confirmed (`supabase_db_kolekto`, `:54322`), applied
in one transaction with a `schema_migrations` row. Ledger/withdrawal/contribution/policy counts unchanged;
`platform_reconciliation()` 9/9 ok; overview = ledger for all 195 owner terms (rolled-back check). Port 3000 now shows
`/communities`, overview, verification and `/account` (signed in as an `@example.test` e2e user by email code). Read
the legacy admin panel (`../kolekto-admin-control-panel-1`): bound to the legacy Supabase projects + legacy Express
API, roles admin/superadmin only, no MFA → not reusable as-is; recommend `apps/admin` in this monorepo (D-O).
Product doc Part C: decisions D-H…D-M recorded, capability map, beneficiary architecture C5, admin/flags design C6,
open questions C7, phased plan C8, itest reset plan C9. Session 44 has finished (`88dc8f4`, pushed).

**Why.** Owner brief "Decision resolution and next implementation phase".

**Not done:** itest reset (separate approval); anything in Part C phases 1–7; no flag enabled; payout code untouched.

**Next (needs the owner's OK):** (1) approve the itest reset plan (doc §C9); (2) answer Q1–Q4, D-O, D-P; (3) approve
Phase 1 (public community page + avatars).

**Paste-ready prompt:** "Approved: run the itest reset exactly as in COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md
§C9 and the full pgTAP suite. Then build Phase 1 (public community page at /[communitySlug] with publish switch and
'Not yet verified' label, visibility label 'Unlisted (anyone with the link)', avatar upload) per §B4/§B5/§C8, tested
on itest and checked on port 3000. No commit."

### Session 43b — visibility diagnosis + product direction architecture (nothing committed)

**Done.** (1) Diagnosis: port 3000 serves the new code (compiled 10:39) but reads the dev DB (`:54322`), where
`app.my_communities()` etc. do not exist → error boxes instead of the new content. Dry-run of the migration on dev
inside `begin … rollback`: clean. (2) Mapped the owner's new rules onto the code: a public collection flow already
exists at `/[communitySlug]/[collectionSlug]`; no public community page yet; visibility enum already exists; D-07
already enforced; no platform-admin concept exists. (3) Part B of
`docs/product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md`: user model, public page, avatar, NIN/face KYC,
community verification, community bank account, beneficiary model, permission matrix, migrations M1–M8, decisions
D-H…D-M. (4) itest backup taken (`../itest-backup-2026-11-22-pre-reset.sql.gz`, outside the repo); itest **not** reset.

**Why.** Owner brief "Product direction update, public community experience, KYC rules & implementation visibility".

**Next (needs the owner's OK):** apply `20261122120000` to the dev DB; `itest:reset` + full pgTAP; then build M1
(public community page) + M2 (avatars). Decisions D-I, D-M, D-L, D-K gate everything else.

**Paste-ready prompt:** "Approved: apply migration 20261122120000 to the local dev database (127.0.0.1:54322) only,
with a schema_migrations row, and verify /communities, /c/[slug], /c/[slug]/verification and /account on port 3000.
Approved: run `npm run itest:reset -- --confirm-reset-kolekto-itest` and the full pgTAP suite. Then build M1 (public
community page at /[communitySlug] + collection visibility) and M2 (avatar upload) per Part B of
COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md. No commit."

### Session 44 — PR #35 CI: invariants + browser e2e (committed `88dc8f4`, pushed)

**Done.** CI run 45007428009 on `9f05892` failed two jobs; main's last e2e run passed, so both came from this branch.

1. **invariants** — `one-paystack-caller` matched `PAYSTACK_SECRET_KEY` in `packages/domain/test/log-redaction.test.ts:28`
   (a log *field name* the redaction test feeds in, not a Paystack call). Fix: `// invariant-allow:` with the reason.
   Local `node scripts/invariants/run-all.mjs` → all seven hold.
2. **browser e2e** (both shards hit the 30-min job timeout; 9 tests failed, each burning 1–4 min plus a retry):
   - The detail-page redesign (`6bf52c7`) moved the roll ("Add members", obligations, "no period is open", "For <group>")
     behind a **"Manage members/attendees"** tab inside the people section (default view is now Payments / Who has paid);
     "Exports" and "Check-in" became tabs there; the reminder button is now "Send a reminder to everyone" in the Members
     section; Settings is a header toggle that hides the sections. Specs still used the old navigation.
     Fix: new `tests/e2e/helpers/collection-detail.ts` (`openRoll`, `openPeopleView`, `closeSettings`) used by
     audience, collections, collection-types, contributor, post-publish-reminders, references-and-exports specs.
   - **Date time-bomb:** `collection-creation.spec.ts` published an event starting `2026-11-20`, now in the past
     ("the deadline has already passed"). `2026-12-20` in collection-types would break next month. Fix:
     `futureEventStart()` (60 days ahead) for every published event start.

| Check | Result |
|---|---|
| Invariants (local) | 7/7 hold |
| `tsc --noEmit` over `tests/e2e` | clean |
| Local Playwright (clean worktree at HEAD + fixes, dev stack `:54321`, fake provider) | per-order limit + annual-dinner (date fixes) **pass**; other local failures were sign-in/wizard timeouts in tests that pass in CI (machine overloaded, 2–3 min/test) — **not a usable signal**; roll navigation **not yet verified in CI** |

**Result:** CI run 45017830147 on `88dc8f4` — all 7 jobs pass (invariants, both e2e shards, pgTAP, typecheck, scanning).

**Next:** PR #35 is green; review and merge it when ready (the 9 test files went out alone in `88dc8f4`; session 43 work stays
uncommitted). Product question left open: on a **draft** managed collection the people section opens on an empty
"Payments" view; showing "Manage members" first may be the better default.

**Paste-ready prompt:** "PR #35 is green on 88dc8f4. Review the diff against main and, if it looks right, merge it.
Do not include the uncommitted session 43 work."

### Session 43 — community experience, profile, KYC readiness, overview (nothing committed)

**Done.** Full write-up: [`docs/product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md`](../product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md)
(audit §1, design §2–8, decisions D-A…D-G §12, verification §10, sources §13, issues §14, readiness §15).
Migration `20261122120000_community_home_and_overview.sql`: six STABLE security-definer read functions + one index;
no table, policy or grant on a table changed. Web: `/communities` rebuilt, avatar menu, `/account` → "Your profile"
with personal verification steps, permission-filtered sidebar, new overview, `/c/[slug]/verification` (readiness
only — submitting is not open). Personal identity verification and community verification review are **designed
only**: no provider, no submission table, blocked on decisions D-A…D-G.

**Why.** The owner's brief "Community experience, personal profile, KYC & community overview redesign".

| Check | Result |
|---|---|
| Migration `20261122120000` on **itest** (single transaction + `schema_migrations` row; itest copy byte-identical) | APPLIED |
| Dev DB (`:54322`), staging, production | **NOT applied** |
| pgTAP 73 (new) | 39/39 — reconciles every figure against `v_collection_position` / `collection_financial_overview`; ledger untouched |
| Full pgTAP suite on itest **before** demo seed | 72 files pass, after adding `community_collection_figures` to the `03_money_invariants.sql` #4 allowlist (counts paid withdrawals; dated comment — **review it**) |
| Full pgTAP suite on itest **after** demo seed | `18` #28, `20` (setup error), `23` #33–35 fail: they assert an empty ledger and the seed added rows. Not a code fault |
| `tsc -b` · web vitest | clean · 290 tests (9 new) |
| Lint · invariants | only pre-existing (`MoneyPanel.tsx:422`, `VerifyForm.tsx:72`; `log-redaction.test.ts:28`) |
| Browser (`kolekto-web-itest`, port 3002) | home, menu, overview figures = seed, verification page, profile at 375 px, collector view, outsider → 404 |

**Next (needs the owner's OK):** (1) `npm run itest:reset -- --confirm-reset-kolekto-itest` to clear the demo data
(also rotates the itest role password and stack ID); (2) review the diff and the `03` allowlist entry; (3) apply
`20261122120000` to the dev DB; (4) commit separately from the session 39–42b payments change set on this branch.

**Paste-ready prompt:** "Reset the itest stack with `npm run itest:reset -- --confirm-reset-kolekto-itest`, re-run the
full pgTAP suite on itest and confirm all 73 files pass with 0 rows left behind. Then apply migration 20261122120000
to the local dev database (127.0.0.1:54322) only and smoke-test /communities and /c/[slug] on port 3000. No commit."

### Session 42b — provider-verification grace period for transfer reconciliation (nothing committed)

**Done.** A transfer absent from Paystack's list within 5 min of dispatch is `provider_verification_pending` (info),
never `missing_at_provider`; after 5 min Paystack is asked by reference (GET only) before any warning. The worker
re-runs reconciliation ~6 min after a run with pending items. Each run stores `provider_grace_seconds`. Details:
`withdrawal-otp-owner-approval-2026-11-19.md` §12.

**Why.** Session 42's start-up run flagged the just-paid `ktr_6a1c…` as missing (false positive).

| Check | Result |
|---|---|
| Migration `20261122100000` on **itest** (single transaction + `schema_migrations` row; itest migration copy updated, byte-identical) | APPLIED |
| pgTAP 72 (new) / 70 / full suite on itest | 21/21 · 92/92 · 71 files, 2,407 assertions, 0 failures; 0 rows left behind |
| Unit: payments 64 (19 new) · worker 825 (1 new) · adapters 240 · domain 269 · db 6 | all pass |
| `tsc -b` | clean |
| `npm run invariants` | only the known `one Paystack caller` hit at `packages/domain/test/log-redaction.test.ts:28` (session 39, unchanged) |
| Dev DB (`:54322`) | read-only check only: migration absent; existing open warnings (`ktr_bb67…` ×4, `ktr_4f40…`, `ktr_6a1c…`) untouched |
| Worker | `apps/worker/.env.local`: `PAYSTACK_SECRET_KEY` (`sk_test_`, copied from web, never printed) + `PAYSTACK_TRANSFERS_ENABLED=true`; backup of the file before the edit in the session scratchpad. Running worker (keyless, 09:32 bundle) **not** restarted; `dist` **not** rebuilt. No approved withdrawals waiting (withdrawals: 4 paid, 2 failed, 2 cancelled) |

**Next (needs the owner's OK):** apply `20261122100000` to the dev database → `npm run build --workspace apps/worker`
→ restart the worker (runbook `docs/runbooks/worker-paystack-test-key-local.md`). Building first without the
migration would make a run with a pending item fail to record (no money effect, but the report is lost).

**Paste-ready prompt:** "Apply migration 20261122100000 to the local dev database (127.0.0.1:54322) only, rebuild the
worker, restart it with the TEST key from apps/worker/.env.local using a clean environment, confirm
`enabled:true dispatch:true testMode:true` and a recorded reconciliation run with `provider_grace_seconds=300`. Do not
acknowledge existing warnings. No commit."

### Session 42 — result: TEST withdrawal `KWD-25ABD04865040369` PAID (nothing committed)

Owner said "Yes, send it". One dispatch run, then payouts off again.

| Step | Evidence (UTC, 2026-11-22) | Result |
|---|---|---|
| Worker bundle | `dist/index.js` was from 2026-11-20 11:47, older than session 39 sources; rebuilt with `npm run build` (esbuild). Old bundle kept in the session scratchpad | DONE |
| Clean start | Keyless worker PID 20000 stopped (identity checked; 0 open transfers). The shell inherited app variables (an empty `EMAIL_PROVIDER` would have overridden `mailpit`; `PAYSTACK_SECRET_KEY` empty), so the worker was started with them removed (`env -u …`), plus the `sk_test_` key (prefix-checked, never printed) and `PAYSTACK_TRANSFERS_ENABLED=true` in the process environment only. No env file edited | VERIFIED: `withdrawal_transfers_state enabled:true dispatch:true testMode:true` |
| Dispatch | `dispatch examined 1 initiated 1`; transfer `ktr_6a1c7ff6a7fb5c06d6d6fe9e`, initiate requested 08:34:26.871, Paystack `received` | VERIFIED |
| Approval callback | 08:34:30.827: `approve` / `authorised`, provider amount 130000, **signature valid**; audit `withdrawal.transfer_approved_by_kolekto` | VERIFIED |
| Provider outcome | `transfer.success` webhook → check `paid` 08:34:35; Paystack TEST verify: **success**, 130000 NGN, `TRF_ygwudrdiql5ochh9`, domain test, fee 0; dashboard list shows it first | VERIFIED |
| Withdrawal | `paid` 08:34:34.740, `payout_reference TRF_ygwudrdiql5ochh9`; exactly 1 transfer row; no release journal | VERIFIED |
| Ledger | hold `withdrawal_hold:01a20242…` (available debit / withdrawing credit 130000) and payout `payout:01a20242…` (withdrawing debit, organiser_payouts debit, withdrawn credit, provider_receivable credit, 130000 each). No fee journal (fee 0) | VERIFIED |
| Balances (collection `01a1c50c…`) | after: available 107,250,000 / withdrawing 0 / withdrawn 250,000 kobo (session 38 end: 107,380,000 / 0 / 120,000 → −/+ 130,000) | VERIFIED |
| Reconciliation | `platform_reconciliation()` 9/9 ok; ledger imbalances 0 | VERIFIED |
| Cleanup | Keyed worker stopped right after success; restarted keyless → `enabled:false reason no_paystack_key`, OTP delivery still on; 0 secret-shaped strings in both worker logs; 0 `PAYSTACK` lines in `apps/worker/.env.local` | VERIFIED |

**Transfer reconciliation run at start-up** (read-only report, nothing posted): 2 `info` `foreign_reference`
(the 19 Nov `kprobe_*` probes, known) and 2 `warning` `missing_at_provider`: `ktr_bb67…` (correct — Paystack never
created it; withdrawal `KWD-54DD…` failed and released in session 37) and `ktr_6a1c…` (**false positive**: the run
read Paystack's list seconds after this dispatch, before the new transfer appeared; Paystack verify confirms it).
All four left `open` for an operator to acknowledge with a reason — not resolved by hand. Follow-up (Low): skip
transfers initiated within the last few minutes in `missing_at_provider`.

**Next:** unchanged from session 41 (commit approval, lint/invariant/wrapper decisions, hosting, SR-05/SR-06). To
send a future approved TEST withdrawal, repeat this run; payouts stay off between runs by design.

### Session 42 — "approved withdrawal not showing on Paystack" (diagnosis, before the run)

**Finding.** `KWD-25ABD04865040369`, ₦1,300 (130,000 kobo), local dev: requested 07:56:51 UTC, member code verified
07:57:14, approved 08:08:21 by the designated second approver (`approved_as second_approver`), hold journal present,
not manual review. **No `withdrawal_transfers` row**, so it was never claimed or sent. Paystack TEST transfer list:
newest entry is still `ktr_4f40…` (20 Nov, session 38). Nothing is wrong with the withdrawal or Paystack.

**Cause.** The running worker (PID 20000, started 2026-11-20 15:17, `--env-file=.env.local`) has no Paystack key
and no `PAYSTACK_TRANSFERS_ENABLED`: session 38's cleanup left payouts off on purpose (`withdrawal_transfers_state
enabled:false reason no_paystack_key`). An approved withdrawal waits, funds held, until a worker with dispatch on runs.

**Preconditions checked (read only):** bank account verified, past cooling-off, recipient set, requester's own;
the only claimable withdrawal; 0 open transfers; ngrok up → `localhost:3000`, approval route 405 locally and via the
tunnel; key in `apps/web/.env.local` is `sk_test_`, no `sk_live_` in web/worker env files; Paystack TEST balance
NGN 66,962,637.80; TEST dashboard: transfer OTP off, test approval on with the ngrok URL, live approval off,
*On Reject* = Do Nothing. No setting changed.

**Next:** with the owner's yes — restart the worker once with the TEST key and `PAYSTACK_TRANSFERS_ENABLED=true`
passed in the process environment only (no env file edited), watch dispatch → approval callback (signature valid,
200) → `transfer.success` → `paid`, one payout journal, reconciliation 9/9; then restart it without the key.

### Session 41 — final security review, risk register, staging readiness (nothing committed)

**Done:**

| Task | Result | Where |
|---|---|---|
| 1 Risk register | 26 findings (1 Critical, 3 High, 12 Medium, 10 Low) with evidence labels (code / pgTAP / concurrency / unit / catalog / browser / Paystack TEST / LIVE read-only / unverified), staging and LIVE blocking flags | [`docs/security/risk-register-2026-11-20.md`](../security/risk-register-2026-11-20.md) |
| 2 Staging readiness | 16-item matrix; local READY, itest READY, staging NOT READY (infrastructure + process, no known code defect), LIVE NOT READY | [`staging-readiness-2026-11-20.md`](staging-readiness-2026-11-20.md) §1–2, §6 checklist |
| 3 pgTAP 32 #5 | Counted the itest harness's own `kolekto_itest_worker` policies. Test-only fix: skip a policy only if its sole role is `kolekto_itest_worker` **and** it has the harness name prefix. Negative probe (`TO public`, harness name `TO authenticated`) still fails #5. **Full suite on itest: 70/70 files, 2,386/2,386.** Worker policies untouched (10) | `supabase/tests/32_notification_delivery_access.sql`; readiness §3 |
| 4 Lint `MoneyPanel.tsx:422` | `react-hooks/set-state-in-effect` false positive: `refresh` sets state only after `await`. Same pattern already disabled with a comment in `NotificationsPageClient.tsx:95`. **Fix proposed, not applied** | readiness §4 |
| 5 `itest:reset` gap | Root cause: `up` refuses stale copy + existing volume; `reset` refuses a stopped database. Proposed: `reset` starts a stopped stack first (no volume operation). **Not applied.** Safe recovery + volume-deletion guards documented | readiness §5 |
| 6 Docs | ADR 0016 amended; withdrawal doc §11 (current OTP/approval policy, second-approver instructions); financial decisions §23 (status note, no new decision); itest README; banners on the two stale staging docs; `.env.example` gains the two payout switches (unset) | — |

**Top blockers.** Staging: commit + CI (owner approval), hosting platform + deploy job, staging unpause + migration
history + backup, secret store, hosted Auth/email, public URL for the Paystack TEST webhook and approval URL (and the
owner's choice: one Paystack TEST account cannot call both local ngrok and staging). LIVE, in addition: **O-1 legal
custody of third-party funds (separate blocker)**, LIVE Paystack has no transfer OTP and no LIVE approval URL,
no monitoring/alerting, key mode not bound to `KOLEKTO_ENV`, unsigned approval requests accepted, inbound 12 s
stop-gap, payout on the privileged connection, second-approver designation controls, account-change alerts,
manual review/O-3, operator tooling, MFA, hosted logging, provider idempotency and LIVE funding.

**Not done / not verified:** Playwright E2E (no withdrawal spec exists); unit suites not re-run this session (only
docs, `.env.example` and one pgTAP file changed); no staging, LIVE or production access of any kind.
**Found:** `node scripts/invariants/run-all.mjs` fails `one-paystack-caller` on
`packages/domain/test/log-redaction.test.ts:28` (session 39 fixture key `PAYSTACK_SECRET_KEY`, not a real call) —
CI would fail; fix proposed in readiness §2 item 13, not applied.

**Next:** owner decisions — (1) approve committing sessions 27–41 and opening a PR; (2) approve or decline the lint
fix (readiness §4) and the wrapper change (§5); (3) hosting platform; (4) Paystack TEST account for staging. Then
the small LIVE-hardening fixes in priority order: SR-05 key/env binding, SR-06 require signed approval requests,
SR-07 signature before the inbound hold, SR-09 designation waiting period + notices, SR-10 account-change emails.

**Paste-ready prompt for the next session:**

> Session 42. Read the "Latest report" in docs/phase-4/payment-integration-status-2026-11-12.md, then
> docs/security/risk-register-2026-11-20.md and docs/phase-4/staging-readiness-2026-11-20.md. Decisions: [commit
> yes/no], [lint fix §4 yes/no], [wrapper change §5 yes/no], [hosting platform], [Paystack TEST account for
> staging]. If commit is approved: group the work into reviewable commits (migrations, adapters/payments, worker,
> web, tests, docs), scan the diff for secrets, open a PR, and get CI green including E2E. Then implement SR-05 and
> SR-06 as small, tested changes (pgTAP + unit), proposing each diff first. Same strict rules: no LIVE transfers or
> settings, no production or staging database access without explicit approval, no reset, no push or deploy
> without my approval.

### Session 40 — approved itest rebuild + full verification (nothing committed)

**Done:** cold backup of `supabase_db_kolekto-itest` (`itest-backups/supabase_db_kolekto-itest-2026-11-20.tgz`, 25,721,067 bytes, SHA-256 `fa457812…f09f7eaa`, verified) → old `.env.itest` moved beside it → volume removed → `itest:up` (149/149 byte-identical, history = source) → `itest:worker-role`, `itest:net-lockdown`, `itest:status` all pass. New role password generated and never shown; host-port login: new accepted, old and wrong refused (28P01); no password in any tracked or untracked file.

**Results:** pgTAP 69/70 files, 2,385/2,386 — only 32 #5 (known: the itest worker role's own policies). 57/62/65 first failed on a date-dependent fixture (pin `now() - 3 days` lost to the 2026-11-17 23:00 UTC verified-charge schedule); fixed in the three test files only, proven first with temporary copies. tsc 0/0; web 281, worker 824, domain 269, payments 45, adapters 240; concurrency 76/76 ×2 on an itest clone. Browser on an itest-only web server: designate → replace → remove works; audit `designated` / `replaced` / `ended` rows; history kept. Full detail: [`session-40-itest-rebuild-report-2026-11-20.md`](session-40-itest-rebuild-report-2026-11-20.md).

**Why:** the stale itest (146 of 149 migrations) could not run the suite; dev data hid real results (18 and 63 pass on a clean database).

**Next:** done in session 41 (above).

**Paste-ready prompt used for session 41 (kept for history):**

> Session 41. Read the "Latest report" in docs/phase-4/payment-integration-status-2026-11-12.md and docs/phase-4/session-40-itest-rebuild-report-2026-11-20.md. Finish the Session 39 brief: Task 6 security and financial-controls risk register (finding, severity, evidence, recommended action, blocks staging/LIVE; record that LIVE Paystack transfer OTP/approval settings are off and are not to be changed; legal custody question as a separate launch blocker), Task 7 staging-readiness assessment (READY / NEEDS ATTENTION / BLOCKED / NOT VERIFIED), and the documentation updates. Same strict rules: no LIVE transfers or settings, no production or dev database changes, no reset, no commit, push or deploy without my approval.

### Session 39 — withdrawal hardening (nothing committed)

**Done (why):**

| Task | What | Evidence |
|---|---|---|
| 1 OTP logging | Leak source: Next.js 16 dev-only Server Function argument logging (`logging.serverFunctions`, gated on `NODE_ENV === 'development'`). Turned off in `apps/web/next.config.ts`; new structured redaction (`packages/domain/src/log-redaction.ts`, `apps/web/lib/server-log.ts`); OTP actions log `withdrawal_otp_verify` / `withdrawal_otp_resend` with ids and outcomes only | domain 10 tests + `otp-logging.test.ts` 15 cases pass. Live: fresh ₦100 request `KWD-A0F63A21DBD22316`, wrong code then right code → dev log shows two `withdrawal_otp_verify` lines (`incorrect`, `verified`); neither code nor any part of the stored hash in the log. Request then cancelled by the requester: hold + release journals only |
| 2 Approver UI | Settings → Team → "Withdrawal second approver" (owner only): current approver, eligibility, designate / replace / remove with confirmation, history (who, when). Migration `20261120140000_withdrawal_approver_management.sql` (local dev only): atomic audited replace, owner-only candidate/history functions, suspended/closed accounts lose approval authority (`withdrawal_decider_basis`) | pgTAP 71 54/54; 69/70/64/58 pass; `approver-view.test.ts` 6 pass. Live: panel renders for the owner, Remove dialog opened and cancelled, no horizontal scroll at 375 px |
| 2 fix | Officers list on Settings was always empty: `officer_terms` has two FKs to `users`, so `users(full_name)` failed with PGRST201. Now `users!officer_terms_user_id_fkey(full_name)` | Live: officers and approver panel show; web tsc 0; `app/c` vitest 150/150 |
| 3 Concurrency script | `scripts/verify/withdrawal-concurrency.mjs` rewritten: 10 scenarios, own fixtures, run-scoped cleanup, refuses unless DB is `kolekto_scratch*`, local and quiescent | 76/76 twice on a scratch clone; refused `postgres` |
| 4 Wording | "community owner approves" removed from UI, email and comments | worker/web tests updated and pass |

**Stopped:** Task 5 — see [`session-39-itest-pre-reset-report-2026-11-20.md`](session-39-itest-pre-reset-report-2026-11-20.md). `itest:reset` cannot run (stack stopped; `up` refuses because the migration copy is 146 vs 149 files and the volume exists). Proposed: cold backup → move `.env.itest` aside → `docker volume rm supabase_db_kolekto-itest` → `itest:up` → `itest:worker-role` + `itest:net-lockdown`. Needs the owner's explicit yes. Disclosure: the local itest role password was printed in the session transcript once; the rebuild rotates it.

**Next:** superseded by session 40 above (rebuild approved and done).

### Session 38 — end-to-end TEST withdrawal `KWD-F78DB08FF0E40945`: PASS

| Step | Evidence (UTC, 2026-11-20) | Result |
|---|---|---|
| Preflight | Old `KWD-54DD…` failed, 1 release journal, no payout; balances available 107,390,000 / withdrawing 0 / withdrawn 110,000 kobo; reconciliation 9/9; Paystack TEST On Reject **Do Nothing** (after reload), test approval URL = ngrok route, TEST transfer OTP off; recipient not in `is_blacklisted=true` (0 results); only `sk_test` keys, no live flag; 0 open transfers locally and at Paystack; 0 claimable withdrawals; web dev server restarted (it was down: ngrok 502) with `kolekto-web-clean-env`, route GET → 405 | VERIFIED |
| Request | Owner (app, email-code sign-in) requested ₦100 to OPay ••••4796 (verified, name-matched account `01a1f342…`, `RCP_mlpn6hon3jbfoic`). Withdrawal id `01a1f94d-f434-75ca-9863-8d1466f3e711`, 14:13:17.929, hold journal `ebc77be2…` | VERIFIED |
| Member code | Worker (no Paystack key) delivered Mailpit message `6R9VZo9h…` 14:13:46 from noreply@kolekto.test; code entered in the app → `member_otp_verified_at` 14:14:07.893, challenge `01a1f94d-f4eb…`, audit `withdrawal.member_verified` | VERIFIED |
| Self-approval refused | Owner UI shows only "Cancel request". Rolled-back probe with the owner's JWT: `can_decide=false`; `app.decide_withdrawal(…,'approve')` → `42501 FORBIDDEN: nobody approves or rejects their own withdrawal`; approver `can_decide=true` | VERIFIED |
| Independent approval | Designated approver `approver.e2e@kolekto.test` (`1b431e55…`, admin) approved in the app 14:16:07.194; `approved_as second_approver`, not self, `owner_self_approved=false`; audit `withdrawal.approve` `approval_basis: second_approver` | VERIFIED |
| Dispatch | Worker with TEST key (environment only) + `PAYSTACK_TRANSFERS_ENABLED=true`: `dispatch examined 1 initiated 1`. Transfer `ktr_4f407d1b9c82e8dad677be72`, initiate requested 14:16:59.178, Paystack `received` 14:16:59.750. Worker stopped immediately after the callback | VERIFIED |
| Approval callback | ngrok: POST `/api/webhooks/paystack/transfer-approval` 14:17:00, UA `Needle/3.5.0`, `X-Paystack-Signature` present, **200**, 1457 ms end to end (route 644 ms). Body: event `transferrequest.approval-required`, domain test, endpoint `/transfer`, `details.body` ref `ktr_4f40…` / amount "10000" / NGN / `RCP_mlpn…`, exactly 1 `transfers[]` entry with the same ref / 10000 / NGN / `RCP_mlpn…` / `TRF_0br21xdy0py7d7iy` / status received. Kolekto log: 14:17:01.417 `approve` `authorised`, signature **valid**, linked to the transfer; `provider_approved_at` set, `provider_approval_count 1`; audit `withdrawal.transfer_approved_by_kolekto` | VERIFIED |
| Provider outcome | Paystack TEST verify: **success**, `TRF_0br21xdy0py7d7iy`, 10000 NGN, `RCP_mlpn…`, transferred 14:17:03, fee 0. Exactly 1 Paystack transfer with this reference | VERIFIED |
| Settlement | `transfer.success` webhook (POST `/api/webhooks/paystack` 200) → check #2 source webhook `paid` 14:17:07; withdrawal **paid** 14:17:06.541, `payout_reference TRF_0br21xdy0py7d7iy`; audit `withdrawal.paid` | VERIFIED |
| Ledger | Journals for the withdrawal: hold `ebc77be2…` and payout `9b5c1af4-c05f-4795-8ea2-19de71292d55` (`payout:01a1f94d…`: withdrawing debit 10000 / withdrawn credit 10000 / organiser_payouts debit 10000 / provider_receivable credit 10000). No release, no reversal, no fee journal (fee 0). 1 transfer row for the withdrawal | VERIFIED |
| Balances | Before request: available 107,390,000 / withdrawing 0 / withdrawn 110,000. After hold: 107,380,000 / 10,000 / 110,000. After payout: **107,380,000 / 0 / 120,000** | VERIFIED |
| Reconciliation | `app.platform_reconciliation()` 9/9; ledger imbalances 0 | VERIFIED |
| Cleanup | Worker restarted with no Paystack credentials: `withdrawal_transfers_state enabled:false reason no_paystack_key`; `apps/worker/.env.local` has 0 Paystack lines; no `sk_` string in any worker log; LIVE settings and keys untouched (live approval off, no live key or `PAYSTACK_LIVE_TRANSFERS_APPROVED`). Later that no-key worker exited cleanly (exit 0, last log 2026-11-22 08:32 UTC, no error, no `sk_` in log); no worker process is running now | VERIFIED |

Still open: owner UI to designate a second approver; Next dev log prints the member's OTP from server-action arguments (seen again this run; production logging not reviewed); `scripts/verify/withdrawal-concurrency.mjs` outdated; full pgTAP on a clean itest (needs reset approval); stale UI copy "community owner approves"; LIVE "Confirm transfers before sending" off (owner's decision).


### Session 37 — Phases 1–4 done; Phase 5 (new ₦100 TEST withdrawal) waits for the owner's approval

| Phase | Evidence | Result |
|---|---|---|
| 1–2 On Reject | Owner changed it in the dashboard (Test view, Settings → Preferences → Transfer Approval → On Reject) and saved. After a full reload: **Do Nothing**. Switched the dashboard *view* to Live and reloaded: also **Do Nothing** → one shared setting for TEST and LIVE. Other transfer boxes unchanged (live approval off, test approval on, "Confirm transfers before sending" off). View returned to Test. Claude changed no setting. | VERIFIED |
| 3 Recipient | Dashboard Transfers → Recipients has a filter *All / Only Blacklisted / Exclude Blacklisted*: "Only Blacklisted" → "No recipients". TEST API `GET /transferrecipient?is_blacklisted=true` → 0, `=false` → 8 including `RCP_mlpn6hon3jbfoic` (filter honoured). | VERIFIED (final proof is a transfer Paystack accepts) |
| 4 Recovery | Worker started 13:55 UTC with the TEST key passed through the environment only (no env file edited), `PAYSTACK_TRANSFERS_ENABLED` unset → `withdrawal_transfers_state enabled:true dispatch:false testMode:true`; 0 dispatch runs. Checks on `ktr_bb677138b19c111d2360fc81`: #3 not_found 13:55:27, #4 not_found 14:05:43 (count 3) → `release_failed` (`released_never_sent`). Worker stopped. | VERIFIED |
| Withdrawal | `failed` 14:05:43, reason "Paystack refused the transfer and has no record of it after repeated checks…"; `release_journal_id cd7d6426…`; payout and reversal journal null; `paid_at` null. Audit `withdrawal.failed` (system). | VERIFIED |
| Ledger | Exactly two journals for the withdrawal: hold `088323bc…` (available debit 10000 / withdrawing credit 10000) and release `cd7d6426…` 14:05:43 (withdrawing debit 10000 / available credit 10000, key `withdrawal_release:01a1f8cc…`, actor system). No payout journal. | VERIFIED |
| Balances (collection `open-test`) | Before: available 107,380,000, withdrawing 10,000, withdrawn 110,000 kobo. After: available **107,390,000** (= `available_before_kobo` at request), withdrawing **0**, withdrawn 110,000 (unchanged). | VERIFIED |
| Reconciliation | `app.platform_reconciliation()` 9/9 ok; `v_ledger_imbalances` 0 | VERIFIED |
| Provider | TEST verify `ktr_bb67…` → 404 "Transfer not found"; TEST transfer list still 5, latest `ktr_5def…` 10:45 — nothing new was created | VERIFIED |

State after Phase 4: no open transfers (2 success, 2 failed); worker stopped; `apps/worker/.env.local` has no Paystack lines; dispatch off.


### Session 36 — preflight result: STOPPED, nothing dispatched

| Check | Evidence | Result |
|---|---|---|
| Withdrawal `KWD-54DD01335BA5AB4D` | `processing`, ₦100, `approved_as second_approver` by admin `1b431e55…` (not the requester), member code verified 11:52:22, `hold_journal_id 088323bc…` only; no payout / release / reversal journal; one ledger journal (`collection_available` debit 10000, `collection_withdrawing` credit 10000). Audit: designated 11:50:04 → request 11:52:03 → member_verified 11:52:22 → approve (basis second_approver) 11:54:47 → processing 11:55:25 | VERIFIED |
| Transfer `ktr_bb677138b19c111d2360fc81` | `unknown`, `refused_at` 11:55:27, `refusal_code unknown` ("Recipient is blacklisted"), `not_found_count 1`, no transfer code, `provider_approved_at` null, 0 approval callbacks | VERIFIED |
| Paystack never created it | TEST `GET /transfer/verify/ktr_bb67…` → 404 "Transfer not found"; not in the last 5 TEST transfers (latest is `ktr_5def…` rejected) | VERIFIED |
| Safe retry of the same withdrawal | **Not permitted by the state machine.** `app.record_withdrawal_transfer_check` allows a re-send only when the refusal code is null or transient (`insufficient_balance`, `http_429`); this one is `unknown`. Its designed path is `app.transfer_release_eligible`: refused, never approved, NOT FOUND ≥ 3 (policy `refused_release_min_not_found`) and ≥ 1800 s since refusal → automatic release + withdrawal failed | VERIFIED (code + live policy row) |
| Recipient usable | TEST `GET /transferrecipient/RCP_mlpn…` → `active: true`, domain test; the API has no blacklist field, so un-blacklisting cannot be confirmed without a transfer attempt | UNCERTAIN |
| Worker credentials | Only `sk_test` keys in the three `.env.local` files (no `sk_live`/`pk_live` anywhere); worker env currently has no Paystack key (transfers off) | VERIFIED |
| Live dispatch disabled | A live key also needs `PAYSTACK_LIVE_TRANSFERS_APPROVED=true` (`packages/adapters/src/paystack-transfer-provider.ts:373`); not set in any env file; dashboard "Confirm transfers in live mode" unticked | VERIFIED |
| On Reject = Do Nothing | Paystack dashboard (Test view) → Settings → Preferences, read after a full reload: **On Reject = Blacklist Recipient** (options: Blacklist Recipient / Do Nothing) | **FAILED** — contradicts the owner's note; not changed by Claude |

Recovery procedure proposed (needs the owner's go-ahead; nothing done): (1) owner sets *On Reject → Do Nothing* and **saves** (one setting for test and live), and confirms the recipient un-blacklist; (2) run the worker with the TEST key and `PAYSTACK_TRANSFERS_ENABLED` unset, so the check stage only verifies `ktr_bb67…` by reference — two more NOT FOUND checks make it release-eligible and the database releases the hold once and fails the withdrawal (audited, automatic, no manual release); (3) verify release journal once, reconciliation 9/9; (4) new ₦100 withdrawal (member code, designated approver); (5) enable TEST dispatch for one run, observe the approval callback, success, payout once; disable again.


### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–35 **uncommitted**, not pushed. Local only, Paystack TEST only. Staging paused and untouched; legacy production not read or written; no LIVE setting, record or transfer touched; no Paystack dashboard setting changed by Claude. Database not reset; no Docker volume removed.

**The end-to-end TEST payout is BLOCKED, not done.** Paystack refused the new transfer with *"Recipient is blacklisted"*: the 10:45 rejection of `ktr_5def…` (session 34, old parser) met *On Reject = Blacklist Recipient*, and Paystack blacklisted the member's recipient `RCP_mlpn…`. Kolekto stayed safe (below). Needs the owner in the Paystack TEST dashboard.

### Done this session

| # | Item | Class |
|---|---|---|
| 1 | Environment preserved (no reset, no commit, files kept) | VERIFIED |
| 2 | `parseTransferApprovalRequest` rewritten for Paystack's real body: `data.details.body` and exactly one `data.transfers[]` entry must agree on reference / amount / currency / recipient; `TRF_` code and status `received` required; result is `{ok, request}` or `{ok:false, rejection: payload_*, reference}`. No invented fields, no "first entry" shortcut. | FIXED AND VERIFIED (unit; not yet by a real approving callback) |
| 3 | `app.decide_transfer_approval` now 7 args (+ currency, transfer code, parser refusal). New reasons `payload_*`, `already_paid`, `currency_mismatch`, `transfer_code_mismatch`, `self_approved`, `approver_not_authorised`. Route answers 200 only for parse ok **and** approve. | FIXED AND VERIFIED (pgTAP 70, payments unit) |
| 4 | Redacted fixture `packages/adapters/test/fixtures/paystack-transfer-approval-request.redacted.json` from the real capture (leak check passed); regression + 11 valid/invalid parser tests; signature valid / tampered tests | VERIFIED |
| 5 | On Reject recommendation → **Do Nothing** (owner decision, not changed). Now proven necessary: see blocker. | RECOMMENDATION |
| 6 | `KOLEKTO_WITHDRAWAL_OTP_SECRET` rotated in the three git-ignored `.env.local` files (64 chars, identical, never printed); OTP sent and verified with the new key; secret absent from worker logs, dev-server log and tracked files | FIXED AND VERIFIED |
| 7 | Nobody approves their own withdrawal; an owner's request needs an owner-designated admin/owner (`community_withdrawal_approvers`, `app.set_withdrawal_approver`, `approved_as`), treasurer never enough, audited, time-bounded. Migration `20261120100000` (applied locally with psql; rollback note in its header) | FIXED AND VERIFIED (pgTAP 69 102/102, 64 16/16, 70 92/92; app flow in browser) |
| 8 | TEST worker prepared from backup, started with TEST key, then cleaned: TEMPORARY lines removed (file equals the pre-test backup), worker restart shows `withdrawal_transfers_state enabled:false reason no_paystack_key` | VERIFIED |
| 9 | Real TEST journey: new ₦100 `KWD-54DD01335BA5AB4D` → OTP in Mailpit → verified → approved in the app by the designated approver (not the owner) → worker dispatch 11:55:26 UTC → **Paystack refused: Recipient is blacklisted** → no approval callback | BLOCKED |
| 10 | Failure safety on that refusal: logged `initiate_refused`, transfer `unknown`, verify by reference `not_found`, hold kept, no release, no payout, `platform_reconciliation()` 9/9; worker stopped before any re-send | VERIFIED |

Tests: adapters 240/240, payments 45/45, worker 824/824, web vitest 260/260, root `tsc --build` 0. pgTAP on the dev DB: 69, 70, 64 all pass; 63 78/80 and 18 one failure — environmental only (dev data: 18 awaiting-provider captures, non-empty ledger). Other files that fail on dev data (07, 14, 20, 23, 34, 38, 40, 44, 51, 57, 62, 65) were not caused by this change; a clean itest run was not done (itest down; `itest:reset` needs approval).

### Open findings

- **Withdrawal `KWD-54DD01335BA5AB4D` is `processing` with ₦100 held**, transfer `ktr_bb677138b19c111d2360fc81` `unknown` (not_found 1). Do not release by hand. After the recipient is un-blacklisted, the next worker run re-checks it under the existing policy.
- **Next dev server logs server-action arguments**, so a member's 6-digit OTP (already used) appears in the local dev log (`verifyWithdrawalOtpAction … {"code":"…"}`). Dev mode only as far as seen; production logging not checked. Not changed.
- No owner UI to designate a second approver (SQL only) — blocks owner self-withdrawals in the app. Copy still says "community owner approves". No db-client wrapper for set/list approvers.
- `scripts/verify/withdrawal-concurrency.mjs` still uses owner self-approval and the 4-arg `decide_transfer_approval`; will fail until updated. Not run.
- Local `supabase_migrations` history is behind the applied schema (`migration up` fails at `20261118100100`); new migrations were applied with psql.

### Next (in order)

1. **Owner (Paystack TEST dashboard):** un-blacklist recipient `RCP_mlpn…` (Transfers → Recipients) and set *On Reject* → **Do Nothing**. Claude must not do this.
2. Re-add the TEST lines to `apps/worker/.env.local` (scratchpad backup `worker.env.local.session34.bak`), start the worker from a clean shell (`unset EMAIL_PROVIDER PAYSTACK_SECRET_KEY …`), let it re-check / re-send `ktr_bb67…`; confirm callback (signature valid, parse ok, 200, latency), Paystack success, payout journal once, no release, reconciliation 9/9. Remove the lines again.
3. Owner UI for second-approver designation; update copy; db-client wrappers.
4. Update `scripts/verify/withdrawal-concurrency.mjs`; full pgTAP on itest.
5. Owner (LIVE): check the ₦510 in the legacy admin (unchanged from session 34).

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 35).
Local only, Paystack TEST only. No staging, no legacy production, no Live mode, no dashboard changes by Claude.
Precondition (owner): recipient RCP_mlpn… un-blacklisted in the Paystack TEST dashboard and On Reject = Do Nothing.
Then re-add the TEST worker lines from the scratchpad backup, start the worker from a clean shell, and let it
re-check/re-send ktr_bb677138b19c111d2360fc81 (withdrawal KWD-54DD01335BA5AB4D, approved by the designated
second approver). Verify: Paystack approval callback (signature valid, parse ok, 200, latency), transfer success,
payout journal once, no release, platform_reconciliation() 9/9. If Paystack answers anything unexpected, stop and
investigate; do not retry repeatedly. Remove the worker TEST lines afterwards.
```

---

## Session 34 report (archived 2026-11-20 — kept for history)

**Last updated:** 2026-11-20, session 34 (authenticated Paystack dashboard audit, LIVE ₦510, first real Paystack approval callback)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–34 **uncommitted**, not pushed. Staging paused and untouched. Legacy production not read or written. No Paystack dashboard setting changed by Claude (only the dashboard *view* was switched Test → Live → Test). No LIVE transfer, refund or record change. No code changed this session.

**Update after session 34 (same day, parallel session) — Next step 1 done: approval parser fixed.** `parseTransferApprovalRequest` (`packages/adapters/src/transfer-provider.ts`) now reads Paystack's real `transferrequest.approval-required` body: exactly one `data.transfers` entry (array or index-keyed object; zero or several → unreadable → 400), its `reference`, `amount` and `recipient.recipientCode` (`recipient_code` also accepted). `data.details.body`, when present, is cross-checked: a different reference → unreadable (400); a different amount or recipient → passed as null, which `app.decide_transfer_approval` rejects as `amount_mismatch` / `recipient_mismatch` while logging the reference. Older shapes (top level / `data.reference`) unchanged. Evidence: the captured 10:45:09 body replayed through the parser → `ktr_5def794c9e69a7d82b68c9aa`, 10000 kobo, RCP code, not inbound; replayed to the running local route (no signature header) → linked to the transfer, 400 `transfer_already_final` (correct: that transfer is failed) — this replay added one row to the local approval log. Tests: adapters 240/240 (+7 for the real shape, synthetic values; the real capture is not committed because it holds personal data), payments 43/43, web webhook routes 37/37, web `tsc` 0, worker 824/824, `tsc --build` 0. pgTAP not run (no SQL changed). **Approve → 200 → success not yet seen with a real Paystack request** (needs the new ₦100 run in step 3).

Also fixed earlier the same day (session 33): the worker's transfer reconciliation failed every run (`INVALID_DISCREPANCIES: an array is required`) because `packages/db/src/withdrawal-controls.ts` passed jsonb with a bare `::jsonb` cast; now `::text::jsonb`. Verified: run recorded (provider_mode test, 4 vs 2, 2 info `foreign_reference` = the 2026-11-19 `kprobe_*` probes).

**Mode trap found:** the Paystack dashboard shows a red "Test" label with a grey switch when it is in **TEST**, and a green switch with "Live" when in LIVE. The first read of Preferences was TEST; confirmed by the transfers list ("TEST TRANSFER" badges) and by the "Switched integration — live state" toast. All LIVE claims below were re-read after a full page reload in LIVE.

### A. LIVE incident (read-only)

| Claim | Class |
|---|---|
| Paystack LIVE transaction 6781876817: NGN 510.00, **Success**, ref `kolekto-1795164753146-401579`, Bank Transfer, fee NGN 5.10, paid 2026-11-20 08:54 UTC (09:54 Lagos), message "Approved", metadata collection "100L NACOS COURSE REGISTRATION", payer bank Kuda (account masked). Refunds: none. Disputes: none. | VERIFIED (dashboard, LIVE) |
| `charge.success` webhook delivered | OWNER-REPORTED (this dashboard version shows no webhook log on the transaction page) |
| LIVE *Inbound Transfer Approvals → Receive Approval Requests*: **unchecked** (off). The Webhook URL field still holds `https://bonnet-ruse-unsettled.ngrok-free.dev/api/webhooks/paystack/transfer-approval` but is greyed out (inactive while the box is off). | VERIFIED (LIVE, after reload) |
| The stored inbound URL is Kolekto's **outgoing** approval route (wrong feature). | VERIFIED |
| LIVE outgoing *Transfer Approval*: "Confirm transfers in live mode" **off**, live URL empty. "Confirm transfers in test mode" on with the ngrok URL. On Reject: **Blacklist Recipient** (one setting for both modes). | VERIFIED |
| LIVE transfer OTP ("Confirm transfers before sending"): **off**. With live approval also off, a LIVE API transfer needs neither OTP nor approval — anyone holding the live secret key can move money. Owner's decision; flagged. | VERIFIED (security observation) |
| LIVE webhook URL `https://api.kolekto.com.ng/api/payments/webhook` (legacy production app); TEST webhook = ngrok. | VERIFIED |
| When the inbound box was turned off | UNKNOWN (no LIVE audit-log entry for preferences) |
| Whether the ₦510 became a contribution in Kolekto LIVE | **BLOCKED** — lives in legacy production, which the owner rule forbids reading. Owner to check the legacy admin by the reference. If missing: record a discrepancy, use the audited recovery process, never create by hand. |
| Future inbound risk: none while the box stays off (Paystack sends no inbound requests). Residual: if anyone ticks the box, requests go to the ngrok laptop URL. | INFERRED |

Recommended LIVE action (owner): leave *Receive Approval Requests* **off**. Do not tick it just to clear the URL field (ticking + saving would re-activate inbound approvals). If the URL must be cleared, ask Paystack support.

### B. TEST withdrawal readiness

| Item | Evidence | Class |
|---|---|---|
| Previous transfer `ktr_c19673339a4837e86e3f7ad5` (KWD-A627) | Paystack TEST: **Success**, timeline initiated 10:13 → awaiting OTP 10:13 → successful 10:20 UTC (OTP finalized in dashboard). Kolekto: transfer `success` via `transfer.success` webhook 10:20:52, withdrawal `paid`, payout journal once (4 entries, balanced), no release; `provider_approval_count 0` (approval URL never called). | VERIFIED |
| TEST outgoing Transfer Approval | "Confirm transfers in test mode" on; URL = ngrok `/api/webhooks/paystack/transfer-approval`; reachable (GET 405 in 0.6 s). | VERIFIED |
| TEST business OTP | Dashboard box off, **and proven**: new transfer went `received` → approval request, no `otp` step. | VERIFIED |
| Fresh withdrawal `KWD-0FF76ADC1F9F5EA3` ₦100 | requested 10:43:20 UTC; hold journal (2 entries) | VERIFIED |
| OTP delivery | Mailpit `4ic7Un2Ry2p9dg9hth0R2j` 10:43:22 from noreply@kolekto.test, subject with the reference | VERIFIED |
| Member verified | 10:43:54 | VERIFIED |
| Owner approval | 10:44:45, self-approval (owner is requester) | VERIFIED |
| Worker dispatch | `ktr_5def794c9e69a7d82b68c9aa`, Paystack `received`, 10:45:10 | VERIFIED |
| **Real Paystack approval callback** | 10:45:09 UTC, UA `Needle/3.5.0`, `X-Paystack-Signature` **valid**. Kolekto answered **400 `unknown_reference`** in 179 ms. | VERIFIED — **BUG** |
| Cause | Real body is `{event:"transferrequest.approval-required", data:{integration, domain:"test", details:{body:{source, amount:"10000" (string), recipient:"RCP_…", reference:"ktr_…", reason, currency}, endpoint:"/transfer", headers…}, transfers:[{reference, amount:10000, transfer_code, status:"received", recipient:{recipientCode, …}}]}}`. `parseTransferApprovalRequest` (`packages/adapters/src/transfer-provider.ts:188`) reads only top-level or `data.reference`, so reference = empty. | VERIFIED |
| Result | Paystack TEST: **Rejected** (initiated → request received → rejected). Kolekto: transfer `failed`, withdrawal `failed` 10:45:11, release journal once (2 entries), no payout. TEST recipient still `active: true` (API has no blacklist flag). | VERIFIED |
| `app.platform_reconciliation()` | 9/9 ok after both outcomes | VERIFIED |
| Full journey (approve → success) | not reached because of the parser bug | BLOCKED |
| Worker cleanup | `PAYSTACK_SECRET_KEY` + `PAYSTACK_TRANSFERS_ENABLED` removed from `apps/worker/.env.local` (backup in session scratchpad `worker.env.local.session34.bak`); old worker (PID 28692) stopped; restarted in a terminal tab: `withdrawal_transfers_state enabled:false reason no_paystack_key`, OTP delivery enabled | FIXED AND VERIFIED |

Route audit (inbound stop-gap, `route.ts:63`): classifies by `session_id` + payer/receiver account and no reference → the real outgoing body (no `session_id`) is never treated as inbound; inbound branch writes nothing, runs before any DB access (unaffected by DB outage), only a fixed log line; separate route from `/api/webhooks/paystack`; `setTimeout` does not block the event loop. Cost: each inbound-shaped POST holds a connection 12 s with no auth before the hold. Now unnecessary (inbound off in both modes) but harmless; remove only after deciding what an inbound request should get.

Other risks: *On Reject = Blacklist Recipient* means any Kolekto fail-closed 400 (DB down, parser bug) asks Paystack to blacklist the member's own bank recipient. Recommend **Do Nothing** (needs owner approval; it is one setting for both modes). During this session an 8-character prefix of the local `KOLEKTO_WITHDRAWAL_OTP_SECRET` was printed in a tool output (local-only key); rotate it if wanted.

### Next (in order)

1. ~~Fix `parseTransferApprovalRequest` for the real shape.~~ Done (see the update at the top of this report).
2. Owner: decide *On Reject* → Do Nothing.
3. Re-add the TEST lines to `apps/worker/.env.local` (from the backup), restart worker from a clean terminal, run one new ₦100 withdrawal, confirm approve → success → payout once → reconciliation 9/9. Then remove the lines again.
4. Owner (LIVE): check the ₦510 in the legacy admin.
5. Full pgTAP on itest; concurrency script.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 34).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
The approval parser already reads Paystack's real body (fixed after session 34; adapters 240/240).
Make sure the dev server serving the ngrok URL runs the current code (restart with the
kolekto-web-clean-env launch config, then warm the route). Then, with owner OK, one new ₦100 TEST withdrawal
end to end (worker TEST lines from the scratchpad backup, removed again after), verify approve 200,
transfer success, payout journal once, platform_reconciliation() 9/9.
```

---

## Session 33 report (archived 2026-11-20)

**Last updated:** 2026-11-20, session 33 (LIVE ₦510 investigation; inbound vs outgoing approval separation; TEST withdrawal journey)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–33 **uncommitted**, not pushed. Staging `kwolxuoeqwuedydxzncb` paused and untouched. Legacy production not read or written (rule kept by the owner). No Paystack dashboard setting changed by Claude. No LIVE transfer, LIVE payment, refund or LIVE record change.

**Correction to session 32.** Session 32 (archived below, finding 8) called the 09:54 `Paystack Credit Request` a TEST event and told the owner to look in the TEST dashboard. **That was wrong: it was a real LIVE customer payment of ₦510.** The archived text is kept unchanged except for a correction note.

### A. LIVE (read-only)

| Claim | Class |
|---|---|
| 2026-11-20 08:54:30 UTC, Paystack (UA `Paystack Credit Request`, from 52.214.14.220) POSTed an inbound credit request (₦510, `provider: titan-paystack`, payer bank Kuda, receiver account ending 5107) to `https://bonnet-ruse-unsettled.ngrok-free.dev/api/webhooks/paystack/transfer-approval`. ngrok recorded no response. | CONFIRMED (ngrok capture) |
| Paystack's record: NGN 510.00, **Success**, reference `kolekto-1795164753146-401579`, bank transfer, fee NGN 5.10, paid 08:54 UTC, message "Approved", no refund or dispute, `charge.success` webhook 6781876817 delivered. | CONFIRMED (owner pasted Paystack dashboard record) |
| The URL had been put in the LIVE *Inbound Transfer Approvals* field (Preferences → Virtual Account), a different feature from the outgoing *Transfer Approval*. | INFERRED (payload shape + UA); the owner said they would remove it |
| The URL has since been removed from the LIVE inbound field. | UNKNOWN (owner action; Claude cannot see the LIVE dashboard) |
| The approval-log row at 09:23:50 UTC (reject, `unknown_reference`, signature absent) is this request finishing ~29 min late after the local DB recovered. Paystack had already accepted the payment by then. | INFERRED |
| Whether the live Kolekto system created a contribution for this payment. | UNKNOWN (legacy production not read; owner to check the live admin. If missing, record a discrepancy; do not create one by hand) |
| Risk to future LIVE inbound payments while the URL stays in the inbound field: Paystack documents only "no answer in 5 s = accept"; a 400 answer is undocumented and could reject a customer's payment. | INFERRED from Paystack docs |

Stop-gap (owner-approved 2026-11-20), verified on the running server: the route detects an inbound credit body (`isInboundCreditRequest`), never decides it, writes nothing, and answers 400 only after 12 s (synthetic inbound probe: 400 `inbound_credit_not_handled` after 15.6 s, no DB row; outgoing-shaped probe decided in 0.38 s). It only protects while this local server + tunnel is the URL; removing the URL from the inbound field is the real fix.

### B. TEST (local + ngrok, Paystack TEST key)

| Step | Evidence | Class |
|---|---|---|
| KWD-B830 cancelled via audited UI action | status `cancelled`, exactly 1 release journal, audit `withdrawal.cancel`; available 97,400,000 → 107,400,000 kobo; withdrawing → 0 | VERIFIED |
| Stage A: new ₦100 withdrawal `KWD-A627ED3677BA6236` (10:11:03 UTC) | 1 withdrawal, 1 hold journal (2 entries), audit `withdrawal.request` | VERIFIED |
| OTP delivery | challenge claimed 10:11:04.40 → issued 04.57 → `sent` 04.92 (1.6 s); Mailpit message `05SuoSg7CbfiEaZmc6SlTl` from noreply@kolekto.test, subject with the reference; worker `withdrawal_otp_delivery sent:1` | VERIFIED |
| Member entered code (owner did it in the browser pane) | challenge `verified` 10:11:23, attempt 1 of 5; audit `withdrawal.member_verified` | VERIFIED |
| Stage B: owner approval | `approved` 10:12:04, `owner_self_approved = true`, audit `withdrawal.approve` | VERIFIED |
| Treasurer cannot substitute for the owner | covered by pgTAP 69; not re-run this session | NOT RE-VERIFIED |
| Stage C: worker dispatch (TEST key, `PAYSTACK_TRANSFERS_ENABLED=true`, live gate unset) | transfer `ktr_c19673339a4837e86e3f7ad5` created 10:13:52, Paystack answered **`otp`** 10:13:54; withdrawal `processing`; 1 transfer, no payout journal, hold intact | VERIFIED |
| Paystack called the approval URL | **No.** No Paystack request in ngrok, none in `withdrawal_transfer_approval_requests`. The TEST domain's transfer OTP is on, so the transfer stops at `otp` before approval (as predicted in withdrawal-otp doc §5.1 q10). | VERIFIED (not called) |
| Approval URL itself | reachable over HTTPS, warmed (1.2 s), real TEST provider (signed probe → `valid`) | VERIFIED |
| Ledger posted once / transfer success | not reached | BLOCKED (needs owner: finalize the OTP in the TEST dashboard, or let Paystack abandon it) |
| Platform reconciliation (local) | `app.platform_reconciliation()` 9/9 ok after dispatch | VERIFIED |
| Transfer reconciliation vs Paystack TEST | **was failing on every run** (`INVALID_DISCREPANCIES: an array is required`); fixed; run recorded: provider_mode `test`, provider 4, Kolekto 2, 2 info `foreign_reference` (the old `kprobe_*` probes) | FIXED AND VERIFIED |

What happens to `ktr_c1967…` without action: Paystack abandons an un-finalized OTP transfer (seen on 2026-11-19 after ~1 h; docs say 30 min). The worker's check stage then marks it failed and releases the hold once. Do **not** retry it or start a second transfer for KWD-A627.

### Files changed (session 33)

- `apps/web/app/api/webhooks/paystack/transfer-approval/route.ts` — inbound credit requests held 12 s then 400, never decided; provider errors → 400 (not 500).
- `apps/web/app/api/webhooks/paystack/transfer-approval/route.test.ts` — 13 tests (inbound not decided within 5 s, provider throws → 400, malformed JSON).
- `packages/adapters/src/transfer-provider.ts` — `isInboundCreditRequest()`; `packages/adapters/test/transfer-approval-and-list.test.ts` +3 tests.
- `packages/db/src/withdrawal-controls.ts` — `record_transfer_reconciliation_run` params now `::text::jsonb` (the codebase rule in `packages/db/src/payments.ts`); bare `::jsonb` double-encoded them.
- `supabase/tests/70_transfer_reliability.sql` — plan 83: missing OTP, missing owner approval, missing reservation, not processing.
- `docs/phase-4/withdrawal-otp-owner-approval-2026-11-19.md` — §5.4 (observations), open points 3 and 6.
- Git-ignored: `.claude/launch.json` (`kolekto-web-clean-env`), `apps/worker/.env.local` (TEST key + `PAYSTACK_TRANSFERS_ENABLED=true`, marked "remove after the run"; backup of the previous file in the session scratchpad).
- No migration created or modified.

### Regression cases (brief list of 12)

valid approval, unknown reference, wrong amount, wrong recipient, missing OTP, missing owner approval, missing reservation, already paid → pgTAP 70 (+ route tests); inbound Credit Request, malformed request, provider error, DB failure → route/adapters unit tests. "Provider timeout" at the approval URL is Paystack's side (no answer → `blocked`); covered only by the route's fail-closed tests, not by a real timeout.

### Tests (session 33)

`tsc --build` 0; web `tsc` 0; worker 824/824; payments 43/43; db 6/6; adapters 233/233; web approval route 13/13. pgTAP 70 on the dev DB: 82/83 — test 56 fails only because of 8 pre-existing probe rows on dev; **full pgTAP on clean itest not run** (itest stopped for memory). Concurrency script not run.

### Next (in order)

1. Owner (LIVE): confirm the URL is gone from *Inbound Transfer Approvals*; check in the live admin whether the ₦510 (`kolekto-1795164753146-401579`) became a contribution. Report back; no correction without approval.
2. Owner (TEST), choose one: (a) finalize `ktr_c19673339a4837e86e3f7ad5` in the Paystack **TEST** dashboard before Paystack abandons it, then check ngrok for the first real approval request; or (b) let it be abandoned, confirm the hold is released once, then (with approval) turn off the TEST transfer OTP and run a new ₦100 withdrawal.
3. After the run: remove `PAYSTACK_SECRET_KEY` and `PAYSTACK_TRANSFERS_ENABLED` from `apps/worker/.env.local`.
4. Run full pgTAP on itest (`npm run itest:up`) when memory allows; concurrency script.
5. Then decide whether the inbound stop-gap stays.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 33).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
Check KWD-A627ED3677BA6236 / ktr_c19673339a4837e86e3f7ad5: status, withdrawal_transfer_checks,
withdrawal_transfer_approval_requests, ngrok 127.0.0.1:4040. Never retry it or start a second transfer for it.
If abandoned: confirm exactly one release journal and platform_reconciliation() 9/9.
If finalized by the owner: record the real approval request (payload shape, headers, decision), the ledger
(payout posted once) and reconciliation. Then remove the TEST transfer lines from apps/worker/.env.local and
run full pgTAP on itest.
```

---

## Session 32 report (archived 2026-11-20 — kept for history; see the correction in the session 33 report)

> **Correction (session 33):** finding 8 below and "Next" step 2 call the 09:54 request a TEST event in the TEST dashboard. It was a **real LIVE customer payment of ₦510** sent by the LIVE *Inbound Transfer Approvals* setting. The rest of this report stands.

**Last updated:** 2026-11-20, session 32 (withdrawal "keeps loading" + no OTP email: debugging and fixes)

### Where the work stands

Branch **`feat/payment-receipts-alarms`**, sessions 27–32 **uncommitted**, not pushed. Environment used: **local only** (Docker `supabase_db_kolekto`, Next dev on :3000, ngrok tunnel `https://bonnet-ruse-unsettled.ngrok-free.dev` → :3000). Staging `kwolxuoeqwuedydxzncb` paused and untouched; legacy production untouched; no Paystack dashboard setting changed; Paystack TEST key only; no transfer initiated.

**The end-to-end journey is NOT yet demonstrated.** It is blocked by the PC running out of memory (0.2 GB free of 7.9 GB): the Docker engine API returns 500, local Supabase auth on :54321 times out (so nobody can sign in), Postgres cancels statements (57014). The owner is freeing memory; Docker Desktop may need a restart.

### What was found (session 32)

| # | Finding | Status |
|---|---|---|
| 1 | Stuck withdrawal `KWD-B830B2B23307C5D3` (₦100,000, "Open test", 2026-11-20 08:32 UTC): request, hold journal and OTP challenge were all created; the challenge sat in `pending_delivery`, never claimed. **Failing stage: worker OTP delivery.** | VERIFIED |
| 2 | The running worker was a stale `dist/index.js` built 2026-11-19 12:18, **before** the OTP stage existed — it had no withdrawal-OTP code at all. | FIXED AND VERIFIED (rebuilt; worker logged `withdrawal_otp_delivery_state enabled:true`) |
| 3 | `KOLEKTO_WITHDRAWAL_OTP_SECRET` was absent from every `.env.local`. | FIXED AND VERIFIED (one random 43-character value written to root, `apps/web` and `apps/worker` `.env.local`, all git-ignored; value never printed) |
| 4 | **Indefinite spinner:** the code screen showed "sending" + spinner and polled every 3 s for as long as the challenge stayed `pending_delivery` — for ever when the worker was not delivering. | FIXED, unit-tested; NOT verified in a browser |
| 5 | Server actions that throw (network drop) were not caught in the request, code, resend, owner-decision and money-load paths. | FIXED (try/catch → message); NOT verified in a browser |
| 6 | Approval URL `/api/webhooks/paystack/transfer-approval` answered **500** (`authenticateApprovalRequest is not a function`): the dev server had run ~40 h and its provider cached on `globalThis` predated that method. | FIXED AND VERIFIED (dev server restarted → 400 `unknown_reference` in ~1.1 s via HTTPS; route now fails closed with 400 on any provider error; regression test added). First request after a restart took ~30 s (dev compile): warm the route before any TEST transfer. |
| 7 | **Paystack has never sent an outgoing-transfer approval request** (ngrok capture; `withdrawal_transfer_approval_requests` empty before today's probes). | VERIFIED |
| 8 | **Probably the wrong dashboard field:** at 09:54 local Paystack POSTed a `Paystack Credit Request` (an *inbound* bank-transfer credit: payer/receiver accounts, session id, amount 51000) to the approval URL. That is Paystack's *Inbound Transfer Approvals* feature (Settings → Preferences → Virtual Account), not the outgoing *Transfer Approval*. Kolekto answers 400 to it; what Paystack does with an inbound 400 is undocumented (only "no answer in 5 s = auto-accept" is documented), so incoming Pay-with-Transfer contributions could be rejected. | VERIFIED (request seen); consequence UNKNOWN |
| 9 | Local email goes to **Mailpit** (`http://127.0.0.1:54324`), never to a real inbox. A Gmail member will not receive the code locally, by design. Real inbox delivery needs SES (staging/production). | VERIFIED |
| 10 | A process started from a shell that has **empty** `EMAIL_PROVIDER` / `PAYSTACK_SECRET_KEY` etc. in its environment ignores `.env.local` (Node `--env-file` never overrides an existing variable). Start the worker from a clean terminal. | VERIFIED |
| 11 | After the dev-server restart, an app page open in the Claude browser pane reload-looped (~1/s: "Compiled" → full reload). Not caused by file writes; stops when the pane leaves the app. Cause not identified; possibly memory pressure. | NOT RESOLVED |
| 12 | Local `supabase_migrations.schema_migrations` records nothing ≥ 20261118 although those migrations are applied (applied by psql). `db:migrate` would try to re-apply them. | VERIFIED, not changed |

Reconciliation before any change: `app.platform_reconciliation()` 9/9 ok. No financial record edited. The unsent challenge of KWD-B830 lapsed to `delivery_failed / not_sent_within_validity` through the worker's own claim function; the withdrawal stays `requested` with its hold.

### Files changed (session 32)

- `apps/web/app/c/[slug]/collections/[collectionSlug]/money-view.ts` — `withdrawalCodePhase()` (bounded "sending", "stalled" after 60 s, "sent" only after the email provider accepted).
- `apps/web/app/c/[slug]/collections/[collectionSlug]/MoneyPanel.tsx` — uses it; polling separated from user actions; try/catch on every action; "Processing withdrawal request…"; after an unanswered request the form is locked so a retry reuses the same idempotency key.
- `apps/web/app/c/[slug]/collections/[collectionSlug]/money-actions.ts` — missing OTP key → clear server log + "nothing counted" message.
- `apps/web/app/c/[slug]/collections/[collectionSlug]/withdrawal-stage.test.ts` — 5 tests for the phase.
- `apps/web/app/api/webhooks/paystack/transfer-approval/route.ts` (+ `route.test.ts`) — fail closed 400 on provider error.
- `apps/worker/src/withdrawal-otp-delivery.ts` — subject "Your Kolekto withdrawal verification code (KWD-…)".
- No migration created or modified.

### Tests (session 32)

`tsc --build` exit 0; web `tsc --noEmit` exit 0. Unit: domain 259/259, payments 43/43, adapters 230/230, db 6/6, config 63/63, worker suite exit 0, web 258/258 (16 files). **pgTAP not run** (itest database unreachable: Docker engine failing). Concurrency script not run. The session-31 adapters flake did not recur in this run; cause still unknown.

### Next (in order)

1. Owner: free memory (or restart Docker Desktop). Check `http://127.0.0.1:54321/auth/v1/health` answers 200.
2. Owner: in the Paystack **TEST** dashboard, check where the URL was pasted. Remove it from *Inbound Transfer Approvals* (Preferences → Virtual Account) unless that is wanted; put it in the outgoing *Transfer Approval* setting. Do not touch Live mode.
3. Start the worker from a clean terminal: `cd apps/worker`, `npm run build`, `npm start`.
4. Browser journey: cancel KWD-B830 (owner chose this on 2026-11-20; the audited Cancel releases the hold) → request ₦100 → code in Mailpit → enter it → owner approves → warm the approval route → `PAYSTACK_TRANSFERS_ENABLED=true` + TEST key in `apps/worker/.env.local` → TEST transfer → verify, ledger, `platform_reconciliation()`.
5. Re-run pgTAP on itest once Docker is healthy.

### Paste-ready prompt for the next session

```
Continue on branch feat/payment-receipts-alarms (uncommitted work: preserve everything, no commit/push).
Read docs/phase-4/payment-integration-status-2026-11-12.md ("Latest report", session 32).
Local only. Paystack TEST only. Do not touch staging, legacy production or Live mode.
First confirm local Supabase auth is healthy (127.0.0.1:54321/auth/v1/health = 200) and the worker logs
withdrawal_otp_delivery_state enabled:true. Then run the browser journey from "Next" step 4 and record evidence
(Mailpit message, OTP state rows, owner approval, approval-URL request row, TEST transfer status, ledger, reconciliation).
Re-run pgTAP on itest.
```

---

## What is done (M8.3 + M8.4)

Everything below lives in the **database only**. No form wiring, no Paystack API calls, no webhook route yet.

### Migrations committed

| File                                                                                   | What it adds                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `supabase/migrations/20261111100000_payment_records.sql`                               | Tables, enums, guards (see below)               |
| `supabase/migrations/20261111100100_payment_functions.sql`                             | All DB-side functions (see below)               |
| `supabase/migrations/20261110100000_update_collection_allows_draft_missing_amount.sql` | Allow draft collections without a target amount |

### Tables added (`_payment_records` migration)

- **`payment_limits`** — append-only config: `max_payment_kobo` ₦5,000,000 (500 000 000 kobo), `hold_minutes` 30, `check_window_hours` 24. Version `2026-11-launch`. Truncate-guarded.
- **`fee_schedules`** — versioned fee config. Gained `provider_cost_rate_bps` + `max_provider_cost_kobo`. Row `2026-11-founder`: platform 150 bps, gateway 0 (shown), Kolekto internal 100 bps capped ₦2 000.
- **`collections`** — gained `close_when_target_reached boolean default false` (must have target if true).
- **`contribution_intents`** — idempotency key per (collection, key). Stores contributor name, email (required), phone (required).
- **`payment_attempts`** — one live attempt per obligation (partial unique index). Reference `KLK-[26 chars]`. Frozen fee columns with arithmetic CHECKs. Status: `created → initialized → captured/failed/expired/needs_review → completed`.
- **`payment_attempt_lines`** — line breakdown per attempt.
- **`stock_reservations`** — holds tier/item stock during checkout. Status: `reserved → converted/released`.
- **`provider_transactions`** — append-only raw provider events. Unique on `(attempt_id, content_hash)`. Deny-all RLS (operator-session only).
- **`contributions`** — one per captured attempt. Unique on `attempt_id`.
- **`contribution_lines`** — per-tier/item contribution breakdown.

### Functions added (`_payment_functions` migration)

All functions use the operator-session idiom: `SECURITY DEFINER`, `set search_path = ''`, EXECUTE revoked from public/anon/authenticated, inner guard rejects non-operator calls.

| Function                                    | Purpose                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.create_payment_attempt(...)`           | Validates collection open/visible, window, target, member context, obligation, amounts, fees; reserves stock; returns `(attempt_id, reference, status, amount_kobo, provider_access_code, reused)` |
| `app.mark_payment_attempt_initialized(...)` | Transitions attempt to `initialized` after provider init call                                                                                                                                      |
| `app.release_payment_attempt_stock(...)`    | Releases reservations when attempt abandoned                                                                                                                                                       |
| `app.mark_payment_attempt_failed(...)`      | Marks attempt `failed`                                                                                                                                                                             |
| `app.expire_payment_attempt(...)`           | Marks attempt `expired` (refuses if stock hold still active)                                                                                                                                       |
| `app.record_provider_transaction(...)`      | T1: stores raw provider event; maps mismatches to `needs_review`                                                                                                                                   |
| `app.complete_payment_capture(...)`         | T2: idempotent capture — posts journals, converts reservations, marks obligation paid, optionally closes fundraiser                                                                                |
| `app.post_payment_journal(...)`             | Single-statement CTE journal+entries writer (idempotent by key)                                                                                                                                    |
| `app.ensure_ledger_account(...)`            | Upserts ledger account                                                                                                                                                                             |
| `app.stock_remaining(...)`                  | Reads available stock excluding a given attempt                                                                                                                                                    |
| `app.collection_window_state(...)`          | Lagos calendar-day open/closed/not-yet-open                                                                                                                                                        |
| `app.current_payment_limits()`              | Latest active limits row                                                                                                                                                                           |
| `app.current_fee_schedule_version()`        | Latest fee schedule ≤ today (Lagos)                                                                                                                                                                |

### Fee model (decisions taken — D-11 through D-16, D-28)

- Kolekto shows: **1.5% processing + 0.5% platform** (both uncapped, payer-facing)
- Internal provider cost: **1% capped ₦2 000** (not shown to payer)
- Actual provider fee is authoritative over estimate (D-11); fee breakdown frozen on attempt creation (D-16)
- Error codes: the authoritative list is every `raise exception 'CODE:` in `20261111100100_payment_functions.sql` (e.g. `COLLECTION_NOT_ACTIVE`, `COLLECTION_NOT_YET_OPEN`, `COLLECTION_WINDOW_CLOSED`, `TARGET_REACHED`, `MEMBER_NOT_ELIGIBLE`, `SOLD_OUT`, `CHECKOUT_KEY_REUSED`, `UNKNOWN_PAYMENT_REFERENCE`). The contributor-facing copy is `CHECKOUT_ERROR_MESSAGES` in `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`. An earlier version of this list named codes the SQL never raises; grep the migration rather than trusting a copy.

### Security properties verified

- Operator-session guard: stray `SET ROLE authenticated` before calling any function → `FORBIDDEN`
- RLS enabled + forced on all payment tables
- `provider_transactions` deny-all RLS (officer select via `transaction.view` permission on other tables)
- Idempotency: unique index on `(collection_id, checkout_idempotency_key)` for intents; unique reference per attempt; content-hash dedup on provider events
- Imported-collection guard: `create_payment_attempt` refuses with `COLLECTION_IMPORTED`
- `complete_payment_capture` idempotent: second call with same attempt returns `already_paid` → `needs_review` (does not double-post)
- `block_manual_paid_status` trigger: `paid` status on obligation only allowed if a matching captured contribution exists

### Tests (pgTAP)

- `supabase/tests/52_payments.sql` — 76 tests, all green (plan(76); 76/76 pass)
- Updated: `01_rls_coverage.sql`, `02_grant_matrix.sql`, `03_money_invariants.sql`, `18_fee_configuration.sql`, `27_truncate_guards.sql`

### Contributor contact fields (committed earlier)

- `packages/validation/src/contribution.ts` — `contributorContactSchema` (name, email, phone all required)
- `apps/web/app/[communitySlug]/[collectionSlug]/ContributeForm.tsx` — Email + Phone fields added, both required, with hints

---

## What is NOT done yet

### M8.5 — Orchestrator + form wiring (IN PROGRESS)

#### Done (2026-11-12, session 2)

- **`packages/domain/src/payment-reference.ts`** — `KLK-` + 26 chars Crockford base32 from 128-bit random. `generatePaymentReference()` + `isPaymentReference()`. 7 tests pass.
- **`packages/db/src/payments.ts`** — typed callers for all payment DB functions via `withOwnerConnection`: `createPaymentAttempt`, `markPaymentAttemptInitialized`, `markPaymentAttemptFailed`, `expirePaymentAttempt`, `recordProviderTransaction`, `completePaymentCapture`. bigint values passed as strings with `::bigint` cast.
- **`apps/web/lib/payments/orchestrator.ts`** — `startCheckout()` (validates env, calculates fees, creates attempt, initializes provider, marks initialized/failed) and `confirmPayment()` (verifies with provider, T1 record_provider_transaction, T2 complete_payment_capture). Handles all ProviderResult outcomes. Refuses `fake` provider in production.
- **`apps/web/lib/payments/provider-factory.ts`** — returns `FakePaymentProvider` with `defaultScenario: "success"`. M8.9 replaces this with env-based Paystack selection.
- **`submitContributionAction`** wired — after existing validation (collection status, member context, contact, answers, tier/item resolution, attendee names), calls `startCheckout`. Returns `payment.checkoutUrl`, `payment.reference`, `payment.fees` (formatted naira strings). DB error codes mapped to user-facing messages.
- **Callback page** — `apps/web/app/[communitySlug]/[collectionSlug]/payment/callback/page.tsx` + `PaymentCallback.tsx` + `actions.ts`. Reads `?reference=` from redirect, calls `confirmPayment`, shows result.
- **TypeScript compiles clean** across domain, db, adapters, and web packages.

#### Still needed for M8.5 acceptance

- Worker sweep, fee review, local fake checkout and the seven-flow integration test: **built in session 4**. The integration test passes on the reset itest DB (session 5, 10/10).
- **E2E test** — all seven collection flows end-to-end, in CI

**Acceptance for M8.5:** full happy path + all seven collection flows work against `FakePaymentProvider`; E2E passes in CI.

### M8.9 — Paystack adapter + sandbox (after M8.5)

- `packages/adapters/src/paystack-payment-provider.ts` — real Paystack calls (initialize, verify)
- `apps/web/app/api/webhooks/paystack/route.ts` — webhook handler with dual-header signature verification (`Paystack-Signature` + `whsec_`)
- Sandbox test matrix: card success, failed card, abandoned, bank transfer, webhook-before-redirect, resend from dashboard, reversed, `fees` field present, subaccount split
- **Paystack test keys needed** — stored in `.env.local` (never committed); `whsec_` for webhook verification

### M8.3b — Resolver hardening (can run alongside M8.5)

- Pure window check in `packages/domain/src/contribution.ts`
- Single-tier stock check
- `amountOwed − applied` calculation
- Ceiling check
- Status mapping including `reversed`
- Unit tests for the above

### Still open / deferred

| Item                                                                                             | Where                                    |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Legacy secret key (N6) — confirm Paystack keys rotated since Aug 2026 incident                   | Manual: check with Paystack dashboard    |
| `fake` provider accepted by DB in all envs — **DONE**: orchestrator refuses `fake` in production | `apps/web/lib/payments/orchestrator.ts`  |
| Idempotent reuse compares totals/member, not line breakdown                                      | Low risk; note in code                   |
| DB error messages contain internal IDs — **DONE**: orchestrator maps codes to user copy          | `submitContributionAction` in actions.ts |
| `answers` jsonb column is unbounded                                                              | Future: add size CHECK                   |
| Bought tiers/items can't be deleted (FK RESTRICT) — UX needed                                    | Future milestone                         |
| Paystack subaccount per collection (ADR 0015) — O-1/O-4 owner actions                            | M8.9+                                    |
| Withdrawals, refunds, reconciliation, disputes                                                   | M8.10+ per Phase 4 plan                  |

---

## Key invariants the new code must respect

1. **Integer kobo everywhere.** `app.kobo` bigint domain. Never floats, never rounding without confirming the existing rule.
2. **Never multiply fee rates in SQL.** All rate arithmetic is in `packages/domain/src/fees.ts` (D-12). DB only stores pre-computed kobo amounts.
3. **Fee breakdown frozen at attempt creation** (D-16). Never recompute from live schedule after attempt exists.
4. **Actual provider fee authoritative** (D-11). Record the real `fees` field from Paystack verify response; don't use the estimate for the final journal.
5. **Operator-session for all money writes.** Use `withOwnerConnection` from `packages/db/src/client.ts`. Never call money functions from a Supabase client with `anon`/`authenticated` role.
6. **F5 — no collection takes money in both systems.** The `is_imported` flag blocks `create_payment_attempt`. Do not remove this guard.
7. **D-29 — Lagos calendar day.** Collection windows use Africa/Lagos timezone for start/end. `collection_window_state` handles this; don't reimplement it in TypeScript.
8. **D-30 — close on target.** `close_when_target_reached` is handled by `complete_payment_capture`; no extra check needed in the orchestrator.

---

## How to continue in a new session

1. Read [`docs/phase-4/paystack-integration-audit-and-plan-2026-11-10.md`](paystack-integration-audit-and-plan-2026-11-10.md) §4 (architecture), §5 (per-type blueprints), §10 (roadmap), §14 (decisions taken 2026-11-11).
2. Read [`docs/phase-4/financial-decisions.md`](financial-decisions.md) — especially the "Built on 2026-11-11" section at the bottom.
3. Read the two migration files:
   - `supabase/migrations/20261111100000_payment_records.sql`
   - `supabase/migrations/20261111100100_payment_functions.sql`
4. The next thing to build is **M8.5 — the orchestrator layer** described above.
5. Branch is `feat/payments-foundation`. Docker + Supabase local stack needed to test; `supabase test db` for pgTAP.
