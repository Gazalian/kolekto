import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "../helpers/auth.ts";
import { openWizard, walkWizard } from "../helpers/wizard.ts";

test.use({ viewport: { width: 390, height: 844 } });
test.describe.configure({ timeout: 240_000 });

/**
 * `openWizard` (helpers/wizard.ts) clicks "Collections" directly, which is
 * correct at desktop width but not here: `AppShell.tsx` hides the sidebar
 * nav below `sm:` and replaces it with a collapsed top bar — the "Collections"
 * link exists only after the "Open menu" button is pressed. First real finding
 * of this mobile pass, not a flake: both attempts of the un-patched test hung
 * the full 240s waiting for a link that was never going to appear.
 */
async function openWizardMobile(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu" }).click();
  await openWizard(page);
}

async function createCommunity(page: import("@playwright/test").Page, name: string): Promise<string> {
  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(name);
  await page.getByLabel("Type").selectOption("fellowship");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);
  await page.waitForLoadState("networkidle");
  const slug = new URL(page.url()).pathname.split("/")[2];
  if (!slug) throw new Error("no slug");
  return slug;
}

async function noOverflow(page: import("@playwright/test").Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(1);
}

test("mobile: fixed collection wizard, 390px", async ({ page }) => {
  await signInAsNewUser(page, "e2e-mobile-fixed");
  await createCommunity(page, `E2E Mobile Fixed ${Date.now()}`);
  await openWizardMobile(page);
  await noOverflow(page, "intent picker");
  await page.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-01-intent.png", fullPage: true });

  await walkWizard(page, {
    flowKey: "fixed",
    intent: /^Fixed contribution/,
    fill: {
      basics: async (p) => {
        await noOverflow(p, "fixed basics");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-02-basics.png", fullPage: true });
        await p.getByLabel("What is this collection called?").fill("Mobile Levy 2026");
      },
      amount: async (p) => {
        await noOverflow(p, "fixed amount");
        await p.getByLabel("Amount each person pays").fill("5000");
      },
      fees: async (p) => {
        await noOverflow(p, "fixed fees");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-03-fees.png", fullPage: true });
        await p.getByRole("radio", { name: "You absorb fees" }).check();
      },
      cover: async (p) => {
        await noOverflow(p, "fixed cover");
      },
      audience: async (p) => {
        await noOverflow(p, "fixed audience");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-04-audience.png", fullPage: true });
        await p.getByRole("radio", { name: /Everyone on the roll/ }).check();
      },
      reference: async (p) => {
        await noOverflow(p, "fixed reference");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-05-reference.png", fullPage: true });
      },
      review: async (p) => {
        await noOverflow(p, "fixed review");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/fixed-06-review.png", fullPage: true });
      },
    },
  });
});

test("mobile: items wizard, 390px", async ({ page }) => {
  await signInAsNewUser(page, "e2e-mobile-items");
  await createCommunity(page, `E2E Mobile Items ${Date.now()}`);
  await openWizardMobile(page);
  await walkWizard(page, {
    flowKey: "items",
    intent: /^Items/,
    stopBefore: "orderRules",
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this catalogue called?").fill("Mobile Merch 2026");
      },
      items: async (p) => {
        await noOverflow(p, "items catalogue");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/items-01-catalogue.png", fullPage: true });
        await p.getByLabel("Item").first().fill("Polo shirt");
        await p.getByLabel("Price").first().fill("8000");
      },
    },
  });
});

test("mobile: ticketing wizard, 390px", async ({ page }) => {
  await signInAsNewUser(page, "e2e-mobile-tix");
  await createCommunity(page, `E2E Mobile Tix ${Date.now()}`);
  await openWizardMobile(page);
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    stopBefore: "purchaseRules",
    fill: {
      event: async (p) => {
        await noOverflow(p, "ticketing event step");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/tix-01-event.png", fullPage: true });
        await p.getByLabel("What is the event called?").fill("Mobile Dinner 2026");
        await p.getByLabel("When does it start?").fill("2026-12-01T18:00");
        await p.getByLabel("Where is it?").fill("Ilorin");
      },
      tickets: async (p) => {
        await noOverflow(p, "ticketing tickets step");
        await p.screenshot({ path: "/tmp/kolekto-qa/mobile-screens/tix-02-tickets.png", fullPage: true });
        await p.getByLabel("Ticket type name").first().fill("Regular");
        await p.getByRole("textbox", { name: "Price" }).first().fill("10000");
      },
    },
  });
});
