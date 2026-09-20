import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * Groups in a real browser: create one, put people in it, filter the roster by
 * it, take someone out again.
 *
 * The assertion worth having is the filter. A group is only useful if the roster
 * can answer "who is in 300 Level", and that is the same question a collection
 * audience will ask later.
 */

test.describe.configure({ timeout: 180_000 });

async function addMember(page: Page, name: string, phone: string): Promise<void> {
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill(name);
  await dialog.getByLabel("Phone number").fill(phone);
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("cell", { name })).toBeVisible();
}

test("create a group, assign members, filter by it, and remove someone", async ({ page }) => {
  await signInAsNewUser(page, "e2e-groups");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(`E2E Groups ${Date.now()}`);
  await page.getByLabel("Type").selectOption("fellowship");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  await addMember(page, "Ada Youth", "+2348071110001");
  await addMember(page, "Bem Adult", "+2348071110002");

  // ── Create the group ──────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("Youth");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group saved.")).toBeVisible();
  await expect(page.getByText("0 members")).toBeVisible();

  // ── Put one person in it ──────────────────────────────────────────────────
  await page.getByRole("button", { name: "Add members" }).click();
  // By name, not by position: the roster is ordered newest-first, so "first
  // checkbox" is whoever was added last — an assumption that would have made
  // this test pass while the wrong person joined the group.
  await page.getByRole("dialog").locator("label", { hasText: "Ada Youth" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByText("1 member added.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForLoadState("networkidle");

  // ── The roster can answer "who is in Youth" ───────────────────────────────
  await page.getByLabel("Group").selectOption({ label: "Youth" });
  await expect(page.getByRole("cell", { name: "Ada Youth" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Bem Adult" })).toHaveCount(0);

  await page.getByLabel("Group").selectOption("");
  await expect(page.getByRole("cell", { name: "Bem Adult" })).toBeVisible();

  // ── And take them out again ───────────────────────────────────────────────
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "View members" }).click();
  await page.getByRole("button", { name: "Remove" }).click();

  // Closing the member list returns to the groups list, which is still the open
  // modal — clicking anything on the page behind it would never land.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByText("0 members")).toBeVisible();
});
