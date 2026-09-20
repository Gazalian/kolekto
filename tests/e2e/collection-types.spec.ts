import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * One journey per kind of collection (§26–§33), in a real browser against the
 * real local stack.
 *
 * collections.spec.ts covers the fixed and tiered paths. These cover what M6
 * added — a fundraiser's suggested amounts, an item order priced by quantity, a
 * ticketed event's date and venue, a recurring charge's periods, and the flyer.
 *
 * Each one ends where the money boundary is (ADR 0012): the contributor's
 * details are checked and the amount is resolved by the server, and the screen
 * says plainly that nothing has been charged.
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

async function startCollection(page: Page, intent: RegExp, name: string): Promise<void> {
  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: intent }).click();
  await page.getByLabel("What is this collection called?").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function publish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
}

/** A one-pixel PNG, built here so the test carries no binary fixture. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a fundraiser suggests amounts, and a contributor can still choose their own", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Fundraiser ${Date.now()}`);

  await startCollection(page, /Fundraiser/, "Medical Fund 2026");

  await page.getByLabel("Smallest contribution").fill("1000");
  await page.getByLabel("Largest contribution").fill("500000");

  // By role: "Suggestion 1" as a label also matches the "Remove suggestion 1"
  // button beside the field.
  await page.getByRole("button", { name: "Add a suggested amount" }).click();
  await page.getByRole("textbox", { name: "Suggestion 1" }).fill("5000");
  await page.getByRole("button", { name: "Add a suggested amount" }).click();
  await page.getByRole("textbox", { name: "Suggestion 2" }).fill("20000");

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await page.getByRole("button", { name: "Continue" }).click(); // who pays — public
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/medical-fund-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("₦5,000 · ₦20,000")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/medical-fund-2026`);
  await contributor.waitForLoadState("networkidle");

  // A suggestion fills the field; it does not decide the amount. The server
  // resolves what is actually owed from what the form sends.
  await contributor.getByRole("button", { name: "₦20,000" }).click();
  await expect(contributor.getByLabel("How much would you like to contribute?")).toHaveValue("20000");

  // Typing over it is the point of an open collection.
  await contributor.getByLabel("How much would you like to contribute?").fill("7500");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText(/Your details are checked, Ada Obi/)).toBeVisible();
  await expect(contributor.getByText("₦7,500").first()).toBeVisible();
  await expect(contributor.getByText(/Nothing has been charged/)).toBeVisible();

  // Below the minimum is refused by the server, not by the browser.
  await contributor.getByRole("button", { name: "Back to the form" }).click();
  await contributor.getByLabel("How much would you like to contribute?").fill("100");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText(/below the smallest contribution/i)).toBeVisible();

  await anonymous.close();
});

test("an item collection prices an order by the item chosen and how many", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Items ${Date.now()}`);

  await startCollection(page, /Items or packages/, "Aso-Ebi Order 2026");

  // Two items, deliberately priced far apart, and the cheaper one capped — a
  // quantity multiplies a price, so it is part of the money path.
  await page.getByLabel("Item").first().fill("Blue");
  await page.getByLabel("Price").first().fill("35000");
  await page.getByLabel("How many are available").first().fill("40");
  await page.getByLabel("Most one person may take").first().fill("2");

  await page.getByRole("button", { name: "Add another item" }).click();
  await page.getByLabel("Item").nth(1).fill("Gold");
  await page.getByLabel("Price").nth(1).fill("50000");

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/aso-ebi-order-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("40 available")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/aso-ebi-order-2026`);
  await contributor.waitForLoadState("networkidle");

  await contributor.getByRole("radio").nth(1).check(); // Gold, ₦50,000
  await contributor.getByLabel("How many?").fill("3");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText("3 × Gold")).toBeVisible();
  await expect(contributor.getByText("₦150,000").first()).toBeVisible();

  // The per-order limit is the database's, and it is enforced whatever the
  // browser shows.
  await contributor.getByRole("button", { name: "Back to the form" }).click();
  await contributor.getByRole("radio").first().check(); // Blue, at most 2
  await contributor.getByLabel("How many?").fill("5");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText(/at most 2 of that in one order/i)).toBeVisible();

  await anonymous.close();
});

test("a ticketed event carries its date and venue, and the venue can still change after publishing", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Event ${Date.now()}`);

  await startCollection(page, /Tickets for an event/, "Annual Dinner 2026");

  await page.getByLabel("Option name").first().fill("Regular");
  await page.getByLabel("Price").first().fill("5000");
  await page.getByRole("button", { name: "Add another option" }).click();
  await page.getByLabel("Option name").nth(1).fill("VIP");
  await page.getByLabel("Price").nth(1).fill("15000");

  await page.getByLabel("When does it start?").fill("2026-12-20T18:00");
  await page.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/annual-dinner-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Ostrich Hall, Ilorin")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/annual-dinner-2026`);
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.getByText("Ostrich Hall, Ilorin")).toBeVisible();

  // A moved venue has to be publishable after the tickets are out. A changed
  // ticket price does not — that is what stays locked.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Where is it?").fill("Moved to the Banquet Hall");
  await page.getByRole("button", { name: "Save event details" }).click();
  await expect(page.getByText("Event details saved.")).toBeVisible();

  await contributor.reload();
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.getByText("Moved to the Banquet Hall")).toBeVisible();

  await anonymous.close();
});

test("a recurring charge owes per period, and no period opens by itself", async ({ page }) => {
  await signInAsNewUser(page, "e2e-types");
  await createCommunity(page, `E2E Recurring ${Date.now()}`);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const memberDialog = page.getByRole("dialog");
  await memberDialog.getByLabel("Full name").fill("Chidi Eze");
  await memberDialog.getByLabel("Phone number").fill("+2348011113333");
  await memberDialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText("Chidi Eze")).toBeVisible();

  await startCollection(page, /A charge that repeats/, "Estate Service Charge");

  await page.getByLabel("Amount each person pays").fill("25000");
  await page.getByLabel("How often").selectOption("monthly");
  await page.getByLabel("First period starts").fill("2026-10-01");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await page.getByRole("button", { name: "Continue" }).click(); // who pays — all members
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/estate-service-charge/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await publish(page);

  // Nothing is owed yet: publishing a recurring charge opens no period, and an
  // open period is what an obligation belongs to (§38).
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText(/no period is open/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add members" })).toBeDisabled();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open the next period" }).click();
  await expect(page.getByText("Opened 2026-10.")).toBeVisible();

  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("You are working on")).toBeVisible();
  await page.getByRole("button", { name: /Add 1 obligation for 2026-10/ }).click();

  await expect(page.getByRole("cell", { name: "₦25,000" })).toBeVisible();
  await expect(page.getByText("1 expected")).toBeVisible();

  // The second period is a separate debt, not a repeat of the first.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open the next period" }).click();
  await expect(page.getByText("Opened 2026-11.")).toBeVisible();

  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: /Add 1 obligation for 2026-11/ }).click();
  await expect(page.getByText("2 expected")).toBeVisible();
});

test("a flyer can be uploaded, shown on the public page, and removed", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Flyer ${Date.now()}`);

  await startCollection(page, /An open contribution/, "Harvest Offering 2026");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/harvest-offering-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("No flyer yet")).toBeVisible();

  // The browser holds no storage credential: this posts bytes to a server
  // action, which is what talks to the bucket.
  await page.getByLabel("Collection flyer").setInputFiles({
    name: "flyer.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });

  const flyer = page.getByRole("img", { name: "Collection flyer" });
  await expect(flyer).toBeVisible({ timeout: 45_000 });
  await expect(flyer).toHaveAttribute("src", /\/storage\/v1\/object\/public\/collection-covers\//, {
    timeout: 45_000,
  });

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/harvest-offering-2026`);
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.locator("img[src*='collection-covers']")).toBeVisible();

  // Removing clears the row first, so the page never points at an object that
  // is already gone.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No flyer yet")).toBeVisible({ timeout: 45_000 });

  await contributor.reload();
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.locator("img[src*='collection-covers']")).toHaveCount(0);

  await anonymous.close();
});

test("a file that is not an image is refused before it reaches storage", async ({ page }) => {
  await signInAsNewUser(page, "e2e-types");
  await createCommunity(page, `E2E Flyer Type ${Date.now()}`);

  await startCollection(page, /An open contribution/, "Building Fund 2026");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save as draft" }).click();

  await expect(page).toHaveURL(/\/collections\/building-fund-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Collection flyer").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is not an image"),
  });

  await expect(page.getByText("Upload a JPG, PNG or WebP image.")).toBeVisible();
  await expect(page.getByText("No flyer yet")).toBeVisible();
});
