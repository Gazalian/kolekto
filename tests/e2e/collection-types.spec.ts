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

  // §5/§19: a fundraiser asks for a story, not a bare description.
  await page.getByLabel("What is this for?").fill("Emergency surgery for a member's father.");
  await page.getByLabel("Why does this matter?").fill("He is the sole provider for six children.");
  await page.getByLabel("What will donations fund?").fill("₦500,000 covers the full theatre bill.");

  await page.getByLabel("Smallest contribution").fill("1000");
  await page.getByLabel("Largest contribution").fill("500000");

  // By role: "Suggestion 1" as a label also matches the "Remove suggestion 1"
  // button beside the field.
  await page.getByRole("button", { name: "Add a suggested amount" }).click();
  await page.getByRole("textbox", { name: "Suggestion 1" }).fill("5000");
  await page.getByRole("button", { name: "Add a suggested amount" }).click();
  await page.getByRole("textbox", { name: "Suggestion 2" }).fill("20000");

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays — public
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/medical-fund-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("₦5,000 · ₦20,000")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/medical-fund-2026`);
  await contributor.waitForLoadState("networkidle");

  // The story reads before the amount block (§25: fundraising is story-first).
  await expect(contributor.getByText("Emergency surgery for a member's father.")).toBeVisible();
  await expect(contributor.getByText("₦500,000 covers the full theatre bill.")).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/aso-ebi-order-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("40 available")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/aso-ebi-order-2026`);
  await contributor.waitForLoadState("networkidle");

  // An order is a basket: one line here, several in the next assertion.
  await contributor.getByRole("checkbox").nth(1).check(); // Gold, ₦50,000
  await contributor.getByLabel("How many Gold?").fill("3");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText("3 × Gold")).toBeVisible();
  await expect(contributor.getByText("₦150,000").first()).toBeVisible();

  // §6: several different items in one order, totalled by the server from its
  // own prices — 2 × ₦35,000 + 3 × ₦50,000.
  await contributor.getByRole("button", { name: "Back to the form" }).click();
  await contributor.getByRole("checkbox").first().check(); // Blue, ₦35,000, at most 2
  await contributor.getByLabel("How many Blue?").fill("2");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText("2 × Blue")).toBeVisible();
  await expect(contributor.getByText("3 × Gold")).toBeVisible();
  await expect(contributor.getByText("₦220,000").first()).toBeVisible();

  // The per-order limit is the database's, and it is enforced whatever the
  // browser shows.
  await contributor.getByRole("button", { name: "Back to the form" }).click();
  await contributor.getByLabel("How many Blue?").fill("5");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText(/at most 2 of "Blue" in one order/i)).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

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
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays — all members
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

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

test("a flyer can be uploaded during creation, shown on the public page, and removed", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Flyer ${Date.now()}`);

  // §1/§33: the flyer belongs in the creation flow, not discoverable only
  // after the fact in settings — so this uploads it at the Cover image step,
  // the moment the draft first exists, rather than afterwards.
  await startCollection(page, /An open contribution/, "Harvest Offering 2026");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution

  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
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

  await page.getByRole("button", { name: "Continue" }).click(); // cover image
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await expect(page.getByText("Flyer", { exact: true })).toBeVisible();
  await expect(page.getByText("Added", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/harvest-offering-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.locator("img[src*='collection-covers']")).toBeVisible();

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
  await page.getByRole("button", { name: "Continue" }).click(); // contribution

  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByLabel("Collection flyer").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("this is not an image"),
  });

  await expect(page.getByText("Upload a JPG, PNG or WebP image.")).toBeVisible();
  await expect(page.getByText("No flyer yet")).toBeVisible();

  // A rejected file does not block the rest of the wizard — the page did not
  // break, which is the defect this feature was built to rule out.
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — none, and that is fine
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/building-fund-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.locator("img[src*='collection-covers']")).toHaveCount(0);
});

test("an item's own image uploads, shows on the public page, and can be replaced", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Item Image ${Date.now()}`);

  // §4/§16: an item's image is added where the item itself is edited — the
  // draft has to exist first (the upload is scoped to a real collection id),
  // so this reaches it through Settings, exactly where `ItemsEditor` renders
  // once a collection has been created, rather than during the wizard.
  await startCollection(page, /Items or packages/, "Snack Pack 2026");
  await page.getByLabel("Item").first().fill("Jollof Rice");
  await page.getByLabel("Price").first().fill("3000");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/snack-pack-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Photo").setInputFiles({ name: "jollof.png", mimeType: "image/png", buffer: TINY_PNG });
  await expect(page.getByRole("button", { name: "Replace image" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Save items" }).click();
  await expect(page.getByText("Items saved.")).toBeVisible();

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/snack-pack-2026`);
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.locator("img[src*='collection-covers/']").first()).toBeVisible();

  await anonymous.close();
});

test("a ticket buyer can take more than one type, and name an attendee per ticket", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Ticket Basket ${Date.now()}`);

  // §17/§18: several ticket types in one order, each with its own quantity,
  // plus one attendee name per ticket — the "VIP × 2, Regular × 1" case.
  await startCollection(page, /Tickets for an event/, "Founders Gala 2026");
  await page.getByLabel("Option name").first().fill("Regular");
  await page.getByLabel("Price").first().fill("10000");
  await page.getByRole("button", { name: "Add another option" }).click();
  await page.getByLabel("Option name").nth(1).fill("VIP");
  await page.getByLabel("Price").nth(1).fill("25000");
  await page.getByLabel("Limit").nth(1).fill("5"); // VIP quantity_limit — plenty for this order

  await page.getByLabel("When does it start?").fill("2026-12-20T18:00");
  await page.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");
  await page.getByRole("checkbox", { name: "Collect attendee details" }).check();

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/founders-gala-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/founders-gala-2026`);
  await contributor.waitForLoadState("networkidle");

  await expect(contributor.getByRole("heading", { name: "Which tickets?" })).toBeVisible();

  // VIP × 2
  await contributor.getByRole("checkbox").nth(1).check();
  await contributor.getByLabel("How many VIP?").fill("2");
  // Regular × 1
  await contributor.getByRole("checkbox").nth(0).check();

  // The server asks for exactly three names — two VIP tickets and one Regular.
  await expect(contributor.getByLabel("Ticket 3 — name")).toBeVisible();
  await contributor.getByLabel("Ticket 1 — name").fill("Ada Obi");
  await contributor.getByLabel("Ticket 2 — name").fill("Bola Ade");
  await contributor.getByLabel("Ticket 3 — name").fill("Chidi Eze");

  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText("2 × VIP")).toBeVisible();
  await expect(contributor.getByText("1 × Regular")).toBeVisible();
  // 2 × ₦25,000 + 1 × ₦10,000
  await expect(contributor.getByText("₦60,000").first()).toBeVisible();
  await expect(contributor.getByText("Ada Obi, Bola Ade, Chidi Eze")).toBeVisible();

  await anonymous.close();
});

test("ticket types can be reordered, and the public page follows that order", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Reorder ${Date.now()}`);

  await startCollection(page, /Options at different prices/, "Sponsor Packages 2026");
  await page.getByLabel("Option name").first().fill("Bronze");
  await page.getByLabel("Price").first().fill("5000");
  await page.getByRole("button", { name: "Add another option" }).click();
  await page.getByLabel("Option name").nth(1).fill("Gold");
  await page.getByLabel("Price").nth(1).fill("25000");

  // Gold moves above Bronze. The ids travel with the rows, so this is a
  // reorder and not a rename — the price that was typed against Gold stays
  // against Gold.
  await page.getByRole("button", { name: "Move Gold up" }).click();
  await expect(page.getByLabel("Option name").first()).toHaveValue("Gold");
  await expect(page.getByLabel("Price").first()).toHaveValue("25000");

  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/sponsor-packages-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/sponsor-packages-2026`);
  await contributor.waitForLoadState("networkidle");

  // The order the organiser chose is the order the contributor reads.
  const options = contributor.locator("fieldset").filter({ hasText: "What are you paying for?" });
  await expect(options.getByText("Gold")).toBeVisible();
  const firstRadio = contributor.getByRole("radio").first();
  await firstRadio.check();
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();

  // Gold is first, so the first option resolves to Gold's price.
  await expect(contributor.getByText("₦25,000").first()).toBeVisible();

  await anonymous.close();
});

test("an oversized item image is refused before it reaches storage", async ({ page }) => {
  await signInAsNewUser(page, "e2e-types");
  await createCommunity(page, `E2E Big Image ${Date.now()}`);

  await startCollection(page, /Items or packages/, "Bake Sale 2026");
  await page.getByLabel("Item").first().fill("Cake");
  await page.getByLabel("Price").first().fill("4000");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/bake-sale-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Settings" }).click();

  // 6 MB of PNG-shaped bytes: over the 5 MB ceiling, refused in the browser
  // before any of it is posted, and the page keeps working.
  await page.getByLabel("Photo").setInputFiles({
    name: "huge.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(6 * 1024 * 1024, 1),
  });
  await expect(page.getByText("That image is larger than 5 MB.")).toBeVisible();

  // And a file that is not an image at all.
  await page.getByLabel("Photo").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByText("Upload a JPG, PNG or WebP image.")).toBeVisible();

  // Neither attempt left the editor broken: the item can still be saved.
  await page.getByRole("button", { name: "Save items" }).click();
  await expect(page.getByText("Items saved.")).toBeVisible();
});

test("the public page works at phone width", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Mobile ${Date.now()}`);

  await startCollection(page, /An open contribution/, "Mobile Offering 2026");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/mobile-offering-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  // A phone-sized viewport, which is what most contributors actually open.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const contributor = await phone.newPage();
  await contributor.goto(`/${communitySlug}/mobile-offering-2026`);
  await contributor.waitForLoadState("networkidle");

  await expect(contributor.getByRole("heading", { name: "Mobile Offering 2026" })).toBeVisible();
  await expect(contributor.getByLabel("How much would you like to contribute?")).toBeVisible();

  // Nothing overflows the viewport sideways — a horizontal scrollbar on a
  // contribution page is the difference between paying and giving up.
  const overflow = await contributor.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await contributor.getByLabel("How much would you like to contribute?").fill("2500");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText("₦2,500").first()).toBeVisible();

  await phone.close();
});

test("a half-finished collection survives leaving the browser, and resumes where it was", async ({ page }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Draft ${Date.now()}`);

  // M7.5 part A: each Continue saves that step. Nothing here clicks a save
  // button, because there is no longer one to click.
  await startCollection(page, /Items or packages/, "Resumed Catalog 2026");
  await page.getByLabel("Item").first().fill("Jollof");
  await page.getByLabel("Price").first().fill("3000");
  await page.getByRole("button", { name: "Add another item" }).click();
  await page.getByLabel("Item").nth(1).fill("Chicken");
  await page.getByLabel("Price").nth(1).fill("2000");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution — saves the items

  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Your progress is saved automatically.")).toBeVisible();

  // Leave. Not "go back" — leave, the way a person with a phone call does.
  await page.goto(`/c/${communitySlug}/collections`);
  await page.waitForLoadState("networkidle");

  // The draft is on the list, and opening it shows the work.
  await expect(page.getByText("Resumed Catalog 2026")).toBeVisible();
  await page.getByRole("link", { name: /Resumed Catalog 2026/ }).click();
  await page.waitForLoadState("networkidle");
  await expect(page).toHaveURL(/\/collections\/resumed-catalog-2026/);
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();

  // Both items survived, with their prices.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Item").first()).toHaveValue("Jollof");
  await expect(page.getByLabel("Item").nth(1)).toHaveValue("Chicken");
  await expect(page.getByLabel("Price").first()).toHaveValue("3000");

  // Editing an item twice must not leave two of it: ids are stable across saves.
  await page.getByLabel("Item").first().fill("Jollof Rice");
  await page.getByRole("button", { name: "Save items" }).click();
  await expect(page.getByText("Items saved.")).toBeVisible();
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Item")).toHaveCount(2);
  await expect(page.getByLabel("Item").first()).toHaveValue("Jollof Rice");
});

test("an event's door: find a guest, check them in, check them out", async ({ page }) => {
  await signInAsNewUser(page, "e2e-door");
  const communitySlug = await createCommunity(page, `E2E Door ${Date.now()}`);

  // A guest list is what a door can check (M7.5 part E): no purchase is
  // recorded anywhere in this phase, so the people who can be admitted are
  // the members an officer put on the collection.
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Ada Guest");
  await dialog.getByLabel("Phone number").fill("+2348097770001");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText("Ada Guest")).toBeVisible();

  await startCollection(page, /Dues or a levy/, "Annual Gala 2026");
  await page.getByLabel("Amount each person pays").fill("10000");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/annual-gala-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  // Put the guest on the list.
  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  const assign = page.getByRole("dialog");
  await assign.getByRole("checkbox").first().check();
  await assign.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByRole("cell", { name: "₦10,000" })).toBeVisible();

  // This is a dues collection, not an event, so it has no door — the tab
  // belongs to ticketed events only.
  await expect(page.getByRole("button", { name: "Check-in" })).toHaveCount(0);

  // Export is where the roll leaves the system, and it is here for every type.
  await page.getByRole("button", { name: "Export" }).click();
  await expect(page.getByRole("heading", { name: "Export" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeEnabled();

  await expect(page.getByLabel("Full name")).toBeChecked();
  await expect(page.getByLabel("Expected amount")).toBeChecked();
});

test("a ticketed event has a door, and it opens and closes", async ({ page }) => {
  await signInAsNewUser(page, "e2e-door");
  await createCommunity(page, `E2E Gala ${Date.now()}`);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("Bola Attendee");
  await dialog.getByLabel("Phone number").fill("+2348097770002");
  await dialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText("Bola Attendee")).toBeVisible();

  await startCollection(page, /Tickets for an event/, "Founders Night 2026");
  await page.getByLabel("Option name").first().fill("Regular");
  await page.getByLabel("Price").first().fill("10000");
  await page.getByLabel("When does it start?").fill("2026-12-20T18:00");
  await page.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");
  await page.getByRole("button", { name: "Continue" }).click(); // contribution
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image

  // A door needs a list, and a list needs a managed audience.
  await page.getByRole("radio", { name: /Everyone on the roll/ }).check();
  await page.getByRole("button", { name: "Continue" }).click(); // who pays
  await page.getByRole("button", { name: "Continue" }).click(); // no questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/founders-night-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  const assign = page.getByRole("dialog");
  await assign.getByRole("checkbox").first().check();
  await assign.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByRole("cell", { name: "₦10,000" })).toBeVisible();

  // The door.
  await page.getByRole("button", { name: "Check-in" }).click();
  await expect(page.getByText("Not arrived")).toBeVisible();

  await page.getByLabel("Find someone").fill("Bola");
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText("Inside")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByText("Left")).toBeVisible({ timeout: 30_000 });
});
