import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * The golden path this phase exists to support (section 30): sign in, create
 * a community, add a member. Each step is a real browser interaction against
 * the real local stack — no mocked Supabase client, no seeded session.
 */
test("sign in via email OTP, create a community, and add a member", async ({ page }) => {
  // The OTP flow itself, including the hydration wait and the retry the local
  // stack occasionally needs, lives in helpers/auth.ts — it is the first step of
  // every journey in this suite, and its reasoning is worth stating once.
  await signInAsNewUser(page);

  // COM-01: a brand-new sign-up already has their personal community.
  await expect(page.getByText("Personal")).toBeVisible();

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
