import { expect, test } from "@playwright/test";
import { readOtpCode } from "./helpers/mailpit.ts";

async function signUpNewUser(page: import("@playwright/test").Page, prefix = "onboard") {
  let lastSignedUpEmail = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (/\/welcome/.test(page.url())) {
      if (!lastSignedUpEmail) throw new Error("On /welcome but no signup completed");
      return lastSignedUpEmail;
    }

    const email = `${prefix}-${Date.now()}-${attempt}@example.test`;
    const phone = `+23480${String(Date.now()).slice(-8)}`;

    await page.goto("/signup");
    await page.waitForLoadState("domcontentloaded");

    if (/\/welcome/.test(page.url())) return lastSignedUpEmail || email;
    if (!/\/signup/.test(page.url())) {
      if (attempt === 2) throw new Error(`Expected /signup but landed on ${page.url()}`);
      continue;
    }

    await page.getByLabel("Full name").fill("Onboarding Test");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Phone number").fill(phone);
    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.first().fill("Test1234!");
    await passwordInputs.last().fill("Test1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    try {
      await page.waitForURL(/\/verify/, { timeout: 30_000 });
    } catch {
      if (attempt === 2) throw new Error("Local stack did not accept signup after two attempts");
      continue;
    }

    lastSignedUpEmail = email;
    const code = await readOtpCode(email);
    await page.getByLabel("Verification code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();

    try {
      await page.waitForURL(/\/welcome/, { timeout: 120_000 });
    } catch {
      if (attempt === 2) throw new Error("Local stack did not complete verification after two attempts");
      continue;
    }

    return email;
  }
  throw new Error("unreachable");
}

test.describe("onboarding paths", () => {
  test.slow();

  test("Path A — Start a collection", async ({ page }) => {
    const email = await signUpNewUser(page, "path-a");

    await expect(page.getByText("What would you like to do first?")).toBeVisible();

    await page.getByRole("button", { name: "Create a collection" }).click();

    await page.waitForURL(/\/c\/.*\/collections\/new/, { timeout: 30_000 });

    // Verify we landed on collection creation inside personal workspace
    await expect(page).toHaveURL(/\/c\/.*\/collections\/new/);

    // Refresh should persist
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/c\/.*\/collections\/new/);

    // Go to communities to verify personal workspace exists
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("My Workspace").first()).toBeVisible();
  });

  test("Path B — Set up a community", async ({ page }) => {
    const email = await signUpNewUser(page, "path-b");

    await expect(page.getByText("What would you like to do first?")).toBeVisible();

    await page.getByRole("link", { name: "Set up a community" }).click();
    await page.waitForURL(/\/setup\/type/);

    await page.getByRole("button", { name: "Fellowship" }).click();
    await page.waitForURL(/\/setup\/create/);

    const communityName = `Path B Community ${Date.now()}`;
    await page.getByLabel("Community name").fill(communityName);
    await page.getByRole("button", { name: "Create community" }).click();

    await page.waitForURL(/\/c\//, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: communityName })).toBeVisible();

    // Refresh works
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/c\//);

    // Go to communities — should see both personal workspace and named community
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("My Workspace").first()).toBeVisible();
    await expect(page.getByText(communityName)).toBeVisible();
  });

  test("Path C — Do this later", async ({ page }) => {
    const email = await signUpNewUser(page, "path-c");

    await expect(page.getByText("What would you like to do first?")).toBeVisible();

    await page.getByRole("button", { name: "Do this later" }).click();

    await page.waitForURL(/\/c\//, { timeout: 30_000 });

    // Should land in personal workspace overview showing "My Workspace"
    await expect(page.getByRole("heading", { name: "My Workspace" })).toBeVisible();

    // Refresh works
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/c\//);

    // Can navigate to communities
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("My Workspace").first()).toBeVisible();

    // Can create a new community later
    await page.getByRole("link", { name: "+ New community" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Create a community" })).toBeVisible();
  });
});

test.describe("onboarding edge cases", () => {
  test.slow();

  test("already-onboarded user visiting /welcome is redirected", async ({ page }) => {
    // Sign up and complete onboarding
    await signUpNewUser(page, "redir");
    await page.getByRole("button", { name: "Do this later" }).click();
    await page.waitForURL(/\/c\//, { timeout: 30_000 });

    // Try to visit onboarding routes — should redirect to /communities
    await page.goto("/welcome");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/communities/);

    await page.goto("/setup/type");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/communities/);
  });

  test("un-onboarded user visiting /communities is redirected to /welcome", async ({ page }) => {
    // Sign up but don't complete onboarding — use signUpNewUser which lands on /welcome
    await signUpNewUser(page, "no-onboard");

    // Now try to go to /communities directly
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");
    // Should be redirected to /welcome because not onboarded
    await expect(page).toHaveURL(/\/welcome/);
  });

  test("invalid OTP code shows an error and does not grant access", async ({ page }) => {
    // Reach /verify with a real signup, then submit a wrong code. The
    // security-relevant invariant is that a bad code grants no session: the
    // user stays on /verify and is never taken to the onboarding flow.
    //
    // The signup step carries the same retry the shared helper uses, because
    // the local stack occasionally does not accept the first signup under load
    // (see signUpNewUser) — that flakiness is in the fixture, not the gate.
    let reachedVerify = false;
    for (let attempt = 1; attempt <= 2 && !reachedVerify; attempt += 1) {
      const email = `bad-otp-${Date.now()}-${attempt}@example.test`;
      const phone = `+23480${String(Date.now()).slice(-8)}`;

      await page.goto("/signup");
      await page.waitForLoadState("domcontentloaded");
      await page.getByLabel("Full name").fill("Invalid OTP Test");
      await page.getByLabel("Email address").fill(email);
      await page.getByLabel("Phone number").fill(phone);
      const passwordInputs = page.locator('input[type="password"]');
      await passwordInputs.first().fill("Test1234!");
      await passwordInputs.last().fill("Test1234!");
      await page.getByRole("button", { name: "Create account" }).click();

      try {
        await page.waitForURL(/\/verify/, { timeout: 30_000 });
        reachedVerify = true;
      } catch {
        if (attempt === 2) throw new Error("Local stack did not accept signup after two attempts");
      }
    }

    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();

    // A danger banner is shown (the mapped auth error), the code field is still
    // present, and navigation to the onboarding flow never happens.
    await expect(
      page.getByText(/code has expired|Something went wrong/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Verification code")).toBeVisible();
    await expect(page).toHaveURL(/\/verify/);
  });

  test("unauthenticated visit to a protected path is redirected to /login", async ({ page }) => {
    // /welcome and /communities are not public; a signed-out visitor must be
    // bounced to /login, never served the page.
    await page.goto("/welcome");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/communities");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/login/);
  });

  test("logout and re-login works after onboarding", async ({ page }) => {
    const email = await signUpNewUser(page, "relogin");
    await page.getByRole("button", { name: "Do this later" }).click();
    await page.waitForURL(/\/c\//, { timeout: 30_000 });

    // Sign out — post to /logout
    await page.goto("/communities");
    await page.waitForLoadState("networkidle");

    // Click community to get to AppShell with logout button
    await page.getByText("My Workspace").first().click();
    await page.waitForLoadState("networkidle");

    // Sign out
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: 30_000 });

    // Re-login with password
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("Test1234!");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Should go to /communities, not /welcome (already onboarded)
    await page.waitForURL(/\/communities/, { timeout: 60_000 });
    await expect(page.getByText("My Workspace").first()).toBeVisible();
  });
});
