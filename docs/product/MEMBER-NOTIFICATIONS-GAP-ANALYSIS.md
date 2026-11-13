# Community member notifications — architecture and gap analysis

**Date:** 2026-11-07
**Branch:** `m13.2-worker-hardening`
**Scope:** local code reading only. No database, remote environment or email provider was touched.
**Supersedes:** section C of `docs/INVESTIGATION-AUTH-MEMBERS-REMINDERS.md` (its recommendation to keep
the `user_id IS NOT NULL` filter as the only route to members is reversed by the product brief:
members are reached through their member record, not through an account).

---

## 1. How the system works today (verified against the code)

### Members vs. team

| Concept | Table(s) | Auth needed | Notes |
|---|---|---|---|
| Community member | `public.members` | No | `user_id` nullable; `members_claimed_consistently` ties it to `claimed_at`. Nothing in the code ever sets `user_id` (MEM-08 claim flow not built), so **every member is account-less today**. |
| Community team | `public.officer_terms` + `role_permissions` | Yes (`auth.users` → `public.users`) | `app.require_permission(community_id, permission)` gates every write. |

The two are already separate in the schema. The defect is only in the notification layer.

### Notification pipeline

```
domain fn → app.write_audit_log → audit_logs INSERT
  → trigger app.enqueue_notification_on_audit (c_watched list) → pgmq notification_events
  → worker processNotificationMessage (apps/worker/src/notification-processor.ts)
      · notification_events row (idempotent on event_key)
      · in-app notification_deliveries (recipient_user_id required)
      · email notification_deliveries for E1/E2/E4/E5 only (app.evaluate_email_eligibility)
  → worker sender (notification-sender.ts): claim → reserve (L1–L5 limits, suppression) → provider → settle
```

Delivery states already distinguish `pending` (queued), `sending` (leased), `sent` (provider accepted),
`delivered` (SES delivery event), `failed`/`dead` (stable `error_code`) and `skipped` (policy, stable code).
Queued is never reported as delivered by the database.

### Collection notifications

| Action (audit) | Trigger watches | In-app recipients | Email |
|---|---|---|---|
| `collection.publish` (publish, notify=all) | yes | audience ∩ `user_id IS NOT NULL` | **none** (`unsupported_event`) |
| `collection.publish_remind_unpaid` (notify=unpaid) | yes | audience ∩ obligation status unpaid/in_installments/overdue ∩ `user_id` | none |
| `collection.publish_silent` (notify=none) | no | — | — |
| `collection.remind` / `collection.remind_unpaid` | yes | as above | none |

Preview counts (`app.count_collection_publish_recipients`) also filter `user_id IS NOT NULL`.

## 2. Findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| G1 | **Member notifications require an account.** All collection recipients are filtered by `members.user_id IS NOT NULL`; since no flow sets `user_id`, every collection notification reaches **zero** members. | `notification-processor.ts` `resolveRecipients`; `20261029100100` count fn | Blocking (core requirement D) |
| G2 | **Collection events are excluded from email.** `app.evaluate_email_eligibility` returns `unsupported_event` for collection actions; the processor never evaluates email for them; no collection email templates exist. | `20261012100000`; `notification-eligibility.ts`; `notification-email-templates.ts` | Blocking |
| G3 | **Payment status cannot be established at all.** There is no contributions/payments table, the ledger has no writer, the public contribute action stores nothing ("payment is not open yet"), and **no code path ever moves an obligation to `paid` or `in_installments`**. `obligations.status = 'unpaid'` is the default and means "not exempt, not cancelled", not "has not paid". Cash/bank payments are not recordable. | `20260917120800` (ADR 0006 boundary, paid-guard trigger); `apps/web/app/[communitySlug]/[collectionSlug]/actions.ts` header; grep for writers | **Safety — the existing "unpaid" targeting can tell people who have paid that they still owe.** |
| G4 | **Consent is defined but never captured.** `members.consent_messages_at` (MEM-07/NOT-01a) is the gate for announcements and reminders per the schema comment and decision record §8, but no flow writes it and nothing checks it. | `20260917120500`; decision record §8 | Blocking for sending (correctly) |
| G5 | **Opt-out preferences exist but are not honoured.** `notification_preferences` (email_enabled, announcements_enabled, reminders_enabled, collection_updates_enabled) has no writer and no reader in the processor. | `20261007100000` | Must be honoured before send |
| G6 | **In-app collection links point to the officer dashboard** (`/c/{slug}/collections/{col}`), which members cannot use. `collection.remind` has no label or link at all. | `apps/web/lib/notification-display.ts` | Medium |
| G7 | **Members-only and scheduled collections have no member-reachable page.** `app.get_public_collection` serves only `public`/`unlisted` collections in `active`/`paused`/`closed`. The personal obligation link (`/o/{token}`, OBL-12) has a schema but no route. | `20260921190100` | Design gap — must not be "fixed" by widening the public route |
| G8 | **No "announce changes" path.** Published collections may change name/description/deadline (amounts are locked by `AMOUNTS_LOCKED`), but there is no explicit announcement action. | `app.update_collection` | Feature gap (requirement C) |
| G9 | **Bulk email is capped at zero.** The `bulk` send class exists for community communications but its L4/L5 caps are zero, so a bulk row defers until it ages out (72 h). Opening it is a reviewed operator migration. | `20261024200000`; sender quota runbook | Operational gate (intentional) |
| G10 | **The least-privilege worker role cannot read member contact or consent columns** (by design: addresses only flow through SECURITY DEFINER eligibility functions). Any new recipient logic must be a definer function plus a grant. | `scripts/itest/itest.mjs` `WORKER_ROLE_READS` | Constraint |
| G11 | **No unsubscribe link mechanism** (D-SUPPRESS). Address-level suppression (`email_suppressions`) is honoured by the sender for bounces/complaints only. | decision record §8 | Gap — documented |

## 3. What changes (this assignment)

1. **Stage 1 — member model.** Recipients for collection email are resolved from `members` (via a new
   SECURITY DEFINER function), not from accounts. Unsafe unpaid targeting is disabled in the worker
   (immediately, no migration needed), in the web validation/UI, and at the trigger (in the new migration).
2. **Stage 2 — publish announcement.** Publishing with "notify all members" now also produces one email
   delivery per eligible member (consent present, not opted out, usable address, collection reachable),
   and a `skipped` row with a stable reason for everyone else. Templates carry name, description excerpt,
   amount, deadline and the public link.
3. **Stage 3 — update announcement.** New explicit action `collection.announce_update` (organiser chooses
   the changed fields; never automatic on edit).
4. **Stage 4 — payment reminders.** **Not started** — blocked by G3. "Reminders" to all members (not
   payment-status targeted) keep working and gain email.

Consent capture (G4), opt-out UI (G5), member-access for members-only collections (G7) and bulk-cap
activation (G9) are documented as proposals, not built.

## 4. Proposals (not implemented)

* **Consent capture (G4).** Members record their own consent: a checkbox on the invite-link join form
  and on the public collection page after member self-identification, writing `consent_messages_at`
  through a SECURITY DEFINER function that records source and time; plus an audited, per-member officer
  attestation only if counsel approves it (D-LEGAL). Existing members are never back-filled.
* **Opt-out (G5/G11).** A signed, per-delivery unsubscribe token in every community email that sets
  `notification_preferences.email_enabled = false` (or the category flag) without sign-in.
* **Members-only access (G7).** Ship the OBL-12 personal link `/o/{token}`: hashed per-obligation token,
  per-member page scoped to that obligation, rate-limited lookup. Members-only announcements stay
  `skipped / collection_not_reachable` until it exists.
* **Payment attribution (G3).** Stage 4 needs: a contributions record tied to `obligation_id`, verified
  provider captures and officer-recorded offline payments both writing it, `amount_paid` derived per
  obligation, and obligation status derived from it. Only then can "not paid / partially paid / fully paid"
  be computed.
