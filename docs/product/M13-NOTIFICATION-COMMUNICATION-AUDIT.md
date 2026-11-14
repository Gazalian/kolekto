# M13 — Notification & Communication Infrastructure

## Full Architecture Audit & Implementation Plan

**Date:** 2026-10-07
**Scope:** Read-only audit of the existing Kolekto codebase. Zero code changes.
**Purpose:** Produce an implementation-ready reference so a second engineering agent can build M13.1 without rediscovering the architecture.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Map](#2-current-architecture-map)
3. [Existing Communication Infrastructure](#3-existing-communication-infrastructure)
4. [Current Collection Publish Flow](#4-current-collection-publish-flow)
5. [Current Membership Flow](#5-current-membership-flow)
6. [Current Payment Architecture (Integration Points)](#6-current-payment-architecture)
7. [Proposed Event Taxonomy](#7-proposed-event-taxonomy)
8. [Proposed Data Model](#8-proposed-data-model)
9. [Security Model](#9-security-model)
10. [M13 Phasing](#10-m13-phasing)
11. [M13.1 Implementation Recommendation](#11-m131-implementation-recommendation)
12. [Implementation Boundary](#12-implementation-boundary)
13. [Verification](#13-verification)

---

## 1. Executive Summary

Kolekto has **zero notification infrastructure** today. Every email the system sends is a Supabase Auth transactional email (OTP sign-in, password recovery). There is no in-app notification bell, no announcement system, no payment receipt delivery, no reminder engine, and no WhatsApp/SMS integration. The `apps/worker` package exists as an empty scaffold; `pgmq`, `pg_cron`, and `pg_net` extensions are already installed but unwired.

**What exists and is reusable:**

| Asset | Location | Reuse for M13 |
|---|---|---|
| `pgmq` extension | `supabase/migrations/20260917120000_extensions_and_schemas.sql:36` | Message queue backbone |
| `pg_cron` extension | Same file, line 34 | Scheduled job triggers |
| `pg_net` extension | Same file, line 35 | HTTP callouts from Postgres |
| `apps/worker` scaffold | `apps/worker/src/index.ts` | Queue consumer process |
| Audit log pattern | `supabase/migrations/20260917120900_audit_log.sql` | Append-only notification event log |
| Financial event processing | `supabase/migrations/20260924160000_financial_event_processing.sql` | Delivery attempt tracking pattern |
| Financial idempotency | `supabase/migrations/20260924120000_financial_idempotency.sql` | Notification deduplication pattern |
| Collection audience resolution | `supabase/migrations/20260920150000_collection_audience.sql` — `app.resolve_collection_audience()` | Recipient resolution for collection-scoped notifications |
| Permission catalogue | `supabase/migrations/20260917120400_roles_and_officers.sql` — `announcement.send`, `reminder.send` already defined | Authorization gates for sending |
| Member consent tracking | `supabase/migrations/20260917120500_members.sql:44-47` — `consent_messages_at` column | Consent gate for outbound messages |
| Member contacts | Same migration — `member_contacts` table with `receives_notices` flag | Estate-unit contact delivery |
| Environment vars | `.env.example:82-89` — `WHATSAPP_PROVIDER`, `SMS_PROVIDER`, `EMAIL_PROVIDER` placeholders | Provider config scaffolding |
| CallerContext pattern | `packages/db/src/client.ts` | Secure notification writes |
| `app.uuid_generate_v7()` | `supabase/migrations/20260917120000_extensions_and_schemas.sql:48-75` | Time-ordered notification IDs |
| `app.write_audit_log()` | `supabase/migrations/20260917120900_audit_log.sql` | Audit trail for notification actions |

**What is completely missing:**

- Notification tables (events, deliveries, preferences, templates)
- In-app notification UI (bell icon, notification centre, read/unread state)
- Email sending capability (beyond Supabase Auth)
- Background job processing (worker is a stub)
- Template system for any channel
- Notification preferences (per-member, per-community, per-channel)
- WhatsApp/SMS integration
- Queue wiring (pgmq queues not created, worker not consuming)
- Announcement/broadcast feature
- Payment reminder engine
- Receipt delivery

---

## 2. Current Architecture Map

### 2.1 Entity Relationships Relevant to Notifications

```
auth.users ──1:1──> public.users
                        │
                        ├──1:N──> officer_terms (time-bounded, has role)
                        │              │
                        │              └── role_permissions (32 permissions incl. announcement.send, reminder.send)
                        │
                        └──1:N──> members.user_id (claimed link, nullable)
                                    │
     communities ──1:N──────────────┤ members (community_id + full_name + phone_e164 + email + consent_messages_at)
         │                          │
         │                          ├──N:M──> member_group_memberships ──> member_groups
         │                          │
         │                          ├──1:N──> member_contacts (receives_notices flag)
         │                          │
         │                          └──1:N──> obligations (per collection, per cycle)
         │
         └──1:N──> collections
                       │
                       ├── collection_audience_groups (audience_mode: all_members/groups/selected_members/public)
                       │
                       ├── collection_tiers
                       │
                       └── published_by / published_at (set on publish transition)
```

### 2.2 Key Architectural Constraints (from ADRs)

| ADR | Constraint | M13 Impact |
|---|---|---|
| 0004 | Community is root aggregate; `community_id` on every row, no `user_id` on financial tables | Every notification table MUST have `community_id`. Recipient is a member, not a user. |
| 0005 | NO Supabase Edge Functions. Webhooks = route handlers in `apps/web`. Background work in `apps/worker`. | Notification delivery runs in `apps/worker`, NOT edge functions. Cron triggers via `pg_cron` → `pg_net` → route handler. |
| 0008 | Authorization via `officer_terms` + `has_permission()`, never user-editable data | Sending notifications gated by `announcement.send` / `reminder.send` permissions. |
| 0009 | Staff realm separation | Staff-only notification data (delivery errors, provider payloads) not client-readable. |
| 0011 | Application writes via direct Postgres connection (`SUPABASE_DB_URL`) | Notification writes go through `app.*` SECURITY DEFINER functions via `packages/db/src/write.ts`. |

### 2.3 Schema Topology

```
public schema   — tenant data, RLS-enforced, PostgREST-exposed
app schema      — SECURITY DEFINER functions, NOT PostgREST-exposed
private schema  — operational views, staff-only reads
extensions      — pgcrypto, citext, pg_trgm, pg_net, pgmq, pgtap
pg_cron         — installed in its own schema (default: cron)
```

---

## 3. Existing Communication Infrastructure

### 3.1 What Actually Sends Messages Today

| What | Channel | Mechanism | Location |
|---|---|---|---|
| Sign-in OTP | Email | Supabase Auth (GoTrue) | `supabase/config.toml:114-120` → `supabase/templates/otp.html` |
| Password recovery | Email | Supabase Auth (GoTrue) | `supabase/config.toml:122-124` → `supabase/templates/recovery.html` |
| SMS OTP (configured, no provider) | SMS | Supabase Auth | `supabase/config.toml:126-143` — no SMS provider wired |

**That is the complete list.** There are exactly two email templates (`otp.html`, `recovery.html`), both owned by Supabase Auth. The application has NO mechanism to send email, SMS, or WhatsApp messages of its own.

### 3.2 Email Templates

Only two templates exist in `supabase/templates/`:
- `otp.html` — shared by confirmation and magic_link auth flows
- `recovery.html` — password reset

Both are Supabase Auth templates using `{{ .ConfirmationURL }}` / `{{ .Token }}` syntax. They are NOT application-controllable templates.

### 3.3 Supabase Local SMTP

`supabase/config.toml:41-43`:
```toml
[local_smtp]
enabled = true
port = 54324
```
This is Mailpit for local development email capture. Not a production email service.

### 3.4 In-App Notification UI

**None.** The `AppShell` component (`apps/web/components/AppShell.tsx`) contains:
- Desktop sidebar with nav items: Overview, Collections, Members, Activity, Settings
- Mobile header with hamburger menu
- `UserFooter` with account link and sign-out

There is **no notification bell**, no badge, no inbox, no toast system, no unread counter. The `Activity` page (`apps/web/app/c/[slug]/activity/page.tsx`) displays the audit log (a history of actions), not notifications.

### 3.5 Background Processing Infrastructure

| Component | Status | Location |
|---|---|---|
| `pgmq` extension | **Installed**, zero queues created | `20260917120000_extensions_and_schemas.sql:36` |
| `pg_cron` extension | **Installed**, zero jobs scheduled | Same file, line 34 |
| `pg_net` extension | **Installed**, zero HTTP calls configured | Same file, line 35 |
| `apps/worker` package | **Exists as empty scaffold** | `apps/worker/src/index.ts` — prints "no queues wired up" and exits |
| Worker dependencies | `@kolekto/config`, `@kolekto/db`, `@kolekto/domain` | `apps/worker/package.json` |
| Worker build | TypeScript, compiles to `dist/` | `apps/worker/tsconfig.json` |

The worker explicitly references `pgmq` in its description: "background work (reminders, recurring collection cycles, reconciliation jobs) runs against `pgmq`."

### 3.6 Existing Event/Audit Mechanisms

**Audit log** (`supabase/migrations/20260917120900_audit_log.sql`):
- Table: `public.audit_logs`
- Columns: `community_id`, `actor_type` (officer/member/contributor/staff/system), `actor_user_id`, `actor_name_snapshot`, `actor_role`, `action` (format: `domain.verb`), `object_type`, `object_id`, `before_state`, `after_state`, `reason`
- Written by: `app.write_audit_log()` SECURITY DEFINER function
- Append-only (UPDATE/DELETE blocked by trigger AND privilege revocation)
- Every `app.*` write function calls `app.write_audit_log()` at the end of its transaction

The audit log is the **closest existing pattern** to a notification event log. Every significant domain action already produces an audit log entry with structured `action` names:
- `collection.create`, `collection.publish`, `collection.pause`, `collection.close`, `collection.archive`
- `member.create`, `member.approve`, `member.reject`, `member.archive`, `member.restore`
- `officer.invite`, `officer.accept`, `officer.end_term`
- `invite_link.create`, `invite_link.redeem`, `invite_link.revoke`
- `audience.set`, `obligations.sync`

**Financial event processing** (`supabase/migrations/20260924160000_financial_event_processing.sql`):
- Pattern: append-only `financial_event_processing_attempts` table
- One row per delivery attempt (not a mutable counter)
- Outcome enum: `succeeded`, `failed`, `unknown`, `ignored`
- Error tracking: `error_code` (Kolekto vocabulary, not provider strings), `error_message`
- Retry tracking: `next_retry_at` (advisory)
- View: `v_financial_event_processing` answering the 8 processing questions

This pattern is **directly reusable** for notification delivery tracking.

### 3.7 Consent Infrastructure

`members.consent_messages_at` (`supabase/migrations/20260917120500_members.sql:44-47`):
```sql
-- MEM-07 / NOT-01a: consent to receive community messages. Without it, no
-- messages, which are not optional (NOT-10).
consent_messages_at timestamptz,
```

This column already exists but is never read or written by any application code. It is the gate for outbound community messages per the schema comments:
- `NULL` = member has NOT consented → no outbound messages
- Non-NULL = member consented at that timestamp → eligible for messages

`member_contacts.receives_notices` (same migration):
- Boolean flag on estate-unit contacts
- Determines which contacts for a member should receive notices
- Already in the schema, not yet read by application logic

### 3.8 Permission Catalogue

From `supabase/migrations/20260917120400_roles_and_officers.sql`:

```
announcement.send  — granted to: owner, admin
reminder.send      — granted to: owner, admin, treasurer, collector (scoped)
```

Both permissions are **defined and granted to roles** but have no implementation behind them. No code checks these permissions today because no notification code exists.

### 3.9 Environment Configuration

`.env.example:82-89`:
```
WHATSAPP_PROVIDER=
WHATSAPP_API_KEY=
SMS_PROVIDER=
SMS_API_KEY=
EMAIL_PROVIDER=
EMAIL_API_KEY=
```
All marked "NOT USED YET. Provider selection is DEC-17."

---

## 4. Current Collection Publish Flow

### 4.1 End-to-End Trace: Draft → Published

```
Step 1: Officer opens /c/{slug}/collections/new
        → Purpose picker (flows.ts FLOWS array, 7 flows)
        → Each flow defines steps, vocabulary, timing shape

Step 2: Officer fills wizard steps
        → createCollectionAction (apps/web/app/c/[slug]/collections/actions.ts)
        → requireCallerContext() → createCollection (packages/db/src/write.ts:457)
        → app.create_collection() SQL function
        → Status: DRAFT
        → Audit log: collection.create

Step 3: Officer reviews on ReviewPanel
        → updateCollectionAction for any changes
        → setCollectionAudienceAction → app.set_collection_audience()
        → syncObligationsAction → app.sync_collection_obligations() (idempotent)

Step 4: Officer clicks "Publish"
        → transitionCollectionStatusAction (actions.ts)
        → requireCallerContext()
        → transitionCollectionStatus(caller, {collectionId, expected: 'draft', target: 'active'})
          (packages/db/src/write.ts:514-524)
        → app.transition_collection_status() SQL function
          (supabase/migrations/20260919120000_collection_and_obligation_functions.sql:448-546)

Step 5: Inside app.transition_collection_status():
        a. SELECT * FROM collections WHERE id = p_collection_id (lock the row)
        b. app.require_permission(community_id, 'collection.publish')
        c. Compare-and-set: status must match p_expected
        d. Precondition checks:
           - Fixed amount collection: fixed_amount_kobo > 0
           - Tiered collection: at least one visible tier
           - Deadline not already passed
        e. Resolve target: if starts_at > now() → 'scheduled', else → 'active'
        f. UPDATE collections SET status, published_at, published_by
        g. app.write_audit_log(community_id, 'officer', uid, 'collection.publish', ...)
        h. RETURN resolved status

Step 6: Server action calls revalidatePath()
        → UI re-renders with published state
```

### 4.2 Where `collection.published` Notification Would Originate

The **single point** where a collection transitions from draft to active/scheduled is:

**`app.transition_collection_status()`** in `supabase/migrations/20260919120000_collection_and_obligation_functions.sql:448`

Specifically, the block at lines 485-512 where `v_action := 'collection.publish'` is set. This is where a `collection.published` notification event should be emitted.

**Two implementation options for the hook point:**

1. **Database trigger on audit_logs INSERT** where `action = 'collection.publish'` — enqueues to pgmq. Keeps the notification concern out of the domain function.

2. **Explicit pgmq.send() call at the end of `app.transition_collection_status()`** after the audit log write — more visible, but couples notification infrastructure to every domain function.

**Recommendation:** Option 1 (trigger on audit_logs). The audit log already captures every domain event with structured action names. A trigger on INSERT that filters by action and enqueues to pgmq is the lowest-coupling approach and means existing domain functions need zero modification.

### 4.3 Recipients for Collection Published

When a collection is published, the recipients are its audience:
- `app.resolve_collection_audience(collection_id)` returns the live-eligible member set
- Audience mode determines who: `all_members`, `groups`, `selected_members`, `public`
- Each member has: `phone_e164`, `email`, `consent_messages_at`, and potentially `member_contacts` with `receives_notices`

---

## 5. Current Membership Flow

### 5.1 End-to-End Trace: Invite → Membership

**Path A: Officer creates member directly**
```
Step 1: Officer opens /c/{slug}/members → "Add member"
        → createMemberAction (apps/web/app/c/[slug]/members/actions.ts)
        → requireCallerContext()
        → createMember(caller, {communityId, fullName, phoneE164, email, attributes, groupIds})
          (packages/db/src/write.ts:88-107)
        → app.create_member() SQL function
        → Status: active (if phone provided) or unclaimed
        → Audit log: member.create
```

**Path B: Member joins via invite link**
```
Step 1: Officer creates invite link
        → createInviteLinkAction → app.create_invite_link()
        → Returns token (hashed in DB, raw returned once)
        → Officer shares link manually (copy-paste, no system delivery)

Step 2: Person opens /invite/{token}
        → getPublicInvite(token) — ANONYMOUS read
        → Shows community name, logo, fields to fill

Step 3: Person submits join form
        → redeemInviteLinkAction (apps/web/app/invite/[token]/actions.ts)
        → ANONYMOUS caller context (the one unauthenticated write path)
        → redeemInviteLink() (packages/db/src/write.ts:338-356)
        → app.redeem_invite_link() SQL function
        → Status: pending_approval (if approve_joiners=true) or active
        → Audit log: invite_link.redeem
        → Returns: memberId, status, memberCode

Step 4 (if approve_joiners=true):
        → Officer sees pending member
        → approveMemberAction / rejectMemberAction
        → app.approve_pending_member() / app.reject_pending_member()
        → Audit log: member.approve / member.reject
```

**Path C: Officer invitation (for roles)**
```
Step 1: Owner creates officer invitation
        → createOfficerInvitationAction
        → app.create_officer_invitation()
        → Stores: role, invitee contact info, hashed token
        → Token is shared MANUALLY (no system delivery)

Step 2: Invitee opens /accept-invite?token={token}
        → acceptOfficerInvitation(caller, token) — must be authenticated
        → app.accept_officer_invitation()
        → Creates officer_term with specified role
        → Audit log: officer.accept
```

### 5.2 Where `member.joined` / `member.approved` Notifications Would Originate

| Event | SQL Function | Audit Log Action | Notification Recipients |
|---|---|---|---|
| Member joins (direct create) | `app.create_member()` | `member.create` | The member themselves (welcome); officers with `member.manage` |
| Member joins via invite | `app.redeem_invite_link()` | `invite_link.redeem` | The member (welcome + code); officers (if approve_joiners, alert to review) |
| Member approved | `app.approve_pending_member()` | `member.approve` | The member (you're in!) |
| Member rejected | `app.reject_pending_member()` | `member.reject` | The member (sorry) |
| Officer invitation accepted | `app.accept_officer_invitation()` | `officer.accept` | Owner/admins (new officer joined) |

Same recommendation as §4.2: trigger on `audit_logs` INSERT, filter by action, enqueue to pgmq.

---

## 6. Current Payment Architecture (Integration Points)

### 6.1 What Exists

The payment architecture is at the **boundary definition** stage (M8.1–M8.2). No payment processing runs yet.

| Component | Status | Location |
|---|---|---|
| `financial_events` table | Schema built, no rows ever written | `20260924120000_financial_idempotency.sql` |
| `financial_event_processing_attempts` | Schema built, no rows ever written | `20260924160000_financial_event_processing.sql` |
| `financial_operation_claims` | Schema built, no rows ever written | `20260924120000_financial_idempotency.sql` |
| Ledger (journals, entries, accounts) | Schema built, no rows ever written | `20260924110000_ledger.sql` |
| Fee schedules | Schema built | `20260924100000_fee_schedules.sql` |
| Fake payment provider | Exists for testing | `packages/adapters/src/fake-payment-provider.ts` |
| Paystack env vars | Defined, not read by code | `.env.example:63-80` |
| Webhook endpoint | **Does not exist** | — |

### 6.2 Future Payment Notification Events

When payment processing is built (M8.9+), these events will need notifications:

| Event | Source | Recipient | Channel |
|---|---|---|---|
| `payment.received` | Webhook handler → financial_events | Contributor (receipt); Officers (dashboard update) | In-app, Email, WhatsApp |
| `payment.failed` | Webhook handler | Contributor (retry prompt) | In-app, Email |
| `obligation.overdue` | pg_cron scheduled check | Member (reminder); Officers (summary) | In-app, Email, WhatsApp, SMS |
| `obligation.upcoming` | pg_cron scheduled check | Member (heads-up) | In-app, Email |
| `refund.issued` | Future refund flow | Contributor (confirmation) | In-app, Email |

### 6.3 DO NOT TOUCH Boundary

Per the M13 audit scope, payment execution, Paystack integration, withdrawal, settlement, and refund logic are **out of scope**. M13 builds the notification delivery infrastructure; it does NOT implement payment processing. The payment notification events listed above are for the event taxonomy only — their triggering mechanisms belong to M8.9+.

---

## 7. Proposed Event Taxonomy

### 7.1 Event Naming Convention

Format: `{domain}.{verb}` — matches existing audit log `action` format.

### 7.2 Full Event Matrix

| Event | Actor | Recipient(s) | In-App | Email | WhatsApp | SMS | Phase |
|---|---|---|---|---|---|---|---|
| **Collection Domain** | | | | | | | |
| `collection.published` | Officer | Audience members | Yes | Yes | Later | — | M13.1 |
| `collection.paused` | Officer | Audience members (active obligations) | Yes | — | — | — | M13.2 |
| `collection.resumed` | Officer | Audience members | Yes | Yes | — | — | M13.2 |
| `collection.closed` | Officer | Audience members | Yes | Yes | — | — | M13.2 |
| **Membership Domain** | | | | | | | |
| `member.approved` | Officer | The member | Yes | Yes | Later | — | M13.1 |
| `member.rejected` | Officer | The member | Yes | Yes | — | — | M13.2 |
| `invite_link.redeemed` | Member (self) | Officers with `member.manage` | Yes | — | — | — | M13.1 |
| `member.pending_review` | System | Officers with `member.manage` | Yes | Yes | — | — | M13.1 |
| **Officer Domain** | | | | | | | |
| `officer.invitation_sent` | Owner/Admin | Invitee (by contact info) | — | Yes | — | — | M13.2 |
| `officer.accepted` | New officer | Owner/admins | Yes | — | — | — | M13.2 |
| `officer.term_ended` | Owner/Admin | The officer | Yes | Yes | — | — | M13.2 |
| **Announcement Domain** | | | | | | | |
| `announcement.sent` | Officer | Target audience | Yes | Yes | Later | Later | M13.3 |
| **Reminder Domain** | | | | | | | |
| `reminder.obligation_upcoming` | System (cron) | Member with obligation | Yes | Yes | Later | Later | M13.4 |
| `reminder.obligation_overdue` | System (cron) | Member with obligation | Yes | Yes | Later | Later | M13.4 |
| `reminder.manual` | Officer | Target audience | Yes | Yes | Later | — | M13.3 |
| **Payment Domain** (future, M8.9+) | | | | | | | |
| `payment.received` | System (webhook) | Contributor + Officers | Yes | Yes | Later | — | M13.4+ |
| `payment.failed` | System (webhook) | Contributor | Yes | Yes | — | — | M13.4+ |
| `receipt.issued` | System | Contributor | — | Yes | — | — | M13.5 |

### 7.3 Consent Rules

- **In-app notifications:** No consent required (system-internal, user controls via preferences)
- **Email to community members:** Requires `consent_messages_at IS NOT NULL` on the member row (NOT-01a)
- **Email for transactional/payment:** Requires member having an email address, no consent gate (NOT-10: "messages which are not optional")
- **WhatsApp/SMS:** Requires explicit opt-in (future consent mechanism, DEC-17)
- **`member_contacts.receives_notices`:** Per-contact override for estate-unit contacts

---

## 8. Proposed Data Model

### 8.1 New Tables

#### `notification_events`

The event that occurred. One row per domain event that warrants notification. Append-only.

```sql
create table public.notification_events (
  id              uuid primary key default app.uuid_generate_v7(),
  community_id    uuid not null references public.communities(id),

  -- Structured event identity
  event_type      text not null,         -- 'collection.published', 'member.approved', etc.
  event_key       text not null,         -- idempotency: '{event_type}:{object_id}[:{qualifier}]'

  -- What triggered it
  actor_type      public.audit_actor_type not null,  -- reuse existing enum
  actor_user_id   uuid,                  -- NULL for system events
  object_type     text not null,         -- 'collection', 'member', 'obligation', etc.
  object_id       uuid not null,

  -- Snapshot of what happened (for template rendering, survives schema changes)
  payload         jsonb not null default '{}',

  created_at      timestamptz not null default now(),

  constraint notification_events_event_key_unique unique (event_key),
  constraint notification_events_event_type_not_blank check (length(btrim(event_type)) > 0)
);

alter table public.notification_events enable row level security;
alter table public.notification_events force row level security;

-- Append-only: reuse pattern from financial_event_processing
-- Time-ordered index for recipient's notification feed
create index notification_events_community_created_idx
  on public.notification_events (community_id, created_at desc);
create index notification_events_type_idx
  on public.notification_events (event_type, created_at desc);
```

**Key design decisions:**
- `event_key` is the deduplication key (D-25 pattern from financial idempotency). A publish of collection X produces event key `collection.published:{collection_id}`. A second call with the same key conflicts and writes nothing.
- `payload` is a JSONB snapshot (collection name, member name, amounts, etc.) frozen at event time. Templates render from this snapshot, never from a live query — so a renamed collection does not retroactively change a sent notification.
- UUIDv7 IDs for time-ordered index locality (DAT-04 pattern).
- `community_id` for RLS tenant isolation (ADR 0004).

#### `notification_deliveries`

One row per (event × recipient × channel). Tracks delivery state.

```sql
create type public.notification_channel as enum ('in_app', 'email', 'whatsapp', 'sms');
create type public.notification_delivery_status as enum ('pending', 'sent', 'delivered', 'failed', 'skipped');

create table public.notification_deliveries (
  id                  uuid primary key default app.uuid_generate_v7(),
  notification_event_id uuid not null references public.notification_events(id),
  community_id        uuid not null references public.communities(id),

  -- Recipient
  recipient_member_id uuid references public.members(id),    -- NULL for non-member recipients
  recipient_user_id   uuid references public.users(id),      -- NULL for unclaimed members
  recipient_address   text,              -- email address, phone number, or NULL for in_app

  channel             public.notification_channel not null,
  status              public.notification_delivery_status not null default 'pending',

  -- In-app specific
  read_at             timestamptz,       -- when the recipient read/dismissed it

  -- Delivery tracking
  provider_message_id text,              -- provider's own message ID for tracking
  error_code          text,              -- Kolekto vocabulary, not provider strings
  error_message       text,

  -- Retry
  attempt_count       integer not null default 0,
  last_attempted_at   timestamptz,
  next_retry_at       timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint notification_deliveries_attempt_count_positive check (attempt_count >= 0),
  constraint notification_deliveries_sent_has_no_error
    check (status <> 'sent' or (error_code is null and error_message is null)),
  constraint notification_deliveries_failed_has_reason
    check (status <> 'failed' or error_message is not null)
);

alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

-- Unique: one delivery per event × recipient × channel
create unique index notification_deliveries_event_recipient_channel_key
  on public.notification_deliveries (notification_event_id, coalesce(recipient_member_id, '00000000-0000-0000-0000-000000000000'::uuid), channel);

-- The in-app notification feed: unread first, then by time
create index notification_deliveries_inbox_idx
  on public.notification_deliveries (recipient_user_id, read_at nulls first, created_at desc)
  where channel = 'in_app';

-- Retry sweep: pending or failed deliveries due for retry
create index notification_deliveries_retry_idx
  on public.notification_deliveries (next_retry_at)
  where status in ('pending', 'failed') and next_retry_at is not null;
```

**Key design decisions:**
- `notification_deliveries` is mutable (unlike financial events) because delivery state legitimately changes: pending → sent → delivered, or pending → failed → retry.
- `read_at` is the in-app read/dismiss timestamp, enabling unread badges.
- `recipient_member_id` is the primary recipient key (ADR 0004: member, not user). `recipient_user_id` is a denormalised convenience for the in-app inbox query (avoids a join through members to find a user's notifications across communities).
- Unique index prevents duplicate deliveries per event × recipient × channel.
- Retry index mirrors the `financial_event_processing_attempts_retry_idx` pattern.

#### `notification_preferences`

Per-member, per-channel preferences. Absence = use defaults.

```sql
create table public.notification_preferences (
  id              uuid primary key default gen_random_uuid(),
  community_id    uuid not null references public.communities(id),
  member_id       uuid not null references public.members(id),

  -- Channel toggles (NULL = use default, which is ON for all except SMS)
  email_enabled   boolean,
  whatsapp_enabled boolean,
  sms_enabled     boolean,
  -- in_app is always on, not configurable

  -- Category toggles (NULL = use default ON)
  announcements_enabled boolean,
  reminders_enabled     boolean,
  collection_updates_enabled boolean,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint notification_preferences_member_community_key unique (community_id, member_id)
);

alter table public.notification_preferences enable row level security;
alter table public.notification_preferences force row level security;
```

#### `notification_templates` (M13.3+)

Deferred to M13.3. M13.1 uses hardcoded templates in application code. When built:

```sql
create table public.notification_templates (
  id              uuid primary key default gen_random_uuid(),
  community_id    uuid,                  -- NULL = system default template
  event_type      text not null,
  channel         public.notification_channel not null,
  subject         text,                  -- email subject, WhatsApp header
  body            text not null,         -- template body with {{variable}} placeholders
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint notification_templates_event_channel_key unique (coalesce(community_id, '00000000-0000-0000-0000-000000000000'::uuid), event_type, channel)
);
```

### 8.2 New pgmq Queues

```sql
-- M13.1: the notification processing queue
select pgmq.create('notification_events');

-- M13.4: the scheduled reminder queue (separate so reminders don't block event notifications)
select pgmq.create('notification_reminders');
```

### 8.3 RLS Policies

```sql
-- notification_events: officers can read their community's events (audit.view permission)
create policy notification_events_community_read
  on public.notification_events for select to authenticated
  using (
    community_id in (
      select ot.community_id from public.officer_terms ot
      where ot.user_id = auth.uid() and ot.ended_at is null
    )
  );

-- notification_deliveries: users can read their own in-app deliveries
create policy notification_deliveries_own_read
  on public.notification_deliveries for select to authenticated
  using (
    recipient_user_id = auth.uid()
    and channel = 'in_app'
  );

-- notification_deliveries: officers can read their community's deliveries (for send history)
create policy notification_deliveries_community_read
  on public.notification_deliveries for select to authenticated
  using (
    community_id in (
      select ot.community_id from public.officer_terms ot
      where ot.user_id = auth.uid() and ot.ended_at is null
    )
  );

-- notification_preferences: members can read/write their own
create policy notification_preferences_own_read
  on public.notification_preferences for select to authenticated
  using (
    member_id in (
      select m.id from public.members m
      where m.user_id = auth.uid()
    )
  );

-- No anon access to any notification table
```

### 8.4 Entity Relationship Diagram

```
notification_events ──1:N──> notification_deliveries
       │                            │
       │ community_id               │ community_id
       │ (FK → communities)         │ recipient_member_id (FK → members)
       │                            │ recipient_user_id (FK → users)
       │                            │ channel (enum)
       │                            │ status (enum)
       │                            │ read_at (in-app)
       │
       │ event_type
       │ event_key (unique, idempotent)
       │ payload (jsonb snapshot)

notification_preferences
       │ community_id (FK → communities)
       │ member_id (FK → members)
       │ per-channel + per-category toggles

notification_templates (M13.3+)
       │ community_id (nullable, NULL = system default)
       │ event_type + channel (unique)
       │ subject + body ({{variable}} placeholders)
```

---

## 9. Security Model

### 9.1 RLS Tenant Isolation

Every notification table has `community_id` (ADR 0004). RLS policies enforce:

1. **notification_events:** Readable by officers of that community (via `officer_terms` join). Not readable by members who are not officers. Not readable by anon.

2. **notification_deliveries (in-app channel):** Readable by the `recipient_user_id` (the user the delivery is addressed to). This is the in-app inbox query.

3. **notification_deliveries (email/whatsapp/sms):** Readable by officers of that community (for send history/debugging). The `recipient_address`, `error_code`, and `error_message` fields may contain PII — future staff-realm views (ADR 0009) should redact these from non-staff reads.

4. **notification_preferences:** Readable and writable only by the member themselves (via `members.user_id = auth.uid()` join).

5. **No anon policies** on any notification table.

### 9.2 Write Path Security

All notification writes go through `app.*` SECURITY DEFINER functions:
- `app.create_notification_event()` — called by the audit log trigger or by explicit domain code
- `app.create_notification_deliveries()` — called by the worker after resolving recipients
- `app.mark_notification_read()` — called by the user marking their own notification read
- `app.update_notification_preferences()` — called by the member updating their own preferences

Each function:
- Runs as SECURITY DEFINER (bypasses RLS for the write, but verifies permissions internally)
- Calls `app.has_permission()` or `auth.uid()` to verify the caller
- Writes an audit log entry where appropriate
- Is unreachable via PostgREST (lives in `app` schema)

### 9.3 Sending Authorization

| Action | Required Permission | Checked By |
|---|---|---|
| Send announcement | `announcement.send` | `app.has_permission()` in the send function |
| Send reminder | `reminder.send` | `app.has_permission()` in the send function |
| Publish collection (triggers notification) | `collection.publish` | Already checked by `app.transition_collection_status()` |
| Approve member (triggers notification) | `member.manage` | Already checked by `app.approve_pending_member()` |

### 9.4 Consent Enforcement

Before creating an outbound delivery (email, WhatsApp, SMS), the delivery creation function MUST check:

1. `members.consent_messages_at IS NOT NULL` — the member consented to messages (NOT-01a)
2. `notification_preferences` for channel-specific opt-out
3. For estate contacts: `member_contacts.receives_notices = true`

If consent is missing, the delivery is created with `status = 'skipped'` and a reason, never silently dropped. This creates an auditable record that the message was suppressed for consent reasons.

**Exception:** Transactional notifications (payment receipts, account security) bypass consent (NOT-10: "messages which are not optional"). The event taxonomy marks which events are transactional.

### 9.5 Recipient Ownership

A user can only mark-as-read deliveries where `recipient_user_id = auth.uid()`. The `app.mark_notification_read()` function enforces this:

```
-- Inside the function:
if v_delivery.recipient_user_id <> auth.uid() then
  raise exception 'FORBIDDEN: cannot mark another user''s notification as read';
end if;
```

### 9.6 Provider Credential Safety

- Provider API keys (`EMAIL_API_KEY`, `WHATSAPP_API_KEY`, `SMS_API_KEY`) are server-only environment variables, never `NEXT_PUBLIC_` prefixed
- Provider responses (which may contain PII) are stored in delivery error fields, readable only by officers and staff
- Provider message IDs are stored for delivery tracking but not exposed to non-officer users
- Webhook secrets for delivery status callbacks follow the financial webhook pattern: verify signature before processing

---

## 10. M13 Phasing

### M13.1 — Foundation + In-App Notifications + Core Events

**Goal:** Notification tables, queue wiring, worker loop, in-app notification bell, and the 4 highest-value events.

**Scope:**
- Create `notification_events`, `notification_deliveries`, `notification_preferences` tables
- Create pgmq queue `notification_events`
- Wire `apps/worker` to consume the queue
- Audit log trigger: enqueue on `collection.publish`, `member.approve`, `invite_link.redeem`, `member.pending_review` (when `approve_joiners = true`)
- In-app notification UI: bell icon in AppShell header, unread badge, notification dropdown/panel
- Mark-as-read functionality
- RLS policies for all new tables

**Does NOT include:** Email delivery, WhatsApp, SMS, announcements, reminders, templates, preferences UI.

**Estimated tables:** 3 new tables, 1 new enum, 1 pgmq queue, 1 migration file.
**Estimated UI:** Bell icon + dropdown in AppShell, notification list component.
**Estimated worker:** Queue consumer loop, in-app delivery writer.

### M13.2 — Email Channel + Collection Lifecycle Events

**Goal:** Outbound email delivery for the M13.1 events, plus additional lifecycle events.

**Scope:**
- Email provider adapter (interface + Resend/Postmark/provider-TBD implementation)
- Hardcoded email templates for each event type (no template table yet)
- Consent gate enforcement (`consent_messages_at`)
- Delivery status tracking (pending → sent → delivered/failed)
- Retry logic for failed email deliveries
- Additional events: `collection.closed`, `collection.paused`, `collection.resumed`, `member.rejected`, `officer.term_ended`
- Environment variable wiring for `EMAIL_PROVIDER`, `EMAIL_API_KEY`

**Does NOT include:** WhatsApp, SMS, custom templates, announcements, reminders.

### M13.3 — Announcements + Manual Reminders + Template System

**Goal:** Officers can send messages to their community/audience.

**Scope:**
- Announcement creation UI (officer dashboard)
- `announcement.send` permission enforcement
- Recipient targeting (all members, groups, specific members)
- `notification_templates` table
- Default templates for all event types
- Community-customisable templates (override defaults)
- Manual reminder sending with `reminder.send` permission
- Template preview before sending

### M13.4 — Automated Reminders + Payment Events

**Goal:** System-driven notifications on schedules and payment events.

**Scope:**
- `pg_cron` jobs for obligation reminders (upcoming, overdue)
- `notification_reminders` pgmq queue
- Reminder scheduling rules (configurable per collection)
- Payment event notifications (wired to M8.9+ financial event processing)
- Receipt generation and delivery
- Notification preferences UI (member self-service)

### M13.5 — WhatsApp + SMS Channels

**Goal:** External messaging channels beyond email.

**Scope:**
- WhatsApp Business API adapter
- SMS provider adapter (Africa's Talking / Termii / provider-TBD)
- Channel-specific consent management
- WhatsApp template approval workflow
- SMS character limit handling
- Provider selection (DEC-17 resolution)
- Environment variable wiring for `WHATSAPP_PROVIDER`, `SMS_PROVIDER`

---

## 11. M13.1 Implementation Recommendation

### 11.1 Migration File

Create: `supabase/migrations/YYYYMMDDHHMMSS_notification_foundation.sql`

Contents:
1. `notification_channel` enum
2. `notification_delivery_status` enum
3. `notification_events` table with RLS
4. `notification_deliveries` table with RLS
5. `notification_preferences` table with RLS
6. All indexes from §8.1
7. All RLS policies from §8.3
8. `pgmq.create('notification_events')` queue
9. `app.create_notification_event()` SECURITY DEFINER function
10. `app.create_notification_deliveries()` SECURITY DEFINER function
11. `app.mark_notification_read()` SECURITY DEFINER function
12. Audit log trigger for notification event enqueuing
13. Append-only enforcement triggers on `notification_events`
14. Privilege grants and revocations

### 11.2 Audit Log Trigger (the event source)

```sql
create or replace function app.enqueue_notification_on_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only enqueue for actions that warrant notifications
  if new.action in (
    'collection.publish',
    'member.approve',
    'invite_link.redeem'
    -- Add more as M13.2+ events are built
  ) then
    perform pgmq.send(
      'notification_events',
      jsonb_build_object(
        'audit_log_id', new.id,
        'community_id', new.community_id,
        'action', new.action,
        'actor_type', new.actor_type,
        'actor_user_id', new.actor_user_id,
        'object_type', new.object_type,
        'object_id', new.object_id,
        'after_state', new.after_state
      )
    );
  end if;
  return new;
end;
$$;

create trigger audit_log_notification_enqueue
  after insert on public.audit_logs
  for each row execute function app.enqueue_notification_on_audit();
```

**Why this approach works:**
- Zero modifications to existing domain functions
- Every domain action already writes an audit log entry
- The trigger filters by action name and enqueues only notification-worthy events
- Adding a new event type = adding one string to the `IN (...)` list
- The enqueued message carries enough context for the worker to resolve recipients and create deliveries

### 11.3 Worker Implementation

File: `apps/worker/src/index.ts` (replace stub)

```
Loop:
  1. pgmq.read('notification_events', visibility_timeout=30, batch_size=10)
  2. For each message:
     a. Parse the audit log action
     b. Resolve recipients:
        - collection.published → app.resolve_collection_audience(object_id)
        - member.approve → the member themselves
        - invite_link.redeem → officers with member.manage in that community
     c. Build notification event row (idempotent via event_key)
     d. For each recipient:
        - Check consent (consent_messages_at for future email)
        - Check preferences (notification_preferences)
        - Create notification_delivery with channel='in_app', status='sent'
     e. pgmq.delete(message_id)
  3. If no messages, sleep(poll_interval)
```

Worker dependencies (already in `apps/worker/package.json`):
- `@kolekto/config` — env vars, database URL
- `@kolekto/db` — direct Postgres connection, CallerContext
- `@kolekto/domain` — business logic if needed

### 11.4 In-App UI Components

**AppShell modification** (`apps/web/components/AppShell.tsx`):
- Add notification bell icon between nav and UserFooter in sidebar
- Add bell to mobile header bar
- Unread count badge (red dot or number)
- Dropdown/panel on click showing recent notifications

**New components:**
- `apps/web/components/NotificationBell.tsx` — bell icon with unread badge
- `apps/web/components/NotificationPanel.tsx` — dropdown list of notifications
- `apps/web/components/NotificationItem.tsx` — single notification row

**Data fetching:**
- Supabase realtime subscription on `notification_deliveries` where `recipient_user_id = auth.uid() AND channel = 'in_app'`
- Or: polling via server component with `revalidatePath` (simpler, no realtime dependency)

**Mark as read:**
- Server action calling `app.mark_notification_read(delivery_id)`
- "Mark all as read" bulk action

### 11.5 Files to Create/Modify

| Action | File | What |
|---|---|---|
| CREATE | `supabase/migrations/YYYYMMDDHHMMSS_notification_foundation.sql` | Tables, enums, RLS, triggers, functions, queue |
| MODIFY | `apps/worker/src/index.ts` | Replace stub with queue consumer loop |
| CREATE | `apps/worker/src/notification-processor.ts` | Event → recipient resolution → delivery creation |
| CREATE | `apps/web/components/NotificationBell.tsx` | Bell icon + unread badge |
| CREATE | `apps/web/components/NotificationPanel.tsx` | Notification dropdown |
| CREATE | `apps/web/components/NotificationItem.tsx` | Single notification row |
| MODIFY | `apps/web/components/AppShell.tsx` | Add NotificationBell to header |
| CREATE | `apps/web/app/c/[slug]/notifications/actions.ts` | mark-as-read server action |
| CREATE | `packages/db/src/notifications.ts` | DB functions for notification reads/writes |
| MODIFY | `packages/db/src/index.ts` | Export notifications module |
| CREATE | `supabase/tests/XX_notifications.sql` | pgTAP tests for RLS, triggers, functions |

### 11.6 Acceptance Criteria

1. Publishing a collection creates an in-app notification for every audience member with a claimed user account
2. Approving a pending member creates an in-app notification for that member (if they have a claimed user account)
3. A member joining via invite link creates an in-app notification for officers with `member.manage` permission
4. Notification bell in AppShell shows unread count
5. Clicking the bell shows a panel with recent notifications
6. Notifications can be marked as read individually or in bulk
7. Read notifications are visually distinct from unread
8. All new tables have RLS policies enforcing tenant isolation
9. notification_events is append-only (trigger-enforced)
10. Worker processes queue messages and creates deliveries

---

## 12. Implementation Boundary

### BUILD NOW (M13.1)

- `notification_events` table + RLS + append-only enforcement
- `notification_deliveries` table + RLS
- `notification_preferences` table + RLS (schema only; no UI yet)
- `notification_channel` and `notification_delivery_status` enums
- pgmq queue `notification_events`
- Audit log trigger `app.enqueue_notification_on_audit()`
- `app.create_notification_event()` function
- `app.mark_notification_read()` function
- Worker queue consumer loop
- Notification processor (event → recipients → deliveries)
- In-app notification bell, panel, mark-as-read
- pgTAP tests for new tables, RLS, triggers

### BUILD LATER

| What | Phase | Dependency |
|---|---|---|
| Email delivery channel | M13.2 | Email provider selection (DEC-17) |
| Additional lifecycle events | M13.2 | M13.1 foundation |
| Announcement feature | M13.3 | M13.2 email channel |
| Template system | M13.3 | M13.2 email channel |
| Automated reminders | M13.4 | M13.3 templates + pg_cron wiring |
| Payment notifications | M13.4 | M8.9+ payment processing |
| WhatsApp channel | M13.5 | Provider selection (DEC-17) |
| SMS channel | M13.5 | Provider selection (DEC-17) |
| Notification preferences UI | M13.4 | M13.1 preferences table |

### DO NOT TOUCH

- Password reset flow (Supabase Auth)
- Paystack/payment execution
- Withdrawals
- Settlement
- Refunds
- Partial payments
- Legacy migration
- Organisation accounts
- Unrelated pgTAP failures
- Unrelated UI bugs
- Unrelated refactors
- Supabase Auth email templates (`supabase/templates/otp.html`, `supabase/templates/recovery.html`)
- Existing `app.*` domain functions (trigger approach means zero modifications)
- Existing audit log table structure

---

## 13. Verification

```
Files changed:     0
Database changes:  0
Migrations:        0
Packages installed: 0
```

This document is the sole deliverable of the M13 Phase 1 audit. It modifies nothing.
