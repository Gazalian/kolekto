import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * The golden path: sign up with password, complete onboarding (which creates
 * the first community), then create a second community and add a member. Each
 * step is a real browser interaction against the real local stack — no mocked
 * Supabase client, no seeded session.
 */
test("sign up with password, complete onboarding, and add a member", async ({ page }) => {
  await signInAsNewUser(page);

  // After onboarding + navigation, we land on the communities listing. The
  // onboarding-created community should be visible.
  await expect(page).toHaveURL(/\/communities/);

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  const communityName = `E2E Test Fellowship ${Date.now()}`;
  await page.getByLabel("Community name").fill(communityName);
  await page.getByLabel("Type").selectOption("fellowship");
  await page.getByRole("button", { name: "Create community" }).click();

  await expect(page).toHaveURL(/\/c\//);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: communityName })).toBeVisible();

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Test Member");
  await dialog.getByLabel("Phone number").fill("+2348011112222");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();

  await expect(page.getByText("Test Member")).toBeVisible();
});
