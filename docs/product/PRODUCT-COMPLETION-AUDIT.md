# Kolekto Product Completion Audit

**Date:** 2026-09-30
**Scope:** Full product surface — code, schema, routes, UI, tests, user flows
**Method:** Read-only code inspection of the live codebase (`apps/web`, `packages/*`, `supabase/`, `tests/`)
**Constraints:** No code changes. No migration work. No staging/production access.

---

## 1. Executive Summary

Kolekto's rebuild has a substantially complete pre-payment product surface. The application delivers a working end-to-end experience for community creation, member management, collection creation across all 7 types, obligation management, public contribution pages (stopping at the payment boundary), activity logging, export, and officer/team management with RBAC.

### Built and working

- **Authentication:** OTP sign-in (email + phone code paths), session middleware, protected routes, defence-in-depth page guards.
- **Community CRUD:** Create, list, switch, edit profile, officer invitation/management, 5-role RBAC with 30 permissions.
- **Member management:** Full directory with search, filtering, groups, custom identity fields (4 types), auto-generated member codes, invite links with self-onboarding, pending approval, archive/restore, duplicate detection.
- **Collection creation:** All 7 types (fixed, open, tiered, items, ticketing/event, fundraiser, recurring) via a flow-based wizard with type-specific steps, vocabulary, review, and draft persistence.
- **Collection management:** Detail dashboard with tabs (Overview, Roll, Check-in, Exports, Activity, Settings). Status lifecycle (draft→active→paused→closed→archived) with optimistic locking. Server-paginated obligations panel. Assign, exempt, waive, cancel actions.
- **Public contributor page:** Mobile-first, no account required. Type-aware display. "Find yourself" member identification (signed httpOnly cookie, rate-limited). Full contribution form per type. Server-authoritative amount resolution. Clear payment boundary messaging.
- **Export:** CSV and PDF with field selection, filters, sensitive-data warnings.
- **Preview:** Phone/desktop frame toggle rendering the actual public page component.
- **RBAC:** Permission-checked UI gating with server-side re-enforcement on every write.

### Not built

- **Payment execution** (Paystack, payment capture, receipts, reconciliation) — deferred to Phase 4.
- **Notifications** (in-app, email, push) — no system exists.
- **User account settings** — no profile editing.
- **Financial dashboard figures** — no contributions means no amounts to display.
- **Ledger write path** — schema exists, no application writer.

### Risk summary

| Risk | Severity | Notes |
|------|----------|-------|
| No notification system | Medium | Officers get no alerts; contributors get no confirmations |
| Member list loads all rows | Medium | No pagination; will degrade at ~1000+ members |
| Slug collision with app routes | Low | Community slugs not checked against reserved segments |
| In-memory rate limiter | Low | Resets on restart; needs edge-level limiting for production |
| Open redirect on `?next` | Low | LoginForm reads `next` from searchParams without validation |

---

## 2. Current Product Architecture

### Monorepo structure

```
kolekto/
├── apps/
│   ├── web/          Next.js app (App Router, Turbopack)
│   └── worker/       Empty shell (Phase 4 queue processor)
├── packages/
│   ├── adapters/     Payment/settlement provider interfaces + fake
│   ├── config/       Environment configuration + guards
│   ├── db/           Supabase client, generated types, write layer, public read
│   ├── domain/       Pure business logic (money, fees, contribution, settlement, reference, csv, report)
│   ├── migration/    Legacy importer (paused workstream)
│   ├── ui/           Shared UI components (Button, Dialog, Card, Field, Table, Badge, States)
│   └── validation/   Zod schemas for all entities
├── supabase/
│   ├── migrations/   75 migration files
│   └── tests/        29 pgTAP test files
├── tests/
│   └── e2e/          13 Playwright spec files
└── docs/             ADRs, history, migration, phase-4 planning
```

### Data flow

- All writes go through `app.*` PostgreSQL functions via the direct connection (ADR 0011), never through Supabase REST.
- Public reads use `SECURITY DEFINER` functions callable by `anon` — no table access for unauthenticated users.
- Client-side code never decides prices, fees, or eligibility — the server re-derives everything from the database.

### Key ADRs

| ADR | Decision |
|-----|----------|
| 0003 | Integer kobo — no floating-point money |
| 0004 | Community is the root entity, not user |
| 0006 | Ledger deferred until Phase 4 |
| 0008 | Authorization via role→permission matrix |
| 0012 | Collections stop at the money boundary |
| 0013 | Collection types are configuration, not a column |
| 0014 | Contributor identification via signed cookies |
| 0015 | Subaccount custody at collection level |

---

## 3. Completed Product Capabilities

### Authentication

| Capability | Evidence | Notes |
|------------|----------|-------|
| Email OTP sign-in | `apps/web/app/(auth)/login/LoginForm.tsx:30-60` | Two-step: email → 6-digit code |
| Phone OTP sign-in | Same file, channel toggle | Code-complete; untestable locally (no SMS provider, DEC-17) |
| Session refresh middleware | `apps/web/lib/supabase/middleware.ts:52-84` | Every request refreshes cookie |
| Protected route enforcement | `middleware.ts:52-77` + `lib/auth.ts:24-28` | Middleware redirect + page-level `requireUser()` |
| `?next=` redirect after login | `LoginForm.tsx:21` | Preserves intended destination |
| Logout | `apps/web/app/(auth)/logout/route.ts` | POST handler, signs out, redirects |
| User bootstrap | `supabase/migrations/20260918140000_user_bootstrap.sql` | Personal community auto-created on first sign-up |

### Community / Organization

| Capability | Evidence | Notes |
|------------|----------|-------|
| Create community | `apps/web/app/communities/new/` | Name, type (11 enum values), description |
| List communities | `apps/web/app/communities/page.tsx` | RLS-scoped; personal first, then alphabetical |
| Edit profile | `SettingsClient.tsx` Profile tab | Name, description, location, institution, contact, public-officers toggle |
| Officer invitation | `SettingsClient.tsx` Team tab | By email, role selection, one-time link |
| Officer management | Same file | View active, end terms, revoke pending |
| Accept/decline invitation | `apps/web/app/accept-invite/` | Token-based, requires sign-in |
| RBAC (5 roles, 30 permissions) | `lib/permissions.ts` + `supabase/migrations/20260917120400` | UI gating + DB enforcement |
| Activity log | `apps/web/app/c/[slug]/activity/page.tsx` | Who/what/when/reason, permission-gated |
| App shell (desktop sidebar + mobile drawer) | `apps/web/components/AppShell.tsx` | Responsive navigation |

### Member Management

| Capability | Evidence | Notes |
|------------|----------|-------|
| Member directory (searchable table) | `MembersClient.tsx:207-276` | Searches name, code, phone, email, all custom attributes |
| Create/edit member | Same file + `actions.ts:87-131` | Full form with all community fields |
| Custom identity fields (4 types) | `MemberProfileConfig.tsx` | text, number, single_select, date; unique/primary/required flags |
| Member codes (auto-ID) | Same file + DB `app.next_member_code` | Configurable prefix, padding, sequential numbering |
| Groups (full CRUD) | `GroupsManager.tsx` | Create, edit, archive, delete, member assignment |
| Invite links (self-onboarding) | `InviteLinkDialog.tsx` + `invite/[token]/` | Configurable: approval, groups, required fields |
| Pending approval queue | `MembersClient.tsx:164-173` | Approve/reject with permission check |
| Archive/restore | `MembersClient.tsx:621-651` | Soft archive with reason; restore determines correct status |
| Duplicate detection | `actions.ts:73-85` + DB `app.find_member_duplicates` | Exact blocks, fuzzy warns; checked pre-creation and in DB |
| Member detail page | `[memberId]/MemberDetailClient.tsx` | Identity, contact, custom fields, groups, activity log |

### Collection Creation (all 7 types)

| Type | Flow key | Steps | Amount model | Timing | Status |
|------|----------|-------|-------------|--------|--------|
| Fixed amount | `fixed` | name→amount→audience→timing→questions→fees→codes→review | fixed | deadline | Complete |
| Open amount | `open` | name→amount(min/max/suggestions)→audience→timing→questions→fees→codes→review | open_amount | deadline | Complete |
| Tiered/packages | `tiered` | name→tiers→audience→timing→questions→fees→codes→review | tiers | deadline | Complete |
| Items/catalog | `items` | name→items(name/price/qty/image)→audience→timing→questions→fees→codes→review | items | order_window | Complete |
| Event/ticketing | `ticketing` | name→event(date/venue)→tiers(tickets)→audience→timing→questions→fees→codes→review | tiers | sales_window | Complete |
| Fundraiser | `fundraiser` | name→story(what/why/impact)→amount(target/suggestions)→audience→timing→questions→fees→codes→review | open_amount | campaign_end | Complete |
| Recurring | `recurring` | name→amount→recurrence(frequency/interval/start/grace)→audience→questions→fees→codes→review | fixed | none | Complete |

Common features across all types: draft persistence with `draft_step`, draft resume from `continue/` route, cover image upload, audience selection (all/groups/selected/public), custom questions, fee configuration, contributor reference codes, type-specific review panel, preview link, publish action.

### Collection Management

| Capability | Evidence | Notes |
|------------|----------|-------|
| Collection listing with filters | `CollectionsClient.tsx` | Chips: All/Open/Drafts/Closed/Archived + search |
| Detail dashboard (tabbed) | `CollectionDetailClient.tsx` | Overview, Roll, Check-in, Exports, Settings |
| Obligations panel (server-paginated) | `ObligationsPanel.tsx` | Filter/search, assign, exempt, waive, cancel |
| Status lifecycle | `actions.ts` | draft→active→paused→closed→archived with optimistic locking |
| Check-in (events) | `CheckInPanel.tsx` | Real-time search, check-in/out, totals |
| Export (CSV + PDF) | `ExportPanel.tsx` | Subject selection, field groups, filters, sensitive-data warnings |
| Settings (type-aware editing) | `SettingsPanel.tsx` (729 lines) | Edit published collection details, tiers, items, event, story, recurrence |
| Preview | `preview/PreviewFrame.tsx` | Phone (390px) / desktop toggle |
| Share | `CollectionDetailClient.tsx` | Copy link, WhatsApp, open public page |

### Public Contributor Experience

| Capability | Evidence | Notes |
|------------|----------|-------|
| Public collection page (all types) | `apps/web/app/[communitySlug]/[collectionSlug]/` | Server component, SEO metadata |
| Mobile-first layout | `CollectionView.tsx:141` | `max-w-xl`, `px-4 py-8 sm:px-6 sm:py-12` |
| Organizer identity + trust signals | Same file | Community name, verified badge, footer trust statement |
| All amount model UIs | `ContributeForm.tsx` | Fixed, open (with suggestions), tiered (single/multi), items, per-member |
| FindYourself member lookup | `FindYourself.tsx:50-184` | Search, single match confirm, multiple match count (no names), no match message |
| Signed identification cookie | `contributor-session.ts` | HMAC-SHA256, httpOnly, collection-scoped, 1-hour TTL |
| Rate-limited lookups | `lookup-throttle.ts` | 12/minute per IP per collection |
| Custom contributor fields | `ContributeForm.tsx:664-698` | text, number, date, single_select with validation |
| Event ticketing with attendees | Same file | Multi-tier basket, per-order limits, attendee name collection |
| Item ordering with stock | Same file | Multi-item basket, quantities, images, stock limits |
| Fundraiser story display | `CollectionView.tsx` | what/why/impact blocks, target amount |
| Contributor references display | `ContributeForm.tsx:467-477` | Monospace, prominent, with guidance text |
| Server-side amount resolution | `actions.ts:240-423` | `resolveContributionAmount()` — browser never decides prices |
| Confirmation summary | `ContributeForm.tsx:162-257` | Amount, selections, attendees, member info, cycle label |
| Error states (all scenarios) | Throughout | Not found, paused, closed, validation, throttle, sold out, expired session |

### Domain Logic (pure, tested)

| Module | Evidence | Notes |
|--------|----------|-------|
| Money (integer kobo) | `packages/domain/src/money.ts` | Branded BigInt, `fromNaira()`, `formatNaira()`, `allocate()`, no floats |
| Fee calculation | `packages/domain/src/fees.ts` | 2 versioned schedules, `calculateFees()` single source of truth |
| Contribution resolution | `packages/domain/src/contribution.ts` | All 5 amount models, stock/limit enforcement |
| Settlement rules | `packages/domain/src/settlement.ts` | T+1 at 05:00 Lagos, pure function, DST-safe |
| Reference formatting | `packages/domain/src/reference.ts` | Format, validate, generate, normalize prefix |
| CSV export | `packages/domain/src/csv.ts` | RFC 4180, BOM, injection prevention |
| Report layout | `packages/domain/src/report.ts` | Pagination, column distribution, orientation |

---

## 4. Partially Completed Capabilities

### PC-01: User onboarding after first login

- **Area:** Authentication / onboarding
- **Current state:** After first OTP verify, user lands on `/communities` with "No communities yet" empty state. No guided setup, no welcome, no name prompt.
- **Evidence:** `apps/web/app/communities/page.tsx:27-29` — just an `EmptyState` component. User bootstrap (DB trigger) creates user + personal community, but no UI acknowledges this.
- **User impact:** First-time users face a blank page with no guidance on what to do next.
- **Dependency/blocker:** None.
- **Recommended action:** Add a first-time welcome flow or contextual guidance on the communities page when the user has only their personal community.
- **Complexity:** S

### PC-02: Community verification

- **Area:** Community / organization
- **Current state:** Verification status badge displayed on overview page, but text says "Submitting for verification is not yet available in this build."
- **Evidence:** `apps/web/app/c/[slug]/page.tsx:39-51`
- **User impact:** Communities cannot become "verified" — the trust signal on public collection pages is always unverified.
- **Dependency/blocker:** Requires a verification review process (possibly manual/staff workflow, ADR 0009).
- **Recommended action:** Defer unless verification is a launch requirement. The display infrastructure is ready.
- **Complexity:** L (requires staff workflow)

### PC-03: Community switching UX

- **Area:** Community / navigation
- **Current state:** Users must click "← All communities" in sidebar, navigate to `/communities`, then select. No quick-switch dropdown.
- **Evidence:** `AppShell.tsx:104` — link only, no dropdown.
- **User impact:** Multi-community officers have extra navigation steps.
- **Dependency/blocker:** None.
- **Recommended action:** Add a community switcher dropdown to the sidebar header.
- **Complexity:** S

### PC-04: Invite link management

- **Area:** Member management / invitations
- **Current state:** Invite links can be created from `InviteLinkDialog`, but there is a list of active links in the members page with label, status, uses, and revoke. However, the dialog does NOT expose expiry or max-uses controls despite the schema supporting them.
- **Evidence:** `InviteLinkDialog.tsx` — no `expiresAt` or `maxUses` fields in UI. `MembersClient.tsx:653-697` — `InviteLinksSection` shows links.
- **User impact:** Links are created without expiry or usage caps. Could be shared indefinitely.
- **Dependency/blocker:** None — schema + validation already support these fields.
- **Recommended action:** Add expiry and max-uses fields to the invite link creation dialog.
- **Complexity:** S

### PC-05: Settings scope (community vs account)

- **Area:** Settings
- **Current state:** Only community-level settings exist (Profile, Team). No user account settings page — user cannot edit their own name, email, or phone after signup.
- **Evidence:** `apps/web/app/c/[slug]/settings/SettingsClient.tsx` — only `profile` and `team` tabs. No `/account` or `/settings` route exists.
- **User impact:** Users who mistype their name at signup or want to change their email have no recourse.
- **Dependency/blocker:** None.
- **Recommended action:** Create `/account` or `/settings` route with name editing. Email/phone change is more complex (requires OTP reverification).
- **Complexity:** S (name only), M (with email/phone change)

### PC-06: Session configuration

- **Area:** Authentication / security
- **Current state:** JWT expiry is 1 hour with refresh token rotation. But the comment in `config.toml:58-65` notes that `[auth.sessions]` (7-day session, 12-hour idle timeout from SEC-04) is intentionally not configured yet.
- **Evidence:** `supabase/config.toml:58-65`
- **User impact:** Sessions may time out unexpectedly. No visible feedback when session expires.
- **Dependency/blocker:** SEC-04 decision.
- **Recommended action:** Configure session duration before launch. Add graceful session expiry handling in the UI.
- **Complexity:** S

---

## 5. Missing Capabilities

### MS-01: Notification system

- **Area:** Notifications
- **Current state:** No notification infrastructure exists — no in-app notifications, no transactional email, no push, no notification center, no bell icon.
- **Evidence:** No notification-related code anywhere in `apps/web/`, `apps/worker/`, or `packages/`.
- **User impact:** Officers get no alerts for: new member joined, approaching deadlines, status changes. Contributors get no: payment confirmations, receipts, reminders. This is the single largest product gap.
- **Dependency/blocker:** Requires email provider decision, worker infrastructure (currently empty shell).
- **Recommended action:** Start with transactional email (Resend/Postmark) for critical notifications: member joined, collection published, officer invitation. In-app notifications as second tier.
- **Complexity:** L

### MS-02: User account settings page

- **Area:** Settings / user profile
- **Current state:** No `/account` or `/settings` route for user-level settings. User can only see their name in the sidebar footer.
- **Evidence:** No account page in `apps/web/app/`. `AppShell.tsx:116` displays name read-only.
- **User impact:** Cannot edit name, cannot change login email/phone, cannot see account info.
- **Dependency/blocker:** None for basic name editing.
- **Recommended action:** Create account settings page with name editing at minimum.
- **Complexity:** S

### MS-03: Member pagination

- **Area:** Member management / performance
- **Current state:** `page.tsx:37` fetches ALL members with `select("*")` and no `.range()`. All members, attributes, and group memberships loaded in a single query.
- **Evidence:** `apps/web/app/c/[slug]/members/page.tsx:28-46`
- **User impact:** Page load will degrade significantly for communities with 1000+ members. The legacy system had communities with 500+ members.
- **Dependency/blocker:** None.
- **Recommended action:** Implement server-side pagination with cursor or offset pagination. Member search should also be server-side.
- **Complexity:** M

### MS-04: Bulk member operations

- **Area:** Member management
- **Current state:** No bulk archive, bulk group assignment, or CSV import. Only individual member actions.
- **Evidence:** `MembersClient.tsx` — no multi-select, no bulk action bar.
- **User impact:** Community admins managing 200+ members must act one-by-one.
- **Dependency/blocker:** None.
- **Recommended action:** Add CSV import for member creation as the highest-value bulk operation. Bulk group assignment second.
- **Complexity:** M (CSV import), S (bulk group assign)

### MS-05: Member merge

- **Area:** Member management
- **Current state:** Schema supports it (`merged_into_id`, `merged_at`, `status: "merged"` in members table). `MemberDuplicate` type exists. But NO UI, NO server action, NO merge flow.
- **Evidence:** DB schema has the columns; no merge code in `apps/web/`.
- **User impact:** Duplicate members can be detected but not merged. Officers must manually reconcile.
- **Dependency/blocker:** None.
- **Recommended action:** Implement merge dialog with side-by-side comparison and field selection.
- **Complexity:** M

### MS-06: Cross-collection dashboard metrics

- **Area:** Dashboard / overview
- **Current state:** Community overview shows only member count and officer count. No collection count, no aggregate obligation status, no recent activity widget.
- **Evidence:** `apps/web/app/c/[slug]/page.tsx:12-16` — two count queries only.
- **User impact:** Officers must navigate to collections list to see community activity. No at-a-glance overview.
- **Dependency/blocker:** None for non-financial metrics.
- **Recommended action:** Add collection count, recent collections, and a "needs attention" section (approaching deadlines, pending approvals).
- **Complexity:** M

### MS-07: Community branding (logo/avatar)

- **Area:** Community / public presence
- **Current state:** `updateCommunityProfileSchema` has `logoUrl` field. `PublicCollection` data model includes `community_logo_url`. But no upload UI exists and the logo is not rendered on public collection pages.
- **Evidence:** `SettingsClient.tsx` Profile tab — no logo field. `CollectionView.tsx` — no logo rendered.
- **User impact:** Communities appear generic on public pages. No visual brand identity.
- **Dependency/blocker:** Storage bucket exists (`config.toml:48-49`).
- **Recommended action:** Add logo upload to community profile settings. Render on public collection pages.
- **Complexity:** S

### MS-08: Global search

- **Area:** Search / navigation
- **Current state:** Per-page search exists (members, collections, obligations, check-in). No cross-entity search from a single search bar.
- **Evidence:** No global search component or route.
- **User impact:** Must navigate to the correct page first, then search within it.
- **Dependency/blocker:** None.
- **Recommended action:** Defer. Per-page search is adequate for current scale.
- **Complexity:** M

### MS-09: "Needs attention" indicators

- **Area:** Dashboard / operations
- **Current state:** No alerts for approaching deadlines, pending member approvals, overdue obligations.
- **Evidence:** No notification or alert infrastructure.
- **User impact:** Officers must proactively check each collection and the member pending queue.
- **Dependency/blocker:** None.
- **Recommended action:** Add a "needs attention" widget to community overview.
- **Complexity:** S

### MS-10: Terminology overrides

- **Area:** Community / customization
- **Current state:** `community_labels` table exists in DB with configurable terms (member, group, collection, etc.). But no UI to configure it.
- **Evidence:** `supabase/migrations/20260917120300` — `community_labels` table.
- **User impact:** Every community uses the same terminology regardless of type (church vs alumni vs estate).
- **Dependency/blocker:** None.
- **Recommended action:** Defer unless terminology is a launch blocker for specific community types.
- **Complexity:** M

---

## 6. Broken Capabilities

### BK-01: Open redirect on login `?next` parameter — RESOLVED (M10)

- **Area:** Authentication / security
- **Resolution:** `safeRedirectPath()` helper validates the path (must start with `/`, rejects `//`, `://`, `/\`). `LoginForm.tsx` now calls it instead of raw `searchParams.get()`. 9 unit tests in `apps/web/lib/safe-redirect.test.ts`.
- **Complexity:** S

### BK-02: Slug collision with app route segments — RESOLVED (M10)

- **Area:** Community / routing
- **Resolution:** `app.is_reserved_community_slug()` — single source-of-truth function. `app.generate_unique_community_slug()` now skips reserved words. `communities_slug_not_reserved` trigger rejects reserved slugs on INSERT/UPDATE regardless of source. Migration `20260930100000`. 8 pgTAP assertions in `supabase/tests/30_reserved_slugs.sql`.
- **Complexity:** S

### BK-03: No confirmation on member field deletion — RESOLVED (M10)

- **Area:** Member management / settings
- **Resolution:** `DeleteFieldConfirmation` component renders a confirmation dialog before delete. Shows field name and count of affected member values. Cancel returns to config; confirm executes deletion. `MembersClient.tsx` computes `fieldValueCounts` via `useMemo`. E2E test in `tests/e2e/field-deletion-safety.spec.ts`.
- **Complexity:** S

---

## 7. Payment-Blocked Capabilities

All items in this section depend on the Phase 4 payment architecture. The contracts, schema, and test infrastructure are ready; the implementation is gated on Paystack adapter + open decisions.

### PB-01: Payment capture (Paystack initialization + verification)

- **Area:** Payments
- **Current state:** `PaymentProvider` interface defined in `packages/adapters/src/payment-provider.ts`. `createPaymentProvider()` throws: "not implemented... M8.9 requirements". No Paystack HTTP client.
- **Evidence:** `packages/adapters/src/payment-provider.ts` — interface only. `FakePaymentProvider` exists with 11 scenarios and 75 tests.
- **User impact:** No money can move through the system. This is the primary launch blocker.
- **Dependency/blocker:** Paystack test account, staging URL, decisions PA-04 through PA-09.
- **Recommended action:** Phase 4 scope.
- **Complexity:** L

### PB-02: Contribution recording

- **Area:** Financial / ledger
- **Current state:** Ledger schema exists (journals, entries, accounts, balance views). No write path from application code. ADR 0006 defers this; ADR 0012 rejected a pending-contribution table.
- **Evidence:** `supabase/migrations/20260924110000_ledger.sql` — schema complete. No writer in `packages/db/src/write.ts`.
- **User impact:** Contributions cannot be recorded, tracked, or reported.
- **Dependency/blocker:** Depends on PB-01 (payment capture).
- **Recommended action:** Phase 4 scope.
- **Complexity:** L

### PB-03: Receipts and payment confirmation

- **Area:** Contributor experience
- **Current state:** The confirmation screen says "Ready to continue to payment" with honest messaging that nothing has been charged. No receipt generation, no confirmation email.
- **Evidence:** `ContributeForm.tsx:242-249`
- **User impact:** Contributors have no proof of payment.
- **Dependency/blocker:** Depends on PB-01 + PB-02.
- **Recommended action:** Phase 4 scope.
- **Complexity:** M

### PB-04: Financial dashboard (balances, totals, progress)

- **Area:** Dashboard
- **Current state:** Community overview explicitly omits financial figures with comment: "Financial figures (balances, collection totals) belong to Phase 3/4 (ADR 0006)." Balance views exist in DB but no data flows into them.
- **Evidence:** `apps/web/app/c/[slug]/page.tsx:53-55`
- **User impact:** Officers cannot see how much has been collected.
- **Dependency/blocker:** Depends on PB-02.
- **Recommended action:** Phase 4 scope.
- **Complexity:** M

### PB-05: Settlement and withdrawal

- **Area:** Financial / operations
- **Current state:** `SettlementProvider` interface defined. `createSettlementProvider()` throws — gated on DEC-01 (custody model), DEC-03 (subaccount vs balance), DEC-06 (withdrawal initiation). Domain logic (`settlement.ts`) is complete and tested.
- **Evidence:** `packages/adapters/src/settlement-provider.ts`
- **User impact:** Community treasurers cannot withdraw collected funds.
- **Dependency/blocker:** Open decisions DEC-01, DEC-03, DEC-06.
- **Recommended action:** Phase 4 scope.
- **Complexity:** L

### PB-06: Obligation status update to "paid"

- **Area:** Collection management
- **Current state:** Obligations can be assigned, exempted, waived, cancelled — but never marked "paid". Only a verified payment can set this status.
- **Evidence:** `ObligationsPanel.tsx` — no "mark as paid" action. Status transitions in DB enforce this.
- **User impact:** Roll/obligations panel always shows obligations as outstanding even after real-world payment.
- **Dependency/blocker:** Depends on PB-01 + PB-02.
- **Recommended action:** Phase 4 scope.
- **Complexity:** M

### PB-07: Stock/quantity decrement on purchase

- **Area:** Collection management / items and tickets
- **Current state:** Items and tiers have `quantity_available` columns. The public page shows stock. But no purchase transaction means stock never decreases.
- **Evidence:** `ContributeForm.tsx` — shows sold-out state, per-order limits. But `submitContributionAction` does not write to DB.
- **User impact:** Stock shows as always available regardless of real-world sales.
- **Dependency/blocker:** Depends on PB-02.
- **Recommended action:** Phase 4 scope.
- **Complexity:** S (once contribution recording exists)

---

## 8. UX / Mobile Gaps

### UX-01: Touch targets on tier/ticket selection

- **Area:** Public contributor page / mobile
- **Current state:** Radio buttons and checkboxes are 16×16 (`h-4 w-4`). Adequate but not generous for touch interaction.
- **Evidence:** `ContributeForm.tsx` — standard Tailwind sizing.
- **User impact:** Users with larger fingers may have difficulty selecting tiers on mobile.
- **Dependency/blocker:** None.
- **Recommended action:** Increase hit area to at least 24×24 or wrap in larger touch target.
- **Complexity:** S

### UX-02: Export panel on mobile

- **Area:** Collection management / mobile
- **Current state:** `ExportPanel.tsx` has complex filter/field selection UI that may be cumbersome on small screens.
- **Evidence:** Export panel uses multi-section layout with checkboxes.
- **User impact:** Export is primarily an officer desktop workflow; low mobile priority.
- **Dependency/blocker:** None.
- **Recommended action:** Defer — export is a desktop workflow.
- **Complexity:** S

### UX-03: "Back to form" resets contribution state

- **Area:** Public contributor page
- **Current state:** After viewing the contribution summary, pressing "Back to the form" clears all entered data.
- **Evidence:** `ContributeForm.tsx` — state resets on navigation.
- **User impact:** Contributors who want to change one field must re-enter everything.
- **Dependency/blocker:** None.
- **Recommended action:** Preserve form state when navigating back from summary.
- **Complexity:** S

### UX-04: No returning contributor experience

- **Area:** Public contributor page
- **Current state:** A contributor who returns to the same collection page sees a fresh form with no memory of their prior visit.
- **Evidence:** No `localStorage` or cookie persistence of contribution form data.
- **User impact:** Low — contributions are a one-time action per collection period.
- **Dependency/blocker:** None.
- **Recommended action:** Defer.
- **Complexity:** S

---

## 9. Accessibility Gaps

### A11Y-01: No `aria-live` regions for dynamic content

- **Area:** Accessibility / screen readers
- **Current state:** Search results, form errors, and status transitions update without screen reader announcement. No `aria-live` regions.
- **Evidence:** `MembersClient.tsx`, `ContributeForm.tsx`, `FindYourself.tsx` — no `aria-live` attributes.
- **User impact:** Screen reader users won't be notified when search results change or errors appear.
- **Dependency/blocker:** None.
- **Recommended action:** Add `aria-live="polite"` to search result containers and error banners.
- **Complexity:** S

### A11Y-02: Focus management after dialogs

- **Area:** Accessibility / keyboard navigation
- **Current state:** Focus management depends on the `Dialog` component from `@kolekto/ui` (Radix-based). Implementation not fully audited but Radix Dialog handles focus trapping by default.
- **Evidence:** `packages/ui/src/components/Dialog.tsx` — uses Radix.
- **User impact:** Likely adequate via Radix defaults, but not verified.
- **Dependency/blocker:** None.
- **Recommended action:** Verify with keyboard-only testing. Low risk given Radix.
- **Complexity:** S

### A11Y-03: No skip navigation link

- **Area:** Accessibility / keyboard navigation
- **Current state:** No skip link to main content. Keyboard users must tab through the entire sidebar navigation on every page.
- **Evidence:** `AppShell.tsx` — no skip link.
- **User impact:** Keyboard-only users have degraded navigation experience.
- **Dependency/blocker:** None.
- **Recommended action:** Add a visually hidden skip link before the sidebar.
- **Complexity:** S

### A11Y-04: No reduced-motion handling

- **Area:** Accessibility / motion sensitivity
- **Current state:** No `prefers-reduced-motion` media queries found in app code. May exist in `@kolekto/ui`.
- **Evidence:** No `prefers-reduced-motion` in `apps/web/`.
- **User impact:** Users with vestibular disorders may experience discomfort if animations exist.
- **Dependency/blocker:** None.
- **Recommended action:** Audit for animations and add motion preference support.
- **Complexity:** S

### A11Y-05: Color contrast unverified

- **Area:** Accessibility / visual
- **Current state:** Uses CSS custom properties for colors. Actual contrast ratios not verified.
- **Evidence:** Theme values in `apps/web/` globals.
- **User impact:** Could fail WCAG AA contrast requirements.
- **Dependency/blocker:** None.
- **Recommended action:** Run axe or Lighthouse audit on key pages.
- **Complexity:** S

---

## 10. Testing Gaps

### TG-01: No server action unit tests

- **Area:** Testing / web layer
- **Current state:** Server actions (e.g., `createCollectionAction`, `updateMemberAction`, `submitContributionAction`) are tested only indirectly through E2E tests. No isolated unit tests.
- **Evidence:** No `*.test.ts` files adjacent to `actions.ts` files (only `export-fields.test.ts` and `flows.test.ts`).
- **User impact:** Edge cases in server actions may not be caught until E2E.
- **Dependency/blocker:** None.
- **Recommended action:** Add targeted tests for the most complex server actions (contribution resolution, collection lifecycle transitions).
- **Complexity:** M

### TG-02: No accessibility test integration

- **Area:** Testing / accessibility
- **Current state:** No axe, Lighthouse, or other a11y testing in the test suite.
- **Evidence:** No accessibility-related test dependencies in `package.json`.
- **User impact:** Accessibility regressions can go undetected.
- **Dependency/blocker:** None.
- **Recommended action:** Add axe-core integration to one or two key E2E specs.
- **Complexity:** S

### TG-03: No UI component tests

- **Area:** Testing / UI layer
- **Current state:** `@kolekto/ui` components (Button, Dialog, Card, Field, Table, Badge, States) have no unit tests.
- **Evidence:** No test files in `packages/ui/`.
- **User impact:** Low — these are thin wrappers, and E2E covers most usage.
- **Dependency/blocker:** None.
- **Recommended action:** Defer. E2E coverage is adequate for these primitives.
- **Complexity:** S

### TG-04: No payment flow tests

- **Area:** Testing / financial
- **Current state:** No test covers payment initialization, checkout, webhook, contribution recording, or balance update. The `FakePaymentProvider` is tested (75 tests) but never integrated into an E2E flow.
- **Evidence:** `packages/adapters/test/fake-payment-provider.test.ts` — adapter tested in isolation.
- **User impact:** N/A until Phase 4.
- **Dependency/blocker:** Phase 4 payment implementation.
- **Recommended action:** Build E2E payment tests alongside Phase 4 implementation.
- **Complexity:** L

### TG-05: Two test runners

- **Area:** Testing / infrastructure
- **Current state:** `node:test` for domain/validation/adapter/config packages, `vitest` for apps/web. Both work but configuration is duplicated.
- **Evidence:** `packages/domain/test/` uses `node:test`; `apps/web/vitest.config.ts` exists.
- **User impact:** None for developers (both run via `npm test`), but inconsistent patterns.
- **Dependency/blocker:** None.
- **Recommended action:** Defer. Not a product blocker.
- **Complexity:** M (to consolidate)

### What IS well-tested

The existing coverage is strong:

- **29 pgTAP database tests** (769+ assertions): RLS, grants, money invariants, auth, RBAC, collections, obligations, identity, groups, invitations, audience, types, contributor identification, check-in, references, fees, ledger, idempotency, migration.
- **13 E2E Playwright specs** (~50 tests): auth, community, member, groups, invitations, identity, protected routes, audience, contributor flow, references/exports, all 7 collection types, mobile wizard.
- **7 domain unit test suites**: money (53 tests), fees (50+ tests), contribution (60+ tests), settlement (30+ tests), reference, csv, report.
- **5 validation test suites**: collection, community, contribution, member, invite.
- **4 web unit test suites**: flows (30 tests), export-fields, format, PDF report.
- **1 adapter test suite**: fake payment provider (75 tests).
- **6 source-tree invariants** enforced by CI: money is bigint kobo, RLS on every table, no money writes outside DB, one Paystack caller, one fee implementation, explicit grants per function.

---

## 11. Technical Debt Affecting Launch

### TD-01: Worker is empty

- **Area:** Infrastructure
- **Current state:** `apps/worker/src/index.ts` is a single `console.log` line. No queue, no job processor, no webhook receiver.
- **Evidence:** `apps/worker/src/index.ts` — one line.
- **User impact:** Every async operation (webhook processing, settlement release, notification delivery, large export generation) is blocked.
- **Dependency/blocker:** Phase 4 requires this.
- **Recommended action:** Set up worker infrastructure when building notifications or payment webhook handling.
- **Complexity:** M

### TD-02: No app-level React error boundary

- **Area:** Error handling
- **Current state:** `apps/web/app/error.tsx` exists (global Next.js error page) but no React error boundary wraps individual route segments. An unhandled error in any component may white-screen the entire application.
- **Evidence:** `apps/web/app/error.tsx` — present. No `ErrorBoundary` components in route layouts.
- **User impact:** A bug in one section (e.g., collections) could take down the entire app view.
- **Dependency/blocker:** None.
- **Recommended action:** Next.js App Router `error.tsx` files per route segment already handle this. Verify the existing `error.tsx` catches all routes.
- **Complexity:** S

### TD-03: Member list performance

- **Area:** Performance
- **Current state:** All members + attributes + groups loaded in a single server query. No pagination.
- **Evidence:** `apps/web/app/c/[slug]/members/page.tsx:28-46`
- **User impact:** Unacceptable load times for communities with 1000+ members.
- **Dependency/blocker:** None.
- **Recommended action:** Server-side pagination before launch.
- **Complexity:** M

### TD-04: In-memory rate limiter

- **Area:** Security / infrastructure
- **Current state:** `lookup-throttle.ts` uses a `Map` — resets on process restart, no cross-instance coordination.
- **Evidence:** `apps/web/lib/lookup-throttle.ts`
- **User impact:** Rate limiting ineffective after restart or across multiple instances.
- **Dependency/blocker:** Production deployment architecture.
- **Recommended action:** Move to edge-level rate limiting (Vercel, Cloudflare) or Redis-backed limiter before launch.
- **Complexity:** S

### TD-05: Export catalogue blocks money columns

- **Area:** Export / financial
- **Current state:** `export-fields.test.ts` has a FORBIDDEN list that fails the build if any export column names payment/balance/transaction concepts.
- **Evidence:** `apps/web/app/c/[slug]/collections/[collectionSlug]/export-fields.test.ts`
- **User impact:** None currently. Must be relaxed when contributions are recordable (Phase 4).
- **Dependency/blocker:** Phase 4.
- **Recommended action:** Update the forbidden list when payment fields are added.
- **Complexity:** S

### TD-06: Large component files

- **Area:** Maintainability
- **Current state:** Several files are 700-1200 lines: `NewCollectionForm.tsx` (1212), `SettingsPanel.tsx` (729), `ObligationsPanel.tsx` (745), `CollectionDetailClient.tsx`.
- **Evidence:** File sizes.
- **User impact:** None for users. Developer experience concern.
- **Dependency/blocker:** None.
- **Recommended action:** Defer. Well-structured internally; splitting is cosmetic.
- **Complexity:** S each

---

## 12. Explicitly Deferred Work

### Payment architecture (Phase 4)

| Feature | Source | Status |
|---------|--------|--------|
| Paystack adapter | `createPaymentProvider()` throws | Gated on M8.9: test account, staging URL, PA-04–PA-09 |
| Contribution recording / ledger writer | ADR 0006 | Deferred to Phase 4 |
| Settlement / withdrawal | `createSettlementProvider()` throws | Gated on DEC-01, DEC-03, DEC-06 |
| Refund flow | Ledger has `collection_refund_reserve` account | No application code |
| Chargeback handling | Ledger has `collection_chargeback` account | No application code |
| Installment tracking | Schema supports `installments_allowed` | No payment writer to track partial payments |

### Pending-contribution table

ADR 0012 **rejected** this — it will not exist. Contributions are recorded only when payment is verified.

### Legacy migration

| Feature | Source | Status |
|---------|--------|--------|
| D2 production rehearsal | `MIGRATION-PAUSED-CHECKPOINT.md` | B1-B4 complete (49/49 tests passing), rehearsal deferred |
| Storage/image migration | Same checkpoint | All image fields null in migration; deferred |
| Live production delta strategy | Same checkpoint | New data during cutover window; deferred |
| `auth.users` credential migration | Same checkpoint | Blocked by Supabase platform limitation |

### Other deferred items

| Feature | Status | Notes |
|---------|--------|-------|
| Staff admin realm | ADR 0009 | Separated by design; not built |
| Edge functions | ADR 0005 | Rejected — will not exist |
| MFA enrollment | TOTP enabled in config | No UI; needed when withdrawal exists (SEC-02) |
| Dark mode | Not started | Light theme only |
| Multi-language / i18n | Not started | English only |
| Mobile app | Not started | Web-only, responsive design |
| Public API | Not started | No external integration API |
| Offline support | Not started | No service worker |

### Open decisions (from code comments and docs)

| Decision | Description |
|----------|-------------|
| DEC-01 | Custody model: who holds the money |
| DEC-03 | Subaccount vs balance model |
| DEC-06 | Withdrawal initiation: who triggers, what approvals |
| DEC-17 | SMS provider for phone OTP |
| PA-04–PA-09 | Paystack integration specifics |

---

## 13. Recommended Build Sequence

The following sequence builds value incrementally, each item unlocking something users can see or do. Non-payment items first (since Phase 4 payment is a separate, larger workstream).

### Phase A: Launch-readiness (pre-payment)

1. **Account settings page** (MS-02) — S
   - Users need to be able to edit their name at minimum.
   - Unblocks: user profile completeness.

2. **Member pagination** (MS-03 / TD-03) — M
   - Required for any community importing from the legacy system (500+ members).
   - Unblocks: launch for existing communities.

3. **Open redirect fix** (BK-01) — S
   - Security fix. Must ship before public launch.
   - Unblocks: security baseline.

4. **Slug collision guard** (BK-02) — S
   - Prevent community slugs from colliding with app routes.
   - Unblocks: safety for self-serve community creation.

5. **Field deletion confirmation** (BK-03) — S
   - Prevent accidental data loss.
   - Unblocks: safe member profile configuration.

6. **Accessibility basics** (A11Y-01, A11Y-03) — S
   - `aria-live` regions + skip navigation link.
   - Unblocks: basic WCAG compliance.

7. **Community logo upload + display** (MS-07) — S
   - Upload in settings, render on public pages.
   - Unblocks: community branding.

8. **First-time onboarding** (PC-01) — S
   - Welcome state or guide on first login.
   - Unblocks: user activation.

9. **Invite link expiry/max-uses** (PC-04) — S
   - Expose existing schema fields in UI.
   - Unblocks: invite link security.

10. **Session configuration** (PC-06) — S
    - Configure session duration per SEC-04.
    - Unblocks: production session handling.

### Phase B: Operational depth

11. **"Needs attention" dashboard** (MS-09) — S
    - Approaching deadlines, pending approvals, overdue.
    - Unblocks: officer workflow efficiency.

12. **Community switcher dropdown** (PC-03) — S
    - Quick switch without navigating away.
    - Unblocks: multi-community officer UX.

13. **Bulk CSV member import** (MS-04) — M
    - Most-requested feature for community migration.
    - Unblocks: onboarding communities with existing member lists.

14. **Cross-collection dashboard metrics** (MS-06) — M
    - Collection count, recent collections, aggregate status.
    - Unblocks: community-level operational visibility.

15. **Transactional email foundation** (MS-01, partial) — M
    - Email provider, templates for: member joined, officer invitation, collection published.
    - Unblocks: basic notification coverage.

### Phase C: Payment (Phase 4)

16. **Paystack adapter** (PB-01) — L
17. **Contribution recording** (PB-02) — L
18. **Webhook receiver + worker** (TD-01) — M
19. **Payment confirmation + receipts** (PB-03) — M
20. **Financial dashboard** (PB-04) — M
21. **Settlement + withdrawal** (PB-05) — L

---

## 14. Proposed MVP / Launch Boundary

### MVP (can launch with)

The application is launchable for **non-payment use cases** today. Communities can:
- Create and manage their organization
- Manage members with codes, groups, and custom identity
- Create all 7 collection types
- Assign obligations and track who owes what
- Share public collection pages for contributors to identify themselves
- Export data
- Manage officers and roles

### Hard launch requirements (before accepting real money)

| Requirement | Status | Notes |
|-------------|--------|-------|
| Phase A items 1-6 (security, pagination, accessibility) | Not started | ~2 weeks of work |
| Paystack adapter | Not started | Phase 4, gated on decisions |
| Contribution recording | Not started | Phase 4 |
| Webhook processing | Not started | Requires worker infrastructure |
| Receipt generation | Not started | Phase 4 |
| Basic transactional email | Not started | At minimum: payment confirmation |

### Soft launch boundary (recommended)

Launch with Phase A (items 1-10) complete. This gives:
- A secure, accessible, production-ready application
- Full pre-payment product surface
- Community branding
- User onboarding
- Session management
- All security fixes applied

Communities can start using Kolekto for member management, obligation tracking, and collection organization immediately — with payment coming in Phase 4.

### What to explicitly defer past launch

- Member merge (MS-05)
- Global search (MS-08)
- Terminology overrides (MS-10)
- Dark mode
- Mobile app
- In-app notification center (email is sufficient initially)
- Public API

---

## 15. Immediate Next 5 Engineering Tasks

These are the highest-impact tasks to start after this audit, ordered by value and risk:

### ~~1. Fix open redirect on `?next` parameter (BK-01)~~ — DONE (M10)

> Resolved in M10 Product Safety Hardening. See `docs/product/M10-PRODUCT-SAFETY-HARDENING.md`.

### ~~2. Add slug collision guard (BK-02)~~ — DONE (M10)

> Resolved in M10 Product Safety Hardening. See `docs/product/M10-PRODUCT-SAFETY-HARDENING.md`.

### ~~3. Add field deletion confirmation dialog (BK-03)~~ — DONE (M10)

> Resolved in M10 Product Safety Hardening. See `docs/product/M10-PRODUCT-SAFETY-HARDENING.md`.

### 4. Implement member list server-side pagination (MS-03 / TD-03)

**Why fourth:** Required for any community with a meaningful member base. Performance blocker.

- Files: `apps/web/app/c/[slug]/members/page.tsx`, `MembersClient.tsx`, `actions.ts`
- Change: Add cursor-based pagination, move search to server-side
- Complexity: M (1-2 days)
- Test: E2E test with >50 members, verify pagination controls

### 5. Create user account settings page (MS-02)

**Why fifth:** Users currently cannot edit their own name.

- Files: New route `apps/web/app/account/page.tsx` + `AccountClient.tsx` + `actions.ts`
- Change: Name editing, display email/phone (read-only initially), sign-out
- Complexity: S (half day)
- Test: E2E test for name update

---

## Methodology

This audit read every route, component, server action, layout, middleware, library, test file, and key migrations in the codebase. No code was modified. No staging or production environments were accessed. No migration work was performed.

Files inspected in full:
- All files under `apps/web/app/` (73 files — routes, pages, layouts, actions, client components)
- All files under `apps/web/lib/` (16 files — auth, permissions, supabase, format, display, PDF)
- `apps/web/components/AppShell.tsx`
- `apps/web/middleware.ts`
- All files under `packages/domain/src/` and `packages/domain/test/` (14 files)
- All files under `packages/validation/src/` and `packages/validation/test/` (12 files)
- All files under `packages/adapters/src/` and `packages/adapters/test/` (6 files)
- All files under `packages/db/src/` (5 files)
- `packages/config/src/env.ts` and test
- `apps/worker/src/index.ts`
- All 13 E2E test files + 3 helper files
- All 29 pgTAP test files (by name; key files in full)
- Key migration files (75 total; ~30 read in full for schema verification)
- `docs/migration/legacy/MIGRATION-PAUSED-CHECKPOINT.md`
- `docs/phase-4/` planning documents

The migration workstream (paused at `docs/migration/legacy/MIGRATION-PAUSED-CHECKPOINT.md`) was verified as documented but is out of scope for this audit.
