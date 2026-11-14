# Investigation Report: Authentication, Member Claiming, and Collection Reminders

**Date:** 2026-11-03
**Branch:** `fix/auth-nav-and-cookie-forwarding`
**Environment:** LOCAL ONLY — no remote, staging, or production access used.

---

## A. Authentication — Login Failure / Account Inconsistency

### User-visible symptom

A user could no longer log in with their existing credentials. They then successfully signed up with the same email and password, which appeared to create a working account.

### Relevant UI components

| Component | Path |
|---|---|
| Login form | `apps/web/app/(auth)/login/LoginForm.tsx` |
| Signup form | `apps/web/app/(auth)/signup/SignupForm.tsx` |
| Email verify form | `apps/web/app/(auth)/verify/VerifyForm.tsx` |
| Auth error mapping | `apps/web/lib/auth-errors.ts` |
| Current user lookup | `apps/web/lib/auth.ts` → `getCurrentUser()` |
| Middleware session refresh | `apps/web/lib/supabase/middleware.ts` |

### Relevant backend functions and queries

| Function | Location |
|---|---|
| Browser Supabase client | `apps/web/lib/supabase/browser.ts` — `createBrowserClient(URL, PUBLISHABLE_KEY)` |
| Server Supabase client | `apps/web/lib/supabase/server.ts` — `createServerClient(url, key, {cookies})` |
| Config loader | `packages/config/src/env.ts` — `loadConfig()` reads `NEXT_PUBLIC_SUPABASE_URL` |
| New-user bootstrap trigger | `supabase/migrations/20260918140000_user_bootstrap.sql` — `app.handle_new_auth_user()` |

### Database relationships

```
auth.users (GoTrue)
  ↓ id (1:1)
public.users (id uuid PK REFERENCES auth.users ON DELETE RESTRICT)
  ↓ unique index on email (citext)
  ↓ unique index on phone_e164
```

The `handle_new_auth_user()` trigger fires `AFTER INSERT ON auth.users` and creates the `public.users` row with `ON CONFLICT (id) DO NOTHING`. The email is populated from `new.email`.

### Confirmed root cause

**No duplicate account was created.** Both login and signup use the same Supabase client (`browser.ts`) talking to the same project (confirmed: `loadConfig()` reads identical `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` env vars; `.env.local` points to `http://127.0.0.1:54321`).

The most likely scenario, given `enable_confirmations = true` in `supabase/config.toml`:

1. **Original signup:** User signed up → `auth.users` row created with `email_confirmed_at = NULL` → `handle_new_auth_user()` trigger created `public.users` row.

2. **Login failure:** `signInWithPassword` fails for unconfirmed emails when `enable_confirmations = true`. GoTrue returns "Invalid login credentials" (mapped to "Incorrect email or password" by `auth-errors.ts`). The error message does not distinguish "wrong password" from "email not confirmed" — this is by GoTrue design (prevents user enumeration).

3. **Re-signup succeeded:** GoTrue's documented behavior for `signUp` with an existing *unconfirmed* email: it **updates the existing `auth.users` row** (does not insert a new one), re-sends the confirmation email, and returns a success-like response. Because this is an UPDATE, not an INSERT, the `handle_new_auth_user()` trigger does NOT fire again, and no second `public.users` row is created. Even if a second INSERT were somehow attempted, the `users_email_key` unique index on `public.users.email` would block it.

4. **After verification:** The user completed `/verify`, which calls `supabase.auth.verifyOtp({email, token, type: "email"})`, setting `email_confirmed_at` on the existing `auth.users` row. From this point, `signInWithPassword` works.

**This is not a bug in Kolekto's code.** The confusion arises because GoTrue intentionally returns the same response shape for both "new signup" and "re-signup of unconfirmed email." The user interpreted this as creating a new account, but they were re-activating their original one.

### Alternative hypotheses not yet proven

- **Session/cookie issues from the recently merged auth fix (`ee9462b`):** The `redirectWithRefreshedCookies` fix prevents premature session termination after middleware redirects. If the user's login failure predates this fix, a cookie-forwarding bug could have caused the session to be lost between the GoTrue response and the middleware redirect, making a valid login appear to fail. This is plausible but cannot be confirmed without access to the user's session timing.

- **Password mismatch:** The user may have genuinely had the wrong password. GoTrue returns the same error for "wrong password" and "unconfirmed email."

- **OTP expiry:** The original confirmation OTP expires after 300 seconds (`supabase/config.toml`: `otp_expiry = 300`). If the user didn't confirm in time, they'd need to re-trigger the flow — which looks like "signing up again."

### Reproduction steps (local)

1. Sign up with `test@example.com` + password.
2. Do NOT enter the verification code.
3. Attempt `signInWithPassword` → expect "Invalid login credentials."
4. Sign up again with the same email + same or different password → expect success (GoTrue re-uses the existing row).
5. Complete verification → login works.
6. Check `auth.users`: exactly one row for that email.

### Classification

**Product-design issue** (GoTrue's intentional UX) + **UX clarity issue** (error messages don't distinguish unconfirmed from wrong-password).

### Recommended actions

1. **No code change needed for the duplicate-account concern** — the safeguards are in place (`users_email_key` unique index, trigger `ON CONFLICT DO NOTHING`).
2. **Consider UX improvement:** After a failed `signInWithPassword`, check whether the email exists but is unconfirmed (via a targeted `signUp` call or a server-side check) and show a specific message: "Check your email for a verification code, or request a new one." This requires a product decision about whether to reveal account existence.
3. **No relation to the auth cookie-forwarding fix** (`ee9462b`) — that fix addresses session loss after middleware redirects, not login/signup mechanics.

---

## B. Member Claiming — "Unclaimed" Status

### User-visible symptom

When an admin adds a member manually, their status shows "Unclaimed" in the member list. It is unclear what this means, whether the member can use the platform, and how (if ever) the status resolves.

### Relevant UI components

| Component | Path |
|---|---|
| Member list | `apps/web/app/c/[slug]/members/MembersClient.tsx` |
| Member CRUD actions | `apps/web/app/c/[slug]/members/actions.ts` |
| Status badge tones | `STATUS_TONE` map: `unclaimed → "neutral"` |

### Relevant backend functions and queries

| Function | Location |
|---|---|
| `app.create_member` | `supabase/migrations/20260918140100_application_write_functions.sql` — inserts with `status = 'unclaimed', joined_via = 'manual'` |
| `app.update_member` | `supabase/migrations/20260920120100_member_identity_functions.sql` — edits name/phone/email/attributes |
| `app.restore_member` | Same file — restores archived member to `'active'` (if phone exists) or `'unclaimed'` |
| `app.redeem_invite_link` | Same file — joiner gets `'unclaimed'` (no approval) or `'pending_approval'` |
| `app.find_member_duplicates` | Same file — duplicate detection for MEM-08 |
| `app.resolve_collection_audience` | `supabase/migrations/20260920150000_collection_audience.sql` — includes `status IN ('active', 'unclaimed', 'invited')` |

### Database relationships

```
public.members
  ├── community_id  → communities(id)
  ├── user_id       → users(id), NULLABLE ← the "claimed" link
  ├── claimed_at    → timestamptz, NULLABLE
  ├── status        → member_status enum (default 'unclaimed')
  └── CONSTRAINT members_claimed_consistently:
       (user_id IS NULL) = (claimed_at IS NULL)
  └── CONSTRAINT members_active_has_phone:
       status = 'active' → phone_e164 IS NOT NULL
```

A member is **not** a user. A member is a community membership record. A user is a login identity (PRD 0.3, SEC-06). The `user_id` column links the two, and the `claimed_at` timestamp records when that link was established.

### Confirmed root cause

**"Unclaimed" is the correct and intentional default status for manually added members.** It means:

1. An officer created a member record for this person.
2. The person has **not** verified their identity or linked a user account.
3. The `user_id` column is `NULL` (enforced by `members_claimed_consistently` constraint).
4. The person cannot receive in-app notifications (no account to deliver to).
5. The person IS included in collection audiences (`resolve_collection_audience` includes `'unclaimed'` in its status filter).
6. The person cannot transition to `'active'` without a phone number (`members_active_has_phone` constraint).

**The claim workflow (MEM-08) has not been built yet.** The schema references it in comments (`20260917120500_members.sql` line 38: "Set when the person claims this record (MEM-08)"), duplicate detection references it (`20260920120100_member_identity_functions.sql` line 162: "Duplicate detection (MEM-08)"), but no function exists anywhere in the codebase that:
- Sets `user_id` on a member row
- Sets `claimed_at` on a member row
- Transitions a member from `unclaimed` to `active` by linking an account

Grep for `claim_member`, `link_member`, `linkAccount`, `claimMember`, `link_user`, `set.*user_id.*member` across the entire codebase returns zero results.

### What exists today

| Path into the system | Resulting status | `user_id` set? |
|---|---|---|
| Officer adds member manually | `unclaimed` | No |
| Person joins via invite link | `unclaimed` or `pending_approval` | No |
| Person signs up for an account | Creates `auth.users` + `public.users` | N/A (no member link) |

There is no automated or manual path from "person signs up" to "their account is linked to their existing member record." The `handle_new_auth_user()` trigger creates a `public.users` row and a personal community; it does not search for matching member records.

### Alternative hypotheses

- **The invite link flow could set `user_id`:** It does not. `app.redeem_invite_link` creates a new member row with `user_id` absent (the function runs as `auth.uid()` for permission checking but does not set the joiner's user_id on the member row — it sets `created_by = null`).

### Reproduction steps (local)

1. As an admin, add a member with name "Test Person" and phone `+2348012345678`.
2. Observe status = "Unclaimed" in the member list.
3. Sign up as `testperson@example.com`, complete verification.
4. The new user account has no link to the member record — they exist independently.
5. No UI or backend path exists to connect them.

### Classification

**Product-design gap / incomplete feature.** The schema is designed for claiming (MEM-08), the constraints enforce it correctly, but the actual workflow has not been implemented. This is not a bug — it is a missing feature that was planned but not yet built.

### Recommended actions

1. **Build MEM-08 (member claiming).** The schema is ready. An `app.claim_member()` function needs to:
   - Accept a `member_id` and validate the caller's identity against the member's email/phone
   - Set `user_id = auth.uid()`, `claimed_at = now()`
   - Transition status to `'active'` (if phone present) or leave as `'unclaimed'` (constraint enforces this)
   - Handle duplicate detection (what if multiple member records match the signing-up user?)

2. **Consider auto-linking on signup.** When `handle_new_auth_user()` fires, it could search for unclaimed members with a matching email or phone and auto-link them. This is a product decision with trade-offs:
   - **Pro:** Seamless experience for invited members who sign up.
   - **Con:** Auto-linking by email alone may match the wrong person in communities where an officer entered an approximate email. The PRD's duplicate detection (MEM-08, CON-27: "a merge is a deliberate act, never automatic") suggests this should be manual.

3. **Improve the "Unclaimed" status display.** Add a tooltip or help text explaining what unclaimed means and what the member can/cannot do (e.g., "This person hasn't linked an account yet. They're included in collections but can't receive in-app notifications.").

---

## C. Collection Reminders — Zero Members

### User-visible symptom

On a collection detail page, clicking "Send reminder" opens a dialog that shows "0 eligible members" even though the community has members. The admin expects to notify their community but the system reports no one to notify.

### Relevant UI components

| Component | Path |
|---|---|
| Collection detail | `apps/web/app/c/[slug]/collections/[collectionSlug]/CollectionDetailClient.tsx` |
| Send reminder dialog | Same file, `SendReminderDialog` (line 870) |
| Publish notify controls | Same file, `PublishNotifyControls` (line 690) |
| Recipient preview action | `apps/web/app/c/[slug]/collections/actions.ts` → `previewPublishRecipientsAction` (line 484) |

### Relevant backend functions and queries

| Function | Location | What it counts |
|---|---|---|
| `app.count_collection_publish_recipients` | `supabase/migrations/20261029100100_fix_count_collection_publish_recipients.sql` | Audience members **with `user_id IS NOT NULL`** |
| `app.count_collection_audience` | `supabase/migrations/20260920150000_collection_audience.sql` (updated in `20260920160300`) | ALL audience members regardless of user_id |
| `app.resolve_collection_audience` | `supabase/migrations/20260920150000_collection_audience.sql` | Members with `status IN ('active', 'unclaimed', 'invited')` |

### Database relationships

```
collections
  ├── community_id → communities(id)
  ├── audience_mode → 'all_members' | 'groups' | 'selected_members' | 'public'
  └── (no user_id — belongs to community)

app.resolve_collection_audience(collection_id)
  → members WHERE status IN ('active', 'unclaimed', 'invited')
  → applies audience_mode filter (all_members / groups / selected_members)
  → returns member_ids (INCLUDES unclaimed members)

app.count_collection_publish_recipients(collection_id)
  → calls resolve_collection_audience
  → JOIN members WHERE user_id IS NOT NULL  ← THE FILTER
  → returns (eligible: count, unpaid: count)
```

### Confirmed root cause

**The `count_collection_publish_recipients` function correctly filters to `user_id IS NOT NULL` because in-app notifications can only be delivered to members who have linked user accounts.** If all community members are `unclaimed` (no user_id), the eligible count is correctly zero.

The chain:

1. Admin adds members manually → all get `status = 'unclaimed'`, `user_id = NULL`.
2. `resolve_collection_audience` includes them (status filter passes).
3. `count_collection_publish_recipients` excludes them (`WHERE m.user_id IS NOT NULL` on line 339 of `20261028100000`).
4. Dialog shows "0 eligible members."

**The count is technically correct** — you cannot send an in-app notification to someone without an account. But **the UI is misleading** — it says "0 eligible members" without explaining that "eligible" means "has an account that can receive notifications," not "is in this collection's audience."

### Comparison of the two counts

The `previewPublishRecipientsAction` calls BOTH functions:
- `countCollectionPublishRecipients` → `eligible` (members with accounts) and `unpaid`
- `countCollectionAudience` → `with_obligation` and `awaiting` (total audience regardless of account status)

But the dialog only displays `eligible` and `unpaid` from the first function. The total audience count (`with_obligation + awaiting`) is available in the response but not shown in the reminder dialog. The publish dialog (line 726) at least includes the caveat: *"Members without an account are not reached in-app."* The reminder dialog does NOT include this caveat.

### Alternative hypotheses

- **The `RETURN QUERY` bug (`20261029100100`):** The original `count_collection_publish_recipients` lacked `RETURN QUERY`, causing error `42601`. The fix migration is in the codebase. If the fix migration has not been applied to the local database, the function throws an error and the dialog shows "Unknown number of..." instead of "0". This is a separate bug (already fixed in code, needs migration applied).

### Reproduction steps (local)

1. Create a community and add 5 members manually (all will be `unclaimed`, `user_id = NULL`).
2. Create a collection with `audience_mode = 'all_members'`, publish it.
3. Click "Send reminder" → dialog shows "0 eligible members."
4. Verify via SQL: `SELECT count(*) FROM app.resolve_collection_audience('<collection_id>')` → returns 5.
5. Verify via SQL: `SELECT * FROM app.count_collection_publish_recipients('<collection_id>')` → returns `eligible = 0, unpaid = 0`.
6. The 5 members exist in the audience but have no accounts, so the notification count is correctly zero.

### Classification

**Product-design issue** (the `user_id IS NOT NULL` filter is correct for in-app notifications) + **UX clarity issue** (the dialog does not explain why eligible = 0 when the community has members).

### Recommended actions

1. **Show both counts in the dialog.** Display the total audience alongside the notification-eligible count:
   > "5 members are in this collection's audience. 0 have accounts and can receive in-app notifications."

   The data is already available — `previewPublishRecipientsAction` returns `with_obligation` and `awaiting` from `countCollectionAudience`. The dialog ignores these fields.

2. **Add the publish dialog's caveat to the reminder dialog.** The publish dialog (line 726) says "Members without an account are not reached in-app." — the reminder dialog should say the same.

3. **Do NOT remove the `user_id IS NOT NULL` filter.** It is correct. In-app notifications require a user account. Removing it would create notification_deliveries rows for `recipient_user_id = NULL`, which would violate the schema or create undeliverable notifications.

4. **Long-term: build MEM-08 (Issue B).** Once members can claim their records and link accounts, the eligible count rises naturally. The zero-member problem goes away as members onboard.

5. **Consider additional notification channels.** If unclaimed members should receive notifications (e.g., SMS or email to the phone/email on the member record), that is a new feature (not a bug fix) requiring a product decision about consent (`consent_messages_at` column exists on members for this purpose).

---

## Summary of Findings

| Issue | Root Cause | Category | Code Change Needed? |
|---|---|---|---|
| A. Login failure | GoTrue re-signup for unconfirmed email looks like a new signup but reuses the existing account. No duplicate created. | Product-design (GoTrue UX) | No (safeguards are in place). Optional: better error messaging for unconfirmed emails. |
| B. Unclaimed status | `unclaimed` is the correct default for manually added members. The claim workflow (MEM-08) has not been built. | Missing feature | Yes — build MEM-08. The schema is ready. |
| C. Zero recipients | `count_collection_publish_recipients` correctly filters to `user_id IS NOT NULL`. All members are unclaimed → zero eligible. The dialog does not explain this. | UX clarity + depends on Issue B | Yes — show total audience count alongside notification-eligible count in the dialog. |

### Cross-cutting dependency

Issues B and C are fundamentally linked. The zero-recipient problem (C) is a symptom of the missing claim workflow (B). Building MEM-08 is the structural fix: once members can link accounts, they become notification-eligible. The UI clarity fix for C is a stopgap that makes the current state understandable while MEM-08 is built.

### Safety confirmation

- No remote, staging, or production systems were accessed.
- No migrations were applied.
- No database was reset or modified.
- No emails were sent.
- No Git state was changed (no commits, no stashes, no reverts).
- All investigation was read-only against the local codebase.
