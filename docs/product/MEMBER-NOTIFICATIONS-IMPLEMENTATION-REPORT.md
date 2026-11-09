# Community member notifications — implementation report

**Date:** 2026-11-07 · **Branch:** `m13.2-worker-hardening` · **Nothing committed, pushed, applied or sent.**
Companion to `MEMBER-NOTIFICATIONS-GAP-ANALYSIS.md` (findings G1–G11 referenced below).

## 1. What was wrong

* Collection notifications were addressed to **accounts**, not members: every recipient query required
  `members.user_id IS NOT NULL`, and no flow ever sets `user_id`, so every announcement reached zero members (G1).
* Collection events were excluded from email entirely, with no templates (G2).
* "Members who still owe payment" targeting treated `obligations.status = 'unpaid'` as payment status. Nothing
  records payments and nothing ever sets an obligation to `paid`, so that cohort included people who had paid (G3).
* In-app collection links opened the officer-only dashboard (`/c/{slug}/collections/{col}`) (G6).

## 2. How members are now resolved

`app.evaluate_collection_email_recipients(collection, category)` (proposal, SECURITY DEFINER, worker-only) returns
one row per audience member with either an address + assurance or a stable skip reason. It reads the member
record; it needs no `auth.users` row, profile, session or app install.

| Check (in order) | Skip reason |
|---|---|
| Collection page openable without an account (public/unlisted; active/paused/closed; community active) | `collection_not_reachable` |
| Member archived/merged | `member_unavailable` |
| `members.consent_messages_at` set | `consent_missing` |
| `notification_preferences.email_enabled` / category flag not `false` | `opted_out` |
| No account: `members.email` present and plausible (`app.email_address_usable`) | `no_recipient` / `invalid_recipient_address` |
| Has account: confirmed `auth.users.email` only (existing Q-FALLBACK rule) | `unverified_account_email` |

Audience = the collection's own audience; for an open (public-audience) collection, every current member.
The worker writes one `notification_deliveries` row per member (`pending` with address, or `skipped` with code and
no address), `send_class = 'bulk'`, idempotent on the existing per-(event, member, channel) unique index.

## 3. Separation of members and team

No change to `officer_terms`, roles, permissions or auth. Officers authorise sends through
`app.require_permission(..., 'collection.publish')`; members are only ever recipients.

## 4. Stages

| Stage | Status |
|---|---|
| 1 Member model | Worker resolves collection email from member records (via proposal function, feature-detected). Unpaid targeting disabled now in worker (no in-app or email deliveries), web validation and UI. |
| 2 Publish announcement | "Announce to all members" on publish → in-app (account holders) + email per eligible member. Templates: name, description excerpt, fixed amount (`formatNaira`), deadline (Africa/Lagos), CTA, public link, "no account needed", opt-out line. |
| 3 Update announcement | "Announce changes" dialog on live collections; organiser picks changes from a fixed list; `app.announce_collection_update` (proposal) audits `collection.announce_update`; worker handles plan/key/payload/template. **Activated only when the proposal is applied** (trigger + one line in `WATCHED_ACTIONS`, kept in parity by `scripts/invariants`). Edits never notify by themselves. |
| 4 Payment reminders | **Not started — blocked (G3).** "Send reminder" now sends a neutral reminder to all members and never claims anyone owes money. |

## 5. Consent and opt-out

> **Superseded (M13.3 R1, 2026-11-07):** consent is no longer a requirement for community
> operational email. The worker now applies the central communication policy
> (`apps/worker/src/communication-policy.ts`): opt-out and a community notice attestation instead of
> consent. See `M13.3-COMMUNITY-NOTIFICATIONS-ARCHITECTURE-REVIEW.md` and
> `M13.3-R1-COMMUNICATION-POLICY-IMPLEMENTATION.md`. The text below describes the M13.2 design.

Consent is required for every collection email and is never written or back-filled; `NULL` is never consent.
Because no flow captures consent today, **no member will actually be emailed until a consent-capture flow exists**
(proposal in the gap analysis §4). Opt-out preferences are honoured, but nothing writes them yet; emails tell
members to contact the organisers to stop.

## 6. Links and access

Emails and in-app items link to `/{community}/{collection}`. Members-only and not-yet-started collections are
skipped (`collection_not_reachable`) rather than linking to a page that needs an account; the public route is
unchanged. Members-only access needs the OBL-12 personal link (design in gap analysis §4).

## 7. Operational gates still closed (by design)

`email_sending_enabled` off; bulk L4/L5 caps zero (bulk rows defer, expire at 72 h); no provider activated; worker
not deployed; proposal not applied; worker role not granted the two new functions.

## 8. To activate (each needs its own approval)

1. Apply `docs/database/proposals/MEMBER-ANNOUNCEMENTS.proposed.sql` as a migration (local → staging → production),
   move its test to `supabase/tests/49_…`, and add `collection.announce_update` to `WATCHED_ACTIONS` in the same change.
2. Grant the worker role EXECUTE on `app.collection_announcement_context(uuid)` and
   `app.evaluate_collection_email_recipients(uuid, text)`.
3. Build consent capture (and an unsubscribe link).
4. Decide bulk caps in a reviewed migration; then the existing release gates for email.
