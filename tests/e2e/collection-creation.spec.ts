import { expect, test, type Page } from "@playwright/test";
import { flowFor } from "../../apps/web/app/c/[slug]/collections/new/flows.ts";
import { signInAsNewUser } from "./helpers/auth.ts";
import { chooseFeeBearer, openWizard, stepCount, walkWizard } from "./helpers/wizard.ts";

/**
 * M7.7 in a real browser: the creation experience itself.
 *
 * The other specs use the wizard to reach something else — a public page, a
 * door, an export. These are about the wizard, because the defect M7.7
 * corrects lives there: seven kinds of collection walking one generic form.
 *
 * Five journeys:
 *
 *   1. two types, side by side, proving the flows differ in shape and in
 *      words rather than only in labels (§28)
 *   2. the fee decision: the breakdown moves when the answer changes, the
 *      contributor-borne total is the contribution PLUS the fees rather than
 *      a fee charged on a fee, and the choice survives a reload (§5, §6)
 *   3. the review's preview, which is the real public page rather than a
 *      mock-up of one (§24)
 *   4. a draft resumed into ITS OWN flow, at its own step (§25)
 *   5. Continue clicked straight from a name field that creates the draft
 *
 * Nothing here pays for anything. The fee screen is a decision and a
 * preview — Phase 4 is not implemented, and no payment, contribution or
 * ledger row exists to be created.
 */

test.describe.configure({ timeout: 240_000 });

async function createCommunity(page: Page, name: string): Promise<string> {
  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(name);
  await page.getByLabel("Type").selectOption("estate");
  await page.getByRole("button", { name: "Create community" }).click();

  await expect(page).toHaveURL(/\/c\//);
  await page.waitForLoadState("networkidle");

  const slug = new URL(page.url()).pathname.split("/")[2];
  if (!slug) throw new Error(`Could not read a community slug from ${page.url()}`);
  return slug;
}

test("two types ask different questions, in different words, in a different order", async ({ page }) => {
  await signInAsNewUser(page, "e2e-create");
  await createCommunity(page, `E2E Shape ${Date.now()}`);

  // ── The intent screen names all seven and nothing else (§3, §4) ───────────
  await openWizard(page);
  await expect(page.getByRole("heading", { name: "What are you collecting for?" })).toBeVisible();
  for (const title of [
    "Fixed contribution",
    "Open contribution",
    "Packages",
    "Items",
    "Tickets",
    "Fundraising",
    "Recurring",
  ]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
  }

  // §27: the examples are an estate, a trade association, a conference — not
  // a lecture theatre.
  const intents = await page.getByRole("button", { name: /contribution|Packages|Items|Tickets|Fundraising|Recurring/ }).allTextContents();
  expect(intents.join(" ")).not.toMatch(/matric|student|classmate|semester/i);

  // ── A ticketed event opens on the event ──────────────────────────────────
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    stopBefore: "tickets",
    fill: {
      event: async (p) => {
        // The first screen is the event, flyer included. It is not called a
        // "collection", and it does not ask for a "contribution amount".
        await expect(p.getByText("Step 2 of " + stepCount("ticketing") + " · The event")).toBeVisible();
        await expect(p.getByText("Event flyer")).toBeVisible();
        await expect(p.getByLabel("Amount each person pays")).toHaveCount(0);

        await p.getByLabel("What is the event called?").fill("Founders Dinner 2026");
        await p.getByLabel("When does it start?").fill("2026-11-14T19:00");
        await p.getByLabel("Where is it?").fill("Kwara Hotel, Ilorin");
      },
    },
  });

  // The next screen is tickets, in the language of tickets.
  await expect(page.getByRole("heading", { name: "What tickets are you selling?" })).toBeVisible();
  await expect(page.getByLabel("Ticket type name")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another ticket type" })).toBeVisible();

  // ── A recurring plan opens on basics and never closes ─────────────────────
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "recurring",
    intent: /^Recurring/,
    stopBefore: "fees",
    fill: {
      basics: async (p) => {
        // Its own noun, and a neutral example.
        await expect(p.getByLabel("What is this plan called?")).toBeVisible();
        await expect(p.getByText(/Estate Service Charge/)).toBeVisible();
        await p.getByLabel("What is this plan called?").fill("Estate Service Charge 2026");
      },
      amount: async (p) => {
        // "per period", not "each person pays" — a plan charges repeatedly.
        await expect(p.getByLabel("Amount per period")).toBeVisible();
        await p.getByLabel("Amount per period").fill("30000");
      },
    },
  });

  // The two flows walk different steps, in a different order, which is the
  // whole point of §28 — not merely a different total, which two flows can
  // share by coincidence (ticketing gained a "timing" step for its sales
  // window, recurring has none, and the counts now land on the same total
  // even though not one single step kind repeats in the same position).
  const ticketingKinds = flowFor("ticketing").steps.map((step) => step.kind);
  const recurringKinds = flowFor("recurring").steps.map((step) => step.kind);
  expect(ticketingKinds).not.toEqual(recurringKinds);
});

test("the fee decision changes the numbers, is saved, and charges nothing", async ({ page }) => {
  await signInAsNewUser(page, "e2e-fees");
  const slug = await createCommunity(page, `E2E Fees ${Date.now()}`);

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "fixed",
    intent: /Fixed contribution/,
    stopBefore: "cover",
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Ikoyi Annual Levy 2026");
      },
      amount: async (p) => {
        await p.getByLabel("Amount each person pays").fill("20000");
      },
      fees: async (p) => {
        // Part 3: the question is asked plainly, and it is not optional.
        await expect(p.getByRole("group", { name: "Who should cover payment fees?" })).toBeVisible();

        // ── The DEFAULT presentation asserts no figure it cannot stand behind ──
        //
        // Kolekto's own fee is settled (D-10), but the provider's fee is only a
        // model until Paystack reports it (D-11), so the headline is the
        // organiser's own amount plus "applicable fees" — and the computed
        // split must not be on screen until it is asked for.
        await chooseFeeBearer("Contributor pays")(p);
        await expect(p.getByText("₦20,000 + applicable fees")).toBeVisible();
        await expect(p.getByText("Estimated total fees")).toHaveCount(0);

        await chooseFeeBearer("You absorb fees")(p);
        await expect(p.getByText("₦20,000 − applicable fees")).toBeVisible();

        // ── The estimate is available, and clearly marked as one ──────────────
        await p.getByRole("button", { name: "Show an estimate of the fees" }).click();
        await expect(p.getByText(/An estimate, using Kolekto's fee schedule \(2026-09-founder\)/i)).toBeVisible();
        await expect(p.getByText(/not a settlement amount/i)).toBeVisible();

        // The two fees are named separately, never summed into one line: an
        // organiser deciding whether to absorb them is entitled to know which
        // is the processor's and which is Kolekto's.
        await expect(p.getByText("Estimated payment processing fee")).toBeVisible();
        await expect(p.getByText("Estimated Kolekto service fee")).toBeVisible();

        // D-10: 1.5% modeled provider fee and 1.5% Kolekto fee on ₦20,000 —
        // ₦300 each, both under their caps.
        await expect(p.getByText("₦300", { exact: true })).toHaveCount(2);
        await expect(p.getByText("₦600", { exact: true })).toBeVisible();

        // Absorbing: the contributor pays ₦20,000, the community nets ₦19,400.
        await expect(p.getByText("₦19,400")).toBeVisible();

        // Passing on: ₦20,000 + ₦600 of fees. NOT ₦20,619, which is what 3% of
        // fees charged on the payable would produce (20,000 / 0.97) — the
        // arithmetic is on the contribution, so it cannot compound.
        await chooseFeeBearer("Contributor pays")(p);
        await expect(p.getByText("₦20,600")).toBeVisible();
        await expect(p.getByText("₦20,619")).toHaveCount(0);

        await expect(p.getByText(/nothing has been charged/i)).toBeVisible();
      },
    },
  });

  // It saved on Continue, like every other step. Reload the wizard's own
  // resume route and the answer is still there.
  await page.goto(`/c/${slug}/collections`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: /Continue setting this up/ }).first().click();
  await page.waitForLoadState("networkidle");

  // Back to the fee step and check the radio the organiser actually chose.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Who pays the fees?" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("radio", { name: "Contributor pays" })).toBeChecked();

  // And nothing was charged: the draft has no contribution, no payment and no
  // receipt, because none of those exist yet (ADR 0006, §31).
  await expect(page.getByText(/nothing has been charged/i)).toBeVisible();
});

test("the review previews the real public page, not a mock-up of one", async ({ page }) => {
  await signInAsNewUser(page, "e2e-preview");
  await createCommunity(page, `E2E Preview ${Date.now()}`);

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "fundraiser",
    intent: /^Fundraising/,
    stopBefore: "review",
    fill: {
      story: async (p) => {
        await p.getByLabel("What are you raising money for?").fill("Rebuild the Health Post");
        await p.getByLabel("What is this for?").fill("The roof came down in the last storm.");
      },
      goal: async (p) => {
        await p.getByLabel("Fundraising goal").fill("2000000");
      },
    },
  });

  // §23: a campaign is reviewed by reading its story back, not by a table of
  // field names.
  await expect(page.getByRole("heading", { name: "Check the campaign" })).toBeVisible();
  await expect(page.getByText("The roof came down in the last storm.")).toBeVisible();
  await expect(page.getByText("Working toward")).toBeVisible();

  // §24: the preview is the real renderer. What appears there is what a
  // supporter will actually get — a summary written for the review screen
  // would drift from the page within a milestone.
  await page.getByRole("link", { name: /See what your supporters will see/ }).click();
  await page.waitForLoadState("networkidle");

  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByRole("heading", { name: "Rebuild the Health Post" })).toBeVisible();
  await expect(page.getByText("The roof came down in the last storm.")).toBeVisible();

  // A preview cannot be paid into: submitting one would be the organiser
  // contributing to their own draft, and in a later phase a payment attempt
  // against it.
  await expect(page.getByText("Contributor view")).toBeVisible();
  await expect(page.getByText(/Nothing here can be submitted/)).toBeVisible();
});

test("a per-order limit set during creation is enforced by the server", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-perorder");
  const slug = await createCommunity(page, `E2E Per Order ${Date.now()}`);

  // Part 7: a per-order limit is a real, server-enforced rule — the column,
  // the write function and the check in `resolveContribution` have existed
  // since the first migration; until M7.7 nothing in the UI could set it.
  //
  // This uses ticketing, not Packages (M7.9 §2D / QA Finding 2): a contributor
  // to a Packages collection chooses exactly one package — confirmed against
  // the legacy contribute flow, which never let anyone take more than one
  // package either — so "how many of this may one person take" can never be
  // exceeded there, and the control for it is no longer offered on that flow
  // (TiersEditor.tsx). Ticketing genuinely allows several of one type in an
  // order, which is where this guarantee actually has something to prove.
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    fill: {
      event: async (p) => {
        await p.getByLabel("What is the event called?").fill("Founders Breakfast 2026");
        await p.getByLabel("When does it start?").fill("2026-11-20T08:00");
        await p.getByLabel("Where is it?").fill("Kwara Hotel, Ilorin");
      },
      tickets: async (p) => {
        await p.getByLabel("Ticket type name").first().fill("Regular");
        await p.getByRole("textbox", { name: "Price" }).first().fill("15000");
        await p.getByLabel("Most one person may buy").first().fill("2");
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/founders-breakfast-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${slug}/founders-breakfast-2026`);
  await contributor.waitForLoadState("networkidle");

  // Select the ticket first (ticketing's public page is a checkbox basket,
  // not a radio group — the quantity field, and its limit hint, only appear
  // once a type is chosen).
  await contributor.getByRole("checkbox").first().check();
  await expect(contributor.getByText("Up to 2 per order.")).toBeVisible();

  // ...and the SERVER refuses more, whatever the browser sends.
  await contributor.getByLabel(/How many/).fill("5");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011112222");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText(/at most 2 of "Regular" in one order/i)).toBeVisible();

  await anonymous.close();
});

test("somebody outside the community cannot reach or change its collection configuration", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-owner-iso");
  const slug = await createCommunity(page, `E2E Isolation ${Date.now()}`);

  await openWizard(page);
  await walkWizard(page, {
    flowKey: "fixed",
    intent: /Fixed contribution/,
    stopBefore: "fees",
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Private Levy 2026");
      },
      amount: async (p) => {
        await p.getByLabel("Amount each person pays").fill("7500");
      },
    },
  });

  // A different signed-in person, with no role in that community at all.
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await signInAsNewUser(outsider, "e2e-outsider");

  // Part 17: community isolation and IDOR. Every one of these is a
  // configuration surface, and none of them may open for a stranger — the
  // community row is invisible to them through RLS, so the page cannot even
  // find what they are asking for.
  for (const path of [
    `/c/${slug}`,
    `/c/${slug}/collections`,
    `/c/${slug}/collections/new`,
    `/c/${slug}/collections/private-levy-2026`,
    `/c/${slug}/collections/private-levy-2026/continue`,
    `/c/${slug}/collections/private-levy-2026/preview`,
    `/c/${slug}/settings`,
    `/c/${slug}/members`,
  ]) {
    const response = await outsider.goto(path);
    expect(
      [403, 404].includes(response?.status() ?? 0) || !outsider.url().includes(slug),
      `${path} should not open for an outsider (got ${response?.status()}, landed on ${outsider.url()})`,
    ).toBeTruthy();
  }

  // And the draft is untouched for its owner.
  await page.goto(`/c/${slug}/collections`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Private Levy 2026")).toBeVisible();

  await outsiderContext.close();
});

test("a resumed draft comes back in its own flow, at its own step", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-resume-flow");
  const slug = await createCommunity(page, `E2E Resume Flow ${Date.now()}`);

  // A ticketed event, abandoned after its tickets are priced.
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "ticketing",
    intent: /^Tickets/,
    stopBefore: "purchaseRules",
    fill: {
      event: async (p) => {
        await p.getByLabel("What is the event called?").fill("West Africa Founders Dinner");
        await p.getByLabel("When does it start?").fill("2026-11-14T19:00");
        await p.getByLabel("Where is it?").fill("Kwara Hotel, Ilorin");
      },
      tickets: async (p) => {
        await p.getByLabel("Ticket type name").first().fill("Regular");
        await p.getByRole("textbox", { name: "Price" }).first().fill("45000");
      },
    },
  });

  // A new context is a new browser: no page state, only what the server kept.
  const second = await browser.newContext({ storageState: await page.context().storageState() });
  const resumed = await second.newPage();
  await resumed.goto(`/c/${slug}/collections`);
  await resumed.waitForLoadState("networkidle");
  await resumed.getByRole("link", { name: /Continue setting this up/ }).first().click();
  await resumed.waitForLoadState("networkidle");

  // The flow is recovered from the rows, never stored (ADR 0013) — so it
  // comes back as the EVENT it is, with the event flow's own length and its
  // own vocabulary, at the step it was left on.
  await expect(resumed.getByText(`Step 4 of ${stepCount("ticketing")} · Buying`)).toBeVisible({ timeout: 45_000 });
  await expect(resumed.getByRole("heading", { name: "How may people buy?" })).toBeVisible();

  await resumed.getByRole("button", { name: "Back" }).click();
  await expect(resumed.getByLabel("Ticket type name").first()).toHaveValue("Regular");

  await resumed.getByRole("button", { name: "Back" }).click();
  await expect(resumed.getByLabel("What is the event called?")).toHaveValue("West Africa Founders Dinner");
  await expect(resumed.getByLabel("Where is it?")).toHaveValue("Kwara Hotel, Ilorin");

  await second.close();
});

test("Continue works straight from the name field, while the draft is still being created", async ({ page }) => {
  await signInAsNewUser(page, "e2e-name-continue");
  const slug = await createCommunity(page, `E2E Name Continue ${Date.now()}`);

  // The two steps that create their draft when the name field loses focus, so
  // a flyer has somewhere to live. Clicking Continue is what takes the focus
  // away: the creation starts between mousedown and click, and it used to
  // disable Continue in that gap, so the click was silently dropped.
  const journeys = [
    {
      flowKey: "fundraiser",
      intent: /^Fundraising/,
      nameLabel: "What are you raising money for?",
      name: "Clinic Roof Fund",
      draftSlug: "clinic-roof-fund",
      before: async () => {},
    },
    {
      flowKey: "ticketing",
      intent: /^Tickets/,
      nameLabel: "What is the event called?",
      name: "Founders Gala",
      draftSlug: "founders-gala",
      // Required on this step, and filled first so the name is the last field.
      before: async () => {
        await page.getByLabel("When does it start?").fill("2026-11-14T19:00");
      },
    },
  ];

  for (const journey of journeys) {
    const flow = flowFor(journey.flowKey);
    await openWizard(page);
    await walkWizard(page, { flowKey: journey.flowKey, intent: journey.intent, stopBefore: flow.steps[0]!.kind });

    await journey.before();
    await page.getByLabel(journey.nameLabel).fill(journey.name);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByRole("heading", { name: flow.steps[1]!.heading, exact: true })).toBeVisible({
      timeout: 45_000,
    });
  }

  // Each draft was created once, and remembered the step it reached — the
  // create, the step's save and its position landed in that order.
  await page.goto(`/c/${slug}/collections`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("link", { name: /Continue setting this up/ })).toHaveCount(journeys.length);

  for (const journey of journeys) {
    await page.goto(`/c/${slug}/collections/${journey.draftSlug}/continue`);
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("heading", { name: flowFor(journey.flowKey).steps[1]!.heading, exact: true }),
    ).toBeVisible({ timeout: 45_000 });
  }
});
