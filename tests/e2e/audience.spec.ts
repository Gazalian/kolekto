import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * Collection audience, in a browser (§24, §38).
 *
 * The journey exists to prove one product rule end to end: a collection can be
 * aimed at a group, and a member who joins that group afterwards becomes
 * ELIGIBLE without becoming INDEBTED. The officer is told, and decides.
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

test("aim a collection at a group, then add obligations for newly eligible members", async ({ page }) => {
  await signInAsNewUser(page, "e2e-audience");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(`E2E Audience ${Date.now()}`);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  // ── Two members, one group, one of them in it ─────────────────────────────
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await addMember(page, "Ada Third", "+2348073330001");
  await addMember(page, "Bem Fourth", "+2348073330002");

  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("300 Level");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group saved.")).toBeVisible();

  await page.getByRole("button", { name: "Add members" }).click();
  await page.getByRole("dialog").locator("label", { hasText: "Ada Third" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByText("1 member added.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForLoadState("networkidle");

  // ── A collection for that group ───────────────────────────────────────────
  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /Dues or a levy/ }).click();
  await page.getByLabel("What is this collection called?").fill("Level Dues 2026");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Amount each person pays").fill("5000");
  await page.getByRole("button", { name: "Continue" }).click();

  // Who it is for: specific groups, and the collection must not charge anyone yet.
  await page.getByRole("radio", { name: /Specific groups/ }).check();
  await page.getByRole("checkbox", { name: "300 Level" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click(); // no extra questions

  await expect(page.getByText("Specific groups")).toBeVisible();
  await page.getByRole("button", { name: "Open this draft" }).click();
  await expect(page).toHaveURL(/\/collections\/level-dues-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  // ── One eligible member, none expected yet ────────────────────────────────
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("For 300 Level")).toBeVisible();
  await expect(page.getByText("1 eligible · 0 already expected to pay")).toBeVisible();

  await page.getByRole("button", { name: /Add 1 obligation/ }).click();
  await expect(page.getByRole("cell", { name: "₦5,000" })).toBeVisible();
  await expect(page.getByText("Not yet paid")).toBeVisible();

  // ── The second member joins the group afterwards ──────────────────────────
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  await page.getByRole("dialog").locator("label", { hasText: "Bem Fourth" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByText("1 member added.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "Level Dues 2026" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Members" }).click();

  // Eligible, and explicitly NOT yet expected to pay — the rule this test exists for.
  await expect(page.getByText("2 eligible · 1 already expected to pay")).toBeVisible();
  await expect(page.getByText("1 eligible member is not expected to pay yet.")).toBeVisible();

  // The officer decides.
  await page.getByRole("button", { name: /Add 1 obligation/ }).click();
  await expect(page.getByText("2 eligible · 2 already expected to pay")).toBeVisible();
  await expect(page.getByText(/not expected to pay yet/)).toHaveCount(0);
});
