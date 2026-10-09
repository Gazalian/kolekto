# QA-ENV-01 — Browser E2E Blocker: Investigation

**Date:** 2026-10-07
**Branch:** `m13.1-notification-foundation` · **HEAD:** `e533e44`
**Nature:** Read-only diagnosis. No application code changed, no DB reset, no production touched. M12A stash preserved.

---

## 1. Executive summary

The browser multi-user E2E cannot complete because signup→OTP→`/verify` succeeds but the app never reaches `/welcome`, so the authenticated UI (and the NotificationBell) is never exercised.

Read-only isolation shows **every dependency and every auth operation is healthy and fast**:

- Node (undici) → Kong/GoTrue reachable in ~210 ms; curl in ~170 ms; URL is `127.0.0.1` (no IPv6 trap); no proxy env vars.
- A **headless Node replay of the full auth flow** (signUp → Mailpit OTP → `verifyOtp` → `getUser`) completes cleanly: signUp 737 ms, OTP 111 ms, `verifyOtp` ok (session=true) 185 ms, **`getUser` ok 148 ms**.
- During an actual browser stall, Kong logs show the server-side calls **succeeding**: `POST /auth/v1/verify → 200`, multiple `GET /auth/v1/user → 200` (from "Next.js Middleware"), and `GET /rest/v1/users?select=onboarding_completed_at → 200`. Requests flow and succeed up to the point of stall, then simply stop progressing.

So the hang is **not** GoTrue/Kong, **not** the DB, **not** Node networking, and **not** the auth operations themselves. It is the resource-constrained local environment failing to reliably complete the multi-step Next.js **server-action → middleware-redirect → navigation → SSR** onboarding sequence. The failure is **intermittent** (the earliest attempts in this engagement did reach `/welcome`), which is consistent with a timing/resource cause, not a deterministic code bug. Critically, **CI does not run the Playwright suite at all**, so there is currently no sufficiently-resourced environment in which this flow is exercised.

## 2. Exact reproduction

1. `npx playwright test <probe>` (real Chromium, production web build on `:3010`, reuseExistingServer).
2. Spec: `/signup` → fill form → Create account → `/verify` → read OTP from Mailpit → fill → **Verify** → `waitForURL(/welcome)`.
3. Observed: reaches `/verify`, obtains OTP, clicks Verify (logged `VERIFY_CLICK 20:15:12Z`); `/welcome` never arrives; `STALLED_AT_VERIFY 20:15:42Z`.
4. Reproduced across 8+ attempts this engagement, including a freshly rebuilt web server and a clean (0-Chromium) process state.

`VerifyForm.tsx` calls `supabase.auth.verifyOtp(...)` (succeeds) then `await setContactVerifiedAction()` before `router.push("/welcome")`; the client's `loading` state never clears (the Verify button stays disabled), i.e. the awaited server-action round-trip does not resolve in the browser.

## 3. Evidence (request/response timing)

| Probe | Result |
|---|---|
| curl → `GET /auth/v1/health` | 200, 0.17 s |
| curl → `GET /auth/v1/user` (no token) | 403, 0.10 s |
| Node undici → `GET /auth/v1/health` | 200, 213 ms |
| Headless Node `signUp` | ok, 737 ms |
| Headless Node Mailpit OTP read | ok, 111 ms |
| Headless Node `verifyOtp` | ok (session=true), 185 ms |
| Headless Node **`getUser`** | **ok, 148 ms** |

## 4. Server logs (Kong, during a real browser stall, verify click 20:15:12Z → stall 20:15:42Z)

```
20:15:13 POST /auth/v1/verify            200 2418   (browser; verifyOtp)
20:15:13 GET  /auth/v1/user              200 1274   "Next.js Middleware"
20:15:14 GET  /auth/v1/user              200 1274   "Next.js Middleware"
20:15:17 GET  /auth/v1/user              200 1274   "Next.js Middleware"
20:15:17 GET  /rest/v1/users?select=onboarding_completed_at&id=eq.<uid>  200 32  "Next.js Middleware"
20:15:18 GET  /auth/v1/user              200 1274   "Next.js Middleware"
20:15:18 GET  /rest/v1/users?...         200 32     "Next.js Middleware"
   (then no further Supabase requests; probe gives up at 20:15:42)
```

All Supabase calls return **200**. The middleware (`apps/web/lib/supabase/middleware.ts` `updateSession`, matched on nearly all paths) runs `getUser` on every request and, for authenticated non-public/onboarding paths, a PostgREST `users.onboarding_completed_at` read — both succeed. The sequence advances to ~20:15:18 then stops; nothing further hits Kong, so the stall is **downstream of the Supabase calls**, in the Next.js server/runtime or the client-side action/navigation handling.

## 5. Supabase / Kong / GoTrue findings

Healthy. `supabase_auth_kolekto`, `supabase_kong_kolekto`, `supabase_db_kolekto`, `supabase_rest_kolekto` all `Up (healthy)`. `GET /auth/v1/health` 200 in 0.17 s. The full auth flow (including token validation via `getUser`) works headlessly from Node. No 5xx/504 observed in the captured windows. **Not the blocker.**

## 6. Resource / concurrency findings (at idle)

- node processes: 5; chrome processes: 0 (no runaway/stale browsers after cleanup).
- Postgres: `max_connections=100`, current=18, idle-in-transaction=0 (no exhaustion, no stuck transactions).
- All containers healthy, up ~29 h.
- The repo's own `playwright.config.ts` documents this suite as **flaky on ~4-CPU/4-GB machines** sharing cores with the full Supabase stack ("a sign-in the local stack would not accept", tests that pass alone but fail under suite load) — i.e. the authors already attribute these failures to resource constraints, matching project memory ("Kong 504s on auth OTP under load; E2E sign-in failures are usually environmental").

## 7. Environment findings (names only; no secrets printed)

`apps/web/.env.local` (loaded by Next from the app dir) provides everything the server needs: `KOLEKTO_ENV`, `NEXT_PUBLIC_SUPABASE_URL` (= `http://127.0.0.1:54321`), `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `KOLEKTO_PRODUCTION_PROJECT_REF`, `KOLEKTO_SESSION_SECRET` (and provider keys that M13.1 does not use). Availability:

| Consumer | Has what it needs |
|---|---|
| Browser | `NEXT_PUBLIC_*` (build-inlined) ✅ |
| Next server / server actions | full `apps/web/.env.local` incl. `SUPABASE_DB_URL` ✅ |
| Worker | `SUPABASE_DB_URL` ✅ |

No proxy variables; URL uses `127.0.0.1` not `localhost`. **No env misconfiguration found** — the earlier "missing DB env" hypothesis is disproven.

## 8. Next-server / server-action observations

- The flow's first server-side auth touch is in the **middleware** (`updateSession`), which runs on nearly every path and calls `getUser` + a PostgREST read; both return 200.
- **Observation (not a confirmed bug, not fixed):** the middleware redirects authenticated requests on auth paths — including **`/verify`** — to `/communities`. The post-verify `setContactVerifiedAction` server-action POST targets `/verify`, so once the session is established that POST is itself subject to a middleware redirect. Server-action-POST-vs-middleware-redirect is a known-fragile Next.js interaction and is a plausible contributor to the client `await` not resolving cleanly. This lives in `apps/web/lib/supabase/middleware.ts` and `apps/web/app/(auth)/verify/VerifyForm.tsx` — **auth/onboarding scope, not notification code**. It was **not** modified.
- Because the failure is intermittent and every dependency is fast, the dominant cause is environmental/runtime timing, not this interaction alone.

## 9. Root-cause classification

**Primary: (1) LOCAL ENVIRONMENT ISSUE / (2) QA-RESOURCE ISSUE.**
The browser multi-user E2E cannot complete because the only available environment — this resource-constrained local stack — cannot reliably finish the multi-step Next.js onboarding sequence (server action → middleware redirect → navigation → SSR render), and **CI does not run the Playwright suite**, so no better-resourced environment currently exercises it. Every dependency (GoTrue, Kong, PostgREST, Postgres, Node networking) and every auth operation (signUp/OTP/verify/getUser) is healthy and fast in isolation.

**Explicitly ruled out:** (3) Supabase/Kong/GoTrue (all 200/healthy); (5) auth/onboarding application bug in the auth operations (they work headlessly); DB connection (worker + middleware queries succeed); env misconfiguration (all vars present).

**Secondary, for a separate review (not this task):** (4) a Next.js server-action-on-auth-path + middleware-redirect interaction (§8) that is worth hardening in a future **auth/onboarding** milestone. It is not an M13.1 notification defect.

## 10. Recommended minimum next action

1. **Run the browser multi-user E2E in a sufficiently-resourced environment.** Concretely: add a Playwright job to CI on `ubuntu-latest` (which runs `supabase start` + the stack far more capably than this 4-CPU Windows machine), or run the suite on a developer machine / CI runner with more CPU/RAM. The repo's `playwright.config.ts` already targets this scenario. This is the minimum step to unblock FINAL-2 and allow M13.1 closure.
2. **Optional, separate scope:** have the auth/onboarding owners review the middleware's handling of server-action POSTs on auth paths (§8) to make `/verify → /welcome` deterministic even under load. Not required for M13.1 notification correctness; must not be bundled into M13.1.

No M13.1 **notification** code change is indicated by this investigation.

## 11. What was NOT changed

No application code was modified. Specifically untouched: `VerifyForm.tsx`, `setContactVerifiedAction`, `apps/web/lib/supabase/middleware.ts`, the notification worker/schema/migrations/UI, and all unrelated code. Diagnosis used only read-only tools (curl, a headless Node script in the scratchpad using the installed `@supabase/supabase-js`, docker logs, psql reads) plus temporary Playwright probe specs that were **removed** afterward. A few disposable QA auth users were created by the probes (harmless local test accounts); no existing data was modified or deleted.

## 12. Git safety state

- Branch `m13.1-notification-foundation`, HEAD `e533e44` (unchanged).
- `stash@{0}` (M12A) present and untouched.
- No reset/clean/stash-pop; no DB reset; no production access.
- Working tree unchanged except the M13.1 + FINAL-1 work and the QA/fix reports (this report added). Temporary Playwright probe specs removed; no stray test specs remain.

---

**Conclusion:** the FINAL-2 browser-E2E blocker is an **environment/resource** problem, not a Supabase, database, or auth-operation fault, and not an M13.1 notification defect. Unblock it by running the browser E2E where the stack is not starved (CI on ubuntu-latest or a better-resourced runner). M13.1 remains **not closed** until that E2E is completed there.
