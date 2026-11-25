# Community experience, personal profile, KYC and community overview

**Date:** 2026-11-22 · **Branch:** `feat/payment-receipts-alarms` (uncommitted; see §11)
**Status:** Phase 1 audit and Phase 2 design complete; Phase 3–4 implemented for the parts that need no
external decision (§9). Personal KYC and community KYC submission are **designed, not built** — both are
blocked on DEC-04/DEC-05 (provider, legal and operational decisions, §7–§8).

**Latest:** Part F (fifth pass, 2026-11-22) — configurable membership IDs, non-member contributions, payment-time
membership snapshot, later linking, separate `kolekto-admin` repository. Designed only; nothing built.

This document is the source of truth for the redesign. Implemented and not-implemented are kept apart on
purpose: nothing here is "done" unless §10 says it was verified.

---

## 1. Audit — what exists (read from the code and migrations, 2026-11-22)

### 1.1 Who logs in

| Fact | Where |
|---|---|
| A **user is a login**, never a financial owner. No `role` column. | `20260917120200_users.sql`, ADR 0004/0008 |
| **Only officers hold accounts.** Members and contributors never log in (PRD 0.3, SEC-06). Joining by invite link creates a `members` row with no account (`app.redeem_invite_link`). | `users.sql` header, `apps/web/app/invite/[token]/actions.ts` |
| A user reaches a community **only through an active `officer_terms` row** (`ended_at is null`, `started_at <= now()`). Roles: `owner`, `admin`, `treasurer`, `collector`, `viewer`. One role per person per community. | `app.current_user_community_ids`, `communities_select_officer` |
| `members.user_id` exists (a claimed member record) and `members_select_self` lets that user read their row, but a member-only user **cannot see the community** (no officer term). There is no member portal. | `20260917120500_members.sql`, RLS |

**Consequence for this brief.** "Ordinary member" in the brief maps to the `viewer` or scoped `collector`
officer roles. A member-facing login does not exist and is **not** invented here (§12, decision D-A).

### 1.2 Journey before this change

1. `/login` → middleware sends a signed-in user from any auth page to **`/communities`**; un-onboarded users
   go to `/welcome` (`apps/web/lib/supabase/middleware.ts`).
2. `/communities`: a two-column list of names + slug. No role, no verification, no counts.
3. `/c/[slug]`: overview with two tiles (members — every row including archived; officers) and a
   "verification not available in this build" card. No money (comment: "belongs to Phase 3/4").
4. `/account`: profile form (name, phone; email read-only), password, saved payout accounts. Reached only by
   typing the URL — **no link anywhere in the app**.
5. Community nav (`AppShell`): Overview, Collections, Members, Activity, Settings — shown to **every** role,
   even when the page would show nothing (Activity needs `audit.view`, Members needs `member.view_contact`).

### 1.3 Profile, KYC, bank accounts

| Area | State |
|---|---|
| Profile | `users.full_name`, `phone_e164`, `email` (citext), `created_at`, `status`. No avatar column. `app.update_user_profile` writes name/phone. Email is read-only in the UI. |
| Personal KYC | `users.identity_level` enum `none` → `contact_verified` (set by email OTP, `20260930110000`) → `identity_verified` (**nothing sets it**; DEC-04 "which checks each level requires" is open). No provider, no table, no documents. |
| Q3 (owner, 2026-11-18) | "A saved bank account whose Paystack-resolved name matches the profile name **replaces the identity_verified gate** for withdrawals." `request_withdrawal_to_account` no longer checks `identity_level`. |
| Bank accounts | **Built and correct.** `user_bank_accounts` (per user, not per community): Paystack resolution, name match (`@kolekto/domain` `matchBankAccountName`), `verified`/`needs_review`/`rejected`/`disabled`, one default, D-08 48 h cooling-off for any account after the first, limits (5 active, 10/day), last-4 only to clients, re-review on profile-name change (`20261118100200`). UI: `apps/web/app/account/PayoutAccounts.tsx` + `bank-actions.ts`. |
| Withdrawal destination | `app.request_withdrawal_to_account(collection, amount, bank_account, key)`: own account only, `verified`, past `usable_from`; funds from **that collection's** `collection_available` ledger account under row lock; hold journal attributed to the collection; OTP challenge; owner / second-approver approval; Paystack transfer with Kolekto-side approval. |

### 1.4 Community verification

| Fact | Where |
|---|---|
| `communities.verification_status` (`unverified`/`pending`/`verified`/`rejected`/`expired`) + `verified_at`. | `20260917120300_communities.sql` |
| Permission `community.submit_verification` exists (owner only). | role matrix |
| **No submission table, no review function, no documents, no provider.** `target-schema.md` lists `verification_records` as designed-not-built, gated on DEC-04/DEC-05. | — |
| The only live effect: an **unverified community may withdraw at most ₦1,000,000 per Lagos day** across all its collections (D-07). | `request_withdrawal_to_account` |

### 1.5 Money — authoritative sources

| Figure | Authoritative source |
|---|---|
| Gross collected | `contributions` with `status = 'applied'` (a contribution exists only after a verified capture). Same expression as `app.collection_financial_overview.total_raised_kobo`. Pending, failed, abandoned, under-review attempts never create a contribution. |
| Pending / available / on hold / being withdrawn / withdrawn | `public.v_collection_position` — ledger-derived, per collection. Its own comment: *"There is no community-level equivalent and there must not be one — a community total is a report, never a thing money is authorised against."* |
| Pending withdrawal requests | `withdrawals.status in ('requested','approved','processing')`; their money is the ledger `collection_withdrawing` bucket. |
| Completed payouts | `withdrawals.status = 'paid'`; their money is the ledger `collection_withdrawn` bucket (a later `reversed` moves money back by journal). |
| Refunds / chargebacks | Ledger accounts exist (`collection_chargeback`, `collection_refund_reserve`); **no refund flow exists** (`contribution_status` has only `applied`). Shown if ever non-zero; nothing to compute today. |

### 1.6 Activity and audit

`audit_logs` (append-only, `audit.view`), `app.collection_payment_activity` (per collection: payer name,
status, eligibility; `transaction.view`; withdrawals with `balance.view`; never email/phone/account number).
No community-wide activity read existed.

### 1.7 Permission matrix (relevant subset)

| Permission | owner | admin | treasurer | collector (scoped) | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| community.view_dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| member.view_contact | ✓ | ✓ | ✓ | ✓ | ✓ |
| transaction.view | ✓ | ✓ | ✓ | ✓ (scope) | ✓ |
| balance.view | ✓ | ✓ | ✓ | — | ✓ |
| collection.draft | ✓ | ✓ | ✓ | — | — |
| invite.create | ✓ | ✓ | ✓ | ✓ | — |
| withdrawal.request / approve | ✓ | — | ✓ | — | — |
| audit.view | ✓ | ✓ | ✓ | — | ✓ |
| community.edit_profile | ✓ | ✓ | — | — | — |
| community.submit_verification | ✓ | — | — | — | — |

### 1.8 Gaps and risks found

| # | Finding | Severity | Action |
|---|---|---|---|
| G1 | `/account` unreachable from the UI | UX | Fixed (§9) |
| G2 | Overview "Members" counts archived, merged and pending-approval rows | Data | Fixed: defined in §5 |
| G3 | Community nav shows pages a role cannot use | UX | Fixed: nav filtered by the same permission read |
| G4 | No community-level money view at all | Product | Built as a **report** (§5), never a balance |
| G5 | Personal KYC and community KYC have no backend | Product/legal | Designed (§7–§8); blocked on decisions |
| G6 | `identity_level = identity_verified` is never set by anything | Data | Shown honestly; not faked |
| G7 | Brief's brand palette (#00BA16 …) is **not** the codebase's tokens (`packages/ui/src/tokens.css`, primary #14532d) and #00BA16 with white text is ~2.6:1 contrast (fails WCAG AA) | Design | Not changed; decision D-E (§12) |
| G8 | Slug allocation does not exclude app route words (pre-existing note in middleware) | Low | Unchanged; mentioned only |

---

## 2. New journey

```
login ──► /communities  (Community home)
            ├─ header: Kolekto · notifications · avatar menu (Profile, Communities, Sign out)
            ├─ "Your personal space" card (personal community)
            ├─ "Communities you manage"  (owner · admin · treasurer)
            ├─ "Other communities"       (collector · viewer)
            └─ empty state: Create a community · How officer invitations work
          /account  (Personal profile — same page from anywhere)
          /c/[slug]  (Community workspace → Overview)
```

Each community card: logo or initials, name, type label, **your role**, verification badge, collections
(live / total — only for roles that can see collections; all officer roles can), status if not active,
"Open" action. A card is served by `app.my_communities()` — one call, no N+1.

## 3. Personal profile (`/account`, reachable from the avatar menu and the community sidebar)

Sections, top to bottom:

1. **Identity header** — initials avatar, legal name, email, "On Kolekto since …", verification badge.
2. **Personal information** — existing form. Legal name edit keeps the existing rule: a name change sends
   every saved bank account back to review (`rereview_bank_accounts_on_name_change`), so a display-name edit
   can never be used to pass a bank-name match. Email read-only (Supabase Auth owns it). Phone validated E.164.
3. **Personal verification** — real state from `users.identity_level` + `email` confirmation; payout-account
   name match shown as the current withdrawal gate (Q3). The identity-check step is shown as **not yet
   available** with why. No form is offered (§7).
4. **Payout bank account** — existing `PayoutAccounts` (unchanged logic): add, verify via Paystack, resolved
   name, default, cooling-off, review states.
5. **Password**.

Avatar photo upload is **not built** (needs a storage bucket + policy; decision D-F).

## 4. Community workspace navigation

Overview · Collections · Members · Activity · Settings, each shown only when the role holds the permission
the page needs (`community.view_dashboard`, `member.view_contact`, `audit.view`). Settings stays visible to
every officer (it lists officers and the caller's own notice settings). Officers are managed inside Settings
(existing); no new page. Sidebar footer gains a link to the personal profile.

## 5. Community overview — layout and metric definitions

Order: verification card → statistics → money (balance.view only) → collections needing attention → recent
activity (5) → quick actions by permission.

All figures come from **`app.community_overview(community)`**, which sums
**`app.community_collection_figures(community)`** — one row per collection the caller may see — so the
community total is the sum of the per-collection rows *by construction*, and each per-collection row reads
the same sources as the collection page. Nothing is computed in the browser.

| Metric | Exact definition | Who sees it |
|---|---|---|
| Members | `members.status in ('active','unclaimed')` — on the roll. Breakdown: confirmed (`active`); waiting (`invited` + `pending_approval`, **not** counted as members). Archived and merged excluded. | view_dashboard |
| Officers | `officer_terms` with `ended_at is null and started_at <= now()` | view_dashboard |
| Collections | every collection except `archived` (= the Collections page "All" tab); drafts counted separately | view_dashboard |
| Live | `status = 'active'` only (scheduled/paused are not live); link opens Collections filtered to "Active" | view_dashboard |
| Total collected | Σ `contributions.contribution_kobo` where `status='applied'`, over collections where the caller has `transaction.view` (collector scope honoured). Gross, before fees. "Collection activity, not money available." | transaction.view |
| Successful payments | count of those contributions | transaction.view |
| Collection balances | Σ (pending + available + on hold + being withdrawn) from `v_collection_position` — money still held for the collections | balance.view |
| Available to withdraw | Σ `available_kobo` (only released, T+1-settled money; held money excluded) | balance.view |
| Settling | Σ `pending_kobo` (successful payments before release) | balance.view |
| Pending withdrawals | amount Σ `withdrawing_kobo` (ledger); count of withdrawals `requested/approved/processing` | balance.view |
| Withdrawn | Σ `withdrawn_kobo` (ledger, net of reversals); count of `paid` withdrawals | balance.view |
| On hold | Σ `on_hold_kobo`, shown only when non-zero | balance.view |

"Available to withdraw" is labelled as a **sum of separate collection balances**: each collection's money
can only be withdrawn from that collection. There is no community wallet, no transfer between collections,
and nothing in these functions writes.

**Recent activity** — `app.community_recent_activity(community, limit ≤ 20)`: successful contributions
(payer name exactly as the collection's own activity shows it to the same officer; no email, phone, reference
or account number), collections published, withdrawals requested / paid (balance.view), officers appointed.
Each source is filtered by the caller's permission **per collection** (collector scope). "View all" goes to
`/c/[slug]/activity` only for roles with `audit.view`.

**Collections needing attention** — up to 5 live collections ordered by most recent payment, with progress
against target where a target exists (integer arithmetic), linking to the collection page.

## 6. Permissions per section

| Section | Requirement (server) |
|---|---|
| Community home cards | active officer term (function reads `auth.uid()` only) |
| Overview counts | `community.view_dashboard` (refused otherwise) |
| Collected / payments | `transaction.view` per collection |
| Balances / withdrawals | `balance.view` per collection |
| Verification card action | `community.submit_verification` to see the "Prepare verification" action |
| Quick actions | `collection.draft` (New collection), `invite.create` (Invite members) |
| View all activity | `audit.view` |

## 7. Personal KYC — architecture (not built; blocked)

**Why not built.** No provider, credentials, data-protection basis or review process exists. Building a form
that stores ID numbers with no verifier would create sensitive data with no purpose and invite a fake
"verified" state.

**Proposed design** (when D-B/D-C are decided):

- Table `identity_verifications` (one row per attempt, per user): `status` (`started`, `submitted`,
  `needs_info`, `approved`, `rejected`, `expired`), `provider`, `provider_reference`, `checks` (jsonb of
  pass/fail per check — **no raw ID numbers, no document bytes**, only last-4 / hash where needed),
  `decision_by` (`provider` | staff id), `decision_reason` (shown to the user), timestamps. RLS: the user reads
  their own rows; no officer of any community can read them. Writes only through `app.*` functions; the
  provider webhook and staff review are the only paths to `approved`.
- `users.identity_level = 'identity_verified'` set **only** by the approval function, audited.
- A legal-name change after approval re-opens verification (same pattern as bank re-review).
- Documents, if a provider needs uploads, go to a private bucket with no client read and a retention window.
- UI states map 1:1 to `status`.

**Decisions required:** D-B provider (e.g. a BVN/NIN-matching API vs. document + liveness vendor), credentials
and sandbox; D-C what Kolekto legally must hold (NDPA 2023 basis, retention, DPO sign-off); D-D what
identity verification unlocks given Q3 already uses the bank-name match for withdrawals.

## 8. Community KYC — architecture (not built; blocked)

**Built now:** the overview card and `/c/[slug]/verification` show the **real** `verification_status`, what
verification changes today (the ₦1,000,000/day limit — the only rule in code), and a readiness checklist
read from real data: profile completed (description, location), community contact verified
(`contact_verified_at`), owner's email confirmed, owner has a verified payout account. Submission is shown as
"not open yet".

**Proposed design:** `community_verification_submissions` (community-scoped, append-only versions):
`status` (`draft`, `submitted`, `needs_info`, `approved`, `rejected`), representative `user_id` (must be an
active owner), snapshot of official name/type/description/address, `documents` (private storage paths;
officers with `community.submit_verification` only), `review_reason`, `reviewed_by` (staff realm, ADR 0009).
`communities.verification_status` changes only through `app.review_community_verification` (staff) — audited
with `community.verification_*` actions. Requirements per `community_type` live in a configuration table,
not code (D-G).

## 9. What this change implements

| Layer | Change |
|---|---|
| Migration `20261122120000_community_home_and_overview.sql` | **Reads only.** `app.my_communities()`, `app.community_collection_figures(uuid)`, `app.community_overview(uuid)`, `app.community_recent_activity(uuid, integer)`, `app.community_verification_readiness(uuid)`. All `security definer`, `search_path=''`, permission-checked inside, granted to `authenticated` only. No table, column, policy or grant on a table changes. |
| `@kolekto/db` | `packages/db/src/community-overview.ts` typed callers (kobo as `bigint` strings, no arithmetic). |
| Web | `/communities` redesign; `AuthenticatedTopBar` avatar menu; `AppShell` permission-filtered nav + profile link; `/account` restructure (identity header, verification section); `/c/[slug]` overview rewrite; `/c/[slug]/verification` readiness page; Collections page honours `?filter=`. |
| Tests | pgTAP `73_community_overview.sql`; unit tests for display helpers. |

## 10. Verification record (2026-11-22)

| Check | Result |
|---|---|
| Migration `20261122120000` dry-run in a rolled-back transaction on **itest** | OK |
| Applied to **itest only** (single transaction + `schema_migrations` row; `supabase-itest` copy byte-identical) | APPLIED |
| **Dev DB (`:54322`), staging, production** | **NOT applied** |
| pgTAP `73_community_overview.sql` (new) | 39/39 |
| Full pgTAP suite on itest (72 files) | all pass after one allowlist entry in `03_money_invariants.sql` #4 (see §14) |
| `tsc --build` | clean |
| `npm run lint` | 1 error + 1 warning, both pre-existing (`MoneyPanel.tsx:422`, `VerifyForm.tsx:72`); none in new files |
| Web unit tests (vitest) | 19 files, 290 tests pass (9 new in `lib/community-display.test.ts`) |
| `npm run invariants` | only the known session-39 `one Paystack caller` hit (`packages/domain/test/log-redaction.test.ts:28`) |
| Browser walkthrough (preview `kolekto-web-itest`, port 3002, itest stack) | community home, avatar menu, overview, verification page, profile at 375 px, collector view, outsider slug → 404 |
| Demo figures vs. ledger (seed `d0e0…`) | collected ₦150,000 = 6 × ₦25,000; available ₦58,000 = ₦98,000 released − ₦30,000 paid − ₦10,000 held; settling ₦49,000; held ₦117,000; `platform_reconciliation()` 9/9 ok, imbalances 0 |

Not verified: Playwright e2e suite (not run); a viewer login in the browser (covered by pgTAP only); performance
at large volumes (functions use the existing indexes plus `contributions_community_captured_idx`; no load test).

## 13. Calculation sources (exact)

| Overview figure | SQL |
|---|---|
| Members / confirmed / waiting | `members.status in ('active','unclaimed')` / `= 'active'` / `in ('invited','pending_approval')` |
| Officers | `officer_terms` `ended_at is null and started_at <= now()` |
| Collections / live / drafts / scheduled-or-paused / closed | `collections.status <> 'archived'` / `= 'active'` / `= 'draft'` / `in ('scheduled','paused')` / `= 'closed'` |
| Total collected, payments, last 30 days | `contributions.status = 'applied'`, `sum(contribution_kobo)`, over collections with `has_permission_for_collection(…,'transaction.view')` |
| Settling / available / on hold / pending withdrawals / withdrawn | `v_collection_position.pending/available/on_hold/withdrawing/withdrawn_kobo`, over collections with `balance.view` |
| Held across collections | pending + available + on hold + withdrawing (same rows) |
| Open / completed withdrawals (counts) | `withdrawals.status in ('requested','approved','processing')` / `= 'paid'` |

pgTAP 73 proves: collected = Σ `collection_financial_overview.total_raised_kobo`; each bucket = Σ
`v_collection_position`; each collection row = that collection's own overview; pending withdrawals (ledger) =
open withdrawal records; a collection's available never includes another collection's money; reading changes
no journal, entry, position or withdrawal.

## 14. Known issues and follow-ups

- `03_money_invariants.sql` #4 is a text guard on `status = 'paid'`; `community_collection_figures` only counts
  paid withdrawals, so it was added to the allowlist with a dated comment (same convention as the 2026-11-17/18
  entries). Review that entry.
- First visit to `/account` on a cold dev compile (≈39 s) redirected to `/communities` once (`requireUser` saw no
  session mid-compile); immediate retry worked. Same class as the existing "vanished session mid-render" notes.
- Next.js dev overlay reports a security advisory for **Next 16.4.2** (pre-existing; not acted on).
- `.claude/launch.json` gains `kolekto-web-itest` (port 3002, itest URLs, payment/email secrets cleared; the local
  keys are the shared CLI defaults, checked by hash, nothing secret in the file).
- itest now holds demo data: users `demo-overview-{owner,viewer}@kolekto-itest.test` (passwords only in the
  session scratchpad), communities `demo-unilag-alumni`, `demo-ikoyi-estate`, `demo-amaka-space`, ids `d0e0…`.
  Withdrawals use the legacy path with no saved bank account, so the transfer worker cannot claim them. Full
  pgTAP re-run with this data present: see the status doc.

## 15. Readiness

| Area | Assessment |
|---|---|
| Local implementation | **Ready** for review: built, tested on itest, walked through in a browser |
| Security and financial integrity | Reads only; permission re-checked in every function; collector scope honoured; no new table, policy or grant on a table; ledger untouched (pgTAP 73 #38). Community verification and KYC states come only from the database |
| Staging | **Not ready**: nothing committed; migration not on dev or staging; staging blockers from the risk register still apply |
| LIVE production | **Not ready**: same, plus the KYC/community-verification decisions (§12) and the Next.js advisory |

## 11. Repository state warning

This branch already carries a large **uncommitted** payments change set (sessions 25–42b). This work is also
uncommitted and touches different files except `apps/web/app/account/page.tsx` (both change sets) and
`apps/web/components/AppShell.tsx`. Commit the payments work first, or review the combined diff carefully.

## 12. Decisions needed from the owner

| # | Decision | Default taken here |
|---|---|---|
| D-A | Should members (non-officers) ever log in? | No — not invented |
| D-B | Personal KYC provider + credentials | None; KYC shown as not available |
| D-C | Legal basis / retention for identity data | — |
| D-D | What `identity_verified` unlocks, given Q3 | Unchanged |
| D-E | Adopt #00BA16 / #FFB300 palette? (contrast issue G7) | Existing tokens kept |
| D-F | Profile photo upload (storage bucket + policy) | Initials avatar only |
| D-G | Community verification requirements per type, reviewer process | Readiness checklist only |

---

# Part B — Product direction update (owner brief, 2026-11-22, second pass)

Status words used below: **IMPLEMENTED** (code exists and was tested), **DESIGNED** (written here, no code),
**BLOCKED** (needs a decision, provider or legal input named in §B12).

## B1. Why the changes were not visible in the normal development app (diagnosis, verified)

| # | Question | Finding (evidence) |
|---|---|---|
| 1 | Branch | `feat/payment-receipts-alarms` at `9f05892`. All session-43 work is **uncommitted** in the working tree. |
| 2 | Files | 11 modified + 9 new (list in §9 and the status doc). Also modified in the tree, **not by session 43**: `packages/domain/test/log-redaction.test.ts`, 7 files under `tests/e2e/` and new `tests/e2e/helpers/collection-detail.ts`. |
| 3 | Pages exist | Yes: `/communities`, `/c/[slug]` overview, `/c/[slug]/verification`, `/account`. |
| 4 | Dev server on that code | Yes. Port 3000 is `next dev` (PID 25912, started 2026-11-20 15:32) from this checkout. Its build folder `.next/dev` compiled the new `/communities` page at 2026-11-22 10:39, so it **is** serving the new code. Not a stale build. |
| 5 | Database used | `apps/web/.env.local` → `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, `SUPABASE_DB_URL=…@127.0.0.1:54322` = the local **dev** stack (`supabase_db_kolekto`). Not hosted, not itest. |
| 6 | Migration applied there | **No.** `20261122120000` is absent; `app.my_communities()` → `ERROR: function app.my_communities() does not exist`. (Six earlier migrations, 20261118100100 … 20261120140000, are present as objects but have no `schema_migrations` row — applied by hand in earlier sessions; only `20261122120000` is truly missing.) |
| 7 | Effect | Every new read is wrapped in `try/catch`, so nothing crashes — instead: `/communities` shows *"Your communities could not be loaded"*; the overview shows the new header and verification card, then *"This community's figures could not be loaded"* instead of the stats, money and activity; `/c/[slug]/verification` shows an error box; `/account` renders but the email/identity summary is blank. |
| 8 | Routes accessible | Yes; `/communities` → `/login?next=%2Fcommunities` when signed out (expected). |
| 9 | Middleware / roles | No new redirect. The sidebar now hides items the role lacks (by design). |
| 10 | Stale state | No (see 4). |

**Cause:** the code reached the dev app; the database functions it reads did not. **Fix:** apply migration
`20261122120000` to the dev database (owner approval needed). Dry-run on dev inside `begin … rollback`: applies
cleanly (6 functions created; dev has 131 communities, 25 contributions; rollback left nothing). The migration
creates 6 read-only functions and 1 index; no table, column, policy, data or grant on a table changes.
Rollback: drop the 6 functions and `contributions_community_captured_idx`.

## B2. What already exists that changes the plan (read from the code)

- **Public collection pages already exist**: `/[communitySlug]/[collectionSlug]` (+ `/payment`, receipt,
  callback), anonymous, via `app.get_public_collection*` (SEC-12: whitelisted fields only). Contributors already
  pay without an account; capture never inserts a `members` row or a user (only member-management and invite-link
  functions do).
- **There is no public community page**: `/[communitySlug]` has no `page.tsx`. `/c/[slug]` is the private
  workspace. So the public page belongs at **`kolekto.com.ng/[communitySlug]`** (matching the existing collection
  URLs), not `/c/…`. Slugs are already unique, regex-checked and checked against reserved route words
  (`app.is_reserved_community_slug`, migration 20260930100000).
- **Collection visibility already exists**: enum `collection_visibility` = `public` (listed on the community page),
  `unlisted` (link only), `members_only`. The UI offers `public` / `unlisted`; the default is `unlisted`.
- **Community profile fields already exist**: `logo_url`, `description`, `location_state`, `location_city`,
  `institution`, `contact_email`, `contact_phone_e164`, `contact_verified_at`, `show_officers_publicly`.
- **Avatar**: `users.avatar_url` exists (unused). Storage pattern to copy: `collection-covers` bucket
  (20260920160500: size and MIME limits, per-path policies) and `CoverUploader.tsx`.
- **D-07 daily limit is already enforced** in `app.request_withdrawal_to_account`: ₦1,000,000 per Lagos day across
  **all** of an unverified community's withdrawals, under a per-community advisory lock — so separate collections
  and simultaneous requests cannot bypass it. Part 7 rule 1 needs no new code; only display.
- **No platform-administrator concept exists anywhere** (no role, table, app or policy). Every "Kolekto admin
  approves" requirement (community verification, community bank accounts, manual KYC decisions) depends on
  building one first.
- **Withdrawals pay only to personal accounts**: `withdrawals.bank_account_id → user_bank_accounts`; the transfer
  worker's claim joins `user_bank_accounts`.

## B3. User and contributor model

| Who | Has an account | How they relate | Can |
|---|---|---|---|
| Visitor / contributor | No | none; a contribution row (and, for managed collections, a matched `members` row the officers created) | view public pages, pay, get a receipt |
| Member | No (ADR 0008) | `members` row created by officers or by redeeming an invite link | be listed, be reminded, pay |
| Officer | Yes | active `officer_terms` row (owner / admin / treasurer / collector / viewer) | role permissions, plus the verification gates in §B8 |

A payment never creates an account, a membership or a role. This is already true and stays true.

## B4. Public community page — DESIGNED (no blocker except D-H/D-J)

- **Route** `app/[communitySlug]/page.tsx`, public, cacheable, with Open Graph tags (WhatsApp/social previews).
- **Read**: new `app.get_public_community(p_slug)` (security definer, granted to `anon`), whitelisted fields only:
  name, type label, description, logo, location, verification status, approved public contact, and collections
  with `visibility = 'public'` and `status in ('active','paused','closed')` (closed shown as ended). Never drafts,
  `unlisted`, `members_only`, members, contributors, balances or officers (unless `show_officers_publicly`).
- **Publishing**: new `communities.public_page_published_at` (null = unpublished → 404), set/cleared only by the
  owner through `app.set_community_public_page(…)`; audited. Public contact shown only with a separate
  `public_contact_visible` flag.
- **Branding**: logo, optional `brand_color` (validated hex; text colour chosen by contrast), "Powered by Kolekto"
  footer.
- **Recommended policy (D-J)**: allow unverified communities to publish, showing a factual "Not yet verified" label,
  because their collection pages are already public today; publishing grants no financial or admin capability.
- **Collection payment**: unchanged — the card links to the existing `/[communitySlug]/[collectionSlug]` flow
  (Paystack, idempotency, webhook, attribution to that collection).

## B5. Personal profile and KYC

**Avatar upload — DESIGNED, unblocked (D-F resolved: approved).** Bucket `avatars`: 2 MB limit, `image/jpeg`,
`image/png`, `image/webp`; objects at `{user_id}/{random}.{ext}`; storage policies let a user write/delete only
their own folder; `app.set_my_avatar(path)` checks the prefix, stores the URL, and the old object is deleted after
the new one is saved. Initials remain the default.

**NIN + face verification — DESIGNED, BLOCKED (provider D-B, legal D-C, admin D-I).**
- Table `identity_verifications` (one row per attempt): `user_id`, `provider`, `provider_reference`, `method`
  (`nin`, `face_liveness`), `status` (`started`, `pending`, `passed`, `failed`, `expired`, `manual_passed`,
  `manual_failed`), `decided_by` (provider or admin id), timestamps, `failure_code`. **No raw NIN, no images** in
  Kolekto tables; at most a provider token. RLS: owner reads own rows' status only; writes only by
  security-definer functions; audit row on every change.
- `users.identity_level = 'identity_verified'` set **only** by a function that requires a `passed` NIN check **and**
  a `passed` face-liveness check from the provider webhook (signature verified), or an admin manual decision.
  Typing a NIN or uploading a photo never sets it.
- Adapter interface in `packages/adapters` (`IdentityProvider`: start NIN check, start liveness session, verify
  webhook, fetch result), with a fake for tests. Prefer a provider-hosted capture flow so face images never touch
  Kolekto servers.
- Provider must offer: NIN lookup with name/DOB match, face match to the NIN photo, liveness, signed callbacks,
  per-check reference, data-processing agreement, Nigerian/NIMC licensing.
- Legal items to settle with counsel before activation (not decided here): NDPA 2023 lawful basis and explicit
  consent for biometric (sensitive) data, privacy notice, DPIA, processor contract and cross-border terms,
  retention and deletion periods (**not invented**), encryption at rest, staff access and audit, NDPC registration
  status.

## B6. Community verification — DESIGNED, BLOCKED (D-I admin model; D-G evidence list)

- `community_verification_submissions`: community, submitted_by, basic info snapshot (official name, type,
  purpose, address, state, city, contact email, contact phone), representative (legal name, role, contact,
  personal KYC level read live, authority evidence), optional website/social, established date, member estimate;
  `status` = `draft` → `submitted` → `under_review` → `info_requested` ↔ `submitted` → `approved` | `rejected`.
  "Not started" = no row.
- `community_verification_documents` in a **private** bucket, per-type evidence (registration certificate,
  constitution, recognition letter, parent-institution letter, establishment document, other) — CAC not required
  for every type.
- `communities.verification_status` stays the field everything else reads: `pending` while a submission is
  submitted/under review/info requested, `verified` on approval, `rejected` on rejection. Only a platform admin
  function can approve or reject; every decision is audited with reason and actor. Representatives see feedback and
  can resubmit from `info_requested` or `rejected`.

## B7. Bank accounts

- **Personal** (`user_bank_accounts`): IMPLEMENTED earlier (Paystack resolve, name match, 48 h cooling-off,
  re-review on name change). Part 5 rule 1 adds an identity gate — see §B8 conflict.
- **Community** — DESIGNED, BLOCKED (D-I, D-K): new `community_bank_accounts` (community, bank, account number,
  resolved name, evidence document, `status` = `submitted` → `approved` | `rejected` → `replaced`, `reviewed_by`,
  `reviewed_at`, `review_reason`). Only verified communities can submit; only a platform admin can approve (never a
  community officer); at most one approved account per community; replacement creates a new row and re-review.

## B8. Verification permission matrix (approved rules) and where each must be enforced

| Rule | Enforcement point (DB function) | Today |
|---|---|---|
| Unverified person cannot add a bank account | `app.register_bank_account` | allowed (owner decision Q3: name match replaces identity check) |
| Unverified person cannot add members to their own community | `app.create_member`, `app.approve_pending_member`, `app.create_invite_link` (and `app.redeem_invite_link` if self-join by link counts as "adding" — part of D-L) | allowed |
| Unverified person: max 1 collection in own community | `app.create_collection` | unlimited |
| Unverified person cannot create a collection where invited | `app.create_collection` | allowed if role has `collection.draft` |
| Unverified person cannot withdraw to a personal account | follows from rule 1; also `app.request_withdrawal_to_account` | allowed |
| Unverified community: ₦1,000,000/day | `app.request_withdrawal_to_account` | **IMPLEMENTED** (D-07) |
| Unverified community cannot invite/appoint officers | `app.create_officer_invitation` | allowed |
| Unverified community cannot add members | same functions as row 2 | allowed |

"Own community" (proposed): a community where the caller holds the active **owner** term. Collection limit counts
that community's collections in any status except deleted drafts (D-L).

**Conflict that needs a decision before enforcing (D-M).** Today nothing can set `identity_verified` (no provider)
and nothing can set a community to `verified` (no admin). Enforcing rows 1–4, 7 and 8 now would immediately stop
**every** user from adding bank accounts, withdrawing, adding members and appointing officers — including the
existing dev/test flows and pgTAP suites that rely on them. Options: (a) build the gates now behind a single
setting that stays off until a verification path exists; (b) enforce now and accept the lock-out; (c) ship the
admin manual-decision path first, then enforce. Recommended: (a) then (c).

## B9. Withdrawal beneficiary model — DESIGNED ONLY (no payout code to change until reviewed)

- `withdrawals` gains `beneficiary_type` (`individual` | `community`) and `community_bank_account_id`, with a check
  that exactly one of `bank_account_id` / `community_bank_account_id` is set. Existing rows = `individual`.
- Ledger unchanged: hold, payout and release journals stay on the withdrawal's own collection accounts; the
  available-balance lock, D-07 limit, OTP, second approver and settlement rules apply unchanged. Collection B is
  untouched by a withdrawal from collection A. No community wallet.
- Worker: `claim_withdrawal_transfers` must learn the second destination; transfer recipient codes for community
  accounts created at admin approval.
- Decisions D-K (owner's 10 questions): who may request a community-beneficiary withdrawal; whether the owner may;
  which officers approve; whether the second approver applies; whether both routes coexist; per-collection payout
  beneficiary; account change effect on pending withdrawals (recommended: they keep the snapshot already stored in
  `destination_*` columns, as personal withdrawals do); cooling-off for community accounts (recommended: same 48 h
  as personal, starting at admin approval); mismatch handling (recommended: admin rejects; no override).

## B10. Database and RLS changes required (none applied yet)

| Migration (proposed) | Contents | Blocked by |
|---|---|---|
| M1 public community page | `public_page_published_at`, `public_contact_visible`, `brand_color`; `get_public_community` (anon); `set_community_public_page` (owner) | D-H, D-J |
| M2 avatars | `avatars` bucket + storage policies; `set_my_avatar` / `clear_my_avatar` | — |
| M3 verification gates | checks in the 6–7 functions in §B8, behind a setting | D-M, D-L |
| M4 platform admin | admin identity, `is_platform_admin()`, audit | D-I |
| M5 community verification | submissions, documents (private bucket), review functions | D-I, D-G |
| M6 community bank accounts | table, review functions | D-I, D-K |
| M7 beneficiary type | `withdrawals` columns, worker claim | D-K, review |
| M8 identity verification | `identity_verifications`, adapter, webhook | D-B, D-C, D-I |

## B11. itest baseline (Part 13)

- Database: container `supabase_db_kolekto-itest`, volume `supabase_db_kolekto-itest` (port 55422). Storage volume
  `supabase_storage_kolekto-itest`.
- Contents: session-43 demo (2 users `demo-overview-*`, 3 communities, 4 collections, 6 contributions,
  2 withdrawals) and **all** ledger rows (29 journals, 60 entries, 13 accounts — the ledger was empty before the
  seed). Also 3 users from session 40 (`s40.*@kolekto.test`) and their 2 communities.
- Ledger tables forbid delete/update/truncate by trigger, so a targeted clean-up would mean disabling append-only
  guards — rejected. The only clean route is `npm run itest:reset -- --confirm-reset-kolekto-itest`: replays every
  migration on the test database only, removes all of the above, rotates the itest role password and stack ID.
- Backup taken 2026-11-22 12:19 before anything: `../itest-backup-2026-11-22-pre-reset.sql.gz` (public + auth data,
  99 tables; outside the repo; test data only).
- No test assertion was or will be changed to accommodate the demo data.

## B12. Decisions (status)

| ID | Decision | Status |
|---|---|---|
| D-A | Member login | **Decided**: contributors need no account |
| D-B | KYC provider | open — blocks M8 |
| D-C | Legal basis / retention for NIN and face data | open — blocks M8 activation |
| D-D | What `identity_verified` unlocks | **Decided**: §B8 rules |
| D-E | Palette | **Decided**: keep brand, fix contrast — see §B13 |
| D-F | Avatar upload | **Decided**: approved |
| D-G | Community evidence per type | partly (list in §B6); final per-type list open |
| D-H | Does "Private" mean `unlisted` (payable by link) or `members_only`/not payable by URL? Today link-only pages are reachable by URL by design | open |
| D-I | How Kolekto administrators are identified and where the admin panel lives | open — blocks M4–M6, manual KYC |
| D-J | May unverified communities publish a public page? (recommended: yes, labelled) | open |
| D-K | The 10 community-withdrawal questions (§B9) | open |
| D-L | What counts toward the 1-collection limit | open |
| D-M | Enforce §B8 gates before any verification path exists? (recommended: build behind a setting) | open |

## B13. Colour and contrast (D-E)

Approximate WCAG ratios, computed: white on `#00BA16` ≈ 2.6:1 (fails); near-black on `#00BA16` ≈ 8:1 (passes);
white on `#00994D` ≈ 3.7:1 (large text only); white on `#007A3D` ≈ 5.5:1 (passes AA); current token `#14532d`
passes easily. Proposal: keep `#00BA16` as the brand accent (icons, highlights, progress, public-page hero with
dark text, light tint backgrounds); filled buttons and links use a dark brand green (`#007A3D` or current
`#14532d`); `#FFB300` only with dark text. Not applied yet; tokens unchanged.

## B14. Proposed order from here

1. Owner approves: apply `20261122120000` to dev → check `/communities`, overview, verification, profile on port 3000.
2. Owner approves: `itest:reset` → full pgTAP from a clean baseline.
3. Build M1 public community page + collection visibility controls, and M2 avatars (no open financial risk).
4. Owner decides D-I, D-M, D-L → M3 gates behind a setting, M4 admin, M5 community verification.
5. Owner decides D-K → M6/M7 design review → only then any payout change.
6. Provider + counsel (D-B, D-C) → M8.

---

# Part C — Decisions D-H…D-M resolved; admin panel; beneficiary architecture (2026-11-22, third pass)

Part C supersedes Part B where they differ (B12 decision statuses, B14 order). Nothing in Part C beyond C1 is
built.

## C1. Dev visibility fix — DONE and verified

| Step | Evidence |
|---|---|
| Diff reviewed | `20261122120000_community_home_and_overview.sql`, 494 lines, sha256 `12fc8a63…f6207a6` (identical to the itest copy). Statements: 6 × `create or replace function` (`app.my_communities`, `community_collection_figures`, `community_overview`, `community_recent_activity`, `community_verification_readiness`, `my_identity_summary`), 1 × `create index if not exists contributions_community_captured_idx`, 6 × `revoke … from public, anon`, 6 × `grant execute … to authenticated` — on those functions only. No table, column, policy, trigger, DML or drop. None of the six functions existed on dev beforehand (nothing overwritten). |
| Target confirmed | Docker container `supabase_db_kolekto`, CLI project label `kolekto`, published port `54322` — the local dev stack (`apps/web/.env.local`). Not a hosted Supabase project, not staging, not production. |
| Applied | 2026-11-22, one transaction + `schema_migrations` row `20261122120000 community_home_and_overview`. |
| No financial or policy change | Before/after counts identical: ledger journals 81, entries 170, withdrawals 8, contributions 25, RLS policies 127. `app.platform_reconciliation()` 9/9 `ok`. |
| Figures vs ledger (all of dev) | As each community owner, inside a rolled-back transaction: 195 owner terms checked, **195 match** `v_collection_position` (available, pending, on hold, withdrawing, withdrawn) and applied contributions (collected); 0 mismatches; all 25 dev contributions covered. |
| Browser, port 3000 (the normal dev server, untouched) | Signed in by email code as an e2e fixture user (`…@example.test`; mailbox `:54324`). `/communities`: "Communities you manage" (2) + "Your personal space", role and "Not verified" badges. `/c/e2e-per-order-…`: header, verification card with ₦1,000,000/day note and "Verify community", Members 0 / Officers 1 / Collections 1 / Live 1, money panel (collected ₦15,000, settling ₦15,000, available ₦0), open collections, recent activity. `/c/…/verification`: status, "Used today ₦0 of ₦1,000,000", checklist, "Submitting … not open yet". `/account`: identity header, personal information, personal verification steps, bank accounts, password. |

Observed while testing, not changed: (1) dev auth returns 500 for users that were inserted by SQL with a NULL
`confirmation_token` (GoTrue scan error) — those fixture users cannot sign in; (2) the e2e collection has sat in
"Settling" since 24 Sep 2026 on dev (no settlement release ran for it locally) while the card says "available after
T+1"; (3) two date formats appear on the overview ("10 Nov 2026" vs "9/24/2026"); (4) the profile's identity-check
copy still says "ID document or BVN" — must become NIN + face (D-B direction).

## C2. Existing admin control panel (`../kolekto-admin-control-panel-1`) — findings

| Aspect | Finding (read from the code; nothing was run or connected) |
|---|---|
| Framework | Vite + React 18 SPA (Lovable template), shadcn/Radix UI, TanStack Query, Zustand; separate git repo `Gazalian/kolekto-admin-control-panel`. |
| Backend / data | The **legacy** Kolekto system: hosted Supabase projects `busf…` (labelled production) and `lpee…` (labelled test) plus the legacy Express API (`kolekto-be-old`, `/api/adminurlabdkole/*`). Tables used: `profiles`, `campaigns`, `campaign_donations`, `kyc_verifications`, `verification_documents`, `user_identity`, legacy `collections`/`contributions`/`withdrawals`, `ambassador_withdrawals`. None of these match this monorepo's schema (`users`, `communities`, `officer_terms`, `collections` v2, ledger, `withdrawals` v2). |
| Authn / authz | Supabase email sign-in; admin = row in legacy `public.admin_users` via RPC `current_admin_user`; roles only `admin` and `superadmin`; route guard `RequireSuperAdmin` is client-side, backend re-checks per its own comments. No MFA in use. |
| Functions present | Dashboard, users, collections, fundraising, legacy KYC dashboard, transactions, payment monitoring, payment reconcile, withdrawals, ambassador payouts, email campaigns, settings. |
| Writes | Its own CLAUDE.md records that `kycStore`/`fundraisingStore` still write financial/KYC tables directly from the browser (an anti-pattern it plans to remove). |
| Reusable for the new platform? | **Not as-is.** Every data call, the admin identity table and the role model are bound to the legacy database and legacy API, and the app is still the operations console for that legacy production system — changing it in place risks legacy operations. Reusable: UI layout, list/detail page patterns, filters, formatters, email-campaign builder UI. |

**Recommendation (needs owner OK, D-O):** build the new central admin as `apps/admin` inside this monorepo (Next.js,
same `@kolekto/ui` and `@kolekto/db`, same Supabase project), porting the legacy panel's UI patterns; keep the legacy
panel untouched for the legacy system until it is retired.

| Required capability | Legacy panel has it (for legacy data) | New platform today |
|---|---|---|
| Platform dashboard | yes | no |
| User management | yes | no |
| Community management | no (no communities) | no |
| Membership / officer management | no | community-side only |
| Collection monitoring | yes (legacy collections) | no |
| Contribution / transaction monitoring | yes | no (reconciliation functions exist: `app.platform_reconciliation`, `collection_reconciliation_checks`) |
| Withdrawal monitoring | yes (legacy) | no UI; transfer reconciliation runs in the worker |
| Personal KYC review | yes (legacy `kyc_verifications`) | no |
| Community KYC review | no | no |
| Personal bank account monitoring | no | no |
| Community bank account approval | no | no |
| Financial reconciliation | partial (payment reconcile) | SQL functions only |
| Audit logs | no viewer | `public.audit_logs` exists |
| Platform settings / verification controls | settings page (legacy) | no |

## C3. Approved decisions (recorded as given by the owner)

| ID | Decision |
|---|---|
| D-H | Keep enum values. `public` = listed on the community page; `unlisted` = not listed, anyone with the link can pay; `members_only` = authenticated, authorised members only. The UI never says "Private" today (labels are "Listed publicly" / "Link only"), so no relabel was needed; "Link only" may be renamed "Unlisted (anyone with the link)" when the visibility control is touched. |
| D-I | Central Kolekto Admin Control Panel, separate from workspaces; roles Super Admin, KYC Officer, Finance Officer, Support Officer, Read-only Auditor; server-enforced; strong authentication; every sensitive action audited. |
| D-J | Unverified communities may publish; page shows "Not yet verified"; no extra privilege; existing D-07 limit only (no duplicate). |
| D-K | Community payouts approved in principle with the 10 rules listed by the owner; payout execution unchanged until the architecture in C5 is reviewed. |
| D-L | One collection in total across communities the unverified person owns or controls; none where merely invited; count every created collection including drafts and closed; deletion cannot be used to get around it. |
| D-M | Gates built but off: `personal_kyc_enforcement_enabled`, `community_kyc_enforcement_enabled`, both false; activation only after the six listed prerequisites exist. |

## C4. Public pages and payments — what exists vs what is missing

- Exists: anonymous collection page, payment, Paystack callback, receipt at `/[communitySlug]/[collectionSlug]…`;
  `app.get_public_collection*` return a whitelist for `public` **and** `unlisted` collections in status active /
  paused / closed of an active community (SEC-12). A payment never creates an account or a membership.
- Missing: the community page `app/[communitySlug]/page.tsx` and its anon read (only `public` collections listed),
  publish switch, public-contact flag, brand colour (M1 in §B10).
- **Contradiction to resolve (Q1):** D-H defines `members_only` as "authenticated members", but members never log in
  (ADR 0008 / D-A: contributors and members have no account). `members_only` exists only in the enum: no function,
  policy or screen uses it, and the UI cannot select it. Until decided it stays unselectable.

## C5. Community withdrawal beneficiary — architecture for review (NOT built)

**Collection ownership today.** A collection belongs to one community (`collections.community_id`); `created_by`
records who drafted it. There is no per-collection owner or beneficiary. Who may act on a collection comes from the
caller's community role (`app.has_permission_for_collection`; collectors are scoped).

**Who can request today.** `withdrawal.request`: the owner (owners hold every permission) and the treasurer; not
admin, collector or viewer. **Paid to:** the requester's **own** saved, verified, cooled-off personal account,
chosen at request time (`request_withdrawal_to_account` refuses an account whose `user_id` is not the caller). The
destination (name, number, bank, code) is copied onto the withdrawal row at request time.

**Who approves today (20261120100000).** A non-owner's request → a current owner. An owner's request → that
community's designated second approver (`community_withdrawal_approvers`, must hold an active owner/admin term).
Nobody approves their own request (trigger refuses `approved_by = requested_by`). Then member OTP, Paystack's
approval URL (`decide_transfer_approval` re-checks basis, amount, currency, transfer code), dispatch by the worker.

**Proposed model.**

1. **Beneficiary designation on the collection** (new columns, all nullable for existing rows):
   `payout_beneficiary_type` (`individual` | `community`), `payout_beneficiary_user_id` (individual),
   set at creation or by an officer with `withdrawal_account.change` (an existing permission, already flagged
   `requires_second_approver`) **before the first contribution**; a trigger refuses any change once the collection
   has a contribution. Changing it later = a separate, audited, admin-reviewed process (to be designed).
2. **Existing collections** keep today's behaviour (`payout_beneficiary_type is null` = requester's own personal
   account), so current individual withdrawals are untouched (owner rule: preserve existing permissions).
3. **Individual beneficiary:** the named person's verified personal account; the requester must still hold
   `withdrawal.request`; if requester ≠ beneficiary the money still goes only to the beneficiary's account (Q2).
4. **Community beneficiary:** `community_bank_accounts` row in status `approved`, `usable_from <= now()`, one active
   per community. The request names no account — the function takes the community's active approved account and
   copies its details onto the withdrawal (`beneficiary_type='community'`, `community_bank_account_id`, existing
   `destination_*` columns). Check constraint: exactly one of `bank_account_id` / `community_bank_account_id`.
5. **Request / approve:** same permission (`withdrawal.request`), same approval basis, same no-self-approval trigger,
   same OTP, same D-06 review flag, same D-07 daily limit under the same per-community lock, same available-balance
   lock on the collection's own `available` account.
6. **Account change:** a new community account needs admin approval and a cooling-off before `usable_from`
   (proposed 48 h, as D-08 — duration to confirm, Q3). Replacing an account never re-points a withdrawal: an open
   withdrawal keeps its `community_bank_account_id` and snapshot; dispatch re-checks that this exact account is still
   `approved`; if it was replaced or revoked, the withdrawal fails through the existing failure path (hold released
   once to the same collection) and the requester is told to request again.
7. **Ledger and reconciliation:** unchanged journals — hold (collection available → withdrawing) on request, payout
   (withdrawing → withdrawn) on paid, release on failure — all on that one collection's accounts. Collection B is
   never touched. No community-level ledger account is created (the `v_collection_position` rule stands). New
   reconciliation check: every community-beneficiary withdrawal's snapshot equals its account row at approval.
8. **Paystack identification:** a transfer recipient (`RCP_…`) is created for the community account when an admin
   approves it (TEST key only until LIVE is approved), stored on the account row (write-once, like
   `user_bank_accounts.recipient_code`); the transfer reference stays `ktr_…`; the approval URL callback matches by
   reference and re-checks amount, currency, transfer code and that the recipient equals the withdrawal's account.
9. **Worker:** `claim_withdrawal_transfers` must join the community account when `beneficiary_type='community'`
   (today it joins only `user_bank_accounts`). This is the one payout-execution change, deferred until review.

## C6. Admin roles, authentication, flags — design (NOT built)

- `platform_admins` (user_id, role, active, granted_by, granted_at, revoked_at) — roles `super_admin`,
  `kyc_officer`, `finance_officer`, `support_officer`, `auditor`; `platform_admin_permissions` (role → permission),
  e.g. `kyc.review_personal`, `kyc.review_community`, `bank.review_community`, `withdrawal.monitor`,
  `finance.reconcile`, `user.support_view` (masked contact), `audit.read`, `settings.manage`, `admin.manage`.
- `app.platform_has_permission(p)` in every admin function (security definer); also requires
  `auth.jwt()->>'aal' = 'aal2'` (Supabase TOTP MFA) for every role. No admin capability comes from a community
  role, and community officers can never hold an approval over their own community.
- `platform_audit_log` (actor, role at the time, action, target, before/after of changed fields, reason, at); no
  update/delete (trigger, as the ledger does). Reads of identity documents are logged too.
- `platform_settings` (key, boolean value, changed_by, changed_at) with `personal_kyc_enforcement_enabled` and
  `community_kyc_enforcement_enabled` = false; only `settings.manage` can change them, audited. The gate functions
  read them; pgTAP flips them inside a transaction to test enforcement on itest.

## C7. Open questions (need the owner)

| Q | Question |
|---|---|
| Q1 | `members_only` vs "members have no accounts" (C4). |
| Q2 | Individual beneficiary: must the requester be the beneficiary, or may a treasurer request a payout to the named owner's account? |
| Q3 | Cooling-off length for community accounts (48 h proposed). |
| Q4 | Must new collections choose a beneficiary at creation, or default to today's "requester's own account"? |
| D-O | Build the new admin as `apps/admin` in this monorepo (recommended) rather than extending the legacy panel? |
| D-P | Admin sign-in: Supabase TOTP MFA for all admin roles (proposed), or something stronger (hardware keys / SSO)? |
| D-B, D-C | KYC provider; legal basis and retention for NIN and face data (unchanged, still open). |

## C8. Phased plan (each phase separately approved; no commit without approval)

1. **Phase 0 (now):** itest clean baseline (C9) → full pgTAP.
2. **Phase 1 — public presence (no money change):** M1 community page `/[communitySlug]`, publish switch, "Not yet
   verified" label, "Link only" → "Unlisted (anyone with the link)"; M2 avatars. Tests: published/unpublished, no
   public collections, mixed public/unlisted, unlisted URL still payable, members_only never shown, anonymous payment
   attributed to the chosen collection.
3. **Phase 2 — gates, off:** `platform_settings`; D-L / personal / community gates in `create_collection`,
   `create_member`, `approve_pending_member`, `create_invite_link`, `create_officer_invitation`,
   `register_bank_account`, `request_withdrawal_to_account`; pgTAP for flag off (today's behaviour unchanged) and flag
   on (every direct call refused).
4. **Phase 3 — admin foundation (after D-O, D-P):** `apps/admin`, platform roles, MFA, audit log, read-only
   dashboards (users, communities, collections, withdrawals, reconciliation).
5. **Phase 4 — community verification:** submissions, private document bucket, admin review (approve / reject /
   request info), resubmission, audit.
6. **Phase 5 — community bank accounts:** submission, admin approval, recipient creation (TEST), replacement and
   cooling-off. Still no payout to them.
7. **Phase 6 — beneficiary + community payout:** only after C5 is reviewed: collection beneficiary columns, request
   path, worker claim, reconciliation check; TEST transfers only.
8. **Phase 7 — personal KYC:** provider adapter, webhook, manual review, after D-B / D-C.

## C9. itest clean-baseline plan (NOT run — needs separate approval)

- **Target:** container `supabase_db_kolekto-itest` (port 55422), volumes `supabase_db_kolekto-itest`,
  `supabase_storage_kolekto-itest`; CLI workdir `supabase-itest`. Not dev (`:54322`), not hosted.
- **Other users of itest:** session 44 has finished (commit `88dc8f4`, pushed; its local e2e ran on the dev stack, not
  itest). Two idle connections from 2026-11-20 (stack services). No other session found using itest.
- **What a reset deletes:** every row in the itest database and storage — today: 5 auth users (2 demo, 3 `s40.*`
  from session 40), 5 communities, 4 collections, 6 contributions, 7 payment attempts, 2 withdrawals, 29 ledger
  journals / 60 entries / 13 ledger accounts, 13 audit rows, 2 withdrawal approvers, plus auth sessions. Also rotates
  the itest role password and stack ID (written to the git-ignored itest env file).
- **What is restored:** the schema, by replaying all 151 migrations from `supabase-itest/supabase/migrations`
  (includes `20261122120000`), and whatever reference rows those migrations insert (e.g. permissions, role
  permissions, ledger account codes). **Nothing from the backup is restored** — restoring it would bring the ledger rows
  back and the same 3 tests would fail. The session-40 users/communities are not needed by any test (pgTAP creates
  and rolls back its own fixtures).
- **Backup:** `../itest-backup-2026-11-22-pre-reset.sql.gz` (gzip verified, 32 tables with rows: public + auth data
  only, test fixtures only). Kept for reference.
- **Command:** `npm run itest:reset -- --confirm-reset-kolekto-itest`, then the full pgTAP loop; expected 73 files
  pass with no assertion changed.
- **Alternative rejected:** deleting the demo rows — ledger tables refuse delete/update/truncate by trigger, and
  disabling those guards would weaken a financial invariant.

---

# Part D — Final decisions: standalone membership, members-only collections (2026-11-22, fourth pass)

Supersedes C7 Q1–Q4, D-O, D-P (now decided). Status words as in Part B.

## D1. Three separate concepts (approved)

| Concept | Record | Account needed |
|---|---|---|
| Kolekto user | `auth.users` + `public.users` | yes |
| Community member | `public.members` (one row per person per community) | **no** |
| Contributor | `public.contributions` (+ payment attempt, receipt) | **no** |

A member row may later be linked to a user (`members.user_id`, `claimed_at` already exist) only by a verified claim
(D8), never by a name or email match.

## D2. What already exists (read from the code, 2026-11-22)

| Need | Existing piece | Fit |
|---|---|---|
| Member record without an account | `members` (`status` = pending_approval, unclaimed, invited, active, archived, merged; `joined_via` = invite_link, import, manual, payment, migration; `member_code`, `user_id`, `claimed_at`, contact fields) | reuse — **no new membership table** |
| Official adds a member | `app.create_member` (`member.create`), CSV import | reuse |
| Apply to join + review | invite links (`invite_links`: `approve_joiners`, groups, asked/required attributes, expiry, max uses) → `app.redeem_invite_link` → `pending_approval` → `app.approve_pending_member` / `app.reject_pending_member` (`invite.approve`) | reuse as the application workflow |
| Membership ID | `member_code` from `community_member_code_settings` (prefix + zero-padded **sequential counter**) | **not suitable as a secret**: guessable by design |
| Restricting who may pay | managed collections: `participation_mode='managed'`, `audience_mode` (all_members / groups / selected_members), `allow_non_members`, obligations with per-member pay-link tokens (`link_token_hash`) | reuse for eligibility |
| Identify on the public page | `app.find_collection_member` (anon): exact member code, unique attribute, phone, email or two name parts → returns name + code | reuse the shape, but see D9 finding |
| Visibility | enum `members_only` exists; no function, policy or screen uses it | extend |
| Suspended state | none (`archived` is the only "out" state) | add `suspended` |
| Rejected applications | `reject_pending_member` (row leaves pending) | reuse; keep audit |

## D3. Membership ID — DESIGNED

- New, separate from `member_code` (which stays the community's own roll number, printed or imported).
- Format `KM-` + 10 Crockford base32 characters (≈50 bits, no ambiguous characters), from `gen_random_bytes`.
  Unique per community by construction; collisions retried.
- Stored only as a keyed hash (`membership_id_hash`, HMAC with a server-held pepper) + `membership_id_last4` for
  display. Officers cannot read it back — they can **re-send** or **rotate** it. Rotation invalidates the old one.
- Issued when a member becomes `active` (direct add, approved application, import); sent by email (SMS when a
  provider exists — none today); valid only while the member is `active`. Suspension or archive makes validation
  fail; reactivation keeps the same ID unless rotated.
- Never a user ID; a person has one per community.

## D4. Members-only collections — DESIGNED

- Collection settings (backend-enforced): `visibility='members_only'` + new `non_member_policy`
  (`existing_only` | `may_apply`) + optional `member_verification` (`none` | `email_otp`) + optional
  `max_contributions_per_member` (null = unlimited). Eligibility = active member of the owning community **and** in
  the collection's audience (`app.resolve_collection_audience`).
- Not listed on the community page; the URL resolves but shows only name, community and "members only" until a
  valid ID is presented.
- Journey: (1) restriction notice + ID field → (2) `app.validate_membership_for_collection(slug, id)` (anon,
  rate-limited per IP hash + per collection; one generic failure message for every failure: unknown, other community,
  suspended, archived, not in audience, collection closed) → on success a short-lived signed **access grant** (opaque
  token, 30 min, bound to collection + member) → (3) optional email OTP to the member's stored address →
  (4) existing contribute form and Paystack checkout, with the grant attached; capture records `member_id` from the
  grant (never from the browser), checks the per-member limit under the collection lock → (5) existing receipt.
- Failure + `may_apply` → "Apply to join" opens the community's standing application form (an invite link flagged
  as the community's application link, `approve_joiners` forced on). Failure + `existing_only` → "contact the
  community" with its public contact if published.
- Public and link-only collections: unchanged code paths (`get_public_collection*` keep returning `public` and
  `unlisted`; members_only gets its own read).

## D5. Application workflow — DESIGNED (reuses invite links)

Pending → approved (member `active`, membership ID issued and sent) or rejected (audit + optional reason, applicant
emailed). Duplicate applications: an open application with the same email or phone in the same community is
reused, not duplicated (existing `find_member_duplicates`). All actions already write `audit_logs`; new ones will too.

## D6. Security and privacy controls (designed)

Generic errors; rate limit and lockout per IP hash/collection; no name or code returned by ID validation; IDs hashed;
OTP optional per collection (operational cost: email delivery, support load); grants short-lived and single-collection;
membership never grants account access; member data never on public pages.

## D7. Contribution limits

`max_contributions_per_member` enforced at capture, counting applied contributions for (collection, member).
A membership ID never implies unlimited payments.

## D8. Linking a member to a Kolekto account — DESIGNED

Signed-in user enters membership ID → one-time code sent to the **member record's** stored email/phone → on success
`members.user_id` + `claimed_at` set (existing columns). No automatic link by name or email.

## D9. Finding (pre-existing, not changed)

`app.find_collection_member` is granted to `anon` and returns a member's **full name and member code** for an exact
member code, unique attribute, phone or email on any managed collection that accepts identification. Member codes
are sequential, and there is no rate limit in the database, so a script could walk `PREFIX-0001, -0002, …` and
collect names for that collection's audience. Recommend: rate limiting at the route, and returning a masked name.
Needs owner decision (it is existing behaviour contributors rely on).

## D10. Migrations proposed for membership (none written yet)

M9 `members.status` gains `suspended`; membership ID hash/last4/issued_at/rotated_at on `members`;
`communities.membership_applications_enabled`; collection columns `non_member_policy`, `member_verification`,
`max_contributions_per_member`; `membership_access_grants`; `membership_validation_attempts` (rate limit);
anon `validate_membership_for_collection`; officer `issue/rotate/resend_membership_id`, `suspend/reinstate_member`.
Capture change for the per-member limit touches the payment path → reviewed separately.

## D11. Decisions now closed

Q1 standalone membership (D1–D8); Q2 individual payout = requester's own verified account only; Q3 48 h cooling-off
for community accounts, admin re-verification, snapshot kept, unusable account → fail and release to the original
collection, officers notified; Q4 every **new** collection must choose a beneficiary before its first successful
contribution, locked after it, existing collections unchanged; D-O `apps/admin`; D-P mandatory MFA (TOTP and/or
passkeys), short sessions, step-up for high-risk actions.

---

# Part E — Implementation record and architecture for review (2026-11-22, fourth pass)

Status words: **IMPLEMENTED** = code and migration exist, tested on itest; **DESIGNED** = written here, no code.
Nothing in this part is committed, applied to dev, staging or production, or touches a payout path.

## E1. Implemented — profile photo (avatar)

- Migration `20261122130000_profile_avatars.sql` (itest only): public bucket `profile-avatars` (2 MB; JPEG, PNG,
  WebP), **no storage policies** (clients can neither list nor write); `app.set_my_avatar(url)` — signed-in, active
  user only; the URL must be exactly `…/storage/v1/object/public/profile-avatars/<own uid>/<uuid>.(jpg|png|webp)`,
  so nobody can point their profile at another user's object or an external host; audit `user.set_avatar` /
  `user.remove_avatar`; returns the previous URL so the server can delete the old object.
- Server: `apps/web/lib/avatar-file.ts` (size + magic-byte check — the declared type is not trusted),
  `apps/web/lib/profile-avatar.ts` (server-only, service-role upload under `<uid>/<random uuid>.<ext>`, removal only
  inside the caller's own prefix), `apps/web/app/account/avatar-actions.ts` (upload → DB → delete previous; on DB
  failure the new object is removed).
- UI: `AvatarUploader` on `/account`; `Avatar` component (renders an image only for profile-avatars URLs, initials
  otherwise) in the top bar, user menu and sidebar footer.
- Verified on itest (browser): PNG upload, replace with WebP (old object deleted, one object left), SVG renamed
  `.png` refused, photo shown in the top bar, anonymous bucket listing returns `[]`, two audit rows.

## E2. Implemented — public community page (D-J)

- Migration `20261122140000_public_community_page.sql` (itest only): `communities.public_page_published_at`,
  `communities.public_contact_visible` (default false); `app.set_community_public_page` (active owner only; unknown
  and non-owner get the same `FORBIDDEN`; personal workspaces refused; publishing needs an active community; audited);
  anon reads `app.get_public_community(slug)` (whitelisted identity fields, contact only if opted in; published,
  active, not personal) and `app.get_public_community_collections(slug)` (only `visibility='public'`,
  active/paused/closed, no money totals, max 50).
- Page `apps/web/app/[communitySlug]/page.tsx`: banner, logo/initials, type, institution, location, "Verified by
  Kolekto" / "Not yet verified" badge and warning, description, optional contact, open and ended collection cards
  linking to the existing payment page, Open Graph metadata. Unpublished or unknown = 404.
- Owner control `apps/web/app/c/[slug]/settings/PublicPageControl.tsx` (+ `setCommunityPublicPageAction`).
- Link-only (`unlisted`) collections: never listed, still payable by direct URL (verified). Payment flow unchanged.
- Verified on itest (browser): unpublished 404 → publish → page with "Not yet verified"; a public collection appears
  and its card opens the existing payment page; 375 px width without horizontal scroll.
- itest demo state changed by this check: `demo-unilag-alumni` published; `annual-dues-2026` set to public.

## E3. Tests

- New `supabase/tests/74_public_community_and_avatar.sql`: 35/35 on itest (owner-only publish; same error for
  outsider, admin and unknown; personal refused; unpublished invisible; only public collections listed; members-only
  and unlisted never listed; contact hidden by default; avatar URL pinned to own folder; external and other-user URLs
  refused; anon cannot call `set_my_avatar`; bucket limits; audit rows).
- `supabase/tests/02_grant_matrix.sql`: the anon allowlist gains `get_public_community` and
  `get_public_community_collections`, with a dated comment (the test exists to make each new anon function a visible
  decision). 7/7 after the change. No other assertion was changed.
- Full pgTAP on itest: 73 files, 2,436 ok; remaining failures only 18, 20, 23 — the known demo-ledger data that the
  unapproved itest reset (C9) clears.
- `apps/web/lib/avatar-file.test.ts`: 4/4.

## E4. Findings from this pass

1. **`members_only` is selectable today** in the collection settings panel, but no read function returns it, so
   choosing it makes the collection page a 404 for everyone, including would-be members. Until M9 lands the option
   should be hidden or labelled "not available yet". Not changed (owner decision on wording).
2. **D9** (`find_collection_member` enumeration) stands.
3. Dev DB has only `20261122120000`; `130000` and `140000` are on itest only. Applying them to dev needs approval.

## E5. Admin panel — architecture (DESIGNED, nothing built)

- **Where:** `apps/admin`, a separate Next.js app in this monorepo, own host name, own deploy, never linked from the
  public app. Uses `@kolekto/db` and `@kolekto/ui`. The legacy panel (C2) stays untouched and is not ported.
- **Identity:** same Supabase Auth; admin rights only from `platform_admins` (C6), never from a community role.
  Roles: Super Admin, KYC Officer, Finance Officer, Support Officer, Read-only Auditor.
- **MFA (D-P):** every admin route requires `aal2`; enrolment at first sign-in (TOTP now; passkeys/WebAuthn when the
  Auth version in use supports them — to confirm). Sessions: 30 min idle, 8 h absolute (proposed). **Step-up:** a
  fresh MFA challenge (≤ 5 min old) to approve/reject KYC, approve a community bank account, change a platform
  setting, grant/revoke admin roles, or take any finance action.
- **Enforcement in the database:** every admin action is an `app.admin_*` security-definer function that itself checks
  `platform_has_permission` + `aal2` + step-up freshness; the UI gate is convenience only.
- **Audit:** `platform_audit_log`, append-only by trigger, including reads of identity documents.
- **Feature flags:** `platform_settings` with `personal_kyc_enforcement_enabled` and
  `community_kyc_enforcement_enabled` = false. Nothing reads them yet.
- **Phases:** A0 schema (`platform_admins`, permissions, audit, settings) + pgTAP → A1 sign-in + MFA + role shell →
  A2 read-only dashboards (users, communities, collections, withdrawals, reconciliation; masked PII) → A3 community
  verification review → A4 community bank-account review → A5 personal KYC review (after D-B/D-C).
- **Bootstrap:** the first Super Admin is inserted by a one-off migration naming an existing user id, approved by the
  owner; no self-registration path.

## E6. KYC workflows — preparation (DESIGNED, nothing built)

- `identity_verifications` (user_id, kind `personal`, status `not_started|pending|approved|rejected|needs_info`,
  provider, provider_reference, decided_by, decided_at, reason). **No NIN or image stored by Kolekto** until D-C sets
  the legal basis and retention; the provider holds evidence, Kolekto keeps the outcome and a reference.
- Provider adapter interface (`startVerification`, `handleWebhook` with signature check, `fetchResult`) with a
  **fake adapter for local/itest only**; no real provider until D-B.
- Community verification: `community_verifications` + a private bucket for documents (no public URL; signed URLs
  issued by admin functions only, every view audited).
- Gates read the C6 flags and stay **off**; pgTAP will prove flag off = today's behaviour and flag on = refusal.

## E7. Community payouts — architecture for review (updates C5; NOT built, payout code unchanged)

Changes from C5 after the decisions in D11:

- **Individual beneficiary (Q2 / D-K):** money goes only to the **requester's own** verified, cooled-off personal
  account — exactly today's rule. C5 item 3 ("the named person's account") is withdrawn.
- **Beneficiary choice (Q4):** a new collection must have `payout_beneficiary_type` set before its first successful
  contribution; capture refuses a contribution to a new collection without one; locked afterwards by trigger.
  Existing collections: `null` = today's behaviour, their data is not migrated.
- **Community account change (Q3):** admin re-verification + 48 h cooling-off before `usable_from`; open withdrawals
  keep their snapshot; dispatch re-checks the exact account; unusable → fail through the existing failure path, hold
  released once to the same collection; owners and treasurers notified.
- **Unchanged:** permissions, approval basis, no self-approval, OTP, D-06, D-07 limit and lock, per-collection ledger
  journals, no community-level wallet or ledger account.
- **Payout-execution changes that need approval:** (a) a `community` beneficiary path in
  `request_withdrawal_to_account`; (b) `claim_withdrawal_transfers` joining `community_bank_accounts`; plus the
  capture check for Q4. TEST mode only until LIVE is approved.

## E8. Members-only — implementation plan (M9, not written)

1. Migration M9 (D10) + pgTAP: ID issue/rotate/resend, hash-only storage, generic failures, rate limit, grant expiry
   and binding, suspended/archived refused, other-community IDs refused, per-member limit.
2. Hide or label the `members_only` option until step 3 ships (E4.1).
3. Public route: members-only gate page → ID → optional OTP → existing contribute form with the grant.
4. Capture: record `member_id` from the grant and enforce the limit — **payment path, separate review**.
5. Applications: community application link (invite link with `approve_joiners`); approval issues the ID.

---

# Part F — Configurable membership IDs, non-member contributions, separate admin repository (2026-11-22, fifth pass)

Source: owner brief "Membership system, configurable membership IDs, non-member contributions & central admin
architecture" (2026-11-22). Part F **extends** Parts D and E. Where they differ, Part F wins only on the points it
names:

| Earlier text | Changed by Part F |
|---|---|
| D3 format `KM-` + 10 characters | F4: community prefix + separator + 5 random characters (configurable) |
| D3 / D10 "membership ID valid while `active`" | F4.6 / Q8: needs a decision — in the code almost nobody is `active` |
| D4 `non_member_policy` column | F5: proposed replacement by the existing `allow_non_members` + community application setting (Q11) |
| D10 / E8 "M9" as one migration | F11: split into M9a…M11 with separate review boundaries |
| D11 D-O and E5 "Where: `apps/admin` in this monorepo" | F3: separate private repository `kolekto-admin`; needs ADR 0017 (drafted, **Proposed**) |
| E5 "`membership_id_last4`" | F4.4: last **2** characters only (security finding) |

Everything else in Parts D and E stands as written.

**Status words.** **IMPLEMENTED** = code and migration exist and were tested (environment named).
**DESIGNED** = written here, no code. **BLOCKED** = cannot start until a named decision or prerequisite.
**APPROVED FOR IMPLEMENTATION** = the owner has said "build it". The owner has approved the *product requirements*
in this brief; **no item in Part F is yet approved for implementation** (the brief limits this pass to Phase 0 and 1).
Nothing in Part F was built, migrated, committed or deployed.

> **Update 2026-11-22 (sixth pass).** The owner's review recorded decisions Q1, Q2, Q8, Q9, Q10, Q12, Q13, Q14 (F15)
> and approved Phase 2a and Phase 2 **on itest only**. Both are **IMPLEMENTED on itest** (F16), uncommitted. The owner
> then changed one part of Q10: the full membership ID is **stored encrypted** so officers can always show it (F16.2) —
> this supersedes the "hash only / never read back" text in F4.4, F4.5 and F4.6. The non-member payment path has its own
> design for review: `docs/phase-4/non-member-contributions-payment-path-design-2026-11-22.md`. Q9 review: F17.

## F0. Phase 0 audit — repository and environments (read-only, 2026-11-22)

| Check | Result |
|---|---|
| Branch / HEAD | `feat/payment-receipts-alarms` at `88dc8f4` (pushed, PR #35). |
| Uncommitted work | 23 modified tracked files (web app, `packages/db`, two pgTAP files, the payment status doc) and 18 untracked paths (three migrations `20261122120000/130000/140000`, two pgTAP files, avatar/public-page/overview code, **and this document itself**). This document has never been committed — a lost checkout loses Parts A–F. |
| Overlap with this pass | This pass edits only documentation: this file (untracked), `docs/phase-4/payment-integration-status-2026-11-12.md` (already modified, uncommitted — only its "Latest report" block is touched) and a new `docs/adr/0017-…` draft. No code, migration or test file was touched. |
| Repo migrations | 153 files in `supabase/migrations`; `supabase-itest/supabase/migrations` holds the same 153 names; `130000` and `140000` byte-identical between the two. |
| itest DB (`supabase_db_kolekto-itest`, :55422) | 153 rows in `schema_migrations`, last `20261122140000`. Collections: public 1, unlisted 3, members_only 0. Members: active 3, unclaimed 2, pending_approval 1, archived 1. `allow_non_members = true`: 0. |
| Dev DB (`supabase_db_kolekto`, :54322) | 145 rows, last recorded `20261122120000`. Not applied: `130000`, `140000` (as E4.3 says). Recorded as missing but **present in the schema** (applied by hand, known item #12 in the status doc): `20261118100100`, `20261118100200`, `20261119100000`, `20261119120000`, `20261120100000`, `20261120140000` — `user_bank_accounts`, `community_withdrawal_approvers`, `request_withdrawal_to_account`, `decide_transfer_approval`, `claim_withdrawal_transfers` all exist. Collections: public 16, unlisted 73, members_only 0. Members: active 44, unclaimed 31, archived 1. `allow_non_members = true`: 0. |
| Staging / production | Not inspected and not touched in this pass. |
| itest reset (C9) | Still not run; still needs separate approval. |

## F1. Code facts that change the design (read from the code, 2026-11-22)

| # | Fact | Where | Consequence |
|---|---|---|---|
| 1 | `collections.allow_non_members` exists ("Managed collections may optionally accept payment from non-members") and is written by `create_collection` / `update_collection`, **but nothing enforces it**: `app.create_payment_attempt` raises `MEMBER_REQUIRED` for every non-`public` audience and `MEMBER_NOT_EXPECTED` when a member is named on a `public` one. The creation form has no control for it; `SettingsPanel` only passes the stored value back. | `20260917120700_collections.sql:58`, `20261111100100_payment_functions.sql:367-380` | "Members and non-members" can reuse this column, but turning it on needs a **payment-path change** (F5.4). |
| 2 | `active` is almost never reached. `create_member` and `approve_pending_member` set `unclaimed`; `redeem_invite_link` sets `pending_approval` or `unclaimed`; only `restore_member` sets `active` (when a phone exists). The collection audience is `active`, `unclaimed`, `invited`. | `20260918140100…:233,469,541`, `20260920120100…:426`, `20260920150000…:263` | "Membership IDs validate only for active members" would lock out most real members (dev: 31 of 75 are `unclaimed`). Decision Q8. |
| 3 | `member_code` is already described in the schema as "the community membership ID (KWASU/0021)", has a community prefix (`community_member_code_settings.prefix`, changed with `community.edit_profile`), is printed on receipts and is what a contributor types to find themselves. | `20260920120000_member_identity.sql:43-90` | The new IDs (`KWASU/P9R2W`) look the same as `KWASU/0021`. Confusion risk for members and officers; Q10. |
| 4 | Permissions are role-based only (`role_permissions`: role → permission). There is no per-officer grant. | `20260917120400_roles_and_officers.sql` | "Owner delegates to one officer" needs a new mechanism touching `app.has_permission` — every authorization check (Q2). |
| 5 | `contributions` is immutable (`contributions_no_update`, `_no_delete`, `_no_truncate` triggers) and already has `member_id`, copied from the payment attempt at capture. | `20261111100000_payment_records.sql:425-460,522,653` | The payment-time snapshot must be written **at insert** inside `complete_payment_capture`. Later linking can never edit the contribution → separate link table (F8). |
| 6 | Managed collections identify a member by an equality search with no secret (`find_collection_member`: code, unique attribute, phone, email, two name parts) and remember the result in a signed, httpOnly, collection-bound, 1-hour cookie (`apps/web/lib/contributor-session.ts`); `get_collection_member_context` and `create_payment_attempt` re-check it. | ADR 0014 | Good pattern to reuse for the access grant. It is **weak identity**: knowing someone's code or phone is enough — acceptable for paying, not for proving who a person is (F8). |
| 7 | The lookup throttle is an in-memory, per-process counter. | `apps/web/lib/lookup-throttle.ts` | Not enough for membership-ID guessing; needs DB-backed limits (F6.3). |
| 8 | `members_only` is still selectable in `SettingsPanel.tsx:268` (E4.1 unresolved). `create_payment_attempt` refuses it (`COLLECTION_NOT_FOUND`), so there is no money risk — only a 404 for everyone. The creation form offers only public / unlisted. | `apps/web/app/c/[slug]/collections/[collectionSlug]/SettingsPanel.tsx` | Hide the option now (Phase 2a, F14). |
| 9 | The web server's DB connection sets `role` and `request.jwt.claims` itself (`sub` + `role` only; no `aal`). | `packages/db/src/client.ts:80` | Any SQL check of MFA level (`aal2`) trusts whoever opened the connection. Central to the admin threat model (F3.4). |
| 10 | ADR 0001 says the staff console is "a route group inside `apps/web`, not a separate application"; ADR 0009 says the same, names the table `staff_users`, and requires IP allow-listing, a reason on every staff action, audited reads, and community-visible staff access. D11 / E5 moved to `apps/admin` without a superseding ADR. | `docs/adr/0001…`, `0009…` | Separate repo needs ADR 0017 superseding those parts (drafted as **Proposed**). |
| 11 | `complete_payment_capture` already parks a payment it cannot apply as `needs_review` with a `review_reason` (`already_paid`, `obligation_changed`, `stock_exhausted`). | `20261114100000_obligation_on_capture.sql:170-205` | The per-member limit can reuse this path (F10); a new reason value needs the reason vocabulary extended. |

## F2. Status of every item in this brief

| # | Item | Status |
|---|---|---|
| 1 | Separate `kolekto-admin` repository | DESIGNED (F3). BLOCKED on ADR 0017 approval and Q13 (DB role check). |
| 2 | Admin security architecture (roles, MFA, step-up, audit) | DESIGNED (C6, E5, F3). |
| 3 | Configurable membership ID prefixes | DESIGNED (F4). Product requirement approved. |
| 4 | Five-character random suffix by default | DESIGNED (F4.3). Q1 open. |
| 5 | Membership ID security and rotation | DESIGNED (F4.4–F4.7). |
| 6 | Members-only collection access | DESIGNED (F6). Not selectable fix (F1.8) DESIGNED, ready to approve. |
| 7 | Members-and-non-members option | DESIGNED (F5). Payment-path change → separate review. |
| 8 | Everyone option | IMPLEMENTED today as `audience_mode = public` (open collection); only the label is new. |
| 9 | Payment-time membership snapshot | DESIGNED (F7). Payment-path change → separate review. |
| 10 | Later verified association of contributions | DESIGNED (F8). |
| 11 | Per-member contribution limits | DESIGNED (F10). Payment-path change → separate review. |
| 12 | Database and migration plan | DESIGNED (F11). No migration written. |
| 13 | Test strategy | DESIGNED (F12). No test written. |
| — | Profile avatar, public community page | IMPLEMENTED on itest only (E1, E2); not on dev, staging or production. |
| — | Community overview (`20261122120000`) | IMPLEMENTED on dev and itest. |

## F3. Central admin — separate private repository `kolekto-admin` (DESIGNED)

### F3.1 Decision recorded

The owner now prefers a separate private repository for the central admin instead of `apps/admin` in this monorepo
(supersedes D11 D-O and E5 "Where"). Reason given: independent codebase, release lifecycle, deployment pipeline and
access permissions for the most sensitive platform operations. A separate repository is **not** a security control by
itself: database authorization, server-side checks, secret handling and deployment security remain mandatory and are
where the real isolation comes from (F3.4).

ADR 0001 rejected a split admin because "it lets the admin authorization model drift away from the product's". The
design below answers that risk by keeping **one** source of truth: all permissions, schema and migrations stay in the
`kolekto` repository and the database; the admin repository holds UI and a thin server only. ADR 0017 (draft,
Proposed) records this and keeps ADR 0009's rules (mandatory MFA, reason on every action, audited reads,
community-visible staff access, IP allow-list).

Naming: ADR 0009 says `staff_users`; C6 says `platform_admins`. Proposed: keep C6's names and record the rename in
ADR 0017. The legacy panel (C2) stays untouched and is a visual/workflow reference only.

### F3.2 Repositories

| Repository | Contains | Does not contain |
|---|---|---|
| `kolekto` (this one) | Public site, community workspaces, collections, payments, members, profiles, public community pages, payment/withdrawal infrastructure, worker, **all migrations**, all `admin.*` database functions and their pgTAP tests, the published contract package | Admin UI |
| `kolekto-admin` (new, private, not created) | Admin UI (server-rendered Next.js), admin sign-in + MFA + step-up handling, a server layer that calls `admin.*` functions only, its own CI/CD | Migrations, fee/ledger/settlement logic, any write to a table, the web app's secrets |

### F3.3 Shared contracts without copying business logic

1. **Schema:** only `kolekto/supabase/migrations`. Admin CI fails if a `supabase/migrations` folder appears there.
2. **Types:** admin CI generates DB types from the target environment (`supabase gen types`), so they match what is
   deployed rather than a copy.
3. **Contract package:** a small private package (proposed `@kolekto/contracts`, published from `kolekto` to GitHub
   Packages, semver): permission keys, role names, enum literals, zod schemas for each `admin.*` function's input and
   output, and error codes. **No** fee engine, ledger, settlement or payment code — admin never computes money; it
   reads figures from DB views and functions.
4. **Contract test:** `kolekto` CI checks that every `admin.*` function signature matches the published schemas, so a
   migration cannot silently break the admin.

### F3.4 Database access model and the main threat

| Layer | Control |
|---|---|
| Identity | Same Supabase Auth project per environment; admins are users; admin rights come only from `platform_admins` (never from a community role; an owner never becomes an admin). |
| Connection | Admin server connects with its **own** login role (proposed `kolekto_admin_api`): not superuser, no `BYPASSRLS`, no table privileges, `EXECUTE` only on functions in a new `admin` schema (not exposed by PostgREST — `config.toml` serves `public` only). `admin.*` functions are revoked from `public`, `anon`, `authenticated` and from the web server's role. |
| In-function | Every `admin.*` function (security definer) checks `platform_has_permission(actor, perm)`, `aal = aal2`, step-up freshness for sensitive actions, a non-empty reason, then writes `platform_audit_log` in the same transaction. |
| Browser | No service-role key and no DB URL in any client bundle. If storage signing for KYC documents needs the service role, it lives only on the admin server, behind an audited function call, as a secret separate from the web app's. |

**Main threat (F1.9).** The DB trusts the claims that the connecting server sets. The `aal2` and step-up checks in SQL
are therefore only as strong as the admin server's own JWT verification, and the thing that stops a compromised
**web** server from calling admin functions is the separate connection role. **Prerequisite (Q13):** confirm which
Postgres role `DATABASE_URL` uses for the web app and worker in each environment. If it is `postgres` or any role that
can `SET ROLE` to the admin role, a compromise of the web server is already a database-wide compromise and the admin
isolation adds little until that is fixed. Not checked in this pass (secrets were not read).

### F3.5 Authentication, sessions, roles

- MFA mandatory for every admin role (D-P): Supabase TOTP (`aal2`) now. Passkeys/WebAuthn: confirm whether the Auth
  version in use supports WebAuthn as an MFA factor; if not, the admin server verifies WebAuthn itself and records the
  step-up in the DB. Enrolment is a precondition of the account working (ADR 0009).
- Sessions: 30 min idle, 8 h absolute (proposed). Step-up (fresh MFA ≤ 5 min) for: KYC approve/reject, community bank
  account approval, platform-setting change, admin role grant/revoke, any finance action, opening an identity document.
- Roles → example permissions: Super Admin (`admin.manage`, `settings.manage`, all reads); KYC Officer
  (`kyc.review_personal`, `kyc.review_community`, document view); Finance Officer (`bank.review_community`,
  `withdrawal.monitor`, `finance.reconcile`); Support Officer (`user.support_view` with masked contact, community
  read); Auditor (`audit.read` and read-only views, no PII unmasking). No admin role can mark an obligation paid or
  create money (ADR 0009, SEC-20a).
- Masking: phone/email/account numbers masked by default; unmasking is its own audited action. Raw NIN and biometric
  images are never stored by Kolekto (E6) and so are never shown.
- Bootstrap: first Super Admin by a one-off, owner-approved migration naming an existing user id (E5).

### F3.6 Audit

`platform_audit_log` (actor, role at the time, action, target, before/after of changed fields, reason, request id,
at); append-only by trigger. Reads of identity documents and unmasking are logged. Actions on a community also write
a row the community's owners can read (ADR 0009 AUD-03).

### F3.7 CI/CD, secrets, environments

- Separate GitHub repository, private; protected `main`; two required reviews; CODEOWNERS; signed commits (proposed);
  dependency and secret scanning.
- Separate hosting project per environment (local, itest, staging, production), separate domain (e.g. an `admin.`
  sub-domain), never linked from the public app; access gateway / IP allow-list in front (ADR 0009).
- Secrets per environment: admin DB URL (admin role), Supabase URL + publishable key, storage-signing secret if
  needed. **None** of the web app's secrets (Paystack keys, session secret, membership pepper) are given to the admin.
- No preview deployment may point at the production database.

### F3.8 What the admin needs from this repository (migration A0, not written)

`admin` schema; `kolekto_admin_api` role and grants; `platform_admins`, `platform_admin_permissions`,
`platform_audit_log` (+ append-only trigger), `platform_settings` (C6 flags, false); `platform_has_permission`;
first read-only `admin.*` functions (users, communities, collections, withdrawals, reconciliation, masked); pgTAP
proving `authenticated`/`anon`/web role cannot execute any `admin.*` function and that every function refuses
without `aal2`.

### F3.9 Threat review (summary)

| Threat | Control | Residual |
|---|---|---|
| Web server compromise reaches admin functions | Separate connection role; `admin.*` not granted to web role | Depends on Q13 |
| Stolen admin password | Mandatory MFA, short sessions, IP allow-list | Phishable TOTP → passkeys preferred |
| Admin abuses access | Least-privilege roles, reasons, append-only audit, community-visible entries, masking | Super Admin trust |
| Client-side-only authorization | All checks in `admin.*` functions; UI gates are convenience | — |
| Schema drift between repos | Migrations only in `kolekto`; generated types; contract test | Contract package must be released with migrations |
| Leaked admin secrets | Separate secrets; no service role in browser; rotation runbook | Secret store access |
| Community owner escalates to admin | Admin rights only from `platform_admins`; no path from `officer_terms` | — |

## F4. Configurable membership IDs (DESIGNED; supersedes D3 format)

### F4.1 Format

`PREFIX` + `SEPARATOR` + `RANDOM SUFFIX`, e.g. `IDS/K7P9Q`, `KWASU/P9R2W`.

- **Alphabet:** Crockford base32 (`0-9 A-Z` without `I L O U`). Input is normalised: upper-case, spaces removed,
  `O`→`0`, `I`/`L`→`1`, separator optional when typed. So the confusable pairs O/0 and I/1 can never cause a failure.
- **Suffix contains at least one letter.** A member code (`KWASU/0021`) is all digits after the prefix, so a
  membership ID can never be the same string as a member code. Cost: 32⁵ − 10⁵ ≈ 33.45 M values instead of 33.55 M.
- Generated with a cryptographically secure source (Node `crypto.randomInt`), on the web server (F4.5).

### F4.2 Community settings (new table `community_membership_id_settings`)

| Field | Rule |
|---|---|
| `prefix` | 2–10 characters, `^[A-Z][A-Z0-9]{1,9}$` after upper-casing; no spaces or symbols; reserved prefixes refused (proposed: `KM`, `KOLEKTO`, `KLK`, `KTR`, `ADMIN`, `SYSTEM`, `SYS`, `TEST` — final list checked against the payment/transfer reference formats at build time). UI suggests the member-code prefix as a starting point. |
| `separator` | `/` or `-` |
| `suffix_length` | 5–8, default 5 (Q1) |
| `enabled` | IDs issued only when true |
| `updated_by`, `updated_at` | set by the function |

Live preview in the settings screen (`Prefix IDS · Separator / · Random characters 5 → IDS/K7P9Q`), using a sample
generated in the browser for display only.

Changing the settings: new function `app.update_membership_id_settings` (permission F4.8), audited in `audit_logs`
with before/after of prefix, separator, suffix length, enabled, plus actor and time — the same pattern as
`update_member_code_settings`.

### F4.3 Prefix change and identifier space

A change affects **new** IDs only. Old IDs stay valid because the stored hash covers the full string as issued; the
prefix used is stored for display. No automatic regeneration.

| Suffix | Values | Chance one random guess hits, community of 5,000 members |
|---|---|---|
| 5 | ≈ 33.4 M | 1 in ~6,700 |
| 6 | ≈ 1.07 B | 1 in ~215,000 |
| 7 | ≈ 34 B | 1 in ~6.9 M |

Five characters are **not** a secret on their own. They are acceptable only with the controls in F6.3 and because a
correct guess reveals no personal data (validation returns no name or contact) — what it allows is opening a
members-only page and paying as that member.

### F4.4 Storage (new table `membership_ids`; hash only)

`id`, `community_id`, `member_id`, `id_hash` (HMAC-SHA256 of the normalised full ID with `community_id`, keyed by a
server-held pepper), `key_version`, `prefix_at_issue`, `last2`, `issued_at`, `issued_by`, `revoked_at`, `revoked_by`,
`revoke_reason`. Unique `(community_id, id_hash)`; at most one unrevoked row per member (partial unique index). Rotation
history is kept as revoked rows. Force RLS, no client policies; reads only through functions.

**Security finding — last four characters.** With a 5-character suffix, showing the last 4 leaves one unknown
character: 32 guesses. Proposed: store and show the **last 2** only (`IDS/•••9Q`), and only to officers.

### F4.5 Pepper and generation

- The pepper is an environment secret of the **web server** only (proposed `MEMBERSHIP_ID_PEPPER`), never in the DB,
  never in a client bundle, never given to the admin app. If the pepper were in the database, a database dump would let
  anyone recompute every 5-character ID in seconds.
- Flow: server generates the ID → computes the HMAC → calls `app.issue_membership_id(member, hash, prefix, last2,
  key_version)` (permission check, insert, audit) → unique violation = regenerate, max 5 tries → plaintext returned once
  for delivery. Plaintext is never written to a table, log or audit row.
- Email delivery: today's emails go through DB rows read by the worker. Putting the ID in such a row would store it in
  plaintext. Proposed: send the ID email directly from the server action through the existing SES adapter and record
  only "sent" in the DB (Q14 — to confirm a direct-send path exists).

### F4.6 Validity and lifecycle

- Validates only for a member "in good standing" (Q8) of the collection's own community, not `pending_approval`,
  `suspended`, `archived` or `merged`. Re-checked on every use; suspension makes it fail at once.
- Issued on: officer add, approved application, import — when the community has IDs enabled. Existing members get no
  ID until an officer runs a batched "issue IDs" action (subject to the M13.2 send limits). The migration issues none.
- Delivery: email when the member has one; members without email → shown once to the issuing officer to pass on
  (Q9). Officers can re-send (re-delivery requires rotation, since plaintext is not kept) or rotate, never read back.

### F4.7 Rotation

One transaction: revoke the current row (reason), insert the new hash, audit `member.rotate_membership_id`; the old ID
fails at once; member notified by email if they have one.

### F4.8 Permissions (proposed)

| Permission | Holders (proposed) |
|---|---|
| `membership.configure_ids` (prefix, separator, length, enable) | owner |
| `membership.issue_ids` (issue, rotate, revoke) | owner, admin |
| `member.suspend` (suspend, reinstate) | the roles that hold `member.archive` |
| `contribution.link_member` (F8 route B) | owner, treasurer |

Owner-to-officer delegation (Q2) is not in the current permission model (F1.4).

### F4.9 `member_code` stays separate

`member_code` remains the community's sequential roll number, unchanged, still used by the existing identification
search and receipts. It is never used as or converted into a membership ID.

## F5. Who can see vs who can contribute (DESIGNED)

### F5.1 Two separate questions

- **Visibility** (unchanged enum): `public` listed on the community page; `unlisted` link only; `members_only` page
  content shown only after a valid membership ID.
- **Contributor eligibility** (new UI question "Who can contribute to this collection?"), mapped onto existing columns:

| Option | `participation_mode` | `audience_mode` | `allow_non_members` | Member proof (`member_verification`, new) |
|---|---|---|---|---|
| C — Everyone | `open` | `public` | false (ignored) | none |
| B — Members and non-members | `managed` | `all_members` / `groups` / `selected_members` | **true** | `lookup` / `membership_id` / `membership_id_otp` |
| A — Members only | `managed` | `all_members` / `groups` / `selected_members` | false | `lookup` / `membership_id` / `membership_id_otp` |

New collection columns: `member_verification` (enum, default `lookup` = today's search, so every existing managed
collection behaves exactly as now) and `max_contributions_per_member` (F10). `allow_non_members` is reused, not
duplicated.

Constraints (proposed): `visibility = 'members_only'` requires option A and `member_verification <> 'lookup'` (a
members-only page must not answer a name search). Option C cannot be `members_only`.

### F5.2 Managed audiences and non-members (Q5)

Recommended rule, stated in the UI: with groups or selected members **and** non-members allowed, only people in the
audience can identify as members; a community member outside the audience gets the same generic failure as anyone
else. Anyone — including that person — may pay **as a guest**. A guest payment never gets member attribution, an
obligation, or counts toward a per-member limit. An owner who wants the list to be strict leaves non-members off.

### F5.3 Everyone (option C)

Today's open collection: no identification, `MEMBER_NOT_EXPECTED` stays. A member who pays here can link the payment
later (F8). Nobody is pushed into an application.

### F5.4 Payment-path changes this needs (separate review, Phase 3/4)

`create_payment_attempt`: (a) accept no member when `allow_non_members` is true; (b) when `member_verification` is not
`lookup`, require a valid access grant for that member and collection (F6.2), checked in SQL, not only in Node;
(c) per-member limit pre-check (F10). `complete_payment_capture`: snapshot (F7) and authoritative limit check (F10).
A guest on a managed collection creates no obligation (the existing on-capture rule needs `member_id`). Reports that
assume every managed contribution has a member (register, expected summary, payment activity) must be tested with
guest rows.

### F5.5 Creation form (progressive disclosure)

1. "Who can see it?" — Listed publicly / Unlisted (anyone with the link) / Members only (when available).
2. "Who can contribute?" — Everyone / Members and non-members / Members only.
3. Only if B or A: "Which members?" (all / groups / selected — the existing `AudiencePicker`), "How do members prove
   it?" (find themselves on the list / membership ID / membership ID + email code), "Limit per member" (unlimited
   default).
4. Only if the community accepts applications: a note that non-members will see "Apply to join".

## F6. Members-only access (DESIGNED; updates D4 journey)

### F6.1 Flow

Open URL → shell page (collection name, community, "for members") → enter membership ID →
`app.validate_membership_for_collection` (anon, rate-limited) checks community, good standing, audience, collection
status, limit → on success an access grant → optional email OTP to the member record's email → existing contribute
form → existing Paystack checkout → capture takes the member from the grant, never from a browser field.

### F6.2 Access grant (new table `membership_access_grants`)

`token_hash` (SHA-256 of 32 random bytes), `member_id`, `collection_id`, `community_id`, `created_at`,
`expires_at` (+30 min, as D4), `otp_verified_at`, `revoked_at`. The raw token sits in a signed httpOnly cookie bound to
the collection (the `contributor-session.ts` pattern, separate cookie). Not single-use (a failed card must be
retryable) but useless after expiry; every use re-checks the member's status live.

### F6.3 Abuse controls

- `membership_validation_attempts` (keyed hash of the IP, community, collection, time, outcome); purge after 30 days.
- Proposed limits: per IP hash 10 failures / 15 min; per collection 200 failures / hour → cool-down and officer
  alert; per community 1,000 failures / day. Over the limit = the same generic message.
- One message for every failure ("We couldn't verify that membership ID for this collection"): unknown, other
  community, suspended, archived, pending, not in audience, collection closed, limit reached before payment.
- Client IP only from the trusted proxy header of the deployed host (deployment config to confirm).
- Validation never returns a name, code or contact.

### F6.4 Until it ships

Hide `members_only` in `SettingsPanel` (F1.8). Proposed as the first small change (Phase 2a).

## F7. Membership status at payment time (DESIGNED; payment path)

New nullable columns on `contributions`, written once at insert by `complete_payment_capture`:

| Column | Values |
|---|---|
| `payer_basis` | `member_verified` (membership ID), `member_identified` (existing lookup), `guest` (not identified as a member) |
| `member_status_at_payment` | the member's `member_status` at capture, when a member was named; else null |

- Existing contributions keep null = "not recorded (paid before this was tracked)". No backfill: the immutability
  trigger stays on, and history is not rewritten.
- `guest` means "not identified as a member when paying" — not proof the person was not a member. UI wording:
  "Paid as a guest". This is the brief's `membership_status_at_payment: non_member`.
- Current membership is always read live from `members`; the snapshot is never derived from it.

## F8. Later linking of a contribution to a member (DESIGNED)

New table `contribution_member_links`: `contribution_id`, `member_id`, `community_id`, `method`
(`member_verified` | `officer_assisted`), `evidence` (which checks passed; no PII), `reason`, `linked_by` (user, null
for member route), `linked_at`, `revoked_at`, `revoked_by`, `revoke_reason`. One unrevoked link per contribution;
append-only except the revoke columns. Refused when the contribution already has `member_id`, belongs to another
community, or the member is not in good standing. Never edits the contribution, an obligation or the ledger.

- **Route A (member):** needs all three: a valid membership grant for that community (ID, plus OTP if configured),
  the payment reference, and a one-time code to the **email recorded on that payment**. A reference alone is never
  enough. A payment with no email can only use route B. Rate-limited like F6.3. (Recommendation for Q3.)
- **Route B (officer):** `contribution.link_member`, reason required, audited, shown in the community audit log,
  revocable with a reason. No second approver in v1 because no money moves (Q4).
- A linked payment never satisfies an obligation, never counts as dues, never counts toward a per-member limit.
  Applying an old payment to an obligation would be a separate, audited action — not designed here.
- Display: "Paid as a guest · Linked to John Doe on 20 Feb (officer-assisted) · Member today: active".
- No automatic linking by name, email or phone, ever.

## F9. Applications and lifecycle (DESIGNED; reuses D5)

- Add `suspended` to `member_status` in its own migration (a new enum value cannot be used in the transaction that
  adds it). The collection audience already lists only `active`, `unclaimed`, `invited`, so suspended members drop out
  of audiences automatically; every other status filter (recipient eligibility, reminders, duplicates, overview counts)
  must be checked and tested.
- `app.suspend_member` / `app.reinstate_member` (`member.suspend`), audited.
- `communities.membership_applications_enabled` (default false). The application form is an invite link with
  `approve_joiners` forced on (D5). Applying never makes anyone a member and never grants access.
- Approval → good-standing status (Q8) + membership ID issued (if enabled) + email. Rejection audited and, if the
  applicant gave an email, communicated. Duplicate open applications reuse `find_member_duplicates`.
- Kolekto user, member and contributor stay separate (D1). No account is ever created by paying or applying.

## F10. Per-member contribution limits (DESIGNED; payment path)

- `collections.max_contributions_per_member` (null = unlimited; 1–N).
- Counts applied contributions with that `member_id` on that collection (attributed at payment). Guests and linked
  payments do not count.
- **At attempt creation:** refuse if applied + in-flight attempts (pending/initialized, not expired) for that member
  ≥ limit. Stops several tabs at once.
- **At capture (authoritative):** re-count under the collection row lock `complete_payment_capture` already takes. If
  the limit is already reached, the payment becomes `needs_review` with a new reason (e.g. `member_limit_reached`) —
  money captured, nothing applied, flagged for resolution; never silently applied or dropped.
- Refunds/reversals: there is no refund flow (`contribution_status` = `applied` only). When D-31 adds one, refunded
  contributions should stop counting (Q6).

## F11. Database and migration plan (none written)

| Migration | Contents | Boundary |
|---|---|---|
| M9a | `member_status` + `suspended` (alone) | membership |
| M9b | `community_membership_id_settings`, `membership_ids`, `membership_access_grants`, `membership_validation_attempts`, `communities.membership_applications_enabled`, new permissions, functions (settings, issue/rotate/revoke, validate, grant, suspend/reinstate), grants, force RLS with no client policies | membership; no payment table touched |
| M9c | collection columns `member_verification`, `max_contributions_per_member`; constraints (F5.1); `create_collection` / `update_collection` signature change (needs drop + create of the function — review); members-only shell read | collections; no payment function touched |
| M10 | `contributions.payer_basis`, `member_status_at_payment`; `create_payment_attempt` (non-members, grant check, limit pre-check); `complete_payment_capture` (snapshot, limit, new review reason) | **payment path — separate design review and dedicated tests before it is written** |
| M11 | `contribution_member_links`, link/revoke functions, `contribution.link_member` | reporting; no payment record edited |
| A0 | admin schema, role and platform tables (F3.8) | admin; lives in this repo |

Each: additive only, one transaction (except M9a), no ledger or payment-record rows touched, no visibility value
changed, never edit an applied migration. Rollback: drop the new objects (feature data lost, nothing older);
for M10, the previous function bodies are kept in a rollback script and restored; the two new contribution columns
stay (dropping them would lose recorded snapshots). Order per migration: itest → (approval) dev → (approval) staging →
(approval) production.

## F12. Test strategy

| File (planned) | Covers |
|---|---|
| `75_membership_id_settings.sql` | prefix/separator/length validation, reserved prefixes, authorisation, audit before/after |
| `76_membership_ids.sql` | issue, hash-only storage (no plaintext column anywhere), uniqueness, collision retry (forced duplicate hash), old IDs valid after prefix change, new IDs use new prefix, rotation invalidates old, suspended/archived/pending/merged/other-community/non-member refused, generic error |
| `77_membership_access.sql` | rate limits (IP, collection, community), grant expiry and binding, members-only shell reveals nothing |
| `78_contribution_eligibility.sql` | options A/B/C; guest on B creates no member and no user; audience restrictions with non-members; existing public/unlisted unchanged |
| `79_payment_snapshot_and_limits.sql` | snapshot values; member association from grant only; limit pre-check and capture check; `needs_review` on overflow; guests not limited |
| `80_contribution_member_links.sql` | route A needs all three proofs; reference alone fails; officer without permission refused; audit; snapshot, amount, reference, date unchanged; duplicate/conflicting link refused; no obligation effect |
| `81_admin_foundation.sql` | no `admin.*` executable by anon/authenticated/web role; `aal2` required; audit append-only |
| `02_grant_matrix.sql` | each new anon function added explicitly with a dated comment |
| `03_money_invariants.sql` and payment files 40–72 | must pass unchanged — any change to their assertions is a stop-and-report |
| Concurrency (`supabase-itest`, two connections) | two captures for one member with limit 1 → one applied, one `needs_review` |
| Unit (`apps/web/lib`) | generator alphabet/length/≥1 letter, normaliser (O/0, I/1, separator), HMAC, cookie |
| E2E | members-only journey, guest on option B, settings preview |

Regression baseline: full pgTAP on itest; the known failures 18, 20, 23 (demo ledger rows, C9) are the only accepted
failures until the itest reset is approved.

## F13. Open questions (recommendations, not decisions)

| Q | Question | Recommendation |
|---|---|---|
| Q1 | Fixed 5 characters, or grow with size? | Default 5; require ≥ 6 when the community has > 2,000 members in good standing (F4.3). |
| Q2 | Only owner, or delegable? | Owner only for `membership.configure_ids` in Phase 2. Per-officer delegation needs a new grant table read by `app.has_permission` — defer and design separately. |
| Q3 | Member linking: transaction evidence and contact ownership? | Both, plus a valid membership grant (F8). |
| Q4 | Second approver for officer linking? | Not in v1 (no money moves); required if linking ever affects obligations. |
| Q5 | Non-members vs groups/selected | F5.2 rule. |
| Q6 | What counts toward limits | Applied, member-attributed only; refunds excluded when refunds exist. |
| Q7 | Which contacts are verified enough for OTP | None are verified today: member emails are officer-typed or self-typed. An OTP proves control of that address now, which is enough for a possession check; treat phone OTP as unavailable (no SMS provider). |
| Q8 | **New.** "Active only" vs real statuses (F1.2) | Valid for `active`, `unclaimed`, `invited` (the existing audience set); refuse `pending_approval`, `suspended`, `archived`, `merged`. |
| Q9 | **New.** Members with no email | Show the ID once to the issuing officer; SMS when a provider exists. |
| Q10 | **New.** Naming next to `member_code` | Call `member_code` "Member number" in the UI and the new one "Membership ID"; the ≥1-letter rule keeps them distinct. |
| Q11 | **New.** Replace D4 `non_member_policy` with `allow_non_members` + community application setting? | Yes (F5.1, F9). |
| Q12 | **New.** Approve ADR 0017 (separate admin repo)? | Approve; it keeps ADR 0009's controls. |
| Q13 | **New.** Which DB role do the web app and worker use per environment? | Check before A0; must not be able to reach the admin role. |
| Q14 | **New.** Direct email send for IDs (no plaintext in the outbox)? | Yes; confirm the SES adapter can be called from a server action. |

## F14. Phased plan (each phase approved separately; no commit, push or deploy without approval)

| Phase | Scope | Gate |
|---|---|---|
| 0 | Audit (F0, F1) | **Done in this pass** (read-only) |
| 1 | This Part F, ADR 0017 draft, status doc | **Done in this pass** (docs only, uncommitted) |
| 2a | Hide `members_only` in `SettingsPanel` | Owner OK; one file; no DB |
| 2 | M9a + M9b, settings UI with preview, issue/rotate/revoke, suspend/reinstate, validation + rate limits + grants, applications setting; tests 75–77 on itest | Q1, Q2, Q8, Q9, Q10, Q14 answered |
| 3 | M9c, creation-form question, members-only page, optional OTP; tests 78 (non-payment parts) | Phase 2 accepted |
| 3/4 | M10 payment-path change: non-member acceptance, grant check, snapshot, limits; tests 78–79, concurrency, full payment regression | **Separate payment-path design review** |
| 4 | M11 linking routes A and B, reporting; test 80 | Phase 3/4 accepted; Q3, Q4 |
| 5 | Admin: A0 migration here, then the `kolekto-admin` repository | ADR 0017, Q12, Q13; explicit OK to create the repository |

Not part of any phase here: payout worker, withdrawal execution, approvals, OTP for withdrawals, transfer dispatch,
the ledger, LIVE Paystack settings, itest reset.

## F15. Owner decisions recorded (owner review, 2026-11-22)

| Q | Decision (summary of the owner's words) | Where it landed |
|---|---|---|
| Q1 | Standalone community membership. Kolekto user, community member and contributor stay separate. No forced account, no auto-linking by name/phone/email. | Unchanged code; nothing links accounts. |
| Q2 | Granular, server-enforced, delegable permissions. Role defaults plus explicit grants; the owner keeps final authority. Not the platform-admin model. | `officer_permission_grants` + `app.has_permission` (F16.1). |
| Q8 | `unclaimed` is not "inactive". Account claim is separate from membership. Suspended and archived must fail validation. No bulk status change. | Good standing = `active`, `unclaimed`, `invited`; `suspended` added; no member row rewritten. |
| Q9 | Keep the lookup experience but close enumeration. Review `find_collection_member` and its callers; document dependencies and propose a safe replacement **before** changing behaviour. New validation: generic answers, rate limits, lockout, no sequential numbers as credentials. | Validation built (F16.1). Review: F17. `find_collection_member` **not changed**. |
| Q10 | `member_code` stays the roll number, never a credential. Separate random membership ID, configurable prefix/separator, 5 random characters default, unambiguous alphabet, collision handling. Format changes affect new IDs only. Hash with a server-held key; last 2 for masked display; no full ID in logs, audit or anonymous responses. **Later changed by the owner (F16.2): store the full ID encrypted so officers can always show it.** | F16.1, F16.2. |
| Q12 | Hide the incomplete `members_only` option until the journey works. Keep the enum value; rewrite nothing. | Phase 2a (F16.1). |
| Q13 | Separate private `kolekto-admin` repository approved **in principle**, subject to verified database-role isolation (inspect grants, prove the web role cannot reach the admin role, positive and negative tests, document). ADR 0017 stays **Proposed**. | Not started. ADR 0017 unchanged (Proposed). |
| Q14 | Phase 2a and Phase 2 approved on **itest only**. No payment-path change. | F16. |

Q3–Q7 and Q11 remain open (F13).

## F16. Implementation record — Phase 2a and Phase 2 (itest only, 2026-11-22, uncommitted)

### F16.1 What exists

**Phase 2a.** `apps/web/app/c/[slug]/collections/[collectionSlug]/SettingsPanel.tsx`: "Members only" is no longer
offered; a collection that already has it shows it disabled as "Members only (not available yet)".
`apps/web/app/c/[slug]/collections/actions.ts`: create refuses `members_only`; update refuses changing **to** it (a
collection already `members_only` keeps it). No enum or stored value changed.

**Migrations (applied to itest only; copied to `supabase-itest/supabase/migrations/`):**

- `20261123100000_member_status_suspended.sql` (M9a): `member_status` gains `suspended`.
- `20261123100100_membership_foundation.sql` (M9b), one transaction:
  - `permissions.delegable`; new permissions `membership.configure_ids`, `membership.issue_ids`, `member.suspend`,
    `officer.delegate` (owner role only). Delegable: those three plus `member.create`, `member.edit`, `invite.approve`.
  - `officer_permission_grants` (owner grants to a non-owner officer term; delegable only; same community; revoke
    once; no delete) and `app.has_permission` extended to read live grants. Grants end with the officer's term.
  - `community_membership_id_settings` (prefix 2–10, starts with a letter, reserved list; separator `/` or `-`;
    5–8 random characters; enabled flag). Audited with before/after.
  - `membership_ids`: `id_hash` (32-byte HMAC), `id_ciphertext` (F16.2), `key_version`, `prefix`, `separator`,
    `last2`, issue/revoke fields. Unique `(community_id, id_hash)` across all rows, so a revoked ID is never re-issued;
    one live row per member; revoke-only updates (ciphertext cleared on revoke); no delete, no truncate.
  - `members.suspended_at`, `members.status_before_suspension`; `app.suspend_member` (reason required; ends that
    member's access grants) and `app.reinstate_member` (returns the earlier status, or `unclaimed` if an `active`
    member no longer has the phone `active` requires).
  - `membership_validation_attempts` (keyed IP hash, outcome; purge function for 30 days, not scheduled) and
    `membership_access_grants` (SHA-256 of the token; at most 30 minutes; revocable).
  - Functions: settings get/set; issue / rotate / revoke; `get_member_membership_id` (`member.view_contact`);
    `members_without_membership_id`; `community_membership_id_summary` (masked); suspend / reinstate; grant / revoke /
    list delegated permissions; anonymous `validate_membership_id` and `resolve_membership_access_grant`.
  - Validation returns `(false, null, null)` for every failure (unknown, other community, suspended, archived,
    pending, not in audience, collection unavailable, rate-limited). Limits: per IP hash 10 failures or 30 attempts
    per 15 minutes; per collection 200 failures per hour; per community 1,000 failures per day; a lockout audit row at
    most once an hour. **Public-audience collections never validate** (there is no membership to prove there).
  - Audit actions: `membership.update_id_settings`, `member.issue_membership_id`, `member.rotate_membership_id`,
    `member.revoke_membership_id`, `member.suspend`, `member.reinstate`, `officer.grant_permission`,
    `officer.revoke_permission`, `membership.validation_lockout`. Audit rows carry the masked ID only.

**Suspension and the ID.** Suspending does **not** revoke the ID row: validation fails because the member is not in
good standing, and reinstating makes the **same** ID work again (verified on itest). Revoke and Replace are separate,
explicit actions.

**Server and UI (`apps/web`):**

- `lib/membership-id.ts`: Crockford base32 suffix with at least one letter (`crypto.randomInt`); canonical form
  (upper-case, separators and spaces removed, O→0, I/L→1); HMAC-SHA256 lookup hash scoped to the community;
  AES-256-GCM ciphertext bound to community + member; keys derived by HKDF from one server secret.
- `lib/membership-id-server.ts` (server-only): issue/replace with up to 5 collision retries; decrypt for display.
  The community is always read from the member row through RLS, never taken from the browser.
- `packages/config`: `loadMembershipIdSecret()` reads `KOLEKTO_MEMBERSHIP_ID_SECRET` (at least 32 characters; refuses
  in a browser). `.env.example` documents it.
- `packages/db/src/membership.ts`: typed callers for every function above.
- `lib/permissions.ts`: the UI permission set includes delegated grants (display only; SQL re-checks).
- Settings: **Membership IDs** card (prefix, separator, length, on/off, live preview using a fixed sample suffix,
  counts, "Issue IDs to members without one" in batches of 100) for `membership.configure_ids` /
  `membership.issue_ids`; **Extra officer permissions** card for `officer.delegate` (owner).
- Member page: **Membership** card — full ID with Copy for `member.view_contact`; Issue / Replace / Revoke for
  `membership.issue_ids`; Suspend / Reinstate (reason required to suspend) for `member.suspend`; suspended badge and
  explanation. Members list shows a "suspended" badge.

### F16.2 Owner change to Q10 — the full ID is stored encrypted

Owner, 2026-11-22: the ID should always be shown and stored, so it can be given to members whenever they are told
about a new collection, without struggle. Implemented as:

- `id_hash` (HMAC) is still the only thing validation looks up.
- `id_ciphertext` = AES-256-GCM of the full ID under a key derived from the same server secret, bound to community and
  member (a ciphertext copied to another member's row does not decrypt). The database never holds the key.
- Officers with `member.view_contact` see the full ID; others see nothing. Audit, logs and anonymous responses still
  never contain it.
- Consequence to accept: anyone holding **both** a database copy and the server secret can read every ID. A database
  copy alone cannot. Rotating the secret needs a re-encryption job (`key_version` exists for this; not built).

### F16.3 Not done in this phase

- Email delivery of the ID (and including it in "new collection" notifications) — next phase; needs a direct-send
  path so the ID never sits in a plaintext outbox row (F13 Q14).
- `communities.membership_applications_enabled` and the application flow (F9) — not built.
- Members-only collection page, M9c, any payment-path change (M10), linking (M11), admin (A0 / `kolekto-admin`).
- Scheduling `purge_membership_validation_records()`.
- Client IP for rate limiting: the server must hash the trusted proxy's client address; the members-only page that
  would call validation does not exist yet, so this is still to wire and to confirm per deployment.

### F16.4 Findings during implementation

- **Reminders include suspended members.** `send_payment_reminders` excludes only archived and merged members
  (`20261117100500_payment_reminders.sql`). A suspended member with an existing unpaid obligation can still be
  reminded, but cannot be found in a new audience. Not changed (payment-reminder code is outside this phase); needs a
  decision.
- Archiving then restoring a suspended member clears the suspension record (documented in the migration).
- Collection audiences and announcements already exclude suspended members (they list `active`, `unclaimed`,
  `invited` only).
- Access grants are issued and resolved but **not yet consumed** by any payment code (by design for this phase).
- The member page's Identity card still labels `member_code` "Member ID", next to the new "Membership ID". F13 Q10
  recommended renaming it "Member number"; not changed in this phase.

## F17. Q9 review — `app.find_collection_member` (no behaviour changed)

**What it does.** Granted to `anon` and `authenticated` (`20260920170200`). On a managed collection it matches the
query by equality on the member code, a unique community attribute, phone, email, or two name parts, inside that
collection's audience. One match returns `member_id`, **full name**, **member code** and the identifying field; several
return only a count; none returns nothing.

**Who depends on it.** One caller: `findMemberAction` in `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts`,
used by `FindYourself.tsx` on every managed collection's public page. The returned name and code are shown so the
person can confirm "yes, this is me"; the member id goes into a server-side contributor-session cookie, which
`confirmMemberAction` and checkout use to name the member on the payment attempt. Every managed-collection payment today
depends on this path. pgTAP `14_contributor_identification.sql` pins the current output.

**The risk.** Member codes are often sequential (`KWASU/0001`, `KWASU/0002`). Anyone with the collection link can type
codes in turn and read back full names. The only brake is `lib/lookup-throttle.ts`: 12 searches a minute per process
and forwarded address, in memory — it resets on restart, is not shared between instances, and is bypassed with many
addresses.

**Proposed safe replacement (for approval; not built):**

1. Collections that switch to `member_verification = membership_id` (M9c) stop using the lookup: the member comes
   from a validated access grant, under the database rate limits of F16.1.
2. For collections that keep the lookup: return a **masked** name (`Ch*** N****`) and no member code; keep the
   confirmation step. The person still recognises themselves; a stranger walking codes learns much less.
3. Move the lookup's rate limit into the database (same shape as `membership_validation_attempts`) so it holds across
   instances and restarts.
4. Refuse a bare member code as the **only** query on collections whose community has membership IDs enabled.

Each step changes what contributors see, so each needs its own approval, a pgTAP update (`14_…`) and a browser check.
