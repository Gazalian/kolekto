import { expect, type Page } from "@playwright/test";
import { readOtpCode } from "./mailpit.ts";

/**
 * Signs up a brand-new user through the full password signup + email
 * verification + onboarding flow, retrying the OTP send once if the local
 * stack stalls.
 *
 * Flow: /signup → /verify (email OTP) → /welcome → "Set up a community" → /setup/type → /setup/create → /c/[slug]
 *
 * Each attempt uses a NEW address, because GoTrue's SMTP_MAX_FREQUENCY (60s,
 * supabase/config.toml) rejects a second send to the same one.
 *
 * Returns the email address that signed up.
 */
/**
 * Drives the onboarding flow from /welcome through to a created community:
 * /welcome → /setup/type → /setup/create → create community → /c/[slug].
 * Assumes the browser is authenticated and currently on /welcome. Throws if a
 * step does not complete, so the caller can decide whether to retry.
 */
async function completeOnboarding(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Set up a community" }).click();
  await page.waitForURL(/\/setup\/type/);

  await page.getByRole("button", { name: "Fellowship" }).click();
  await page.waitForURL(/\/setup\/create/);

  const communityName = `E2E Community ${Date.now()}`;
  await page.getByLabel("Community name").fill(communityName);
  await page.getByRole("button", { name: "Create community" }).click();

  await page.waitForURL(/\/c\//, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/c\//);
}

/**
 * Whether the browser already holds an authenticated session, decided by where
 * middleware sends a request for /welcome: an unauthenticated request is
 * redirected to /login; an authenticated one stays on /welcome (not onboarded)
 * or is sent on to /communities (already onboarded). Navigates as a side
 * effect, leaving the page on whichever route middleware chose.
 */
async function isAuthenticated(page: Page): Promise<boolean> {
  await page.goto("/welcome");
  await page.waitForLoadState("networkidle");
  return !new URL(page.url()).pathname.startsWith("/login");
}

/** Fails immediately, with diagnostics, if the browser is not on the signup form. */
async function assertOnSignupPage(page: Page): Promise<void> {
  const path = new URL(page.url()).pathname;
  const createAccountVisible = await page
    .getByRole("button", { name: "Create account" })
    .isVisible()
    .catch(() => false);
  if (!path.startsWith("/signup") || !createAccountVisible) {
    const title = await page.title().catch(() => "(unknown)");
    const heading = await page
      .locator("h1, h2")
      .first()
      .innerText()
      .catch(() => "(none)");
    throw new Error(
      `Expected the signup form but the browser is on ${page.url()} ` +
        `(title: ${JSON.stringify(title)}, heading: ${JSON.stringify(heading)}). ` +
        `The browser may already be authenticated from a previous attempt.`,
    );
  }
}

export async function signInAsNewUser(page: Page, prefix = "e2e"): Promise<string> {
  let email = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A previous attempt may already have authenticated the browser (e.g. OTP
    // verification succeeded but a later step was retried). Re-running signup
    // would land an authenticated user on /welcome via redirect and then fail
    // trying to fill the signup form — the misleading "Full name" timeout. So
    // on retry, detect the authenticated state and resume onboarding from it
    // instead of signing up again.
    if (attempt > 1 && (await isAuthenticated(page))) {
      if (new URL(page.url()).pathname.startsWith("/welcome")) {
        await completeOnboarding(page);
      }
      await page.goto("/communities");
      await page.waitForLoadState("networkidle");
      return email;
    }

    email = `${prefix}-${Date.now()}-${attempt}@example.test`;

    // ── Step 1: Sign up with password ──────────────────────────────────────
    await page.goto("/signup");
    await page.waitForLoadState("networkidle");
    await assertOnSignupPage(page);

    await page.getByLabel("Full name").fill("E2E Test User");
    await page.getByLabel("Email address").fill(email);
    const phone = `+23480${String(Date.now()).slice(-8)}`;
    await page.getByLabel("Phone number").fill(phone);
    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.first().fill("Test1234!");
    await passwordInputs.last().fill("Test1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    // ── Step 2: Email OTP verification ─────────────────────────────────────
    try {
      await page.waitForURL(/\/verify/, { timeout: 30_000 });
    } catch {
      if (attempt === 2) {
        throw new Error("The local stack did not accept a signup after two attempts");
      }
      continue;
    }

    const code = await readOtpCode(email);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();

    // ── Step 3: Onboarding ─────────────────────────────────────────────────
    try {
      await page.waitForURL(/\/welcome/, { timeout: 30_000 });
    } catch {
      if (attempt === 2) {
        throw new Error("The local stack did not complete verification after two attempts");
      }
      continue;
    }

    try {
      await completeOnboarding(page);
    } catch {
      if (attempt === 2) {
        throw new Error("The local stack did not complete onboarding after two attempts");
      }
      continue;
    }

    // Navigate to /communities so callers can click "+ New community" or
    // interact with the community listing, matching the old helper's contract.
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");

    return email;
  }

  throw new Error("unreachable");
}

/**
 * Signs in an existing user via OTP (the login page's "Sign in with OTP"
 * alternative). Kept for tests that need to re-authenticate a previously
 * created user.
 */
export async function signInWithOtp(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Sign in with OTP" }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();

  await page.getByText(email).waitFor({ timeout: 30_000 });

  const code = await readOtpCode(email);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();

  await page.waitForURL(/\/communities/, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/communities/);
}
