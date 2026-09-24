import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";
import { chooseFeeBearer, configureReferences, fillTier, openWizard, walkWizard } from "./helpers/wizard.ts";

/**
 * One journey per kind of collection (§26–§33), in a real browser against the
 * real local stack.
 *
 * collections.spec.ts covers the fixed and packaged paths. These cover a
 * fundraiser's suggested amounts, an item order priced by quantity, a ticketed
 * event's date and venue, a recurring charge's periods, and the flyer.
 *
 * M7.7 gave each type its own flow — different steps, different order,
 * different words — so every walk below is driven by that flow's own
 * definition rather than by counting Continue clicks, and `walkWizard` checks
 * each heading as it arrives. A flow that quietly collapsed back into one
 * shared sequence fails here.
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

/**
 * Three visibly different one-pixel PNGs.
 *
 * Distinct bytes, so "the right image is on the right item" is a question the
 * test can actually answer — three copies of one file would pass even if the
 * uploads were crossed.
 */
const PNGS: Record<"red" | "green" | "blue", Buffer> = {
  red: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==",
    "base64",
  ),
  green: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWm5XgwAAAABJRU5ErkJggg==",
    "base64",
  ),
  blue: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
};

test("a fundraiser suggests amounts, and a contributor can still choose their own", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Fundraiser ${Date.now()}`);

  await openWizard(page);

  // §15: a campaign's first screen is its story, not a name-and-amount form —
  // and its second is a goal, never a fixed price.
  await walkWizard(page, {
    flowKey: "fundraiser",
    intent: /^Fundraising/,
    fill: {
      story: async (p) => {
        await p.getByLabel("What are you raising money for?").fill("Medical Fund 2026");
        await p.getByLabel("What is this for?").fill("Emergency surgery for a member's father.");
        await p.getByLabel("Why does this matter?").fill("He is the sole provider for six children.");
        await p.getByLabel("What will donations fund?").fill("₦500,000 covers the full theatre bill.");
      },
      goal: async (p) => {
        await p.getByLabel("Fundraising goal").fill("500000");
        await p.getByLabel("Smallest donation").fill("1000");

        // By role: "Suggestion 1" as a label also matches the "Remove
        // suggestion 1" button beside the field.
        await p.getByRole("button", { name: "Add a suggested amount" }).click();
        await p.getByRole("textbox", { name: "Suggestion 1" }).fill("5000");
        await p.getByRole("button", { name: "Add a suggested amount" }).click();
        await p.getByRole("textbox", { name: "Suggestion 2" }).fill("20000");
      },
      fees: async (p) => {
        // §6: an open campaign has no single price, so the preview is priced
        // at the suggestions the organiser just set — their own figures, not
        // an invented one.
        await expect(p.getByText("If somebody gives ₦5000")).toBeVisible();
        await expect(p.getByText("If somebody gives ₦20000")).toBeVisible();
      },
      review: async (p) => {
        // §23: a campaign is reviewed by reading its story back.
        await expect(p.getByText("Emergency surgery for a member's father.")).toBeVisible();
        await expect(p.getByText("Working toward")).toBeVisible();
      },
    },
  });

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

  await openWizard(page);

  // §16: a catalogue is built item by item, then asked how people may order —
  // two separate questions, which is how an organiser thinks about it.
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Aso-Ebi Order 2026");
      },
      // Two items, deliberately priced far apart, and the cheaper one capped —
      // a quantity multiplies a price, so it is part of the money path.
      items: async (p) => {
        await p.getByLabel("Item").first().fill("Blue");
        await p.getByLabel("Price").first().fill("35000");
        await p.getByLabel("How many are available").first().fill("40");
        await p.getByLabel("Most one person may take").first().fill("2");

        await p.getByRole("button", { name: "Add another item" }).click();
        await p.getByLabel("Item").nth(1).fill("Gold");
        await p.getByLabel("Price").nth(1).fill("50000");
      },
      fees: async (p) => {
        // One example per item, from what the organiser typed — and no
        // computed figure until the estimate is asked for (Part 3).
        await expect(p.getByText("₦35,000 − applicable fees")).toBeVisible();
        await expect(p.getByText("₦50,000 − applicable fees")).toBeVisible();
        await expect(p.getByText("Estimated total fees")).toHaveCount(0);
      },
      review: async (p) => {
        // §23: a catalogue is reviewed by looking at the catalogue.
        await expect(p.getByText("40 available")).toBeVisible();
      },
    },
  });

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

  await openWizard(page);

  // §18: a ticketed event opens on the event — name, date, venue and flyer
  // together — and is never asked for a "contribution amount".
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    fill: {
      event: async (p) => {
        await p.getByLabel("What is the event called?").fill("Annual Dinner 2026");
        await p.getByLabel("When does it start?").fill("2026-12-20T18:00");
        await p.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");
      },
      tickets: async (p) => {
        await fillTier(0, { name: "Regular", price: "5000" }, "Ticket type")(p);
        await fillTier(1, { name: "VIP", price: "15000" }, "Ticket type")(p);
      },
      review: async (p) => {
        // §23: an event is reviewed by looking at the event.
        await expect(p.getByText("2026-12-20 at 18:00 · Ostrich Hall, Ilorin")).toBeVisible();
      },
    },
  });

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

  await openWizard(page);

  // §20/§21: a plan is asked how often it charges, and never when it closes.
  await walkWizard(page, {
    flowKey: "recurring",
    intent: /^Recurring/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this plan called?").fill("Estate Service Charge");
      },
      amount: async (p) => {
        await p.getByLabel("Amount per period").fill("25000");
      },
      schedule: async (p) => {
        await p.getByLabel("How often").selectOption("monthly");
        await p.getByLabel("First period starts").fill("2026-10-01");
      },
      review: async (p) => {
        await expect(p.getByText("No closing date — a plan that repeats does not close")).toBeVisible();
        await expect(p.getByText(/you open each period yourself/i)).toBeVisible();
      },
    },
  });

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

  await openWizard(page);

  // §1/§33: the image belongs in the creation flow, not discoverable only
  // after the fact in Settings — so this uploads it at the flow's own image
  // step, while the draft is being made, rather than afterwards.
  await walkWizard(page, {
    flowKey: "open",
    intent: /^Open contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Harvest Offering 2026");
      },
      cover: async (p) => {
        await expect(p.getByText("No flyer yet")).toBeVisible();

        // The browser holds no storage credential: this posts bytes to a
        // server action, which is what talks to the bucket.
        await p.getByLabel("Collection flyer").setInputFiles({
          name: "flyer.png",
          mimeType: "image/png",
          buffer: TINY_PNG,
        });

        const flyer = p.getByRole("img", { name: "Collection flyer" });
        await expect(flyer).toBeVisible({ timeout: 45_000 });
        await expect(flyer).toHaveAttribute("src", /\/storage\/v1\/object\/public\/collection-covers\//, {
          timeout: 45_000,
        });
      },
      review: async (p) => {
        await expect(p.locator("img[src*='collection-covers']")).toBeVisible();
      },
    },
  });

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

  await openWizard(page);

  await walkWizard(page, {
    flowKey: "open",
    intent: /^Open contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Building Fund 2026");
      },
      cover: async (p) => {
        await p.getByLabel("Collection flyer").setInputFiles({
          name: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("this is not an image"),
        });

        await expect(p.getByText("Upload a JPG, PNG or WebP image.")).toBeVisible();
        await expect(p.getByText("No flyer yet")).toBeVisible();
        // A rejected file does not block the rest of the wizard — the page did
        // not break, which is the defect this feature was built to rule out.
      },
    },
  });

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
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Snack Pack 2026");
      },
      items: async (p) => {
        await p.getByLabel("Item").first().fill("Jollof Rice");
        await p.getByLabel("Price").first().fill("3000");
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/snack-pack-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Photo").setInputFiles({ name: "jollof.png", mimeType: "image/png", buffer: TINY_PNG });
  // Wait for the upload to finish, not for a preview to appear: the preview
  // is a local object URL set the instant the file is chosen, so saving on
  // sight of it saved an item that had no uploaded image yet.
  await expect(page.getByRole("button", { name: "Uploading…" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Replace image" })).toBeEnabled({ timeout: 45_000 });
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

test("three items carry three different images through edit, remove and a reload", async ({ page }) => {
  await signInAsNewUser(page, "e2e-item-images");
  const slug = await createCommunity(page, `E2E Item Images ${Date.now()}`);

  // Part 8's exact scenario: three items, three different images, replace
  // each one, remove one, reload the draft, and confirm what remains is still
  // there. The images are added DURING creation — the catalogue is named on
  // the first step, so a draft exists by the time the items step renders and
  // the uploader has a collection to scope to.
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    stopBefore: "orderRules",
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Anniversary Merchandise 2026");
      },
      items: async (p) => {
        const rows: [string, string, keyof typeof PNGS][] = [
          ["Polo shirt", "12000", "red"],
          ["Cap", "3500", "green"],
          ["Tote bag", "5000", "blue"],
        ];

        for (const [index, [name, price, colour]] of rows.entries()) {
          if (index > 0) await p.getByRole("button", { name: "Add another item" }).click();
          await p.getByLabel("Item").nth(index).fill(name);
          await p.getByLabel("Price").nth(index).fill(price);
          await p.getByLabel("Photo").nth(index).setInputFiles({
            name: `${colour}.png`,
            mimeType: "image/png",
            buffer: PNGS[colour],
          });
          // Wait for the upload itself, not for the preview: the preview is a
          // local object URL set the instant the file is chosen, and saving on
          // sight of it saved items with no uploaded image at all.
          await expect(p.getByRole("button", { name: "Replace image" }).nth(index)).toBeEnabled({
            timeout: 45_000,
          });
        }

        // Three uploads, three distinct stored objects.
        const sources = await p.locator("img[src*='collection-covers']").evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLImageElement).src),
        );
        expect(new Set(sources).size).toBe(3);

        // Replace the middle one, then remove the last one.
        await p.getByLabel("Photo").nth(1).setInputFiles({
          name: "cap-v2.png",
          mimeType: "image/png",
          buffer: PNGS.red,
        });
        await expect(p.getByRole("button", { name: "Replace image" }).nth(1)).toBeEnabled({ timeout: 45_000 });

        await p.getByRole("button", { name: "Remove" }).nth(2).click();
        await expect(p.getByRole("button", { name: "Add image" })).toHaveCount(1);
      },
    },
  });

  // Leave, the way somebody with a phone call does, and come back.
  await page.goto(`/c/${slug}/collections`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Continue setting this up/ }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Back" }).click();

  await expect(page.getByRole("heading", { name: "What is in the catalogue?" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel("Item").first()).toHaveValue("Polo shirt");
  await expect(page.getByLabel("Item").nth(2)).toHaveValue("Tote bag");

  // Two images survived; the removed one did not come back.
  await expect(page.locator("img[src*='collection-covers']")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Add image" })).toHaveCount(1);
});

test("a ticket buyer can take more than one type, and name an attendee per ticket", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-types");
  const communitySlug = await createCommunity(page, `E2E Ticket Basket ${Date.now()}`);

  // §17/§18: several ticket types in one order, each with its own quantity,
  // plus one attendee name per ticket — the "VIP × 2, Regular × 1" case.
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    fill: {
      event: async (p) => {
        await p.getByLabel("What is the event called?").fill("Founders Gala 2026");
        await p.getByLabel("When does it start?").fill("2026-12-20T18:00");
        await p.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");
        // §18: how many names are needed is a question about SELLING tickets,
        // so the ticketing flow asks it on its own step rather than here.
        await expect(p.getByRole("checkbox", { name: "Collect attendee details" })).toHaveCount(0);
      },
      tickets: async (p) => {
        await fillTier(0, { name: "Regular", price: "10000" }, "Ticket type")(p);
        // Plenty for this order: the VIP stock is the database's limit, not
        // the browser's.
        await fillTier(1, { name: "VIP", price: "25000", limit: "5" }, "Ticket type")(p);
      },
      purchaseRules: async (p) => {
        await p.getByRole("checkbox", { name: /Ask for a name per ticket/ }).check();
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/founders-gala-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/founders-gala-2026`);
  await contributor.waitForLoadState("networkidle");

  // A fieldset legend names a group, not a heading — this asked for a role
  // the page has never rendered, and had been timing out since it was
  // written.
  await expect(contributor.getByRole("group", { name: "Which tickets?" })).toBeVisible();

  // VIP × 2
  await contributor.getByRole("checkbox").nth(1).check();
  await contributor.getByLabel("How many VIP?").fill("2");
  // Regular × 1
  await contributor.getByRole("checkbox").nth(0).check();

  // The form asks for exactly three names, each labelled by the ticket it
  // belongs to rather than by its position in an undifferentiated list —
  // "VIP — attendee 2", not "Ticket 3". This test still asked for the old
  // labels, which is why it had been failing.
  await expect(contributor.getByLabel("Regular — attendee 1")).toBeVisible();
  await contributor.getByLabel("VIP — attendee 1").fill("Ada Obi");
  await contributor.getByLabel("VIP — attendee 2").fill("Bola Ade");
  await contributor.getByLabel("Regular — attendee 1").fill("Chidi Eze");

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

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "tiered",
    intent: /^Packages/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Sponsor Packages 2026");
      },
      packages: async (p) => {
        await fillTier(0, { name: "Bronze", price: "5000" }, "Package")(p);
        await fillTier(1, { name: "Gold", price: "25000" }, "Package")(p);

        // Gold moves above Bronze. The ids travel with the rows, so this is a
        // reorder and not a rename — the price that was typed against Gold
        // stays against Gold.
        await p.getByRole("button", { name: "Move Gold up" }).click();
        await expect(p.getByLabel("Package name").first()).toHaveValue("Gold");
        await expect(p.getByLabel("Price").first()).toHaveValue("25000");
      },
    },
  });

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

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Bake Sale 2026");
      },
      items: async (p) => {
        await p.getByLabel("Item").first().fill("Cake");
        await p.getByLabel("Price").first().fill("4000");
      },
    },
  });

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

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "open",
    intent: /^Open contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Mobile Offering 2026");
      },
    },
  });

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

  // M7.5 part A, preserved through M7.7's rebuild (§25): each Continue saves
  // that step. Nothing here clicks a save button, because there is no longer
  // one to click. The walk stops partway, at the order-rules step, with the
  // items already written.
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    stopBefore: "fees",
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Resumed Catalog 2026");
      },
      items: async (p) => {
        await p.getByLabel("Item").first().fill("Jollof");
        await p.getByLabel("Price").first().fill("3000");
        await p.getByRole("button", { name: "Add another item" }).click();
        await p.getByLabel("Item").nth(1).fill("Chicken");
        await p.getByLabel("Price").nth(1).fill("2000");
      },
    },
  });

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

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "fixed",
    intent: /Fixed contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Annual Gala 2026");
      },
      amount: async (p) => {
        await p.getByLabel("Amount each person pays").fill("10000");
      },
    },
  });

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
  await page.getByRole("button", { name: "Exports" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to export?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Download PDF" })).toBeEnabled();

  await expect(page.getByLabel("Full name")).toBeChecked();
  await expect(page.getByLabel("Expected amount")).toBeChecked();

  // A dues collection has no options and no door, so it is not offered a
  // column for either (M7.6 part F: only what this collection can answer).
  await expect(page.getByLabel("Option")).toHaveCount(0);
  await expect(page.getByLabel("At the door")).toHaveCount(0);
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

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    fill: {
      event: async (p) => {
        await p.getByLabel("What is the event called?").fill("Founders Night 2026");
        await p.getByLabel("When does it start?").fill("2026-12-20T18:00");
        await p.getByLabel("Where is it?").fill("Ostrich Hall, Ilorin");
      },
      tickets: async (p) => {
        await fillTier(0, { name: "Regular", price: "10000" }, "Ticket type")(p);
      },
      // A door needs a list, and a list needs a managed audience.
      audience: async (p) => {
        await p.getByRole("radio", { name: /Everyone on the roll/ }).check();
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/founders-night-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  // On an event the roll is a guest list, and the tab says so (M7.6 part C).
  await page.getByRole("button", { name: "Attendees" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  const assign = page.getByRole("dialog");
  await assign.getByRole("checkbox").first().check();
  // A ticketed collection has no single headline amount, so the roll records
  // what this guest is expected to pay.
  await assign.getByLabel("Amount expected from each member selected").fill("10000");
  await assign.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByRole("cell", { name: "₦10,000" })).toBeVisible();

  // The door.
  await page.getByRole("button", { name: "Check-in" }).click();
  // Scoped to the guest’s own row: the counters above it use the same
  // words, and an assertion that cannot say which one it found is not one.
  const guest = page.getByRole("listitem").filter({ hasText: "Bola Attendee" });
  await expect(guest.getByText("Not arrived", { exact: true })).toBeVisible();

  await page.getByLabel("Find someone").fill("Bola");
  await guest.getByRole("button", { name: "Check in" }).click();
  await expect(guest.getByText("Inside", { exact: true })).toBeVisible({ timeout: 30_000 });

  await guest.getByRole("button", { name: "Check out" }).click();
  await expect(guest.getByText("Left", { exact: true })).toBeVisible({ timeout: 30_000 });
});
