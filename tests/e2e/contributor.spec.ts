import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";
import { openWizard, walkWizard, type StepFiller } from "./helpers/wizard.ts";
import type { StepKind } from "../../apps/web/app/c/[slug]/collections/new/flows.ts";

/**
 * The public contributor experience (M7), in a real browser against the real
 * local stack.
 *
 * Two journeys exist, and they are different products:
 *
 *   · an OPEN collection takes money from anyone with the link;
 *   · a MANAGED collection asks named people, so the contributor has to find
 *     themselves on the roll before anything about amounts appears.
 *
 * Most of what these tests assert is a refusal — an archived member, somebody
 * outside the audience, a member of another community, a browser that edits its
 * own payload. The database tests (supabase/tests/14) prove the same rules at
 * the SQL level; these prove the application actually applies them.
 *
 * Every journey ends at the payment boundary and no further (ADR 0012). There
 * is no Paystack, no transaction, and nothing anywhere marks an obligation paid.
 */

test.describe.configure({ timeout: 300_000 });

async function createCommunity(page: Page, name: string): Promise<string> {
  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Community name").fill(name);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();

  await expect(page).toHaveURL(/\/c\//);
  await page.waitForLoadState("networkidle");

  const slug = new URL(page.url()).pathname.split("/")[2];
  if (!slug) throw new Error(`Could not read a community slug from ${page.url()}`);
  return slug;
}

/** Gives the community a member-code prefix and a primary identifier, the way an officer would. */
async function configureMemberProfile(page: Page, identifierLabel: string): Promise<void> {
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Member profile" }).click();
  await page.getByLabel("Prefix").fill("KWASU/");
  await page.getByRole("button", { name: "Save ID format" }).click();
  await expect(page.getByText(/KWASU\/0001/)).toBeVisible();

  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label").fill(identifierLabel);
  await page.getByLabel("This field identifies a member").check();
  await page.getByRole("button", { name: "Add field", exact: true }).click();

  // Wait for the save to land before closing: a click during the pending
  // transition is swallowed by the re-render and leaves the dialog open over
  // everything else on the page.
  await expect(page.getByText("Field saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}

async function addMember(
  page: Page,
  member: { name: string; phone: string; identifier?: string },
): Promise<void> {
  // Counted before and after, because two of the people added below share a
  // name: "is the name on screen?" cannot tell the second one from the first.
  // Filtered by text rather than by accessible name — the member's name lives
  // in a link inside the row, and the row itself does not answer to it.
  const rows = page.locator("tr").filter({ hasText: member.name });
  const before = await rows.count();

  // Scoped to `dialog[open]` rather than the dialog ROLE: this page mounts
  // several dialogs, and a role-based locator that matches more than one fails
  // strict mode inside a try/catch, which looks exactly like "no warning shown".
  const open = page.locator("dialog[open]");

  await page.getByRole("button", { name: "Add member" }).first().click();
  await open.getByLabel("Full name").fill(member.name);
  await open.getByLabel("Phone number").fill(member.phone);
  if (member.identifier) await open.getByLabel(/Matric number/).fill(member.identifier);
  await open.getByRole("button", { name: "Add member", exact: true }).click();

  // Two people really can share a name, and the roll below needs exactly that.
  // Kolekto warns rather than refusing (§4: never auto-merge), so the warning
  // is answered here the way an officer would.
  const addAnyway = page.getByRole("button", { name: /They are different people/ });

  await expect(async () => {
    const added = (await rows.count()) > before;
    const warned = await addAnyway.isVisible().catch(() => false);
    expect(added || warned).toBeTruthy();
  }).toPass({ timeout: 30_000 });

  if (await addAnyway.isVisible().catch(() => false)) await addAnyway.click();

  await expect(rows).toHaveCount(before + 1);
  await expect(open).toHaveCount(0);
}

/**
 * Walks the creation wizard for a fixed managed collection and leaves the
 * browser on the finished draft.
 *
 * Driven by the flow's own step list rather than by counting Continue clicks.
 * Counting is what put every walk in this file one step behind the wizard for
 * a whole milestone once the flyer step was added.
 */
async function createDuesCollection(
  page: Page,
  name: string,
  amount: string,
  fill: Partial<Record<StepKind, StepFiller>> = {},
): Promise<void> {
  await openWizard(page);
  await walkWizard(page, {
    flowKey: "fixed",
    intent: /Fixed contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill(name);
      },
      amount: async (p) => {
        await p.getByLabel("Amount each person pays").fill(amount);
      },
      ...fill,
    },
  });
}

async function publish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
}

test("a managed collection: find yourself, see what you owe, reach the payment boundary", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-contrib");
  const communitySlug = await createCommunity(page, `E2E Contributor ${Date.now()}`);
  await configureMemberProfile(page, "Matric number");

  // One person with a distinct name, two who share one, and one who has left.
  await addMember(page, { name: "Ghazali Habeebulahi", phone: "+2348011110101", identifier: "20/53A/0123" });
  await addMember(page, { name: "Grace Adeyemi", phone: "+2348011110102", identifier: "20/53A/0456" });
  await addMember(page, { name: "Grace Adeyemi", phone: "+2348011110103", identifier: "20/53A/0789" });
  await addMember(page, { name: "Tunde Bakare", phone: "+2348011110104", identifier: "20/53A/0999" });

  // Tunde has left the class: archived members are not asked for anything new.
  await page.locator("tr").filter({ hasText: "Tunde Bakare" }).getByRole("button", { name: "Archive" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Archive member" }).click();
  await expect(page.locator("tr").filter({ hasText: "Tunde Bakare" })).toHaveCount(0);

  await createDuesCollection(page, "Departmental Dues M7", "5000", {
    // One required question, so the field rules get exercised on the public page.
    questions: async (p) => {
      await p.getByRole("button", { name: "Add a question" }).click();
      await p.getByLabel("Question").fill("House number");
      await p.getByLabel("Required").check();
    },
  });

  await expect(page).toHaveURL(/\/collections\/departmental-dues-m7/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  // Everyone eligible is expected to pay: the officer decides that, explicitly.
  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: /Add 3 obligations/ }).click();
  await expect(page.getByText("3 expected")).toBeVisible();

  await page.getByRole("button", { name: "Overview" }).click();
  await publish(page);

  // ── The contributor, with no account and no session ───────────────────────
  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/departmental-dues-m7`);
  await contributor.waitForLoadState("networkidle");

  // WHO IS THIS FOR, before anything else.
  await expect(contributor.getByText(/For members of/)).toBeVisible();
  await expect(contributor.getByRole("heading", { name: "Find yourself on the list" })).toBeVisible();
  // Nothing about the money until they say who they are.
  await expect(contributor.getByLabel("Full name")).toBeHidden();

  // A name two people answer to: a count and a prompt, never a list.
  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Grace Adeyemi");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText(/2 people on this list match that/)).toBeVisible();
  // The banner's own wording: /matric number/ alone also matches the intro
  // paragraph above the search box.
  await expect(contributor.getByText(/Enter your matric number or your member ID instead/i)).toBeVisible();
  // The other Grace's details are nowhere on the page.
  await expect(contributor.getByText("20/53A/0456")).toBeHidden();
  await expect(contributor.getByText("20/53A/0789")).toBeHidden();

  // An archived member cannot identify at all.
  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Tunde Bakare");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText(/Nobody on this list matches that/)).toBeVisible();

  // The identifier tells the two Graces apart.
  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("20/53A/0456");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText("Is this you?")).toBeVisible();
  await expect(contributor.getByText("Grace Adeyemi")).toBeVisible();
  await expect(contributor.getByText("20/53A/0456")).toBeVisible();

  await contributor.getByRole("button", { name: "Yes, this is me" }).click();

  // Their own obligation, and an honest status.
  await expect(contributor.getByText("Contributing as")).toBeVisible();
  await expect(contributor.getByText("₦5,000").first()).toBeVisible();
  await expect(contributor.getByText("Awaiting contribution")).toBeVisible();
  await expect(contributor.getByText(/Paid/)).toBeHidden();

  // The collection's own question is required, and the server says so.
  await contributor.getByLabel("Full name").fill("Grace Adeyemi");
  await contributor.getByLabel("Phone number").fill("+2348011110102");
  await contributor.getByRole("button", { name: "Continue" }).click();
  await expect(contributor.getByText(/House number/)).toBeVisible();

  await contributor.getByLabel("House number").fill("14B Sobi Close");
  await contributor.getByRole("button", { name: "Continue" }).click();

  // The payment boundary: the amount is resolved, and nothing has been charged.
  await expect(contributor.getByText("Ready to continue to payment")).toBeVisible();
  await expect(contributor.getByText(/Nothing has been charged/)).toBeVisible();
  await expect(contributor.getByText("₦5,000").first()).toBeVisible();

  await anonymous.close();
});

test("identification cannot be forged: the server refuses a contribution with no confirmed member", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-contrib");
  const communitySlug = await createCommunity(page, `E2E Forge ${Date.now()}`);
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await addMember(page, { name: "Bola Ahmed", phone: "+2348011110201" });

  await createDuesCollection(page, "Levy M7", "2000");
  await expect(page).toHaveURL(/\/collections\/levy-m7/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/levy-m7`);
  await contributor.waitForLoadState("networkidle");

  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Bola Ahmed");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await contributor.getByRole("button", { name: "Yes, this is me" }).click();
  await expect(contributor.getByText("Contributing as")).toBeVisible();

  // The identification lives in an httpOnly signed cookie. Throwing it away is
  // the closest a browser can get to editing it — and the server then refuses,
  // rather than taking the page's word for who is contributing.
  await anonymous.clearCookies();

  await contributor.getByLabel("Full name").fill("Somebody Else");
  await contributor.getByLabel("Phone number").fill("+2348011110299");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText(/Find yourself on the list before continuing/)).toBeVisible();
  await expect(contributor.getByText("Ready to continue to payment")).toBeHidden();

  await anonymous.close();
});

test("a group collection only knows the members of that group, and never another community's", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-contrib");

  // A second community first, to prove its members cannot be reached from the
  // first one's collection.
  const otherSlug = await createCommunity(page, `E2E Other ${Date.now()}`);
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await addMember(page, { name: "Outsider Person", phone: "+2348011110301" });

  await page.getByRole("link", { name: "← All communities" }).click();
  await page.waitForLoadState("networkidle");
  const communitySlug = await createCommunity(page, `E2E Groups M7 ${Date.now()}`);
  expect(communitySlug).not.toEqual(otherSlug);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await addMember(page, { name: "Inside Group", phone: "+2348011110302" });
  await addMember(page, { name: "Outside Group", phone: "+2348011110303" });

  // A group with exactly one of them in it.
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("300 Level");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("300 Level").first()).toBeVisible();

  await page.getByRole("button", { name: "Add members" }).click();
  await page.locator("dialog[open]").locator("label", { hasText: "Inside Group" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: /Add 1 member/ }).click();

  // Two dialogs are stacked here — the group manager, with the add-members one
  // on top — so closing once leaves the page still covered.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.locator("dialog[open]").count()) === 0) break;
    await page.getByRole("button", { name: "Close" }).first().click();
  }
  await expect(page.locator("dialog[open]")).toHaveCount(0);

  // This one is for the group, not the whole roll.
  await createDuesCollection(page, "Level Dues M7", "1500", {
    audience: async (p) => {
      await p.getByRole("radio", { name: /Specific groups/ }).check();
      await p.getByRole("checkbox", { name: "300 Level" }).check();
    },
  });

  await expect(page).toHaveURL(/\/collections\/level-dues-m7/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/level-dues-m7`);
  await contributor.waitForLoadState("networkidle");

  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Inside Group");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText("Is this you?")).toBeVisible();

  await contributor.getByRole("button", { name: "No, search again" }).click();
  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Outside Group");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText(/Nobody on this list matches that/)).toBeVisible();

  // And a member of the other community is not reachable from here at all.
  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Outsider Person");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await expect(contributor.getByText(/Nobody on this list matches that/)).toBeVisible();

  await anonymous.close();
});

test("a recurring charge shows the period it is asking about", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-contrib");
  const communitySlug = await createCommunity(page, `E2E Recurring M7 ${Date.now()}`);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await addMember(page, { name: "Resident One", phone: "+2348011110401" });

  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  // §20: a recurring plan asks its amount and its frequency on separate
  // steps, and is never asked when it closes — a plan that repeats does not.
  await walkWizard(page, {
    flowKey: "recurring",
    intent: /^Recurring/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this plan called?").fill("Service Charge M7");
      },
      amount: async (p) => {
        await p.getByLabel("Amount per period").fill("20000");
      },
      schedule: async (p) => {
        await p.getByLabel("How often").selectOption("monthly");
        await p.getByLabel("First period starts").fill("2026-10-01");
      },
      review: async (p) => {
        await expect(p.getByText("Every month")).toBeVisible();
        await expect(p.getByText(/does not close/i)).toBeVisible();
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/service-charge-m7/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Open the next period" }).click();
  await expect(page.getByText("Opened 2026-10.")).toBeVisible();

  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: /Add 1 obligation for 2026-10/ }).click();
  await expect(page.getByText("1 expected")).toBeVisible();

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/service-charge-m7`);
  await contributor.waitForLoadState("networkidle");

  await contributor.getByLabel(/Your member ID, identifier, phone or name/).fill("Resident One");
  await contributor.getByRole("button", { name: "Find me" }).click();
  await contributor.getByRole("button", { name: "Yes, this is me" }).click();

  // The period is named, because October's charge and November's are different
  // debts and a contributor must know which one they are settling.
  await expect(contributor.getByText(/01 Oct 2026 – 31 Oct 2026/)).toBeVisible();
  await expect(contributor.getByText("₦20,000").first()).toBeVisible();
  await expect(contributor.getByText("Awaiting contribution")).toBeVisible();

  await anonymous.close();
});

test("an open collection asks nobody to identify, and a closed one takes nothing", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-contrib");
  const communitySlug = await createCommunity(page, `E2E Open M7 ${Date.now()}`);

  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  // §15: a campaign opens on its story, not on a name-and-description form.
  await walkWizard(page, {
    flowKey: "fundraiser",
    intent: /^Fundraising/,
    fill: {
      story: async (p) => {
        await p.getByLabel("What are you raising money for?").fill("Building Fund M7");
      },
    },
  });

  await expect(page).toHaveURL(/\/collections\/building-fund-m7/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await publish(page);

  const anonymous = await browser.newContext();
  const contributor = await anonymous.newPage();
  await contributor.goto(`/${communitySlug}/building-fund-m7`);
  await contributor.waitForLoadState("networkidle");

  await expect(contributor.getByText("Open to anyone with this link.")).toBeVisible();
  await expect(contributor.getByRole("heading", { name: "Find yourself on the list" })).toBeHidden();

  await contributor.getByLabel("How much would you like to contribute?").fill("7500");
  await contributor.getByLabel("Full name").fill("Ada Obi");
  await contributor.getByLabel("Phone number").fill("+2348011110501");
  await contributor.getByRole("button", { name: "Continue" }).click();

  await expect(contributor.getByText("Ready to continue to payment")).toBeVisible();
  await expect(contributor.getByText("₦7,500").first()).toBeVisible();

  // Closing it takes the form away entirely — there is nothing to continue to.
  await page.getByRole("button", { name: "Close" }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByText("Closed", { exact: true })).toBeVisible();

  await contributor.goto(`/${communitySlug}/building-fund-m7`);
  await contributor.waitForLoadState("networkidle");
  await expect(contributor.getByText(/no longer accepting contributions/)).toBeVisible();
  await expect(contributor.getByRole("button", { name: "Continue" })).toBeHidden();

  await anonymous.close();
});
