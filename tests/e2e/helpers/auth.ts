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
export async function signInAsNewUser(page: Page, prefix = "e2e"): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const email = `${prefix}-${Date.now()}-${attempt}@example.test`;

    // ── Step 1: Sign up with password ──────────────────────────────────────
    await page.goto("/signup");
    await page.waitForLoadState("networkidle");

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

    await page.getByRole("link", { name: "Set up a community" }).click();
    await page.waitForURL(/\/setup\/type/);

    await page.getByRole("button", { name: "Fellowship" }).click();
    await page.waitForURL(/\/setup\/create/);

    const communityName = `E2E Community ${Date.now()}`;
    await page.getByLabel("Community name").fill(communityName);
    await page.getByRole("button", { name: "Create community" }).click();

    try {
      await page.waitForURL(/\/c\//, { timeout: 30_000 });
    } catch {
      if (attempt === 2) {
        throw new Error("The local stack did not complete onboarding after two attempts");
      }
      continue;
    }

    await expect(page).toHaveURL(/\/c\//);

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
