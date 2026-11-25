# Phase A — migration strategy, affected records, rollback and verification

**Date:** 2026-11-23 (session 48). **Status:** written and dry-run only. **Nothing has been applied to itest.**
Nothing has been committed. Dev, staging and production have not been touched.
**Owner decisions incorporated:** D1–D9 of 2026-11-23 (reply to the Phase 0 report
[`community-experience-phase-0-reconciliation-2026-11-23.md`](community-experience-phase-0-reconciliation-2026-11-23.md)).

Phase A has two parts:

- **A-1 — plaintext membership IDs** (A1, D1, D2, D5). Built and dry-run. **Ready to apply on your approval.**
- **A-2 — secure member identification** (A2, D4). Designed below. **Needs your confirmation of the specific
  behaviour** before I write its migration, because it changes what contributors see on every member collection
  (brief A2.11).

---

## 1. Decisions as implemented

| Decision | Where it is enforced |
|---|---|
| A1 plaintext storage | `membership_ids.membership_id` (original ID) + `canonical_id` (comparison form). No hash and no ciphertext on any new row: the row guard refuses them (`PLAINTEXT_ONLY`). |
| D1 two legacy IDs reserved forever | The rows keep `id_hash`. Issuing in a community that has such rows requires the server to send the candidate's HMAC. A match is a collision. A missing HMAC means **refused** (`LEGACY_CHECK_UNAVAILABLE`), so it fails closed. The rows are never deleted or recreated. |
| D2 revoked and replaced IDs kept | Revoke and rotate no longer erase anything. The unique indexes on `(community_id, canonical_id)` and `(community_id, membership_id)` cover **all** rows, revoked ones included. |
| D5 full ID visibility | `app.get_member_membership_id` now requires `membership.issue_ids` (the owner holds it by role; other officers only by grant). Officers who have only `member.view_contact` get the masked form from `app.community_membership_id_summary`. The member page follows the same rule. |
| D3, D6, D7, D8, D9 | Not part of A-1. D3 and D7 apply in Phase F; D6 and D8 in Phase C; D9 means the demo grant is left untouched. |

## 2. Files (all uncommitted)

| File | Change |
|---|---|
| `supabase/migrations/20261123120000_membership_id_plaintext.sql` | **New (M9b2a).** Adds the columns, constraints, unique indexes and canonical function, rewrites the row guard, and re-creates issue/rotate/revoke/get/validate with plaintext parameters. Adds a one-time gated backfill function. Existing rows are **not** changed by this migration. |
| `supabase/pending-migrations/20261123120100_membership_id_plaintext_finalize.sql` | **New (M9b2b), deliberately outside `supabase/migrations`.** The itest tooling compares that folder with its copy, so a file there that has not been applied would be flagged as drift. This one drops `id_ciphertext` and `key_version`, clears `id_hash` on rows that now hold plaintext, requires every row without plaintext to be a revoked legacy row, and drops the backfill function. Its first statement refuses to run while any live row lacks plaintext. |
| `scripts/itest/membership-id-plaintext-backfill.mjs` | **New.** A one-time script that decrypts the five live rows with the itest secret. It is a dry run by default; `--apply` writes everything in one transaction. It refuses any database other than `127.0.0.1:55422` and only prints masked IDs. |
| `apps/web/lib/membership-id.ts` | Encryption removed. `newMembershipId()` added. HMAC kept **only** as the legacy fingerprint (D1) and for the keyed IP hash. |
| `apps/web/lib/membership-id-server.ts` | Issues plaintext and sends the legacy fingerprint when the secret is available. Display reads the plaintext; nothing is decrypted. |
| `apps/web/lib/membership-id.test.ts` | 4 encryption tests replaced by 3 plaintext-format tests. |
| `packages/db/src/membership.ts` | New call signatures; `isLegacyCheckUnavailable()`. |
| `apps/web/app/c/[slug]/members/[memberId]/page.tsx`, `MembershipPanel.tsx` | D5: the full ID only for `membership.issue_ids`; masked for `member.view_contact`. |
| `packages/config/src/env.ts` | Comment only: what the secret is still used for. |
| `supabase/tests/75_membership_ids.sql` | 58 → **71** assertions. Covers plaintext and canonical storage, alphabet and length checks, the legacy fingerprint (refused without the check, collision on a match), revoked IDs kept and never reissued, D5 visibility, immutability, no plaintext in audit rows, and that no client role can run the backfill. |
| `supabase/tests/76_membership_access.sql` | 40 → **41** assertions. Plaintext fixtures, typed-ID validation, typing tolerance, and overlong input treated as a generic failure. |

## 3. Affected records on itest

All in `demo-unilag-alumni`. No other community has membership ID rows.

| Row | Today | After M9b2a + backfill | After finalize |
|---|---|---|---|
| UAL/…E4, …ZQ, …MT, …Y8, …6Z (5 live) | hash + ciphertext | **+ plaintext + canonical** (hash and ciphertext still present) | plaintext only (hash cleared, ciphertext column dropped) |
| UAL/…YM, UAL/…3F (2 revoked, unrecoverable) | hash only | unchanged | unchanged; permanently reserved fingerprints (D1) |

Other writes on apply: one `schema_migrations` row (`20261123120000`); **5 audit rows**
`membership.backfill_plaintext`, which hold the masked form only. Member associations, statuses, timestamps, existing
audit rows, settings and grants are not changed. The active `invite.approve` demo grant (D9) is not touched.

**Backfill dry run, already run (read-only, 2026-11-23):** all 5 live rows decrypt under their own community and
member binding, each recovered ID's HMAC equals the stored `id_hash`, and the prefix, separator and last two
characters agree. The 2 fingerprint-only rows are left untouched. Nothing was written.

## 4. How it will be applied (on your approval)

1. **Pre-checks (read-only):** the latest applied version on itest is `20261123100100`; the 7 rows match §3; the
   backfill dry run is all `ok`.
2. **Apply M9b2a to itest only:** copy the single file into the git-ignored `supabase-itest/supabase/migrations/`
   and run `npx supabase migration up --local --workdir supabase-itest`. This is the wrapper's allowed form: no
   `--db-url`, `--linked` or `--project-ref`. No reset.
3. **Backfill:** `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres node
   scripts/itest/membership-id-plaintext-backfill.mjs --apply`. All 5 rows go in one transaction, or none do.
   (Your shell's `SUPABASE_DB_URL` currently points at the local **dev** database on port 54322. The script refused
   it during the dry run, which is the guard working as intended.)
4. **Verification** (§6).
5. **Stop.** M9b2b (finalize) needs a **separate approval** because it drops two columns.

## 5. Rollback

- **After step 2, before the backfill:** nothing is lost. Restore the `20261123100100` bodies of the guard,
  `insert_membership_id`, issue, rotate, revoke, get and validate. Drop the new functions, indexes, constraints and
  the two new columns. Set `id_hash` back to `not null` and restore `membership_ids_live_has_ciphertext`. All 7 rows
  still have their hash, and the 5 live rows still have their ciphertext.
- **After the backfill:** the same, plus the 5 backfill audit rows stay as history (audit rows are never deleted).
  The old hash and ciphertext are still on the rows, so the old design works again unchanged.
- **If plaintext-only IDs were issued after apply:** before rolling back, the server must compute a hash and
  ciphertext for each of them. Without that, the old `not null` and ciphertext rules cannot be restored. I will not
  issue IDs in a demo community between apply and your sign-off.
- **After finalize:** re-add the two columns, have the server re-encrypt and re-hash from plaintext, then re-apply
  the old functions. No ID is lost at any point, because the plaintext and the legacy fingerprints are never removed.

## 6. Verification

Already done, before any apply:

| Check | Result |
|---|---|
| Dry run (`begin; migration; test; rollback;` per file) on itest | `01_rls_coverage` 4/4, `02_grant_matrix` 7/7, `27_truncate_guards` 25/25, `75_membership_ids` **71/71**, `76_membership_access` **41/41** |
| Finalize applied too early | Refused with `BACKFILL_INCOMPLETE: 5 live membership ID row(s)…`; nothing changed |
| After the dry run | The `membership_id` column does not exist on itest and `20261123120000` is not recorded. Nothing persisted. |
| Root `tsc --build`, `apps/web tsc --noEmit` | Clean |
| `apps/web` vitest | 21 files, **307/307** (was 308: 4 encryption tests removed, 3 added) |
| ESLint on changed web files | Clean. The DB package has no ESLint config, so it was not linted. |
| Postgres logging (itest) | `log_statement=ddl`; parameters are not logged on error (`log_parameter_max_length_on_error=0`); `pgaudit.log=none`. **Residual risk:** `auto_explain` logs the parameters of any statement slower than 10 s. No membership function comes near that, but it is noted for hosted environments. |

**Applied 2026-11-23 (session 49), itest only.** `20261123120000` applied with `migration up --local` (exit 0).
itest records it; the dev DB does not (and has no `membership_ids` table). Backfill `--apply`: 5 rows in one
transaction. Results:

| Check | Result |
|---|---|
| Live rows | 5 with plaintext, 0 without; `canonical_id = app.canonical_membership_id(membership_id)` on all; old hash + ciphertext still present on all 5 (finalize not applied) |
| Legacy rows (D1) | 2, both revoked, hash kept, no plaintext (UAL/…YM, UAL/…3F) |
| Audit | 5 `membership.backfill_plaintext` rows; rows containing any full ID: **0**; notification payloads containing any full ID: **0** |
| Unchanged | unilag member statuses (active 3, archived 1, pending_approval 1, unclaimed 2); D9 `invite.approve` grant still active |
| Validation (rolled back, temporary managed collection) | 5/5 IDs valid as typed; 5/5 valid typed carelessly (lower case, spaces, ` - ` for `/`); unknown ID → false |
| D1 reserved fingerprints (rolled back) | rotate with a legacy fingerprint → `MEMBERSHIP_ID_COLLISION`; with none → `LEGACY_CHECK_UNAVAILABLE` |
| D5 (rolled back) | owner reads 5/5 full IDs; viewer → `FORBIDDEN`; viewer summary gives masked forms only |
| After rollback | temporary collection gone; nothing persisted |
| Full pgTAP on itest | 75 files. Known failures 18 (1), 20 (aborts), 23 (3) as before. **New, environmental:** 57, 62, 63, 65 fail one assertion each because 2 demo settlements on itest became due for T+1 release at 05:00 WAT today, and those tests count every payment the release job moves (each sees exactly +2). Not related to membership IDs; the tests roll back, so nothing was released. 75 71/71, 76 41/41. |
| `packages/db` read as owner (fresh process) | `getMemberMembershipId` returns the full ID |
| Browser (port 3002) | Session 49: not completed (stale server). **Session 50: PASS.** Restarted only the `kolekto-web-itest` process tree (it was the desktop-app preview started 10:25; code changed 11:52). Owner (`demo-overview-owner`): full ID `UAL/…E4` shown; Copy puts exactly that ID on the clipboard. Viewer (`demo-overview-viewer`, grant `invite.approve` only): masked `UAL/•••E4`, no Copy, no full ID in the DOM, the raw HTML or the RSC payload. Direct requests as the viewer: `issueMembershipIdAction` replayed → `missing permission membership.issue_ids`; PostgREST `membership_ids` → 403 (42501); `rpc/get_member_membership_id` → 404 (not in `public`); `Content-Profile: app` → 406 (schema not exposed). Afterwards: still 7 rows, no new audit rows. |

---

## 7. A-2 — member identification by membership ID (REVISED 2026-11-23, for review; not built)

> **Superseded:** the earlier "Prove it's you" design (email one-time codes, challenges, a code-delivery worker
> stage) is withdrawn by the owner's instruction of 2026-11-23. A membership ID is an identifier, like a matric
> number. It is not a password, and A-2 builds no new authentication.

### 7.1 Flow

On a collection whose audience is members (managed), the page asks one question first:
**"I'm a member"** or **"I'm not a member"**. "I'm not a member" appears only when the collection allows
non-members, and the backend enforces that (see 7.5).

**I'm a member**

1. The visitor types their membership ID. Careless typing is fine: case, spaces and `/` versus `-` are ignored
   (`app.canonical_membership_id`).
2. **Lookup (server).** `app.validate_membership_id` runs (already built, DB rate-limited). If the ID is valid, live,
   belongs to a member in good standing, and that member is in this collection's audience, it returns a 30-minute
   access token. Only the token's SHA-256 is stored. The server action keeps the token in an httpOnly cookie
   (`kolekto_member_pass`). The browser's JavaScript never sees it.
3. **Confirmation screen.** A new SQL function returns the member's full name, a partially masked email and a
   partially masked phone. The masking happens **in SQL**, so the full values never leave the database on this path.
   The format is `j•••@gmail.com` and `+234 ••• ••• •567`. A missing value shows as "No email on record". The page
   asks: **"Are these your details?"**
   - **No, that's not me:** the pass cookie is cleared and nothing is stored.
4. **Yes (server).** A confirm action re-resolves the pass live with `app.resolve_membership_access_grant`. Only then
   does it set the existing signed contributor-session cookie (`member_id`). **The confirm step is the only place
   that cookie is set.** The name-search path that set it today (`findMemberAction`) is removed.
5. **Payment form.** It is prefilled with the member's name, and the email and phone in masked, read-only form. If
   the record has no email, the member types one, because Paystack requires an email.
6. **Checkout (server).** `submitContributionAction` already ignores the browser for the member:
   - It reads `member_id` from the signed cookie and re-checks it with `get_collection_member_context`.
   - New: it also requires the pass to resolve to the **same** member, so an expired or mismatched pass means
     starting again.
   - New: it reads the member's **stored** name, email and phone from SQL by the pass and passes them to Paystack
     as the customer details. For a member, contact fields typed in the browser are used only where the record has
     no value.
   - The attempt is created through today's `p_member_id` path (`MEMBER_REQUIRED` / `MEMBER_NOT_ELIGIBLE` checked
     in SQL), so the contribution is attributed to that member. Nothing in `create_payment_attempt` or capture
     changes for the member path.

**Invalid ID:** "We couldn't find a member with this ID. Please check and try again." The same wording covers
unknown, revoked, suspended, not-in-audience and rate-limited (the last one adds "wait a few minutes"). No details
are shown.

**I'm not a member:** the normal payment form (name, email, phone typed in). It is recorded as a guest: no
`member_id`, no membership created, no ID asked for. See 7.5. It is never compulsory to identify where non-members
are allowed.

### 7.2 What is reused, and what is new

| Piece | Status |
|---|---|
| `app.validate_membership_id` (canonical match, good standing, audience check, generic failure, DB rate limits, 30-min token) | **Reused as is** |
| `app.resolve_membership_access_grant` (live re-check) | **Reused as is** |
| `membership_access_grants`, `membership_validation_attempts` tables | **Reused as is.** No new table. |
| Signed contributor-session cookie (`lib/contributor-session.ts`) | **Reused.** It is now set only by the confirm step. |
| `getCollectionMemberContext`, `describeMember`, the obligation / amount resolution, `startCheckout` | **Reused as is** |
| `contributorContactSchema`, the Paystack customer fields | **Reused.** The member's values come from the server. |
| `FindYourself.tsx` | **Reworked** into member/non-member choice → ID box → confirmation |
| `lib/lookup-throttle.ts` (in memory, keyed on `x-forwarded-for`) | **Removed from this path.** The DB limits replace it. |
| Email OTP, challenge tables, code-delivery worker stage, SMS/WhatsApp, new auth or permission types | **Not built** |

### 7.3 Security model

- **Only the server reads full records.** The `app` schema is not reachable through PostgREST
  (`[api] schemas = ["public"]`). The new functions are called only from server actions, through `withCallerContext`
  as `anon`.
- **Enumeration (D4).** `anon` and `authenticated` lose EXECUTE on `app.find_collection_member`. No name, email or
  phone search is left for anonymous visitors. A lookup succeeds only for an exact ID. Every failure reads the same.
- **Rate limits (D4).** They are DB-held, survive restarts and are shared across instances.
  - Per collection: 200 failures per hour. Per community: 1,000 failures per day. These do not depend on the
    caller, so header spoofing cannot get around them.
  - Per client: 10 failures or 30 attempts per 15 minutes, keyed with the server secret on one trusted edge header
    (`KOLEKTO_CLIENT_IP_HEADER`). When it is not configured (itest, local), every caller shares one bucket. It never
    trusts `x-forwarded-for`.
- **No manipulation of attribution.**
  - The browser never sends a member id or member details that the server believes.
  - The member comes from a signed cookie that only the confirm step sets, after a live pass check.
  - Checkout re-checks both the cookie and the pass, and SQL re-checks eligibility.
  - Guessing another member's ID is bounded by the limits above. The ID space is large (5+ Crockford characters
    per community prefix) and failures are generic.
- **Audit.**
  - Existing: `membership.validation_lockout` and the masked validation attempt rows.
  - New: a `membership.identity_confirmed` audit row (collection, member, masked ID only) when the member says
    "yes". No plaintext ID, email or phone goes in any audit, log or queue payload.
- **Residual exposure, for your decision (plain language).** Paystack's hosted checkout page normally shows the
  customer's email address to the person paying.
  - If we pass the **stored** email to Paystack, as the requirement says, anyone who types another member's
    correct ID and clicks "yes" will see that member's full email on Paystack's page. The receipt also goes to the
    member, not to the person who paid.
  - **Option 1 (as specified):** use the stored email. It is simplest and the receipt reaches the real member. It
    accepts this exposure for a person who already knows the member's ID.
  - **Option 2:** show the masked email, and have the payer type an email for their receipt (prefilled empty).
    Paystack gets the typed email. Attribution is unchanged, because it comes from the ID, not the email.
  - **I recommend Option 1 only if you accept that the ID is "something the member has" and not secret. Otherwise
    choose Option 2.** Phone is optional for Paystack. I propose not sending the stored phone in either option.

### 7.4 Database changes (one migration, M9b3; no new tables)

1. `app.membership_pass_summary(p_collection_id uuid, p_token text)` returns
   `(full_name, email_masked, phone_masked)`. It is security definer and granted to `anon` and `authenticated`. It
   returns no row for an unknown, expired or other-collection token. Masking is done in SQL.
2. `app.membership_pass_contact(p_collection_id uuid, p_token text)` returns `(member_id, full_name, email, phone)`
   for checkout, under the same rules. It is called only by the checkout server action. Its result is never
   returned to the browser.
3. `app.confirm_membership_pass(p_collection_id uuid, p_token text)` returns the `member_id`. It does the live check
   and writes the `membership.identity_confirmed` audit row (masked). Optional: the web could call
   `resolve_membership_access_grant` and skip the audit. I recommend the audit.
4. `revoke execute on app.find_collection_member from anon, authenticated`. The function stays for internal use and
   test 14's matching tests run as the owner role. Test 02's anonymous allowlist changes, with a dated comment.

**No payment-function, settlement, ledger, reconciliation, withdrawal or contribution-history change in M9b3.**
Rollback: drop the three functions and re-grant EXECUTE on `find_collection_member`. No data is written by the
migration itself.

### 7.5 Non-member (guest) path — needs the payment function, so it is a separate step (A-2b, M10-lite)

Today a managed collection **cannot** take a payment without a member (`MEMBER_REQUIRED` in
`app.create_payment_attempt`). `allow_non_members` is stored but not read. A real guest path therefore needs a
payment-path migration. It is kept apart from M9b3 and needs its own approval:

- `create_payment_attempt`: on a managed collection with `allow_non_members = true` and no member, the attempt is
  accepted as a guest. Per D7, only `fixed`, `tiers` and `items` are allowed; `per_member` is refused with
  `GUEST_NOT_SUPPORTED`. **Question for you: `open_amount` with guests — allowed or not?**
- New nullable `payer_basis` (`member` / `guest`) on `payment_attempts` and `contributions`, written once at insert.
  No existing row is updated. The append-only triggers stay on.
- `complete_payment_capture`: a guest gets no obligation and no obligation is created.
- Organiser records: register, expected summary, payment activity and reminders show "Guest". Every query that
  joins `contributions.member_id` to `members` is listed and tested with guest rows before apply.
- This reduces the earlier design doc's §3.3: no `member_verification` enum and no `MEMBER_PROOF_*` codes, because
  there is now one member method.
- **Not touched:** fees, Paystack settlement, T+1 release, ledger, reconciliation, withdrawals, transfers,
  collection ownership.

### 7.6 Recovery ("I've forgotten my membership ID") — separate from payment

- **Form:** a registered email address, or an existing member number, for this community. The answer is always:
  "If this matches a member, we've sent their membership ID to the email address on record." It never says
  whether anything matched.
- **Server:** a new anonymous function `app.request_membership_id_reminder(community_id, text, ip_hash)` always
  does the same work and returns nothing.
  - On a match with a live ID **and** an email on record, it inserts a `notification_events` row with only
    `member_id` and `membership_id_id`, never the ID itself.
  - DB limits: per client, per community, and per member (3 a day), so an inbox cannot be flooded.
- **Delivery:** the existing governed worker and email pipeline. The worker reads the ID at send time through a
  worker-only function and renders it in the email. It is never put in the queue payload or logs. This is the same
  template as Phase E's "your membership ID" email. So **I propose building recovery together with that Phase E
  email** rather than in A-2, to avoid building the email twice.
- **Limitation, plainly:** on itest, **none of the 5 members with an ID has an email on record**, so email recovery
  would reach nobody there today. A member who cannot recover can pay as a non-member where allowed, or ask an
  officer, who sees the full ID (D5).

### 7.7 Implementation order (each step reported before the next)

1. **M9b3 + web member path** (7.1–7.4): migration, `packages/db` wrappers, the reworked identification component,
   the actions, checkout contact sourcing, and removal of `findMemberAction` / `lookup-throttle` from this path.
2. **A-2b guest path** (7.5): only after your approval of that migration.
3. **Recovery** (7.6): with Phase E.

### 7.8 Tests

- **pgTAP `77_member_id_lookup.sql`** (new):
  - Valid ID → token → summary with the correct masks, and a missing email shown as null.
  - Careless typing still matches.
  - Unknown, revoked, suspended, archived, not-in-audience and wrong-collection IDs → no row and the same answer.
  - An expired token → nothing.
  - The contact function refuses a bad token.
  - The confirm writes one masked audit row.
  - `anon` cannot execute `find_collection_member`.
  - Lockout still triggers after the limits, and holds across connections (the DB state).
  - The audit and notification leak checks find no plaintext ID, email or phone.
- **Updated:** `02_grant_matrix` (allowlist, dated comment) and `14_contributor_identification` (call as the owner
  role).
- **vitest:**
  - The confirm action sets the session only after the live pass check.
  - "Not me" clears it.
  - Checkout uses the server's contact and ignores tampered browser contact for members.
  - Checkout with a session but no pass, or a pass for another member, is refused.
  - Error copy is identical across failure kinds.
- **Browser (itest, disposable community `qa-membership-2026-11` with a managed fixed collection, fake payment
  provider only):**
  - Valid ID → masked confirmation → yes → prefilled form → fake checkout → contribution attributed to that
    member in the register.
  - An invalid ID shows the exact message.
  - "Not me" resets.
  - Typing an ID in lower case with spaces works.
  - The guest flow is tested after A-2b.
- **Regression:** full pgTAP on itest, web vitest, `tsc --build`, eslint on changed files.

### 7.9 What I need from you for A-2

1. Approve 7.1–7.4 (M9b3 + member path) for itest.
2. Choose Option 1 or 2 in 7.3 (stored email on Paystack's page versus a typed receipt email).
3. Guests: approve A-2b as a separate migration later, and say whether `open_amount` allows guests.
4. Recovery: agree to build it with the Phase E "your membership ID" email.

---

## 8. Owner instructions recorded for later phases

1. Fix the member-added email copy ("member number", not "member ID"): **Phase E**.
2. Member-added and ID-issued notifications stay distinct, with no duplicate welcome email: **Phase E**.
3. Email goes through the governed worker: A-2 and Phase E.
4. WhatsApp is a recommendation only: Phase E.
5. A disposable test community and test accounts: created at the first browser test that writes (after A-1 apply).
6. The `03_money_invariants.sql` difference (one allowlist name, from session 43d) is reported and not overwritten.
7–9. Itest only; nothing LIVE; no transfer, withdrawal, settlement, ledger or reconciliation change; no reset,
demo-data deletion, commit, push, merge or deploy.
