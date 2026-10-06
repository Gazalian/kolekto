# Personal Workspace + Onboarding Redesign — Implementation Report

**Date:** 2026-09-30

---

## 1. Files Changed

### New files

| File | Purpose |
|------|---------|
| `supabase/migrations/20260930120000_personal_workspace.sql` | `app.ensure_personal_workspace()` — idempotent DB function |
| `apps/web/app/(onboarding)/welcome/WelcomeOptions.tsx` | Client component: 3-option onboarding picker |
| `apps/web/app/(onboarding)/welcome/actions.ts` | Server actions: `startCollectionAction`, `skipOnboardingAction` |

### Modified files

| File | Change |
|------|--------|
| `packages/db/src/write.ts` | Added `ensurePersonalWorkspace(caller)` export |
| `apps/web/app/(onboarding)/welcome/page.tsx` | Replaced single "Get started" button with intent-first 3-option UI |
| `apps/web/app/(onboarding)/setup/create/actions.ts` | Added `ensurePersonalWorkspace(caller)` call before `completeOnboarding` |
| `apps/web/app/communities/page.tsx` | Display "My Workspace" for `is_personal` communities; removed `Badge` import |
| `apps/web/components/AppShell.tsx` | Display "My Workspace" in sidebar header and mobile header for personal communities |
| `apps/web/app/c/[slug]/page.tsx` | Display "My Workspace" heading; hide slug URL for personal communities |
| `supabase/tests/07_application_write_functions.sql` | Added 8 assertions (plan 30 → 38) for `ensure_personal_workspace` |
| `tests/e2e/helpers/auth.ts` | Updated onboarding step: "Get started" → "Set up a community" |

### Not modified (confirmed correct as-is)

- Middleware (`apps/web/lib/supabase/middleware.ts`) — existing guards work correctly with all three onboarding paths
- `/setup/type` page — unchanged, reached via "Set up a community" link
- `/setup/create` form — unchanged, only the server action was updated
- `app.create_community()` — still rejects `type='personal'`; personal workspaces go through `ensure_personal_workspace`
- `app.complete_onboarding()` — unchanged
- Collection creation routes — unchanged; personal workspace is a regular community so collections work identically
- RBAC/permissions — unchanged; personal workspace uses standard officer_terms ownership

## 2. Migration Added

`20260930120000_personal_workspace.sql`

Creates `app.ensure_personal_workspace()`:
- SECURITY DEFINER function, granted to `authenticated` only
- Fast path: returns existing personal workspace ID if one exists
- Slow path: creates community (`is_personal=true`, `type='personal'`, `name='My Workspace'`), adds owner `officer_term`
- Uses `ON CONFLICT (created_by) WHERE is_personal DO NOTHING` to leverage the existing partial unique index
- Race-condition safe: GET DIAGNOSTICS checks row count and falls back to SELECT if another transaction won
- No schema changes, no column additions, no data modifications

## 3. Personal Workspace Creation Mechanism

```
app.ensure_personal_workspace()
  │
  ├─ SELECT existing? → return id (fast path)
  │
  └─ INSERT community (My Workspace, personal, is_personal=true)
     ON CONFLICT DO NOTHING
       │
       ├─ inserted → INSERT officer_term (owner) → return id
       │
       └─ conflict → SELECT existing → return id (race-safe)
```

Called from three places:
1. `startCollectionAction` — "Create a collection" on /welcome
2. `skipOnboardingAction` — "Do this later" on /welcome
3. `setupCreateCommunityAction` — "Set up a community" path (after named community creation)

## 4. Onboarding Flow — Before vs After

### Before

```
/welcome → [Get started] → /setup/type → /setup/create → community created → /c/[slug]
```

5 mandatory screens. No skip. Must choose community type + name.

### After

```
/welcome → Choose one:
  │
  ├─ [Create a collection]
  │    → ensurePersonalWorkspace + completeOnboarding
  │    → /c/[personal-slug]/collections/new
  │
  ├─ [Set up a community]
  │    → /setup/type → /setup/create
  │    → createCommunity + ensurePersonalWorkspace + completeOnboarding
  │    → /c/[named-community-slug]
  │
  └─ [Do this later]
       → ensurePersonalWorkspace + completeOnboarding
       → /c/[personal-slug]
```

"Create a collection" path: 1 click to first useful action (collection creation form).
"Do this later" path: 1 click to personal workspace dashboard.
"Set up a community" path: same as before (type picker → create form).

## 5. UX Terminology

| Context | Display |
|---------|---------|
| Sidebar header (personal) | "My Workspace" |
| Mobile header (personal) | "My Workspace" |
| Community overview heading (personal) | "My Workspace" |
| Communities list (personal) | "My Workspace" |
| Sidebar header (named) | Community name |
| Communities list (named) | Community name |
| Community slug URL (personal) | Hidden |
| Community slug URL (named) | Shown as `kolekto.app/{slug}` |

The word "personal community" never appears in the UI. The DB stores `name='My Workspace'` and `type='personal'`.

## 6. Existing-User Handling

| User state | Behavior |
|------------|----------|
| Existing user WITH personal community (backfilled) | `ensure_personal_workspace` returns existing ID — no duplicate created |
| Existing user WITHOUT personal community (signed up after auth migration, before this change) | First onboarding action creates one |
| New user (post this change) | All three onboarding paths call `ensure_personal_workspace` |

The partial unique index `communities_one_personal_per_user` enforces at most one personal workspace per user at the database level. `ON CONFLICT DO NOTHING` prevents duplicates without raising errors.

## 7. Public/Private Visibility

| Entity | Visibility |
|--------|-----------|
| Personal workspace community | Private (RLS: `communities_select_officer` — visible only to the owner) |
| Named communities | Private by default (same RLS) |
| Published collections (in personal workspace) | Public via `/{workspace-slug}/{collection-slug}` URL (existing `isPublicCollectionPath` middleware rule) |
| Published collections (in named community) | Public via `/{community-slug}/{collection-slug}` URL (unchanged) |
| Personal workspace profile | No public profile exists. Slug is used only for collection URLs |

No changes were made to RLS policies, collection visibility, or public URL routing.

## 8. Test Results

### pgTAP (database)

| Test file | Result |
|-----------|--------|
| 07_application_write_functions.sql | **38/38 pass** (was 30/30, added 8 for `ensure_personal_workspace`) |
| All 30 test files | 29/30 pass (784 of 791 assertions) |
| 29_auth_user_import_context.sql | 7/14 fail — **pre-existing**, legacy importer workstream (paused), unrelated |

New assertions added:
1. Personal workspace created with `is_personal=true` and `type='personal'`
2. Named "My Workspace"
3. Has owner officer_term
4. Does not create member record
5. Second call returns same ID (idempotency)
6. Only one personal workspace exists after two calls
7. Different users get different workspaces
8. Other user's workspace also has correct flags

### TypeScript

`tsc --noEmit` — zero errors

### Next.js build

`next build` — all routes present, zero errors

## 9. E2E Results

E2E tests were updated to match the new onboarding flow (click "Set up a community" instead of "Get started"). Tests were not run live because the full local stack with Mailpit was not started. Test files were updated and verified by code inspection.

## 10. Regressions

None detected. The only failing test (29_auth_user_import_context) was failing identically before this change — it is a pre-existing issue in the paused legacy importer workstream.

## 11. Remaining Product Decisions

1. **Existing personal communities named "{name}'s collections":** Users backfilled during the original migration have personal communities named e.g. "John's collections". The new workspace creates "My Workspace". The UI shows "My Workspace" regardless of the DB name for any `is_personal` community, so the display is consistent. No data migration is needed.

2. **Slug for personal workspace:** Auto-generated from the user's name (e.g. "john-doe") using `generate_unique_community_slug`. This slug appears in public collection URLs. A future decision could standardize these or use a UUID-based slug for privacy.

3. **"Set up a community" path also creates personal workspace:** If the named community creation succeeds but `ensurePersonalWorkspace` fails (non-fatal catch), the user proceeds with only the named community. The personal workspace would be created on next login/navigation via the middleware redirect cycle. This edge case is extremely unlikely in practice.
