# Current Onboarding UX and Architecture Review

**Date:** 2026-09-30
**Purpose:** Document the current onboarding experience before deciding whether to introduce an automatic personal workspace.

---

## Answers to Questions (from actual code)

### A. Does a newly registered user automatically receive any community/workspace?

**No.**

- **File:** `supabase/migrations/20260930110000_auth_onboarding_state.sql:50-82`
- **Function:** `app.handle_new_auth_user()` (trigger on `auth.users` INSERT)
- **Behavior:** The trigger creates only a `public.users` row (full_name, phone_e164, email). It does NOT create a community, officer term, or any other record.
- **Status:** This is a deliberate design decision. The previous trigger created a personal community automatically; the current migration replaced it to move community creation into the onboarding flow.

### B. If not, exactly when is the first community created?

At the end of the onboarding flow, when the user submits the "Create community" form on `/setup/create`.

- **File:** `apps/web/app/(onboarding)/setup/create/actions.ts:13-44`
- **Function:** `setupCreateCommunityAction`
- **Behavior:** Validates input with `createCommunitySchema`, calls `createCommunity(caller, parsed.data)` (which calls `app.create_community`), then calls `completeOnboarding(caller)`, then redirects to `/c/[slug]`.

### C. What is the exact name of that first community?

Whatever the user types into the "Community name" text field. There is no default name, no auto-generated name.

- **File:** `apps/web/app/(onboarding)/setup/create/SetupCreateForm.tsx:56`
- **Component:** `<TextField label="Community name" name="name" required placeholder="Ikoyi Residents Association" />`
- **Behavior:** The placeholder is "Ikoyi Residents Association". The field is required. Name must be 3-80 characters (`createCommunitySchema`). The user must actively choose a name.

### D. Is the first community personal, organizational, or generic?

**Organizational.** It is a non-personal community of a user-chosen type.

- **File:** `supabase/migrations/20260918140100_application_write_functions.sql:105-106`
- **Function:** `app.create_community` — `if p_type = 'personal' then raise exception`
- **Behavior:** `app.create_community` explicitly rejects `type = 'personal'`. The INSERT uses `is_personal = false`. The user picks from 11 organizational types (university_association, fellowship, cooperative, etc.). The type "personal" exists in the DB enum but is excluded from `COMMUNITY_TYPES` in the validation package.

### E. Can the user skip community creation?

**No.** The middleware forces un-onboarded users into the onboarding flow.

- **File:** `apps/web/lib/supabase/middleware.ts:120-121`
- **Function:** `updateSession` middleware
- **Behavior:** `if (!onboarded && !isOnboardingPath(pathname))` → redirect to `/welcome`. The only path through onboarding is: `/welcome` → `/setup/type` → `/setup/create` → submit form → community created → `completeOnboarding` → redirect to `/c/[slug]`. There is no "Skip" button, no alternative path, no way to reach `/communities` or any protected page without completing onboarding.

### F. Can the user immediately create a collection without manually understanding or creating a community?

**No.** Collections exist inside communities. The path to create a collection is:

1. Complete onboarding (create a community)
2. Navigate to `/c/[slug]/collections`
3. Click "New collection" (requires `collection.draft` permission — granted to owners)

- **File:** `apps/web/app/c/[slug]/collections/new/page.tsx:20`
- **Behavior:** `if (!hasPermission(access, "collection.draft")) redirect(...)` — the user must have a role in a community and the `collection.draft` permission.

### G. What happens if the user signs up but abandons onboarding?

They are stuck. On every subsequent visit to any protected page, middleware redirects them to `/welcome`.

- **File:** `apps/web/lib/supabase/middleware.ts:118-121`
- **Behavior:** `onboarding_completed_at` remains NULL. Every request to a non-public, non-onboarding path triggers `!onboarded && !isOnboardingPath` → redirect `/welcome`. The user can access `/account` only if it is an onboarding path (it is NOT — it would redirect to `/welcome`). They can sign out (via `/logout`), but signing back in restarts the same loop.

### H. What happens when the user logs in again before completing onboarding?

Same as G. Middleware checks `onboarding_completed_at` on every request to protected pages. If NULL, redirect to `/welcome`. The user re-enters the onboarding flow exactly where the middleware puts them — at `/welcome`, not at wherever they left off.

- **File:** `apps/web/lib/supabase/middleware.ts:112-121`
- **Behavior:** No partial-progress tracking. `/setup/type` and `/setup/create` are stateless client components — they read query params, not saved state.

### I. What happens after onboarding is completed?

The user is redirected to `/c/[slug]` (the community dashboard they just created). From there:

- Sidebar shows: Overview, Collections, Members, Activity, Settings
- Sidebar header has "← All communities" link to `/communities`
- Community dashboard shows member count (0) and officer count (1 — the user is the owner)

- **File:** `apps/web/app/c/[slug]/layout.tsx:26` → `AppShell` component
- **File:** `apps/web/components/AppShell.tsx:16-23` — nav items
- **Behavior:** The user lands on a community page with no members and no collections. The empty state for collections says "No collections yet — Create your first collection to start collecting toward one purpose."

### J. Is the created community private or publicly discoverable?

**Private by default.** Visibility is controlled by RLS.

- **File:** `supabase/migrations/20260917120300_communities.sql:89` — `enable row level security`
- **Behavior:** `communities_select_officer` RLS policy returns only communities where the caller holds an active officer term. There is no public listing of communities. The community is visible only to its officers (initially just the creator/owner). The community's `slug` forms a URL path (`/{slug}/{collection-slug}`) for public collection pages, but the community itself has no public-facing page — only published collections within it are publicly accessible.

### K. Can a user create additional communities later?

**Yes.** `/communities` page has a "+ New community" link to `/communities/new`.

- **File:** `apps/web/app/communities/page.tsx:22` — `<Link href="/communities/new">+ New community</Link>`
- **File:** `apps/web/app/communities/new/NewCommunityForm.tsx` — same fields as onboarding (name, type, description)
- **Behavior:** Uses the same `app.create_community` DB function. No limit on number of communities. Each new community gets a new officer term (owner) for the creator.

### L. How does the current UI expose/switch between multiple communities?

A flat list at `/communities`, plus a "← All communities" link in every community's sidebar.

- **File:** `apps/web/app/communities/page.tsx:28-48` — grid of community cards
- **File:** `apps/web/components/AppShell.tsx:104` — `<Link href="/communities">← All communities</Link>`
- **Behavior:** No dropdown switcher, no global sidebar, no persistent community selector. The user navigates to `/communities`, sees all communities they belong to as cards, clicks one. Inside a community, they click "← All communities" to go back. Personal communities (from before the migration) display a "Personal" badge.

### M. Is "community" currently understandable to a first-time user, or is it primarily an internal product concept exposed in the UI?

**It is exposed in the UI as the primary organizing concept.** The word "community" appears everywhere:

- Welcome page: "Let's set up your first community."
- Type picker: "What kind of community are you setting up?" with options like "Fellowship", "Cooperative", "Estate"
- Create form: "Community name"
- Dashboard: "Your communities", "+ New community", "← All communities"
- Empty state: "No communities yet — Create one to start collecting money from a group."

For Kolekto's target users (Nigerian group treasurers, association officers), the term "community" maps to a real-world concept they already use. However, it creates friction for a solo user who just wants to collect money from a few people — they must choose a "community type" and name it before they can do anything.

---

## 1. Current Onboarding Flow

```
SIGNUP                      AUTH LAYER
─────────────────────────────────────────────────
  /signup
    │ name, email, phone, password
    ▼
  auth.users INSERT
    │ trigger: app.handle_new_auth_user()
    │   └─ creates public.users row ONLY
    │      (no community, no officer term)
    │      onboarding_completed_at = NULL
    ▼
  /verify?email=...
    │ 6-digit email OTP
    │ verifyOtp(type: "email")
    │ setContactVerifiedAction() → identity_level = contact_verified
    ▼

ONBOARDING                  APP LAYER
─────────────────────────────────────────────────
  /welcome
    │ "Welcome, {firstName}!"
    │ "Let's set up your first community."
    │ [Get started] button
    ▼
  /setup/type
    │ "What kind of community are you setting up?"
    │ Grid: 11 type buttons
    │ (fellowship, cooperative, estate, etc.)
    ▼
  /setup/create?type=...
    │ "Community name" (required, 3-80 chars)
    │ "Description" (optional, up to 500)
    │ [Create community] button
    ▼
  setupCreateCommunityAction()
    │ validate → createCommunity(caller, input)
    │              └─ app.create_community()
    │                   └─ INSERT communities (is_personal=false)
    │                   └─ INSERT officer_terms (role=owner)
    │                   └─ audit log
    │ completeOnboarding(caller)
    │   └─ app.complete_onboarding()
    │        └─ UPDATE users SET onboarding_completed_at = now()
    ▼

POST-ONBOARDING             APP LAYER
─────────────────────────────────────────────────
  redirect → /c/[slug]
    │ Community dashboard
    │ Sidebar: Overview, Collections, Members,
    │          Activity, Settings
    │ 0 members, 1 officer (self)
    │ 0 collections
    ▼
  /c/[slug]/collections
    │ "No collections yet"
    │ [Create a collection] → /c/[slug]/collections/new
    ▼
  First usable screen:
    /c/[slug]/collections/new
```

**Middleware guard (every request):**
```
  Request
    │
    ├─ Not authenticated + not public path → /login
    │
    ├─ Authenticated + auth path → /communities
    │
    └─ Authenticated + protected path
         │
         ├─ onboarding_completed_at = NULL
         │    └─ not onboarding path → /welcome
         │
         ├─ onboarding_completed_at ≠ NULL
         │    └─ onboarding path → /communities
         │
         └─ pass through
```

---

## 2. Current Data Model Flow

```
auth.users INSERT (Supabase Auth)
    │
    │  trigger: app.handle_new_auth_user()
    ▼
public.users
    ├─ id (= auth.users.id)
    ├─ full_name (from metadata or email prefix)
    ├─ phone_e164 (normalized)
    ├─ email
    ├─ identity_level = 'none' (→ 'contact_verified' after email OTP)
    ├─ onboarding_completed_at = NULL
    └─ (no community, no officer term, no member record)

    ... user completes onboarding ...

app.create_community(name, type, description)
    │
    ├──► public.communities
    │      ├─ id (v7 UUID)
    │      ├─ slug (auto-generated from name)
    │      ├─ name (user-chosen)
    │      ├─ type (user-chosen, never 'personal')
    │      ├─ is_personal = false
    │      └─ created_by = user.id
    │
    └──► public.officer_terms
           ├─ community_id
           ├─ user_id
           ├─ role = 'owner'
           └─ start_reason = 'created'

app.complete_onboarding()
    │
    └──► public.users
           └─ onboarding_completed_at = now()

    ... user adds members manually ...

app.create_member(community_id, full_name, phone)
    │
    └──► public.members
           ├─ community_id
           ├─ full_name
           ├─ phone_e164
           └─ status = 'unclaimed'

    ... user creates collection ...

app.create_collection(community_id, name, ...)
    │
    └──► public.collections
           ├─ community_id
           ├─ name
           ├─ status = 'draft'
           └─ (audience, amount, deadline, etc.)
```

Key: the user (auth account) is NOT a member of their own community. The user is an officer (owner). Members are separate people added by officers. Collections belong to communities and target members.

---

## 3. Current User Experience

A brand-new user signing up today sees:

1. **Signup form** — Full name, email, phone, password, confirm password. Submit creates auth account.

2. **Email verification** — "We sent a 6-digit code to {email}." Enter code. Identity level upgraded.

3. **Welcome screen** — "Welcome, {firstName}! Kolekto helps communities collect and manage money together. Let's set up your first community." One button: "Get started."

4. **Community type picker** — "What kind of community are you setting up?" Grid of 11 buttons (Fellowship, Cooperative, Estate, University association, etc.). No explanation of what a "community" is or why they need one.

5. **Community creation form** — "Type: {chosen type} [Change]". Fields: "Community name" (required, placeholder "Ikoyi Residents Association"), "Description" (optional). Submit button: "Create community."

6. **Community dashboard** — Lands on `/c/[slug]`. Sidebar with Overview, Collections, Members, Activity, Settings. Dashboard shows 0 members, 1 officer. Verification banner: "Submitting for verification is not yet available in this build."

7. **Collections page** (one click away) — "No collections yet — Create your first collection to start collecting toward one purpose." [Create a collection] button.

8. **New collection form** (two clicks from landing) — The first screen where the user can actually DO something with Kolekto.

**Total steps from signup to first useful action: 8 screens** (signup → verify → welcome → type → create → dashboard → collections → new collection).

**Total screens the user cannot skip: 5** (signup, verify, welcome, type, create).

---

## 4. Gaps

### Technical Defects

None found in this review. The flow works as implemented. (Defects from the QA audit were already fixed.)

### UX Issues

1. **High friction for solo/simple use cases.** A treasurer who wants to collect graduation dues from 40 classmates must: choose a community type, name the community, understand what a "community" is in Kolekto's model, THEN create a collection. The first useful screen is 8 steps from signup.

2. **No skip path in onboarding.** If a user signed up to explore, they're forced to create a community before seeing any of the product. Abandoned onboarding = permanent redirect loop to /welcome.

3. **"Community type" decision pushed too early.** A first-time user who just wants to collect money is asked to classify their group into one of 11 organizational types before they can proceed. For many use cases (class reunion, birthday fund, neighborhood repair), none of the types feel right — they'd pick "Other."

4. **No personal/default workspace.** The system has the concept of a personal community in the data model (`is_personal`, `community_type = 'personal'`, partial unique index). But the current onboarding never creates one. Existing users who were backfilled have personal communities; new users do not.

5. **Community switching is basic.** "← All communities" link in sidebar, flat list at `/communities`. No dropdown, no persistent switcher. Functional but not fast.

6. **User is not a member of their own community.** The user is an officer (owner), but not in the `members` table. This is architecturally correct (officers and members are separate concerns) but means the user can't be a "contributor" to their own collection without being manually added as a member.

### Product Decisions Needed

1. **Should new users get an automatic workspace?** The data model supports it. The old trigger created one. The current implementation removed it. This is the central question.

2. **What should the first usable action be?** Currently: create a collection (8 steps). Could be: create a collection (3 steps, if auto-workspace exists).

3. **Should community type be required at onboarding?** It could be deferred to settings, or defaulted to a generic type.

4. **Should the personal workspace be visible as a "community" or abstracted?** It could be shown as "Your workspace" or hidden behind a simpler UI.

5. **Should existing backfilled personal communities be treated differently from new ones?** They currently have `is_personal = true` and `type = 'personal'`.

---

## 5. Recommendation — Model Comparison

### Model A: User Must Explicitly Create a Community During Onboarding

*(Current implementation.)*

| Dimension | Implication |
|-----------|-------------|
| **Onboarding friction** | High. 5 mandatory screens before any useful action. Type selection adds cognitive load for simple use cases. Users who don't identify with a "community" may bounce. |
| **Data model** | Clean. Every community is intentional. No orphaned personal workspaces for users who sign up and never return. `is_personal` column and partial unique index exist but are unused for new users. |
| **Collection ownership** | Clear. Every collection belongs to a community the user explicitly created and named. No ambiguity about where a collection "lives." |
| **Multiple communities** | Works well. Each community is distinct and named. The user chose each one. Switching via `/communities` is straightforward. |
| **Public visibility** | Each community has a slug used for public collection URLs (`/{slug}/{collection-slug}`). Since the user named it, the slug is meaningful. |
| **Future organization accounts** | Straightforward. Organizations are just communities with more officers. No personal workspace to reconcile with org structure. |
| **Migration** | No migration needed — this is the current state. Existing backfilled personal communities continue to work. |
| **Permissions/RBAC** | Clean. The user is the owner of a community they created. RBAC grants permissions per community. No special-casing for personal workspaces. |
| **User understanding** | Requires the user to understand that Kolekto is community-first. Users who think of Kolekto as "a way to collect money" rather than "a community platform" may find this confusing. |

### Model B: Auto-Create a Private Personal Workspace, Let User Create Collections Immediately

*(Hypothetical. Partially matches the old trigger behavior.)*

| Dimension | Implication |
|-----------|-------------|
| **Onboarding friction** | Low. Signup → verify → land on personal workspace → create collection. 3-4 screens to first useful action. No type picker, no community naming. The user can start doing what they came for immediately. |
| **Data model** | Adds a record. Every new user gets a `communities` row with `is_personal = true`, `type = 'personal'`. The partial unique index (`communities_one_personal_per_user`) already enforces exactly one per user. The trigger or a post-verification step would need to be updated to create it. |
| **Collection ownership** | Every collection belongs to a community — either the personal workspace or a named community. For solo collectors, all collections live in the personal workspace. This works but means "community" is doing double duty as both "your personal space" and "a group." |
| **Multiple communities** | The personal workspace coexists with named communities. The user's `/communities` page shows both. The UI would need to distinguish them — the current code already shows a "Personal" badge for `is_personal` communities. The user must understand that their personal workspace and their named communities are different things. |
| **Public visibility** | The personal workspace needs a slug for public collection URLs. Auto-generated from the user's name (the old trigger did this). Could be confusing: `kolekto.app/john-doe/graduation-fund` vs `kolekto.app/class-of-2024/graduation-fund`. |
| **Future organization accounts** | Adds complexity. An organization account may want to replace the personal workspace with an org workspace, or the personal workspace may need to coexist with the org's workspace. The personal workspace is per-user, but org accounts are per-organization — different ownership model. |
| **Migration** | Existing users already have personal communities (backfilled). New users created after the current migration do NOT. Implementing Model B requires either: (a) restoring community creation in the trigger, or (b) adding it to the post-verification step, or (c) adding it as a new step after `completeOnboarding`. Also requires deciding what happens to existing new users who signed up after the migration but haven't completed onboarding — they have no personal community and are stuck in the onboarding loop. |
| **Permissions/RBAC** | Same RBAC applies. The user is the owner of their personal workspace. Officers of named communities have their own permissions. No special-casing needed — personal workspace is just a community with `is_personal = true`. However, if the UI hides the "community" concept for the personal workspace, there's a risk of confusion when the user encounters it in named communities. |
| **User understanding** | Lower barrier. The user sees "your workspace" and can act immediately. But the product eventually needs to explain communities (when they want to add officers, share ownership, or hand over administration). The risk: the user builds everything in their personal workspace and never creates a real community, making handover and shared governance harder later. |

---

*Report complete. No code changes made. No migrations applied. No commits.*
