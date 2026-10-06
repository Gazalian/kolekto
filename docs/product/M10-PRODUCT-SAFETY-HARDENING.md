# M10: Product Safety Hardening

**Date:** 2026-09-30
**Scope:** Three targeted fixes for audit findings BK-01, BK-02, BK-03
**Environment:** Local development only — no staging or production changes

---

## Issue 1: Login open redirect on `?next` parameter (BK-01)

### Problem

`LoginForm.tsx` read the `?next` search parameter and passed it directly to `router.push()` after OTP verification. An attacker could craft a URL like `/login?next=https://evil.com` to redirect users to an external site after sign-in.

### Root cause

No input validation on the redirect target. The value was used as-is from `searchParams.get("next")`.

### Implementation

Created a reusable `safeRedirectPath()` helper that validates the redirect path:

- Must be a string starting with `/`
- Rejects `//` prefix (protocol-relative URLs)
- Rejects paths containing `://` (absolute URLs embedded in path)
- Rejects `/\` prefix (backslash protocol-relative on some browsers)
- Falls back to `/communities` for any invalid input (null, undefined, empty string, external URLs)

### Files changed

| File | Change |
|------|--------|
| `apps/web/lib/safe-redirect.ts` | New — `safeRedirectPath()` helper |
| `apps/web/lib/safe-redirect.test.ts` | New — 9 vitest unit tests |
| `apps/web/app/(auth)/login/LoginForm.tsx` | Import + use `safeRedirectPath()` on line 22 |

### Tests added

9 unit tests covering:
- Valid relative paths (with and without query strings)
- External URLs (`https://`, `http://`)
- Protocol-relative URLs (`//evil.com`)
- JavaScript protocol (`javascript:alert(1)`)
- Backslash variant (`/\evil.com`)
- Null, undefined, empty string inputs

### Test results

All 9 tests pass.

### Security implications

Eliminates the open redirect vector. Client-side only (not a server redirect), so the original severity was low, but this is standard defense-in-depth.

### Remaining limitations

- The helper only validates the path shape, not whether the path exists as an app route. A redirect to `/nonexistent` would 404, which is acceptable.
- If additional auth entry points are added in the future, they should also use `safeRedirectPath()`.

---

## Issue 2: Reserved community slug collision guard (BK-02)

### Problem

Community slugs are auto-generated from the community name, but the generator did not exclude application route segments (`c`, `communities`, `login`, `logout`, `invite`, `accept-invite`, `api`). A community with a matching name would produce a slug that shadows an app route.

### Root cause

`APP_SEGMENTS` existed in the middleware for routing decisions, but the DB-level slug generator had no knowledge of reserved words.

### Implementation

Defense in depth with three layers:

1. **`app.is_reserved_community_slug(text)`** — immutable SQL function returning true for reserved slugs. Single source of truth referenced by both the generator and the trigger.

2. **`app.generate_unique_community_slug(text)`** — replaced to skip reserved slugs in its allocation loop. If the base slug is reserved, it appends `-2`, `-3`, etc.

3. **`communities_slug_not_reserved` trigger** — BEFORE INSERT OR UPDATE trigger on `public.communities` that rejects reserved slugs regardless of how they were sourced (generator, manual SQL, migration).

### Files changed

| File | Change |
|------|--------|
| `supabase/migrations/20260930100000_reserved_community_slugs.sql` | New migration — function, generator replacement, trigger |
| `supabase/tests/30_reserved_slugs.sql` | New — 8 pgTAP assertions |

### Tests added

8 pgTAP assertions:
- Reserved words `c`, `communities`, `login`, `api` are all recognized
- Normal slug `kwasu-alumni` is not reserved
- Slug generator does not return a reserved slug
- Slug generator still produces expected base for normal names
- Case-insensitive check (`Login` is also reserved)

### Test results

All 8 assertions pass. All 777 tests across 30 pgTAP files pass (no regressions).

### Security implications

Eliminates the route-shadowing vector. The trigger makes this a hard constraint — no code path, including raw SQL, can create a community with a reserved slug.

### Remaining limitations

- The reserved list must be manually kept in sync with `APP_SEGMENTS` in middleware. A comment in the migration file documents this.
- Adding a new app route segment in the future requires updating both the middleware set and the DB function. This is intentional — the DB function is the authority, and a mismatch would be caught by existing tests.

---

## Issue 3: Member custom-field deletion confirmation (BK-03)

### Problem

Deleting a community-defined member attribute definition cascades to ALL stored values for ALL members. The delete button had no confirmation — one click destroyed data across the entire community.

### Root cause

The delete action was wired directly to the button's `onClick` with no intermediate confirmation step. The DB function (`app.delete_member_attribute_definition`) already counted affected values and logged them to the audit trail, but the UI didn't surface this information before acting.

### Implementation

1. **`fieldValueCounts` computation** in `MembersClient.tsx` — a `useMemo` that counts non-null, non-empty values per attribute definition across all member rows. Passed as a prop to `MemberProfileConfig`.

2. **`deleting` state** in `MemberProfileConfig` — clicking Remove sets this state instead of executing the action.

3. **`DeleteFieldConfirmation` component** — renders a Dialog showing:
   - The field name being deleted (in the title)
   - Count of affected member values with appropriate singular/plural
   - Cancel button (returns to config)
   - Destructive "Remove field" button (uses `variant="danger"`)
   - Loading state during deletion
   - Error handling (surfaces server errors as a banner)

### Files changed

| File | Change |
|------|--------|
| `apps/web/app/c/[slug]/members/MembersClient.tsx` | Added `fieldValueCounts` useMemo + prop |
| `apps/web/app/c/[slug]/members/MemberProfileConfig.tsx` | Added `deleting` state, `DeleteFieldConfirmation` component, `fieldValueCounts` prop |
| `tests/e2e/field-deletion-safety.spec.ts` | New — E2E test for confirmation flow |

### Tests added

E2E test (`field-deletion-safety.spec.ts`):
- Creates a community with a custom field
- Adds a member with a value for the field
- Clicks Remove — confirms the confirmation dialog appears with value count
- Clicks Cancel — confirms the field is still present
- Clicks Remove again, then confirms — verifies the field is deleted

### Test results

Typecheck: pass. Lint: pass. Build: pass. Unit tests (safe-redirect): 9/9 pass. pgTAP: 777/777 pass.

E2E test written but not yet executed (requires running Playwright against a live local stack with the Supabase dev server).

### Security implications

None — this is a UX safety improvement, not a security fix. The underlying DB function's behavior is unchanged.

### Remaining limitations

- The value count is computed client-side from the already-loaded member rows. If the member list is paginated in the future (MS-03), the count would need to come from a server-side query instead.

---

## Summary

| Issue | Status | Tests |
|-------|--------|-------|
| BK-01: Open redirect | RESOLVED | 9 unit tests pass |
| BK-02: Slug collision | RESOLVED | 8 pgTAP assertions pass |
| BK-03: Field deletion safety | RESOLVED | E2E written, typecheck + lint + build pass |

### Verification matrix

| Check | Result |
|-------|--------|
| TypeScript typecheck | Pass |
| ESLint | Pass |
| Next.js build | Pass |
| Vitest (safe-redirect) | 9/9 pass |
| pgTAP (all 30 files) | 777/777 pass |
| E2E (field-deletion-safety) | Written, not yet run against live stack |

### Not touched

- No staging or production changes
- No database reset
- No migration data modified
- No Paystack integration
- No financial ledger changes
- No D2 migration rehearsal
- No legacy migration importer changes
- No new dependencies added
- No unrelated refactoring
