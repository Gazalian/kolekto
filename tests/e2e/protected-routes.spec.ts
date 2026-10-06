import { expect, test } from "@playwright/test";

test.describe("protected routes", () => {
  test("visiting /communities while signed out redirects to /login", async ({ page }) => {
    await page.goto("/communities");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Sign in to Kolekto" })).toBeVisible();
  });

  test("the landing page offers sign-in when signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("/signup is accessible when signed out", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Create your Kolekto account" })).toBeVisible();
  });

  test("/forgot-password is accessible when signed out", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  });
});
