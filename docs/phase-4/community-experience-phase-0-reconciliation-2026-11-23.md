# Community experience — Phase 0 reconciliation and implementation plan

**Date:** 2026-11-23 (session 47). **Status:** read-only reconciliation. No code, migration, test, database row,
commit or push was made in this phase. The only files written are this report and the status doc's "Latest report".
**Brief:** owner directive "Kolekto — Consolidated Engineering Review, Product Improvements and Implementation
Directive" (Parts A–L), 2026-11-23.
**Environment inspected:** itest only (local Docker stack `kolekto-itest`, database on `127.0.0.1:55422`), read in a
`begin transaction read only … rollback` block. Dev, staging and production were not touched.

---

## 1. Executive summary

The M9a/M9b membership foundation is on itest and matches the session 46 report in substance. There are six findings
that the owner should see before Phase A starts:

1. **Two of the seven itest membership IDs cannot be recovered.** The design erased the ciphertext on replace and
   revoke. Only their HMAC hash is left. The five live IDs can be recovered with the itest secret. (§3.1, decision D1)
2. **The previous report under-counted the permission changes.** There were three grants and two removals, and the
   `invite.approve` grant to the `viewer` officer of `demo-unilag-alumni` is **still active**. (§3.2)
3. **itest has no managed collection.** All four collections are `audience_mode = public`. Journeys 3 and 4 need new
   managed collections in a disposable test community. (§3.3)
4. **"Members only" is ambiguous in the code.** The brief's "Members only" maps to the existing managed audience
   (`all_members` and the others). It is a different thing from the `members_only` *visibility* value, which hides
   the page and is the value Phase 2a disabled. (§6.1, decision D3)
5. **`find_collection_member` exposes more than member codes.** It also matches on email, on a phone-number suffix of
   7 or more digits, and on two name parts. Each of these returns the full name and member code to an anonymous
   caller. (§4, decision D4)
6. **The existing "member added" email already labels the member number as "Your community member ID"**, so it will
   be confused with the new membership ID. (§5.1)

There is no conflict with a money invariant so far. The payment-path work (Phase F) is the only phase that touches
`create_payment_attempt` and `complete_payment_capture`, and it is scoped by the existing design document.

---

## 2. Working tree (preserved, not touched)

Branch `feat/payment-receipts-alarms`. 34 modified and 30 untracked paths from sessions 43d–46, none committed. Every
file listed below is part of that uncommitted work. Nothing in this phase changed any of it.

| Area | Files |
|---|---|
| Migrations (itest only) | `20261122120000_community_home_and_overview`, `20261122130000_profile_avatars`, `20261122140000_public_community_page`, `20261123100000_member_status_suspended` (M9a), `20261123100100_membership_foundation` (M9b) |
| pgTAP | new `73`–`76`; modified `01_rls_coverage`, `02_grant_matrix`, `03_money_invariants`, `27_truncate_guards` |
| DB package | `packages/db/src/membership.ts` (new), `write.ts`, `public-read.ts`, `types.ts`, `index.ts`, `community-overview.ts` |
| Web — membership | `lib/membership-id.ts`, `lib/membership-id-server.ts`, `lib/membership-id.test.ts`, `members/membership-actions.ts`, `members/[memberId]/MembershipPanel.tsx`, `settings/MembershipIdSettingsCard.tsx`, `settings/OfficerPermissionsCard.tsx`, `settings/PublicPageControl.tsx`, `settings/page.tsx` |
| Config | `packages/config/src/env.ts` (`loadMembershipIdSecret`), `.claude/launch.json` (`kolekto-web-itest` reads `.claude/itest-membership-secret.local`, 43 bytes, git-ignored) |

> `03_money_invariants.sql` already differs from `HEAD` (session 43d): one function name,
> `community_collection_figures`, was added to the allowlist of the "no function other than capture sets an
> obligation to paid" assertion, with a dated comment saying it is a STABLE read. The assertion itself is unchanged.
> The owner should know about it because Part F8 says this file must stay unchanged. Phases A–F will not edit it.

---

## 3. itest database state (read-only queries, 2026-11-23)

Latest applied migrations: `20261123100100`, `20261123100000`, `20261122140000`, `20261122130000`,
`20261122120000`, `20261122100000`.

### 3.1 Membership IDs — 7 rows, all in `demo-unilag-alumni` (format `UAL` `/` 5, enabled)

| Masked | Ciphertext present | Revoked | Reason | Recoverable to plaintext |
|---|---|---|---|---|
| UAL/…YM | no | yes | itest verification: rotate | **No.** Only the HMAC hash remains. |
| UAL/…E4 | yes | no | — | Yes (itest secret) |
| UAL/…ZQ | yes | no | — | Yes |
| UAL/…MT | yes | no | — | Yes |
| UAL/…Y8 | yes | no | — | Yes |
| UAL/…3F | no | yes | itest verification: revoke | **No.** Only the HMAC hash remains. |
| UAL/…6Z | yes | no | — | Yes |

Sequence (from the audit rows: issue 6, rotate 1, revoke 1): bulk issue of 5 → YM replaced by 3F → 3F revoked → 6Z
issued. So there are 5 live IDs held by 5 members, which matches session 46.

Why two cannot be recovered: `rotate_membership_id` and `revoke_membership_id` set `id_ciphertext = null`, and the
trigger `guard_membership_id_row` requires it (`new.id_ciphertext is not null` → exception). This was intentional
under the encrypted design. The brief says to stop and report if any ID cannot be recovered. **This is that report.**
These two IDs are revoked, so nobody needs to *use* them. Their only remaining job is "never reissue", which today is
enforced by the hash unique index. See decision D1.

### 3.2 Other membership data written in session 46

- Officer permission grants on the `viewer` term of `demo-unilag-alumni`:
  `membership.issue_ids` granted then revoked (twice), and **`invite.approve` granted 15:47:18 and never revoked**.
  The audit log has 3 grant rows and 2 revoke rows, which is consistent. Session 46 reported "one permission grant +
  revoke", which is inaccurate. I have not changed the active grant. Removing it would write to demo data, so it
  waits for the owner (D9).
- One suspend and one reinstate, plus one `membership.update_id_settings`.
- `membership_validation_attempts`: 5 rows, all `collection_unavailable`. `membership_access_grants`: 0.
- Audit payload check: there are 0 membership audit rows whose before/after state contains a full-ID-shaped string.
- `notification_events` with `event_type like 'member.%'`: **0**. Either no member was created since the itest
  rebuild, or the trigger routing is not producing events on itest. To be verified in Phase E.

### 3.3 Collections and members

- Collections: 4 in total, all `audience_mode = public` (1 `public` visibility, 3 `unlisted`), all
  `allow_non_members = false`. **No managed collection exists on itest.** The §7 pre-check in the payment design
  ("count managed collections with allow_non_members = true; expected 0") passes: there are 0.
- Members in `demo-unilag-alumni`: active 3, unclaimed 2, pending_approval 1, archived 1. Their `member_code` values
  are empty.
- Officers (active terms): unilag-alumni owner + viewer; ikoyi-estate owner + collector; amaka-space owner.
- Roles: `kolekto_itest`, `kolekto_itest_worker`, `kolekto_importer` exist. The web DB client switches to
  `anon`/`authenticated` per transaction (`packages/db/src/client.ts:80-83`).

---

## 4. `app.find_collection_member` — what anonymous callers get today

Source: `20260920170000_contributor_identification.sql:69`. Granted to `anon, authenticated`
(`20260920170200`). It is gated by `collection_accepts_identification`: the collection must be active or paused,
visibility public or unlisted, `audience_mode <> 'public'`, and the community active.

**Matching (any one of these):** exact member code; exact unique attribute value; **phone digits suffix**
(`like '%' || digits`, at least 7 digits, leading 0 dropped); exact email; exact full name; or two or more name
parts, each a prefix of a stored name part.

**Returned for exactly one match:** `member_id`, **full name**, **member code**, primary identifier label and
**value**. Several matches return a count; no match returns nothing.

**One caller:** `findMemberAction` (`apps/web/app/[communitySlug]/[collectionSlug]/actions.ts:181`), used by
`FindYourself.tsx`. It stores `member_id` in the server-side httpOnly contributor-session cookie, and checkout reads
that cookie. **Every managed-collection payment today depends on this path.**

**Rate limit:** `apps/web/lib/lookup-throttle.ts`, 12 per minute per process, keyed on `x-forwarded-for`. It is held
in memory, resets on restart and is not shared between instances. Because the key is a client-supplied header, it can
also be bypassed by sending a different header value on each request.

**Exposure:** an anonymous person with a collection link can (a) walk sequential member codes, (b) confirm whether an
email address belongs to the community and learn the person's full name, and (c) confirm a phone number from its last
7 digits. On itest the exposure is currently zero, because there are no managed collections.

Tests pinning current behaviour: `supabase/tests/14_contributor_identification.sql` (plan 35). It is outside the
40–72 payment band, but changing it changes contributor-visible behaviour.

---

## 5. Notifications

### 5.1 What exists

- **Governed pipeline:** a `notification_events` row (idempotent on `event_key`) is created from audit rows by the
  notification trigger. The worker (`apps/worker/src/notification-*.ts`) then decides eligibility
  (`communication-policy.ts`), applies the dedupe key, rate limits, claims the send, renders and sends through the
  `EmailProvider` adapter (SES, Mailpit or fake), and records the result. Delivery statuses are `pending`, `sending`,
  `sent`, `delivered`, `failed`, `skipped` and `dead`.
- **Event 1 already exists:** `member.create` and `member.approve_join` render `renderMembershipConfirmation`
  ("You have been added to X"), with dedupe key `membership_confirmation:{member_id}`. Its payload includes
  `member_code`, rendered as **"Your community member ID is: …"**. That copy has to change to "member number" to keep
  it distinct from the new membership ID (B6).
- **Precedent for sending a secret safely:** `withdrawal-otp-delivery.ts`. The worker claims a reference, produces the
  secret value only in memory at delivery time, sends it, records the outcome, and logs counts only. Membership-ID
  delivery can follow this pattern exactly.
- `member.issue_membership_id` audit rows exist, but **no notification routing** reads them yet.

### 5.2 WhatsApp

- Present: the `whatsapp` channel enum value, a `whatsapp_permission` consent fact, and policy rows (opt-in only;
  payment-status WhatsApp `disabled: payment_attribution_unavailable`). `notification_preferences.whatsapp_enabled`
  exists.
- **Absent:** any WhatsApp provider adapter (`packages/adapters/src` has email, payment, transfer and settlement
  only), credentials, approved templates, delivery webhooks and cost data.
- **Conclusion:** WhatsApp is **blocked by an external integration**. Per Part J.17, I will prepare a provider
  recommendation for approval and will not build or configure anything.

---

## 6. Collections and the payment path

### 6.1 Today's model, and how the brief's three options map onto it

| Field | Values | Meaning today |
|---|---|---|
| `participation_mode` | `open` / `managed` | paired with audience by a constraint |
| `audience_mode` | `public` / `all_members` / `groups` / `selected_members` | who is expected to pay |
| `visibility` | `public` / `unlisted` / `members_only` | who can open the page; `members_only` is refused in `createCollectionAction` and `updateCollection` (Phase 2a) and makes the page 404 |
| `allow_non_members` | bool, default false | stored; **not read by any payment code**; not exposed in the wizard |
| `amount_model` | `fixed` / `open_amount` / `tiers` / `per_member` / `items` | independent of audience |

The proposed mapping (decision D3):

- **Everyone** = `audience_mode = public` (today's open collection). No change.
- **Community members only** = managed `all_members` (also `groups`/`selected_members` as today), with
  `allow_non_members = false`. This is what managed collections already are. What is new is the verification method
  (`member_verification`: `lookup` / `membership_id`).
- **Members and non-members** = managed **`all_members` only**, with `allow_non_members = true`.
- The `members_only` **visibility** value is a separate feature (hide the page from non-members). It stays disabled
  in this phase.

Collection creation is a flow-based wizard (`collections/new/NewCollectionForm.tsx`, 1,312 lines, with `flows.ts`).
The type picker sets `participation_mode`, and `audienceMode` is a step. The audience choice and the amount choice
are already separate steps. The work is to add the guest switch and the verification choice to the audience step, and
to block the combination of guests with `per_member`.

### 6.2 Payment path

The design in `non-member-contributions-payment-path-design-2026-11-22.md` still matches the code (I re-checked the
§1 table). The owner's brief now answers all four §8 questions: `needs_review` with `member_ineligible_at_capture`;
guests refused on `per_member`; "Paid as a guest" on the receipt; `all_members` only. **Open point:** the `items`
amount model is not covered by the brief (D7).

Reports that join contributions or attempts to `members` already use `left join`: contributor register
(`20261116130000:320`), payment activity (`20261117130000:157`) and community overview (`20261122120000:335`). The
reminders roster joins the audience (`20261117100500:190,537`), and guests never appear in an audience. The
expected-vs-collected summary and the member history still need checking with guest rows in Phase F.

---

## 7. Team and Settings (current information architecture)

- `/c/[slug]/settings` renders **Public Page, Membership IDs and Officer Permissions as three cards ABOVE the
  "Settings" heading and its tabs** (`settings/page.tsx:143-160`). This is why Public Page looks "too high".
- The tabs are **Profile**, **Team** and **Notifications** (Notifications appears only with the notice permission).
  **Team is a tab inside Settings**; there is no separate Team route. The sidebar has Overview, Collections, Members,
  Activity and Settings.
- `OfficerPermissionsCard` uses **one officer dropdown and one permission dropdown**, so it grants one permission at a
  time.
- **The real permission catalogue (backend):**
  - Delegable (6): `membership.configure_ids`, `membership.issue_ids` (one key covers **issue, replace and revoke**),
    `member.suspend`, `member.create`, `member.edit`, `invite.approve`.
  - Owner-only, not delegable: `officer.delegate`, every money permission, every officer and ownership permission,
    and everything else.
  - Overlap: `admin` and `treasurer` already hold `member.create`, `member.edit` and `invite.approve`, so granting
    those to them is redundant. The UI should show them as "included in role".
  - `collector` holds `member.create`/`member.edit` *scoped*. A delegated grant goes through `has_permission`, which
    does not check scope, so a delegated `member.create` would widen a collector's reach to the whole community
    (D6).
- **Who can see a full membership ID today:** anyone with `member.view_contact`. That includes `viewer` and `collector`
  (scoped) by role (D5).

---

## 8. Reuse, redesign and migration

| Item | Verdict |
|---|---|
| Suffix generation, canonicalisation, prefix rules (`lib/membership-id.ts`) | **Reuse** |
| Settings table, issue/rotate/revoke/suspend/reinstate SQL, audit shapes, grants, access-grant table, validation rate-limit table | **Reuse**; change only the parameters that carry hash or ciphertext |
| HMAC lookup + AES-GCM ciphertext (`id_hash`, `id_ciphertext`, `key_version`) | **Redesign** to plaintext (A1). Needs a new migration (M9b2) that rewrites function signatures and the guard trigger. |
| `hashClientAddress` uses the membership secret | **Keep a server secret for IP hashing.** An unkeyed SHA-256 of an IPv4 address can be reversed by trying all 4 billion addresses. The secret is renamed in docs to "rate-limit key". |
| `lookup-throttle.ts` | **Replace** with a DB-backed limiter (new attempts table, the same shape as `membership_validation_attempts`) |
| `find_collection_member` | **Change output** (decision D4) behind a new limited wrapper; update test 14 |
| Member-added email | **Reuse**; fix the copy; teach it to include a live ID fetched at delivery time |
| Settings page layout and `OfficerPermissionsCard` | **Redesign** (move into Team, multi-select) |
| Payment functions | **Change per the design** (M9c, M10) in Phase F only |

---

## 9. Decisions needed before or during Phase A

| # | Question | Recommendation |
|---|---|---|
| **D1** | The two revoked itest IDs (UAL/…YM, UAL/…3F) cannot be turned back into plaintext. How should "never reissue" hold for them? | **A:** keep the old `id_hash` column, nullable, filled only on legacy rows. When a new ID is generated, the server also checks its HMAC against those legacy hashes while the itest secret exists. All new rows store plaintext only, and **revocation no longer erases the plaintext**, so a single unique index on `(community_id, canonical_id)` covers every row from then on. **B:** drop the hashes and accept a chance of about 1 in 33.5 million per issuance of matching one of the two old IDs (5-character suffix). A is safer; B is simpler. This only affects itest, because M9b has never been applied anywhere else. |
| **D2** | Should revoked and replaced IDs keep their plaintext in the database (not displayed, only used for uniqueness)? | **Yes.** It is the simplest guarantee of "never reissued". The UI shows only the masked form for history rows. |
| **D3** | Is the §6.1 mapping right ("Members only" = managed audience; `members_only` visibility stays disabled)? | **Yes.** |
| **D4** | What should anonymous lookup return on `lookup` collections? | (a) For one match, return a **masked name** (`Ch*** N****`) and **no** member code or identifier value, and keep the "yes, this is me" step. (b) Remove the **phone-suffix** match and require the full number. (c) Use the DB-backed limiter: 10 failures or 30 attempts per 15 min per keyed IP, 200 failures per hour per collection, 1,000 per day per community (the same figures as membership-ID validation). (d) When a community has IDs on, offer "use your membership ID" first. I do **not** recommend an OTP step now: it needs email or WhatsApp delivery to anonymous visitors, adds friction to every payment, and would be the first anonymous-triggered email. |
| **D5** | Who may see a member's **full** ID? | Keep `member.view_contact` (which includes viewers and collectors in scope), or narrow it to `membership.issue_ids`. **Recommend narrowing** to `membership.issue_ids`, plus the owner. Everyone else sees the masked form. |
| **D6** | Delegating a scoped permission to a collector widens its scope. Should that be allowed? | **Block** delegating `member.create` and `member.edit` to `collector` terms until scope-aware grants exist. |
| **D7** | `items` amount model and guests? | Allow, the same as `fixed` and `tiers` (the price comes from the items, not from a member). |
| **D8** | Does "replace" and "revoke" need separate permissions from "issue"? | No new keys this phase (Part D2 says do not invent permissions). Show it as one checkbox: "Issue, replace and revoke membership IDs". |
| **D9** | The active `invite.approve` grant on the unilag `viewer` officer from session 46: leave it or remove it? | **Leave it** (demo data, Part A4). Use disposable officers for testing. |

---

## 10. Implementation plan (each phase stops for a report)

**Test fixture plan (all phases):** create one disposable itest community, `qa-membership-2026-11` (an owner
account, plus officers: plain, one grant, several grants, revoked), with its own members and managed collections
(`fixed`, `tiers`, `per_member`, `open_amount`). The demo communities are not modified. Every row written is listed
in the phase report.

**Phase A — storage correction + enumeration (itest).**
1. Migration `M9b2`: add `membership_id text` and `canonical_id text` (with a unique index on
   `(community_id, canonical_id)`), make `id_hash` nullable (legacy only, per D1), and drop `id_ciphertext` and
   `key_version` after the backfill. Rewrite the guard trigger so revocation no longer erases the value.
   Re-create issue, rotate, revoke and get with plaintext parameters, and change `validate_membership_id` to take a
   canonical ID. Audit keeps the masked form only.
2. One-off backfill on itest: a Node script decrypts the five live rows with the itest secret, inside a single
   transaction with a *per-row* guarded update. I will report its exact SQL before running it. Rows are verified by
   comparing the decrypted ID's HMAC with the stored `id_hash` before writing.
3. Lookup: a new `member_lookup_attempts` table and `app.find_collection_member_limited(collection, query, ip_hash)`.
   `anon` loses EXECUTE on the old function. The output changes according to D4.
4. Tests: rewrite 75 and 76 for plaintext; add 77 (enumeration and limits). Update 14, 02 and 01 with dated
   comments. Run the full pgTAP suite, tsc, vitest and eslint.

**Phase B — member page.** Restructure `MemberDetailClient` and `MembershipPanel` into a "Member information" section
and a "Membership ID" section, using the existing card and row patterns. Copy, issue, replace and revoke get
confirmations, with status chips (Active / Suspended — not valid / Revoked). The member number and the membership ID
are labelled separately.

**Phase C — Team + permissions.** Move `OfficerPermissionsCard` into the Team tab as a per-officer panel with
grouped checkboxes ("included in role" shown and disabled). Saving sends a diff, and each grant or revoke goes
through the existing audited functions in one server action. Owner-only enforcement stays in SQL. Browser test with
the five disposable accounts, plus direct server-action calls from a refused account.

**Phase D — Settings IA.** Order the tabs **General · Membership · Public page · Notifications · Team**. Move the
three floating cards into their tabs. The Security/verification content stays on `/verification` with a link from
General (no duplication). No change to public-page behaviour.

**Phase E — notifications.** Route `member.issue_membership_id` to a new `membership_id.issued` event whose payload
carries only `membership_id_id` and the masked form. Add a worker-only function
`app.claim_membership_id_for_delivery(delivery_id)`, granted to `kolekto_itest_worker` only and audited without the
ID. It returns the live plaintext only if the row is still live and belongs to the recipient. If a member is added
and given an ID within the same pending window, the welcome email fetches the live ID at send time and the separate
"ID issued" email is skipped (dedupe key `membership_id_issued:{membership_id_id}`). Fix the "member ID" copy.
Surface delivery status on the member page. WhatsApp gets a recommendation document only.

**Phase F — collections + payments.** M9c (`member_verification`, `max_contributions_per_member`) and M10 (payer
basis + snapshot columns on attempts and contributions, the new error codes and review reasons, the guest path),
exactly as in the design doc. First, diff `03_money_invariants.sql` and add characterization tests. Payment files
40–72 must pass unchanged. Add the two-connection concurrency test. Then the wizard's audience step and the checkout
UI.

**Phase G — end-to-end.** Journeys 1–5 on desktop, tablet and mobile, then the final report under the Part L
headings.

**Not in scope (recorded):** reminders to suspended members (F16.4, A5); OTP verification; `groups`/`selected_members`
with guests; the `members_only` visibility value; anything on dev, staging or production.

---

## 11. What was and was not verified in Phase 0

- Verified by reading: M9a, M9b, membership web code, `find_collection_member` and its caller, the permission
  catalogue, the Settings and Team code, the wizard fields, the payment design doc, the notification worker, the OTP
  delivery and the WhatsApp references.
- Verified by read-only SQL on itest: the migration list, the ID rows, settings, grants, collections, attempts, audit
  counts, the audit leak check, roles and member statuses.
- **Not re-run:** pgTAP, tsc, vitest, eslint and the browser checks. The session 46 counts are quoted, not
  re-measured. No ID was decrypted in this phase.
