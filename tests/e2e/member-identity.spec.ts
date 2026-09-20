import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * Milestone 1 in a real browser: a community defines how it identifies its own
 * members, and the roll behaves accordingly.
 *
 *   configure the member ID prefix → define a community field that identifies
 *   people → add a member and see the ID Kolekto issued → be warned about a
 *   possible duplicate → be refused an exact one → archive and restore
 *
 * The assertions that matter are the ones a jsonb column could not have made
 * true: an issued code, a unique field that refuses a second holder, and a
 * duplicate check that names the existing person.
 */

test.describe.configure({ timeout: 180_000 });

test("configure member identity, add members, and handle duplicates", async ({ page }) => {
  await signInAsNewUser(page, "e2e-members");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(`E2E Member Identity ${Date.now()}`);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  // ── The community's own identity scheme ───────────────────────────────────
  await page.getByRole("button", { name: "Member profile" }).click();
  await page.getByLabel("Prefix").fill("KWASU/");
  await expect(page.getByText("KWASU/0001")).toBeVisible();
  await page.getByRole("button", { name: "Save ID format" }).click();
  await expect(page.getByText("Member ID format saved.")).toBeVisible();

  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label").fill("Matric number");
  await page.getByLabel("This field identifies a member").check();
  // Marking a field as identifying forces uniqueness — one implies the other.
  await expect(page.getByLabel("Must be unique")).toBeChecked();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(page.getByText("Field saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // ── A member, and the ID the database issued them ─────────────────────────
  await page.getByRole("button", { name: "Add member" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Chidi Eze");
  await dialog.getByLabel("Phone number").fill("+2348011110001");
  await dialog.getByLabel(/Matric number/).fill("20/53A/021");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();

  await expect(page.getByText("KWASU/0001")).toBeVisible();
  await expect(page.getByRole("cell", { name: "20/53A/021" })).toBeVisible();

  // ── A possible duplicate: same phone, different person ────────────────────
  await page.getByRole("button", { name: "Add member" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Chidi Eze Jr");
  await dialog.getByLabel("Phone number").fill("+2348011110001");
  await dialog.getByLabel(/Matric number/).fill("20/53A/022");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();

  await expect(page.getByText("Possible duplicate")).toBeVisible();
  await expect(page.getByText("Same phone number")).toBeVisible();
  await page.getByRole("button", { name: /add anyway/i }).click();

  await expect(page.getByText("KWASU/0002")).toBeVisible();

  // ── An exact duplicate: the identifying field is already taken ────────────
  await page.getByRole("button", { name: "Add member" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Someone Else");
  await dialog.getByLabel("Phone number").fill("+2348011110003");
  // Same matric number as the first member, in a different case — the stored
  // comparison form is folded, so this is the same value.
  await dialog.getByLabel(/Matric number/).fill("20/53a/021");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();

  await expect(page.getByText("This member already exists")).toBeVisible();
  await expect(page.getByText(/Matric number "20\/53A\/021" already belongs/)).toBeVisible();
  // No "add anyway" is offered for an exact duplicate.
  await expect(page.getByRole("button", { name: /add anyway/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Go back" }).click();
  await page.getByRole("button", { name: "Close" }).click();

  // ── Archive is reversible (§42) ───────────────────────────────────────────
  await page
    .getByRole("row", { name: /Chidi Eze Jr/ })
    .getByRole("button", { name: "Archive" })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive member" }).click();
  await expect(page.getByText("KWASU/0002")).toHaveCount(0);

  await page.getByRole("button", { name: "Show archived" }).click();
  await expect(page.getByText("KWASU/0002")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();

  await page.getByRole("button", { name: "Showing archived" }).click();
  await expect(page.getByText("KWASU/0002")).toBeVisible();
});
