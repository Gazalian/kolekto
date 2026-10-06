# Authentication & First-Time Onboarding Architecture Audit

**Date:** 2026-09-30
**Scope:** Authentication, signup, user bootstrap, first-time onboarding, personal community model
**Method:** Read-only code inspection of the live codebase
**Constraints:** No code changes. No migration work. No staging/production access. No Paystack. No notifications.

---

## PART 1 — CURRENT AUTHENTICATION ARCHITECTURE

### 1.1 Current Signup Flow

**Current behavior:** There is no dedicated signup screen. Signup and login are the same flow — `signInWithOtp` with `shouldCreateUser: true`. A new email or phone triggers account creation in `auth.users`; a returning one sends a code to the existing account.

**Evidence:** `apps/web/app/(auth)/login/LoginForm.tsx:37-38`

**Implications:** No full name, phone, or password is collected at signup. The user's name is derived from the email prefix (`split_part(new.email, '@', 1)`) or defaults to `'New member'`. Users cannot set their own name during signup.

**Recommendation:** Must change. The placeholder name is a known problem (PRODUCT-COMPLETION-AUDIT PC-01, MS-02).

### 1.2 Current Login Flow

**Current behavior:** Two-step OTP flow:
1. User enters email or phone, clicks "Send code"
2. User enters 6-digit code, clicks "Verify and sign in"
3. On success, redirects to `safeRedirectPath(next)` (default `/communities`)

**Evidence:** `LoginForm.tsx:31-61`

**Implications:** Clean, simple. Email channel works. Phone channel is code-complete but untestable locally (no SMS provider, DEC-17).

**Recommendation:** Remains. OTP login should survive as a code path even if password auth is added.

### 1.3 Email Authentication

**Current behavior:** `supabase.auth.signInWithOtp({ email, shouldCreateUser: true })` sends a 6-digit code via the local SMTP (Mailpit). Template at `supabase/templates/otp.html` renders `{{ .Token }}` as a large numeric code. Both `confirmation` and `magic_link` mail actions use the same template.

**Evidence:** `config.toml:73-107`, `supabase/templates/otp.html`

**Configuration:**
- `otp_expiry = 300` (5 minutes, per SEC-05)
- `otp_length = 6`
- `max_frequency = 60s`
- `enable_confirmations = true`
- Rate limit: 100 emails/hour (local only, raised for E2E suite)

**Recommendation:** Remains. Well-configured.

### 1.4 Phone Authentication

**Current behavior:** `signInWithOtp({ phone, shouldCreateUser: true })` is wired in LoginForm but no SMS provider is configured. Local stack prints codes to CLI log. Actual SMS delivery gated on DEC-17 (SMS provider decision).

**Evidence:** `config.toml:108-126`, `LoginForm.tsx:38,54`

**Configuration:**
- `enable_signup = true`
- `enable_confirmations = true`
- `max_frequency = 60s`
- No otp_expiry/otp_length for SMS (CLI limitation; these are project-level settings)

**Implications:** Phone OTP is structurally ready but operationally inert. Phone normalization exists in the DB (`app.normalise_phone`) but is applied only in `handle_new_auth_user`, not in the login form or client-side validation.

**Recommendation:** Remains. Phone normalization needs to move client-side or pre-validation for the signup form.

### 1.5 OTP Behavior

**Current behavior:**
- 6-digit numeric code
- 5-minute expiry (email; SMS is platform default)
- 60-second minimum between sends
- `shouldCreateUser: true` — so a new email/phone auto-creates an `auth.users` row
- Verification via `verifyOtp({ email/phone, token, type: "email"/"sms" })`
- On verify success, Supabase issues a session (JWT + refresh token)

**Evidence:** `LoginForm.tsx:47-54`, `config.toml:73-80`

**Implications:** Because `shouldCreateUser: true`, anyone who enters an email/phone and verifies an OTP gets an account. There is no gate before account creation — no name, no terms acceptance, no second factor.

**Recommendation:** If password signup is added, `shouldCreateUser` behavior needs rethinking. OTP-only signup should probably become a separate "passwordless login" path for existing users, while new account creation goes through an explicit signup form.

### 1.6 Password Authentication — Does Not Exist

**Current behavior:** No password authentication anywhere in the codebase. No `signInWithPassword`, no `signUp` with password, no password reset, no password field in any form.

**Evidence:** Grep for `signInWithPassword`/`signUp.*password` across `apps/web` — zero hits in auth code. Only references to "password" are in unrelated files (contributor-session.ts HMAC, collection form fields).

**Supabase config:** `config.toml` does not set `[auth.password]` or `password_min_length`. GoTrue defaults apply (minimum 6 characters when password auth is used).

**Recommendation:** Must be added. The proposed signup requirements include password + confirm password.

### 1.7 Password Reset Behavior — Does Not Exist

**Current behavior:** No password reset flow, because no passwords exist.

**Recommendation:** Must be built alongside password authentication. Supabase provides `resetPasswordForEmail` which sends a link; the app needs a `/reset-password` route to handle it.

### 1.8 Session Creation and Refresh

**Current behavior:**
- JWT expiry: 3600s (1 hour) — `config.toml:63`
- Refresh token rotation enabled, reuse interval 10s — `config.toml:64-65`
- Middleware refreshes session on every request via `@supabase/ssr`'s `createServerClient` with cookie get/set — `lib/supabase/middleware.ts:52-84`
- Server components read session via `lib/supabase/server.ts` (same cookie pattern)
- Browser client via `lib/supabase/browser.ts` (publishable key only)

**Session duration:** NOT configured. `config.toml:58-65` explicitly notes that `[auth.sessions]` (7-day session, 12-hour idle timeout from SEC-04) is "intentionally not configured yet."

**Implications:** With no session configuration, Supabase defaults apply: refresh tokens last 168 hours (7 days) by default. The 1-hour JWT expiry is effectively the "re-check" interval. No idle timeout exists — a session stays alive as long as the refresh token is used before it expires.

**Recommendation:** Configure `[auth.sessions]` per SEC-04 before launch. Add graceful session expiry UI (redirect to login with a message, not a blank page).

### 1.9 Logout

**Current behavior:** `POST /logout` route handler calls `supabase.auth.signOut()`, redirects to `/login`.

**Evidence:** `apps/web/app/(auth)/logout/route.ts`

**Implications:** Clean. POST-only (no CSRF via GET). No client-side state to clear beyond the Supabase cookie.

**Recommendation:** Remains.

### 1.10 Auth Middleware

**Current behavior:** `apps/web/middleware.ts` delegates to `lib/supabase/middleware.ts:updateSession()`:
1. Creates a Supabase server client with cookie forwarding
2. Calls `supabase.auth.getUser()` to refresh the session
3. If no user AND path is not public, redirects to `/login?next={pathname}`
4. If user exists AND path is `/login`, redirects to `/communities`
5. Otherwise passes through

**Public paths:** `/`, `/login`, `/invite/*`, `/accept-invite/*`, and any two-segment path where the first segment is not an app segment (the public collection page).

**Evidence:** `middleware.ts:1-10`, `lib/supabase/middleware.ts:1-84`

**Implications:** UI-level protection only (as documented). RLS + DB functions are the real boundary. The middleware exists for UX, not security.

**Recommendation:** Remains. May need expansion if onboarding routes are added (e.g., `/welcome`, `/setup`).

### 1.11 Protected Routes

**Current behavior:** Two layers:
1. **Middleware** (above) — redirects unauthenticated requests from non-public paths
2. **Page-level `requireUser()`** — defence-in-depth; each protected page calls `requireUser()` which checks `auth.getUser()` then reads `public.users` row, redirecting to `/login` if absent

**Evidence:** `lib/auth.ts:24-28`, used in `communities/page.tsx`, `communities/new/page.tsx`, `c/[slug]/layout.tsx`, `c/[slug]/settings/page.tsx`, `accept-invite/page.tsx`

**Implications:** Solid defence-in-depth pattern. No page that should be protected is unprotected.

**Recommendation:** Remains.

### 1.12 Supabase Auth Configuration

**Summary of `config.toml` auth settings:**

| Setting | Value | Notes |
|---------|-------|-------|
| `site_url` | `http://127.0.0.1:3000` | Local only |
| `jwt_expiry` | 3600 | 1 hour |
| `refresh_token_rotation` | true | — |
| `refresh_token_reuse_interval` | 10 | Seconds |
| `enable_signup` | true | — |
| `enable_anonymous_sign_ins` | false | — |
| `email.enable_signup` | true | — |
| `email.enable_confirmations` | true | — |
| `email.otp_expiry` | 300 | 5 minutes |
| `email.otp_length` | 6 | — |
| `email.max_frequency` | 60s | — |
| `sms.enable_signup` | true | — |
| `sms.enable_confirmations` | true | — |
| `sms.max_frequency` | 60s | — |
| `mfa.totp.enroll_enabled` | true | For SEC-02 (withdrawal gate) |
| `mfa.totp.verify_enabled` | true | — |
| `rate_limit.email_sent` | 100 | Local only; raised for E2E |
| `[auth.sessions]` | NOT SET | SEC-04 pending |
| `[auth.password]` | NOT SET | GoTrue defaults |

**Recommendation:** Configure `[auth.sessions]` and `[auth.password]` when adding password auth.

### 1.13 `auth.users` Fields Used by Kolekto

The `handle_new_auth_user` trigger reads:
- `new.id` — becomes `public.users.id`
- `new.raw_user_meta_data ->> 'full_name'` — becomes user's name (if present)
- `new.email` — stored on `public.users`
- `new.phone` — normalized via `app.normalise_phone`, stored as `phone_e164`

No other `auth.users` columns are read by application code. The application never reads `auth.users` directly from the frontend; `lib/auth.ts:getCurrentUser()` reads `public.users` after `auth.getUser()` confirms identity.

### 1.14 `public.users` Fields

```
id                  uuid PK → auth.users(id)
full_name           text NOT NULL (1-120 chars)
phone_e164          text (nullable, E.164 format, unique where not null)
email               citext (nullable, unique where not null)
identity_level      identity_level NOT NULL DEFAULT 'none'
status              user_status NOT NULL DEFAULT 'active'
anonymised_at       timestamptz
created_at          timestamptz NOT NULL
updated_at          timestamptz NOT NULL
```

**Constraint:** `users_has_a_contact_method` — either phone or email must be non-null (unless status = 'closed').

**RLS:** `users_select_self` — a user sees only their own row.

### 1.15 Phone Normalization and Uniqueness

**Normalization:** `app.normalise_phone()` handles Nigerian numbers (0803..., 234803..., +234803...) and returns E.164 or NULL. Called in `handle_new_auth_user` on the `auth.users.phone` value.

**Uniqueness:** Partial unique index `users_phone_key` on `phone_e164 WHERE phone_e164 IS NOT NULL`.

**Gap:** Phone normalization happens only at bootstrap time. If a user changes their phone later (no UI for this yet), normalization must be applied again. Also, `LoginForm.tsx` does not normalize before sending to Supabase — the phone is sent raw to `signInWithOtp({ phone })`. Supabase's own phone handling may or may not normalize; the app does not enforce E.164 client-side.

### 1.16 Email Uniqueness

**Implementation:** Partial unique index `users_email_key` on `email WHERE email IS NOT NULL`. Email column is `citext` (case-insensitive text).

**Implication:** Two accounts with the same email (different case) cannot exist. Migration `20260928100000_citext_explicit_email_comparisons.sql` ensures all email comparisons use `citext` explicitly.

### 1.17 Existing Verification State

**`identity_level` enum:** `'none'`, `'contact_verified'`, `'identity_verified'`

**Current behavior:** All new users get `identity_level = 'none'`. Nothing in the codebase sets it to `contact_verified` or `identity_verified`. The column exists for the verification ladder (PRD 10.1) but no verification flow is implemented.

**Implication:** Despite having verified their email/phone via OTP, the user's `identity_level` stays `'none'`. This is a known gap — completing the OTP should set it to `'contact_verified'`.

### 1.18 Existing Auth Error Handling

**LoginForm:** Displays `sendError.message` and `verifyError.message` from Supabase in a `Banner` component. No custom error mapping — Supabase's raw messages are shown to the user.

**Middleware:** Silent redirect (no error message on the login page after session expiry).

**Page-level:** `requireUser()` does a hard `redirect("/login")` — no error state preserved.

**Recommendation:** Add error mapping for common Supabase errors (rate limited, invalid code, expired code). Add session-expiry feedback.

### 1.19 Existing Auth Tests

**E2E (Playwright):**
- `tests/e2e/helpers/auth.ts` — `signInAsNewUser()`: real OTP flow against local stack, with retry logic for Kong 504s
- `tests/e2e/helpers/mailpit.ts` — `readOtpCode()`: reads 6-digit code from Mailpit API
- `tests/e2e/auth-community-member.spec.ts` — golden path: sign in, see personal community, create named community, add member
- `tests/e2e/protected-routes.spec.ts` — `/communities` redirects to `/login` when signed out; landing page shows "Sign in"
- Every other E2E spec uses `signInAsNewUser` as setup

**pgTAP:**
- `04_authorization.sql` — role matrix, cross-community isolation, ended-term revocation (12 assertions)
- `05_guards.sql` — auth guards on write functions
- `07_application_write_functions.sql` — write function auth checks
- Multiple other tests verify bootstrap behavior indirectly (inserting into `auth.users` triggers `handle_new_auth_user`)

**Unit:**
- `lib/safe-redirect.test.ts` — 9 tests for redirect validation

**Gaps:**
- No test for phone OTP path
- No test for session expiry behavior
- No test for rate limiting
- No test for duplicate email/phone at signup
- No test for what happens when bootstrap partially fails

---

## PART 2 — USER BOOTSTRAP

### Bootstrap Sequence

```
auth.users INSERT (Supabase Auth creates row on OTP verify)
  ↓ trigger: on_auth_user_created
  ↓ function: app.handle_new_auth_user()
  ↓
  ├─ Extract full_name from raw_user_meta_data (or email prefix, or 'New member')
  ├─ Normalize phone via app.normalise_phone()
  ├─ INSERT INTO public.users (id, full_name, phone_e164, email) ON CONFLICT DO NOTHING
  ├─ Generate community_id via app.uuid_generate_v7()
  ├─ INSERT INTO public.communities (id, slug, name, type='personal', is_personal=true, created_by)
  │   slug = app.generate_unique_community_slug(full_name + '-collections')
  │   name = full_name + "'s collections" (capped at 80 chars)
  └─ INSERT INTO public.officer_terms (community_id, user_id, role='owner', start_reason='created')
```

**Evidence:** `supabase/migrations/20260918140000_user_bootstrap.sql:96-151`

### What Creates the Personal Community

The DB trigger `on_auth_user_created`, firing `app.handle_new_auth_user()`, creates it. This is a `SECURITY DEFINER` function with no EXECUTE grant to any client role — it is only reachable via the trigger, which fires as a superuser-equivalent when Supabase Auth inserts into `auth.users`.

### What Name the Personal Community Receives

`left(v_full_name || '''s collections', 80)` — e.g., "john's collections" or "New member's collections".

### Where That Name Comes From

1. `raw_user_meta_data ->> 'full_name'` (if present — currently never set, because OTP signup collects no name)
2. `split_part(new.email, '@', 1)` (email prefix)
3. `'New member'` (fallback)

### What Slug the Personal Community Receives

`app.generate_unique_community_slug(coalesce(v_full_name, 'my') || '-collections')` — e.g., `john-collections` or `new-member-collections-2`.

### Whether It Is PUBLIC or PRIVATE

The community is type `'personal'` with `is_personal = true`. It is neither public nor private in the visibility sense — it is scoped by RLS. Only the owner (via their officer_term) can see it. The `communities_select_officer` policy scopes SELECT to communities where the user has an active officer_term.

### Whether It Is Editable

Yes. `app.update_community_profile` works on personal communities. The constraint `communities_personal_type_agrees` enforces `is_personal = (type = 'personal')`, so changing the type away from `'personal'` requires also setting `is_personal = false` (COM-02: convertible to a named community).

### What Happens on Retry/Re-authentication

`ON CONFLICT (id) DO NOTHING` on `public.users` — the user row is not duplicated. However, the community and officer_term inserts have no ON CONFLICT guard. If the trigger fires twice for the same `auth.users` row (unlikely but theoretically possible in a race), the `communities_one_personal_per_user` partial unique index would reject the second community INSERT, and the entire trigger transaction would fail. The `auth.users` INSERT would also roll back.

**Risk:** Low. Supabase Auth does not insert the same user twice. But the bootstrap is not idempotent by design — it relies on the assumption that the trigger fires exactly once.

### What Happens If Bootstrap Partially Fails

The entire bootstrap runs in one transaction (the trigger function). If any step fails (e.g., slug allocation exhausted, community name too short), the whole transaction rolls back — including the `auth.users` INSERT. The user's OTP verify would fail, and they would see an error in LoginForm.

**Implication:** A bootstrap failure means the user simply does not exist. They can try again. There is no partial state.

---

## PART 3 — PROPOSED NEW SIGNUP REQUIREMENTS

### Proposed Fields

| Field | Current Support | Notes |
|-------|----------------|-------|
| Full name | NOT collected at signup; derived from email | Need a signup form field |
| Email | Collected (OTP identifier) | Already works |
| Phone number | Collected (OTP identifier, alternate channel) | Already works, needs normalization |
| Password | NOT supported anywhere | Need Supabase password auth enabled |
| Confirm password | N/A | Client-side only |

### What Supabase Supports Today

Supabase Auth supports:
- Email + password signup via `signUp({ email, password, options: { data: { full_name } } })`
- Phone + password signup via `signUp({ phone, password })`
- Email OTP via `signInWithOtp({ email })`
- Phone OTP via `signInWithOtp({ phone })`
- Password reset via `resetPasswordForEmail(email)`
- MFA (TOTP) — already enabled in config

Supabase does NOT natively support collecting email AND phone AND password in a single `signUp` call. The primary identifier for password auth is either email or phone, not both. Adding the second channel requires a separate update after signup.

### Required Configuration Changes

1. **`config.toml`:** Add `[auth.password]` section with `password_min_length` (recommend 8 per NIST 800-63B)
2. **`config.toml`:** Optionally add password reset email template (`[auth.email.template.reset_password]`)
3. **No change needed** to `enable_signup`, `enable_confirmations`, MFA — already correct

### Required Database Changes

1. **`public.users`:** No schema change needed — `full_name`, `phone_e164`, and `email` already exist
2. **`handle_new_auth_user`:** Needs update to read `full_name` from `raw_user_meta_data` (already does, but currently falls through to email prefix because no metadata is sent)
3. **Potentially:** Add `onboarding_completed_at` to `public.users` (see Part 7)
4. **No new tables required** for auth itself

### Verification Flow

**Recommended approach:**

1. User fills signup form (name, email, phone, password, confirm password)
2. `signUp({ email, password, options: { data: { full_name, phone } } })` creates the account
3. Supabase sends email confirmation (existing template works)
4. User enters 6-digit code from email (same `verifyOtp` flow)
5. After email verification, app prompts for phone verification
6. Phone OTP sent via `signInWithOtp({ phone })` or MFA phone factor
7. Both verified → `identity_level = 'contact_verified'`

**Alternative (simpler, recommended for MVP):**

1. Signup with email + password
2. Email OTP verification (required)
3. Phone number stored but verified lazily (before first withdrawal, per PRD 10.1)

### Should Password + OTP Coexist?

**Yes.** Password for signup and primary login. OTP as:
- Email verification after signup
- Passwordless login option for returning users
- Account recovery
- Phone verification when needed

Supabase supports both simultaneously. No conflict.

### Should Email and Phone Both Be Verified?

**Email:** Required at signup. Supabase does this automatically with `enable_confirmations = true`.

**Phone:** Recommended but can be deferred. The identity_level ladder (`none` → `contact_verified` → `identity_verified`) gates money movement, not basic usage. Phone verification should be required before withdrawal (PRD 10.1), not before creating a community.

### Duplicate Email/Phone Behavior

**Email:** `auth.users` enforces email uniqueness. Attempting `signUp` with an existing email returns an error. The app should show "An account with this email already exists. Sign in instead."

**Phone:** More complex. If a user signs up with email+password and provides a phone, the phone is stored on `public.users` but may not be on `auth.users.phone`. Need to handle:
- Two users claiming the same phone → `users_phone_key` unique index rejects at the `public.users` level
- A user who signed up with phone OTP vs one who provided phone during email+password signup → different `auth.users` entries

**Recommendation:** Phone uniqueness is enforced on `public.users.phone_e164`. At signup, check for duplicates before attempting the Supabase call, and show a clear error.

### Password Reset

Supabase provides `resetPasswordForEmail(email)` which sends a reset link. The app needs:
1. A "Forgot password?" link on the login page
2. A `/reset-password` route that handles the reset token
3. A form to enter new password + confirm
4. Supabase handles the token verification and password update

**Note:** `auth.email.template.reset_password` is not configured in `config.toml`. A template needs to be added.

### Security Implications

1. **Password storage:** Supabase/GoTrue handles hashing (bcrypt). The app never sees plaintext passwords after the initial form submission.
2. **Brute force:** Supabase has built-in rate limiting. Additional protection recommended at the edge.
3. **Enumeration:** `signUp` with an existing email reveals the email is taken. Mitigate with generic error messages.
4. **Phone normalization:** Must normalize BEFORE checking uniqueness, or `0803...` and `+234803...` create duplicate accounts.
5. **Password strength:** Configure `password_min_length` in `config.toml`. Consider client-side strength indicator.

### Architecture Migration vs. UI Change

| Change | Type |
|--------|------|
| Adding password fields to a new signup form | UI change |
| Enabling password auth in Supabase | Configuration change |
| Adding password reset flow | New route + UI |
| Changing `shouldCreateUser: true` behavior | Architecture change |
| Separating signup from login | Architecture change (currently one flow) |
| Adding phone as a secondary identifier (not primary) | Architecture change (Supabase signup is single-identifier) |
| Updating `handle_new_auth_user` to read metadata | Migration (SQL) |
| Adding `identity_level` management | New application logic |

---

## PART 4 — PERSONAL COMMUNITY MODEL

### Current Architecture

```
User (public.users)
  └─ Personal Community (communities WHERE is_personal = true)
       └─ Officer Term (owner, via officer_terms)
```

The personal community is auto-created at signup with:
- `name`: "[email prefix]'s collections"
- `type`: `'personal'`
- `is_personal`: `true`
- User becomes `owner` via an officer_term

There is NO separation between community and collection. A community contains collections. The current model is:

```
User
  └─ Community (org/group — the tenancy boundary)
       ├─ Members
       ├─ Collections
       │    └─ Obligations
       └─ Officer Terms
```

### Problem: User Name Becomes Community Name

When a user signs up with email `john@example.com`, the bootstrap creates:
- `public.users.full_name` = "john" (email prefix)
- Personal community name = "john's collections"
- Personal community slug = "john-collections"

This is wrong in multiple ways:
1. "john" is not a name — it's an email prefix
2. The personal community name is derived without user input
3. There's no opportunity to name the community something meaningful
4. The community type is forced to `'personal'`

### Recommended Architecture

```
USER (identity)
  ├─ full_name, email, phone, identity_level
  └─ can hold officer_terms in multiple communities

COMMUNITY (the tenancy root)
  ├─ name (user-chosen)
  ├─ type (user-chosen from enum, NOT 'personal')
  ├─ is_personal flag (for the auto-created one)
  └─ owns: members, collections, officer_terms

COLLECTION (belongs to community)
  └─ owns: obligations, contributions
```

### Personal Community: Keep or Remove?

**Keep, but change how it's created.**

The personal community serves a real purpose: a solo user who wants to collect money from people without creating a "community" in the social sense still needs a tenancy boundary. But:

1. It should not be auto-named from the email prefix
2. It should not be created silently at signup
3. The user should choose what to call their first workspace
4. The type should be meaningful, not `'personal'`

### Recommended Onboarding Flow

```
Signup (name, email, phone, password)
  ↓
Email Verification (6-digit OTP)
  ↓
Welcome Screen (acknowledges the user)
  ↓
"What are you using Kolekto for?" (community type selection)
  ↓
"Name your community" (user-chosen name)
  ↓
Dashboard (of the just-created community)
```

### Impact on `handle_new_auth_user`

The bootstrap trigger must still create `public.users` — a user must exist in the database after signup. But the personal community creation should be decoupled from the trigger and moved to the onboarding flow.

**Option A: Remove community creation from trigger, add to onboarding**
- Pro: Clean separation. User chooses name and type.
- Con: There is a window where a signed-in user has no community. Every page that assumes at least one community exists would need a guard.

**Option B: Keep trigger community creation as a "default workspace," rename during onboarding**
- Pro: No window of communityless state. Simpler migration for existing users.
- Con: Still creating something the user didn't ask for. Rename during onboarding means the slug changes.

**Recommendation: Option A** — but gate access to the main app behind onboarding completion, so the communityless window is invisible. The middleware redirects a user with no onboarding to `/welcome` instead of `/communities`.

### Multi-Community Users

Already supported. A user can hold officer_terms in multiple communities. The communities page lists all communities the user has a role in. No change needed.

### Community Type

The existing `community_type` enum has 12 values (including `'personal'`). For the onboarding "what are you using Kolekto for?" screen, present the non-personal types:

```
university_association, fellowship, alumni_association, cooperative,
estate, professional_association, event_committee, social_group,
school_pta, community_development, other
```

The `'personal'` type should be removed from user-facing options. If Option A is chosen, existing personal communities remain but are never auto-created again.

---

## PART 5 — EXISTING USER COMPATIBILITY

### Current State

The local database has existing users and personal communities created via the bootstrap trigger. Each user has:
- A `public.users` row
- A personal community (type `'personal'`, `is_personal = true`)
- An owner officer_term for that community

### How Existing Users Are Affected

**If Option A (decouple community from bootstrap):**
1. Existing users already have communities — they skip onboarding
2. The trigger change only affects NEW users
3. Existing personal communities remain unchanged
4. The key differentiator: does the user have `onboarding_completed_at` set?

**Migration needed:** Add `onboarding_completed_at` to `public.users` and backfill existing users:
```sql
ALTER TABLE public.users ADD COLUMN onboarding_completed_at timestamptz;
UPDATE public.users SET onboarding_completed_at = created_at WHERE id IN (
  SELECT created_by FROM public.communities WHERE is_personal = true
);
```

### Distinguishing New From Existing Users

| Signal | New User | Existing User |
|--------|----------|---------------|
| `onboarding_completed_at` | NULL | Backfilled |
| Communities count | 0 | >= 1 |
| Personal community exists | No | Yes |

**Recommendation:** Use `onboarding_completed_at IS NULL` as the primary signal. Backfill existing users so they are never trapped in onboarding.

### Whether Existing Users Need Onboarding

**No.** Existing users already have communities and are functional. Forcing them through onboarding would be disruptive and confusing. The backfill of `onboarding_completed_at` ensures they bypass it.

### Whether Existing Community Ownership/RBAC Changes

**No.** The RBAC model is unchanged. Officer terms, roles, and permissions are unaffected. The only change is when and how the first community is created (during onboarding instead of in a trigger).

---

## PART 6 — UX PROPOSAL

### Screen 1: Create Account

**Fields:**
- Full name (text, required, 1-120 characters)
- Email address (email, required, validated format)
- Phone number (tel, required, E.164 or local Nigerian format)
- Password (password, required, minimum 8 characters)
- Confirm password (password, required, must match)

**Validation:**
- Full name: non-empty, max 120 chars
- Email: valid format, not already registered
- Phone: valid after normalization, not already registered
- Password: minimum 8 characters (configurable), matches confirm
- All fields required

**Actions:**
- "Create account" button → calls `signUp({ email, password, options: { data: { full_name, phone_e164 } } })`
- "Already have an account? Sign in" link → `/login`

**Errors:**
- "Email already registered" (with link to sign in)
- "Phone number already registered"
- "Passwords don't match"
- "Password too short"
- Network/server errors

**Loading state:** Button shows spinner, fields disabled during submission.

**Back behavior:** N/A (entry point).

**Data persisted:** `auth.users` row created. `public.users` row created via trigger (updated to read `full_name` and `phone` from metadata). No community yet.

### Screen 2: Email Verification

**Fields:**
- 6-digit OTP code (numeric input)

**Validation:**
- 6 digits, numeric

**Actions:**
- "Verify" button → calls `verifyOtp({ email, token, type: "email" })`
- "Resend code" button (visible after 60 seconds) → calls `resend()`
- "Use a different email" → back to Screen 1

**Errors:**
- "Invalid code"
- "Code expired — request a new one"
- "Too many attempts"

**Loading state:** Verify button shows spinner.

**Back behavior:** "Use a different email" returns to signup. State is NOT preserved (new email means new account).

**Data persisted:** Email verified in `auth.users`. Session created.

### Screen 3: Welcome

**Fields:** None (informational).

**Content:**
- "Welcome to Kolekto, [full_name]!"
- Brief value proposition (1-2 sentences)
- "Let's set up your first community" CTA

**Actions:**
- "Get started" button → navigates to Screen 4

**Errors:** None.

**Loading state:** None.

**Back behavior:** None (forward-only from here).

**Skip behavior:** None — onboarding is required for new users.

**Data persisted:** Nothing new.

### Screen 4: What Are You Managing?

**Fields:**
- Community type selection (radio group or card selector)
- Options: all `community_type` values except `'personal'`, with human-readable labels and brief descriptions

**Validation:**
- One type must be selected

**Actions:**
- "Continue" button → stores selection in local state, navigates to Screen 5
- Back arrow → returns to Screen 3

**Errors:**
- "Please select a type" (if continue without selection)

**Loading state:** None.

**Back behavior:** Returns to Welcome.

**Skip behavior:** None.

**Data persisted:** Nothing yet — stored in client state until Screen 5.

### Screen 5: Create Your Community

**Fields:**
- Community name (text, required, 3-80 characters)
- Description (textarea, optional, max 500 characters)

**Validation:**
- Name: 3-80 characters, not empty
- Description: max 500 characters

**Actions:**
- "Create community" button → calls `app.create_community(name, type, description)` via server action
- Back arrow → returns to Screen 4

**Errors:**
- "Name too short" / "Name too long"
- Server errors

**Loading state:** Button shows spinner, fields disabled.

**Back behavior:** Returns to type selection. Previously entered name/description preserved.

**Skip behavior:** None — at least one community is required.

**Data persisted:**
- Community created in DB
- Officer term created (owner)
- `onboarding_completed_at` set on `public.users`

### Screen 6: Dashboard

**Redirect to:** `/c/[slug]` — the community overview page for the just-created community.

**No additional fields.** This is the existing community dashboard.

---

## PART 7 — DATA MODEL

### Required Changes

| Change | Table | Type | Notes |
|--------|-------|------|-------|
| `onboarding_completed_at` | `public.users` | `timestamptz` nullable | NULL = not onboarded. Backfill for existing users. |

### NOT Required

| Considered | Why Not |
|------------|---------|
| `onboarding_step` | Onboarding is 6 screens; client state is sufficient. If the user closes the browser, they restart onboarding (it's 30 seconds). A `step` column adds complexity for no benefit. |
| `community_type` changes | The existing enum has all needed values. `'personal'` remains for existing communities. |
| `personal community marker` | `is_personal` column already exists. |
| New `account`/`profile` table | `public.users` already holds all necessary fields. |
| New enum values | None needed. |
| New tables | None needed for auth/onboarding. |

### Trigger Change

`handle_new_auth_user` should be modified to:
1. Still create `public.users` row (read `full_name` from metadata)
2. NOT create a personal community
3. NOT create an officer_term

The community and term are created during onboarding (Screen 5) via `app.create_community`, which already exists and works correctly.

### Minimum Data-Model Change

**One column addition:**
```sql
ALTER TABLE public.users ADD COLUMN onboarding_completed_at timestamptz;
```

**One trigger modification:**
Remove community + officer_term creation from `handle_new_auth_user`. Keep user row creation.

**One backfill:**
```sql
UPDATE public.users SET onboarding_completed_at = created_at
WHERE EXISTS (SELECT 1 FROM public.communities WHERE created_by = users.id AND is_personal = true);
```

---

## PART 8 — SECURITY

### Password Policy

**Current:** No password auth exists.

**Recommendation:** Configure in `config.toml`:
- `password_min_length = 8` (NIST 800-63B recommends 8 minimum)
- Consider adding client-side strength indicator (not a Supabase setting)
- Do NOT enforce complexity rules (uppercase/special char requirements) — NIST discourages them

### Password Hashing

Supabase/GoTrue handles hashing with bcrypt. The app never stores, logs, or transmits passwords after the initial signup/login form submission. No application-level responsibility.

### OTP Verification

Already well-configured:
- 6-digit code
- 5-minute expiry
- 60-second minimum between sends
- Rate limit (100/hour local, lower in production)

**Risk:** OTP codes are 6 digits = 1,000,000 possibilities. With 5-minute expiry and rate limiting, brute force is impractical. Acceptable.

### Rate Limiting

**Auth rate limiting:** Supabase's built-in limits apply. `config.toml` sets `email_sent = 100` (local only).

**Lookup rate limiting:** In-memory `Map` in `lookup-throttle.ts` — 12 attempts per IP per minute. Resets on process restart.

**Recommendation:**
- Production must use edge-level rate limiting (Vercel/Cloudflare)
- Login attempts should be rate-limited (Supabase does this, but verify the limits)
- Add login failure counting for account lockout awareness (not lockout itself — that's anti-user)

### Phone Normalization

**Current:** `app.normalise_phone()` handles Nigerian numbers. Returns NULL for unrecognizable input.

**Gap:** Normalization only runs in the DB trigger. The signup form should normalize client-side to prevent UX issues (user types `0803...`, form should show it as `+234803...` before submission).

### Duplicate Account Prevention

**Email:** Unique index on `public.users.email`. Supabase also enforces uniqueness on `auth.users.email`.

**Phone:** Unique index on `public.users.phone_e164` (partial, WHERE NOT NULL).

**Gap:** If a user signs up with email+password and provides phone number, the phone uniqueness is checked on `public.users` but not necessarily on `auth.users` (which may have a different phone or no phone). This is fine — `public.users` is the source of truth for profile data.

### Session Handling

**Current:** JWT expiry 1 hour, refresh token rotation, no session duration configured.

**Risks:**
- No idle timeout — a session on a shared computer stays alive indefinitely if refreshed
- No session count limit — a user can have unlimited active sessions

**Recommendation:** Configure `[auth.sessions]` per SEC-04:
- `timebox = 604800` (7 days)
- `inactivity_timeout = 43200` (12 hours)

### Redirect Validation

**Resolved in M10:** `safeRedirectPath()` validates the `?next` parameter. Rejects `//`, `://`, `/\`, non-`/`-prefixed paths. 9 unit tests.

### CSRF Considerations

**Logout:** POST-only route — safe.
**Login:** No CSRF token on the OTP form, but `signInWithOtp` is idempotent (sends a code, does not change state). Acceptable.
**Signup (proposed):** `signUp` creates an account. The form should include CSRF protection (Next.js server actions provide this automatically via the action token).

### Enumeration Risks

**Email enumeration:** `signInWithOtp` with `shouldCreateUser: true` creates an account for any email. An attacker cannot distinguish "new" from "existing" by the OTP response (both succeed). This is a feature, not a bug, for the OTP-only model.

**With password signup:** `signUp` returns an error for existing emails. This reveals email registration status. Mitigate by returning a generic "Check your email for a verification code" message regardless of whether the account is new or existing (Supabase supports this with `MAILER_AUTOCONFIRM = false`).

### Password Reset

**Not yet built.** When built:
- Use `resetPasswordForEmail(email)` — always returns success regardless of whether email exists (prevents enumeration)
- Reset link should expire (Supabase default: 1 hour)
- After reset, invalidate all existing sessions (Supabase does this automatically)

### Account Recovery

**Current:** OTP to the registered email/phone is the only recovery path.

**With passwords:** Password reset via email is the primary recovery path. Phone OTP can serve as a secondary recovery method.

---

## PART 9 — TEST PLAN

### Signup Tests

| Test | Input | Expected |
|------|-------|----------|
| Valid signup | All fields valid | Account created, verification email sent |
| Missing full name | Empty name | Validation error, no account created |
| Invalid phone | "abc123" | Validation error |
| Duplicate phone | Phone already in `public.users` | "Phone number already registered" |
| Duplicate email | Email already in `auth.users` | "Email already registered" |
| Weak password | "123" | "Password must be at least 8 characters" |
| Password mismatch | "Pass1234" vs "Pass1235" | "Passwords don't match" |
| Phone normalization | "08031234567" → "+2348031234567" | Account created with E.164 phone |

### Verification Tests

| Test | Input | Expected |
|------|-------|----------|
| Valid OTP | Correct 6-digit code within 5 minutes | Session created, redirect to welcome |
| Invalid OTP | Wrong code | "Invalid code" error |
| Expired OTP | Code after 5 minutes | "Code expired" error |
| Resend OTP | Click resend after 60s | New code sent, old code invalidated |
| Multiple OTP attempts | 3 wrong codes | Still allows retry (no lockout) |

### Bootstrap Tests

| Test | Condition | Expected |
|------|-----------|----------|
| User created | After OTP verify | `public.users` row exists with correct name, email, phone |
| No auto community | After OTP verify (new flow) | No community exists yet |
| Existing user login | OTP for existing email | No duplicate user, no duplicate community |

### Onboarding Tests

| Test | Condition | Expected |
|------|-----------|----------|
| New user sees onboarding | `onboarding_completed_at IS NULL` | Redirected to `/welcome` |
| Existing user bypasses | `onboarding_completed_at IS NOT NULL` | Goes to `/communities` |
| Community creation | Complete onboarding flow | Community exists, officer_term exists, `onboarding_completed_at` set |
| Refresh during onboarding | Close browser, reopen | Onboarding restarts (no partial state persisted) |
| Abandoned onboarding | Sign up but don't complete onboarding | User exists, no community, redirected to `/welcome` on next login |
| Duplicate submission | Double-click "Create community" | Exactly one community created (server-side idempotency) |

### Security Tests

| Test | Condition | Expected |
|------|-----------|----------|
| Unsafe redirect | `/login?next=https://evil.com` | Redirects to `/communities`, not evil.com |
| Auth boundary | Access `/communities` signed out | Redirected to `/login` |
| Session refresh | Expired JWT | Middleware refreshes via refresh token |
| Onboarding bypass | Navigate directly to `/communities` without completing onboarding | Redirected to `/welcome` |
| Phone normalization injection | Phone: `+234'; DROP TABLE--` | Rejected by normalise_phone |

---

## PART 10 — FINAL RECOMMENDATION

### A. Current Architecture Summary

Kolekto uses OTP-only authentication (email primary, phone ready but no SMS provider). Signup and login are the same flow — `signInWithOtp` with `shouldCreateUser: true`. A DB trigger auto-creates a `public.users` row, a personal community, and an owner officer_term on first authentication. Sessions use JWTs (1-hour expiry) with refresh token rotation. All writes go through `SECURITY DEFINER` functions with permission checks. RLS protects every table. No passwords, no password reset, no onboarding flow.

### B. Problems With Current Signup/Onboarding

1. **No name collection:** User's name is derived from email prefix or defaults to "New member"
2. **No password:** Users cannot choose a familiar credential
3. **No onboarding:** First-time users land on a blank communities page
4. **Silent community creation:** Personal community auto-created with a bad name
5. **No phone verification:** Phone stored but never verified
6. **No session configuration:** SEC-04's 7-day session / 12-hour idle timeout not implemented
7. **No password reset:** Because no passwords exist
8. **No account settings:** Users cannot edit their name, email, or phone after signup

### C. Recommended Architecture

1. **Separate signup from login:** New `/signup` route with name, email, phone, password, confirm password
2. **Keep OTP login:** Existing `/login` with email/phone OTP for returning users
3. **Add password login:** Add a "Sign in with password" option on `/login`
4. **Email verification required:** Before proceeding to onboarding
5. **Phone verification deferred:** Until withdrawal gate (PRD 10.1)
6. **Guided onboarding:** Welcome → type → name → dashboard
7. **Remove auto-community from trigger:** User creates first community during onboarding

### D. Exact Screens/Flow

```
/signup       → name, email, phone, password, confirm password
/verify       → 6-digit email OTP
/welcome      → "Welcome, [name]!"
/setup/type   → "What are you using Kolekto for?"
/setup/create → "Name your community"
/c/[slug]     → Dashboard (onboarding complete)

/login        → email/phone OTP or email+password (returning users)
/reset-password → password reset flow
```

### E. Required Database Changes

1. **Add column:** `public.users.onboarding_completed_at timestamptz`
2. **Modify trigger:** `handle_new_auth_user` — remove community + officer_term creation, keep user row creation
3. **Backfill:** Set `onboarding_completed_at = created_at` for all existing users with a personal community
4. **Add template:** Password reset email template

### F. Required Supabase Configuration Changes

1. Add `[auth.password]` with `password_min_length = 8`
2. Add `[auth.sessions]` with `timebox = 604800`, `inactivity_timeout = 43200`
3. Add `[auth.email.template.reset_password]` with template file

### G. Required Application Changes

1. **New routes:** `/signup`, `/verify`, `/welcome`, `/setup/type`, `/setup/create`, `/reset-password`
2. **Modify middleware:** Redirect un-onboarded users to `/welcome`
3. **Modify login page:** Add password login option alongside OTP
4. **New server actions:** `signupAction`, `verifyAction`, `completeOnboardingAction`
5. **Update `handle_new_auth_user`:** Remove community creation
6. **Account settings page:** `/account` with name, email, phone editing

### H. Migration/Backward-Compatibility Considerations

1. **Existing users:** Backfill `onboarding_completed_at` so they are never trapped in onboarding
2. **Existing personal communities:** Remain unchanged. Not deleted, not renamed.
3. **Existing sessions:** Unaffected. Adding password auth does not invalidate OTP sessions.
4. **Auth flow coexistence:** Both OTP and password login work simultaneously
5. **No destructive migration:** All changes are additive (new column, new routes)

### I. Test Plan

See Part 9 above. Key additions to the existing test suite:
- 8 signup validation tests
- 5 verification tests
- 3 bootstrap tests (updated for new flow)
- 6 onboarding tests
- 5 security tests

### J. Implementation Sequence

1. **Add `onboarding_completed_at` column + backfill** (migration, no app change)
2. **Configure Supabase password auth + session settings** (config.toml)
3. **Build `/signup` form** (new route, server action)
4. **Build `/verify` screen** (adapts existing OTP verification)
5. **Update `handle_new_auth_user` trigger** (remove community creation)
6. **Build onboarding flow** (`/welcome`, `/setup/type`, `/setup/create`)
7. **Update middleware** (redirect un-onboarded users)
8. **Add password login option** to existing `/login`
9. **Build password reset flow** (`/reset-password`)
10. **Build account settings** (`/account`)
11. **Tests** (pgTAP for schema, E2E for flows)

### K. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing users trapped in onboarding | High | Backfill `onboarding_completed_at` before deploying middleware change |
| Bootstrap trigger modification breaks E2E tests | Medium | Update all `signInAsNewUser` helpers; tests that expect a personal community must be updated |
| Phone normalization inconsistency | Medium | Normalize client-side before submission; validate server-side |
| Password reset email not delivered | Low | Test with Mailpit locally; configure production email provider |
| Race in onboarding (double community creation) | Low | Use `create_community` which is already safe; add idempotency guard |

### L. What Should Explicitly NOT Be Changed

1. **RLS model** — unchanged
2. **RBAC / officer_terms / permissions** — unchanged
3. **Community CRUD** (`app.create_community`) — unchanged (used as-is during onboarding)
4. **Existing personal communities** — remain, not deleted or renamed
5. **Contributor identification (cookies)** — unchanged
6. **Write-through-DB-functions pattern** — unchanged
7. **Grant matrix** — unchanged
8. **Payment boundary** — still not crossed
9. **Paystack** — not touched
10. **Notifications** — not built as part of this
11. **Migration workstream** — remains paused
12. **Staging/production** — not touched
