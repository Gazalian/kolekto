import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

test.describe.configure({ timeout: 180_000 });

test("deleting a member field requires confirmation", async ({ page }) => {
  await signInAsNewUser(page, "e2e-field-del");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(`E2E Field Delete ${Date.now()}`);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  // ── Add a custom field ────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Member profile" }).click();
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label").fill("Block number");
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(page.getByText("Field saved.")).toBeVisible();

  // ── Add a member with a value for the field ───────────────────────────────
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Add member" }).click();
  const addDialog = page.getByRole("dialog");
  await addDialog.getByLabel("Full name").fill("Amina Bello");
  await addDialog.getByLabel("Phone number").fill("+2348090000001");
  await addDialog.getByLabel(/Block number/).fill("B-12");
  await addDialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByRole("cell", { name: "B-12" })).toBeVisible();

  // ── Re-open profile config and click Remove ───────────────────────────────
  await page.getByRole("button", { name: "Member profile" }).click();
  const configDialog = page.getByRole("dialog");
  await expect(configDialog.getByText("Block number")).toBeVisible();
  await configDialog.getByRole("button", { name: "Remove" }).click();

  // The confirmation dialog appears — the field is NOT yet deleted.
  await expect(configDialog.getByText('Remove "Block number"?')).toBeVisible();
  await expect(configDialog.getByText("1 member has a value")).toBeVisible();

  // ── Cancel leaves the field intact ────────────────────────────────────────
  await configDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(configDialog.getByText("Block number")).toBeVisible();

  // ── Confirm actually deletes the field ────────────────────────────────────
  await configDialog.getByRole("button", { name: "Remove" }).click();
  await expect(configDialog.getByText('Remove "Block number"?')).toBeVisible();
  await configDialog.getByRole("button", { name: "Remove field" }).click();
  await expect(configDialog.getByText('"Block number" removed.')).toBeVisible();
});
