import { expect, test } from "@playwright/test";
import { readOtpCode } from "./helpers/mailpit.ts";

/**
 * The golden path this phase exists to support (section 30): sign in, create
 * a community, add a member. Each step is a real browser interaction against
 * the real local stack — no mocked Supabase client, no seeded session.
 */
test("sign in via email OTP, create a community, and add a member", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  await page.goto("/login");
  // Without this, a click can land before the page finishes hydrating and
  // falls through to the <form>'s native GET submission instead of React's
  // onSubmit handler — observed directly against this build; Next.js gives
  // no other DOM signal that hydration has completed.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();

  await expect(page.getByText(email)).toBeVisible();
  const code = await readOtpCode(email);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Verify and sign in" }).click();

  await expect(page).toHaveURL(/\/communities/);

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
