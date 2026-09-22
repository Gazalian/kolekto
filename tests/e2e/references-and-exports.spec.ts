import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * M7.6 in a real browser: references, exports and picking a draft back up.
 *
 * Three journeys, each one the whole way through rather than a screenshot of
 * a screen:
 *
 *   1. a tiered collection whose options carry their own prefixes, so REG-0001
 *      and VIP-0001 both exist — and then both files, downloaded and opened
 *   2. a draft abandoned mid-wizard and continued in a fresh browser context,
 *      which is the only honest way to test "close the browser and come back"
 *   3. the reference format refusing to change once codes are out
 *
 * The downloads are read, not merely triggered. A CSV whose bytes nobody
 * looked at is a button that fired an event; what matters is whether the
 * reference is actually in the file, and whether the PDF is a PDF.
 */

test.describe.configure({ timeout: 240_000 });

async function createCommunity(page: Page, name: string): Promise<string> {
  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(name);
  await page.getByLabel("Type").selectOption("fellowship");
  await page.getByRole("button", { name: "Create community" }).click();

  await expect(page).toHaveURL(/\/c\//);
  await page.waitForLoadState("networkidle");

  const slug = new URL(page.url()).pathname.split("/")[2];
  if (!slug) throw new Error(`Could not read a community slug from ${page.url()}`);
  return slug;
}

async function addMember(page: Page, slug: string, name: string, phone: string): Promise<void> {
  await page.goto(`/c/${slug}/members`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill(name);
  await dialog.getByLabel("Phone number").fill(phone);
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function startCollection(page: Page, slug: string, intent: RegExp, name: string): Promise<void> {
  await page.goto(`/c/${slug}/collections/new`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: intent }).click();
  await page.getByLabel("What is this collection called?").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("options with their own prefixes give REG-0001 and VIP-0001, and both land in the files", async ({ page }) => {
  await signInAsNewUser(page, "e2e-refs");
  const slug = await createCommunity(page, `E2E Refs ${Date.now()}`);

  await addMember(page, slug, "Ada Regular", "+2348097771001");
  await addMember(page, slug, "Bola Vip", "+2348097771002");

  await startCollection(page, slug, /Options at different prices/, "Department Dinner 2026");

  // Two options, each with its own reference series (part K).
  await page.getByLabel("Option name").first().fill("Regular");
  await page.getByLabel("Price").first().fill("10000");
  await page.getByLabel("Reference prefix").first().fill("REG");

  await page.getByRole("button", { name: "Add another option" }).click();
  await page.getByLabel("Option name").nth(1).fill("VIP");
  await page.getByLabel("Price").nth(1).fill("25000");
  await page.getByLabel("Reference prefix").nth(1).fill("VIP");

  await page.getByRole("button", { name: "Continue" }).click(); // options
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover

  // A roll is what a reference attaches to, so the collection has to be for
  // named members rather than for anyone with the link.
  await page.getByRole("radio", { name: /Everyone on the roll/ }).check();
  await page.getByRole("button", { name: "Continue" }).click(); // who
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/department-dinner-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  // ── Switch references on ────────────────────────────────────────────────
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel(/Give everyone on this collection a reference/).check();
  await page.getByLabel("Prefix", { exact: true }).fill("DIN26");

  // The live example is the point of this screen (part I).
  await expect(page.getByText("DIN26-0001", { exact: true })).toBeVisible();
  // And each prefixed option shows where its own series starts.
  await expect(page.getByText("REG-0001", { exact: true })).toBeVisible();
  await expect(page.getByText("VIP-0001", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

  // ── Put one person on each option ───────────────────────────────────────
  await page.getByRole("button", { name: "Members" }).click();

  for (const [name, option] of [
    ["Ada Regular", "Regular"],
    ["Bola Vip", "VIP"],
  ] as const) {
    await page.getByRole("button", { name: "Add members" }).click();
    const assign = page.getByRole("dialog");
    // The option's own <option> carries its price and prefix in the label, so
    // it is selected by the value the row actually holds rather than by a
    // label this test would have to reproduce exactly.
    const select = assign.getByLabel("Which option?");
    const value = await select
      .locator("option")
      .filter({ hasText: new RegExp(`^${option} `) })
      .first()
      .getAttribute("value");
    await select.selectOption(value!);
    await assign.getByLabel("Search members").fill(name);
    await assign.getByRole("checkbox").first().check();
    await assign.getByRole("button", { name: /Add 1 member/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  }

  // The references are on the roll, each from its own option's series.
  await expect(page.getByRole("cell", { name: "REG-0001" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("cell", { name: "VIP-0001" })).toBeVisible();
  // The tier supplies the amount, so the VIP row is the VIP price.
  await expect(page.getByRole("cell", { name: "₦25,000" })).toBeVisible();

  // ── Both files, read rather than merely requested ───────────────────────
  await page.getByRole("button", { name: "Exports" }).click();
  // By role: "Option" is both a column to tick and a filter to choose from,
  // in different cards, and a bare label matches both.
  await page.getByRole("checkbox", { name: "Reference" }).check();
  await page.getByRole("checkbox", { name: "Option" }).check();

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const csvText = (await (await csv.createReadStream()).toArray()).map((chunk) => chunk.toString("utf8")).join("");
  expect(csvText).toContain("Reference");
  expect(csvText).toContain("REG-0001");
  expect(csvText).toContain("VIP-0001");
  // The ₦ survives, which is what the byte-order mark is for.
  expect(csvText).toContain("₦25,000");

  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF" }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const pdfBytes = Buffer.concat(await (await pdf.createReadStream()).toArray());
  expect(pdfBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(pdfBytes.byteLength).toBeGreaterThan(1000);
});

test("a reference format is fixed once references are out", async ({ page }) => {
  await signInAsNewUser(page, "e2e-refs-lock");
  const slug = await createCommunity(page, `E2E Lock ${Date.now()}`);
  await addMember(page, slug, "Chidi Locked", "+2348097772001");

  await startCollection(page, slug, /Dues or a levy/, "Locked Levy 2026");
  await page.getByLabel("Amount each person pays").fill("5000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Open this draft" }).click();
  await expect(page).toHaveURL(/\/collections\/locked-levy-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel(/Give everyone on this collection a reference/).check();
  await page.getByLabel("Prefix", { exact: true }).fill("LOCK");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible({ timeout: 30_000 });

  // Issue one by putting somebody on the roll.
  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  const assign = page.getByRole("dialog");
  await assign.getByRole("checkbox").first().check();
  await assign.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByRole("cell", { name: "LOCK-0001" })).toBeVisible({ timeout: 30_000 });

  // Now the format is history: those codes may be printed on something.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText(/reference has been issued, so the format is fixed/)).toBeVisible();
  await expect(page.getByLabel("Prefix", { exact: true })).toBeDisabled();
});

test("a draft survives closing the browser, and continues where it stopped", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-resume");
  const slug = await createCommunity(page, `E2E Resume ${Date.now()}`);

  // Get several steps in, including the parts that are rows of their own.
  await startCollection(page, slug, /Items or packages/, "Aso Ebi Order 2026");
  await page.getByLabel("Item").first().fill("Lace wrapper");
  await page.getByLabel("Price").first().fill("15000");
  await page.getByRole("button", { name: "Add another item" }).click();
  await page.getByLabel("Item").nth(1).fill("Gele");
  await page.getByLabel("Price").nth(1).fill("6000");
  await page.getByRole("button", { name: "Continue" }).click(); // items

  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover
  await page.getByRole("button", { name: "Continue" }).click(); // who can order

  // And then the organiser walks away. A new context is a new browser: no
  // page state, no memory, only what the server kept.
  const second = await browser.newContext({ storageState: await page.context().storageState() });
  const resumed = await second.newPage();

  await resumed.goto(`/c/${slug}/collections`);
  await resumed.waitForLoadState("networkidle");
  await resumed.getByRole("link", { name: /Continue setting this up/ }).first().click();
  await resumed.waitForLoadState("networkidle");

  // It came back at the step it was left on, not at the beginning.
  await expect(resumed.getByText(/Step 6 of 7 · Questions/)).toBeVisible({ timeout: 45_000 });

  // And the work is all still there. Walk back to the Items step and look.
  await resumed.getByRole("button", { name: "Back" }).click();
  await resumed.getByRole("button", { name: "Back" }).click();
  await resumed.getByRole("button", { name: "Back" }).click();

  await expect(resumed.getByLabel("Item").first()).toHaveValue("Lace wrapper");
  await expect(resumed.getByLabel("Item").nth(1)).toHaveValue("Gele");
  await expect(resumed.getByLabel("Price").first()).toHaveValue("15000");

  await resumed.getByRole("button", { name: "Back" }).click();
  await expect(resumed.getByLabel("What is this collection called?")).toHaveValue("Aso Ebi Order 2026");

  await second.close();
});
