import { expect, test, type Page } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * The Phase 3 golden path, in a real browser against the real local stack:
 *
 *   sign in → create a community → create a collection → assign a member
 *   → publish → open the public link with no session → contribute
 *
 * Phase 2's lesson, written into its own spec, was that a green typecheck and a
 * green build say nothing about whether the application runs. These tests exist
 * for the same reason and are the only evidence that this phase works.
 */

// These journeys are longer than Phase 2's (sign in, create a community, add a
// member, six creation steps, assign, publish, then a second browser context
// for the public page). The 60s default in playwright.config.ts was sized for
// the 8-step Phase 2 path; each server action here is a round trip through the
// direct Postgres connection plus a full RSC re-render, and the sum comfortably
// exceeds it on a machine also running the Supabase stack.
test.describe.configure({ timeout: 180_000 });

/** Returns the community's slug, which is also the first segment of every collection's public address. */
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

test("create a fixed collection, assign a member, publish it, and contribute from the public page", async ({
  page,
  browser,
}) => {
  await signInAsNewUser(page, "e2e-collections");
  const communitySlug = await createCommunity(page, `E2E Collections ${Date.now()}`);

  // A member to be expected to pay. Managed collections are the half of the
  // product that answers "who has not paid", so the member comes first.
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const memberDialog = page.getByRole("dialog");
  await memberDialog.getByLabel("Full name").fill("Chidi Eze");
  await memberDialog.getByLabel("Phone number").fill("+2348011112222");
  await memberDialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText("Chidi Eze")).toBeVisible();

  // ── Create ────────────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("No collections yet")).toBeVisible();

  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /Dues or a levy/ }).click();
  await page.getByLabel("What is this collection called?").fill("Departmental Dues 2026");
  await page.getByLabel("What is it for?").fill("Dues for the 2026 session.");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Amount each person pays").fill("5000");
  await page.getByRole("button", { name: "Continue" }).click();

  // Cover image — leaving Contribution is when the draft is actually created,
  // so the uploader has a real collection to attach to. Upload itself is
  // covered by collection-types.spec.ts's dedicated flyer test.
  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // Who pays — the dues preset picks the whole roll, which is what makes the
  // collection managed. (Until M5 this step was a "Who can pay" select; it is
  // now the audience picker, and this assertion was left behind.)
  await expect(page.getByRole("radio", { name: /Everyone on the roll/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();

  // Questions — one, so the public form has something beyond contact details.
  await page.getByRole("button", { name: "Add a question" }).click();
  await page.getByLabel("Question").fill("Matric number");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByText("Check this over")).toBeVisible();
  await page.getByRole("button", { name: "Open this draft" }).click();

  // Saving runs three server actions in sequence (create, then the questions,
  // then the navigation), so this one assertion gets a longer budget than the
  // 15s default rather than the whole suite getting one.
  await expect(page).toHaveURL(/\/collections\/departmental-dues-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();

  // A draft is not public. The address exists, but nothing is served at it.
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  const draftResponse = await anonymousPage.goto(`/${communitySlug}/departmental-dues-2026`);
  expect(draftResponse?.status()).toBe(404);

  // ── Assign ────────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("No members have been added to this collection yet")).toBeVisible();

  await page.getByRole("button", { name: "Add members" }).click();
  const assignDialog = page.getByRole("dialog");
  await assignDialog.getByRole("checkbox").first().check();
  await assignDialog.getByRole("button", { name: /Add 1 member/ }).click();

  await expect(page.getByRole("cell", { name: "₦5,000" })).toBeVisible();
  await expect(page.getByText("Not yet paid")).toBeVisible();

  // ── Publish ───────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Review and publish" }).click();
  const publishDialog = page.getByRole("dialog");
  await expect(publishDialog.getByText(`/${communitySlug}/departmental-dues-2026`)).toBeVisible();
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();

  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByText("Share this collection")).toBeVisible();

  // ── Contribute, with no account and no session ────────────────────────────
  await anonymousPage.goto(`/${communitySlug}/departmental-dues-2026`);
  await anonymousPage.waitForLoadState("networkidle");

  await expect(anonymousPage.getByRole("heading", { name: "Departmental Dues 2026" })).toBeVisible();
  await expect(anonymousPage.getByText("₦5,000").first()).toBeVisible();
  await expect(anonymousPage.getByText("Dues for the 2026 session.")).toBeVisible();

  // A managed collection asks a named list, so the contributor identifies
  // themselves before anything else (M7). Until they do, the form is not shown.
  await expect(anonymousPage.getByRole("heading", { name: "Find yourself on the list" })).toBeVisible();
  await anonymousPage.getByLabel(/Your member ID, identifier, phone or name/).fill("Chidi Eze");
  await anonymousPage.getByRole("button", { name: "Find me" }).click();
  await anonymousPage.getByRole("button", { name: "Yes, this is me" }).click();
  await expect(anonymousPage.getByText("Contributing as")).toBeVisible();

  // The collection's own question is asked, separately from contact details.
  await expect(anonymousPage.getByLabel("Matric number")).toBeVisible();

  await anonymousPage.getByRole("button", { name: "Continue" }).click();
  // Server-side validation: a contributor with no way to be reached is refused.
  await expect(anonymousPage.getByText(/email address or a phone number/i)).toBeVisible();

  await anonymousPage.getByLabel("Full name").fill("Ada Obi");
  await anonymousPage.getByLabel("Email address").fill("ada@example.test");
  await anonymousPage.getByLabel("Matric number").fill("CSC/2021/001");
  await anonymousPage.getByRole("button", { name: "Continue" }).click();

  await expect(anonymousPage.getByText(/Your details are checked, Ada Obi/)).toBeVisible();
  await expect(anonymousPage.getByText("₦5,000").first()).toBeVisible();
  // The honest confirmation: no receipt, no "payment successful".
  await expect(anonymousPage.getByText(/Nothing has been charged/)).toBeVisible();

  await anonymous.close();
});

test("a tiered collection prices a contribution from the option the contributor chose", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-collections");
  const communitySlug = await createCommunity(page, `E2E Tiers ${Date.now()}`);

  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  // "Options at different prices" rather than the ticketed preset: this test is
  // about pricing from the chosen option, and a ticketed collection would also
  // ask for a date and a venue (covered in collection-types.spec.ts).
  await page.getByRole("button", { name: /Options at different prices/ }).click();
  await page.getByLabel("What is this collection called?").fill("Alumni Dinner 2026");
  await page.getByRole("button", { name: "Continue" }).click();

  // Two options, deliberately priced far apart so the confirmation cannot pass
  // by accident: the 2026-08-06 incident charged the first option's price for
  // every selection.
  await page.getByLabel("Option name").first().fill("Standard");
  await page.getByLabel("Price").first().fill("5000");
  await page.getByRole("button", { name: "Add another option" }).click();
  await page.getByLabel("Option name").nth(1).fill("VIP");
  await page.getByLabel("Price").nth(1).fill("20000");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Add a flyer" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: "Continue" }).click(); // cover image — skipped
  await page.getByRole("button", { name: "Continue" }).click(); // who pays — open by default
  await page.getByRole("button", { name: "Continue" }).click(); // no extra questions
  await page.getByRole("button", { name: "Open this draft" }).click();

  await expect(page).toHaveURL(/\/collections\/alumni-dinner-2026/, { timeout: 45_000 });
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();

  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`/${communitySlug}/alumni-dinner-2026`);
  await anonymousPage.waitForLoadState("networkidle");

  await anonymousPage.getByRole("radio").nth(1).check(); // VIP
  await anonymousPage.getByLabel("Full name").fill("Ada Obi");
  await anonymousPage.getByLabel("Phone number").fill("+2348011112222");
  await anonymousPage.getByRole("button", { name: "Continue" }).click();

  await expect(anonymousPage.getByText("VIP")).toBeVisible();
  await expect(anonymousPage.getByText("₦20,000").first()).toBeVisible();

  await anonymous.close();
});
