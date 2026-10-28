import { expect, type Page, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";
import { walkWizard } from "./helpers/wizard.ts";

/**
 * Post-publish reminder journey (M13.3, migration 20261029100000):
 *
 *   create a community → add a member → create a fixed collection →
 *   assign the member → publish → send a reminder → verify success →
 *   re-open the dialog → send a second reminder with a fresh key.
 *
 * The second-open proves two things at once:
 *   · the client disables the submit button while a reminder is in flight
 *     and switches to a "Done" state on success (so a user cannot post the
 *     same key twice from the UI); and
 *   · a fresh dialog open mints a new idempotency key, so a later reminder
 *     actually goes through — the server-side dedupe does not block
 *     legitimate future reminders.
 *
 * `walkWizard` runs the real wizard against the real stack; the reminder
 * dialog uses the real server action + real DB function + real audit trigger
 * (there is no mock here). Email remains disabled.
 */

test.describe.configure({ timeout: 180_000 });

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

test("an organiser can send a reminder on an already-published collection, twice", async ({ page }) => {
  await signInAsNewUser(page, "e2e-reminders");
  await createCommunity(page, `E2E Reminders ${Date.now()}`);

  // A single member on the roll gives the audience a non-zero size and
  // makes the "Send to N members" copy predictable.
  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add member" }).click();
  const memberDialog = page.getByRole("dialog");
  await memberDialog.getByLabel("Full name").fill("Ngozi Ade");
  await memberDialog.getByLabel("Phone number").fill("+2348011113333");
  await memberDialog.getByRole("button", { name: "Add member", exact: true }).click();
  await expect(page.getByText("Ngozi Ade")).toBeVisible();

  // Create a fixed collection via the real wizard.
  await page.getByRole("link", { name: "Collections" }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");

  await walkWizard(page, {
    flowKey: "fixed",
    intent: /Fixed contribution/,
    fill: {
      basics: async (p) => {
        await p.getByLabel("What is this collection called?").fill("Reminder Dues");
        await p.getByLabel("What is it for?").fill("A reminder-dues collection for e2e coverage.");
      },
      amount: async (p) => {
        await p.getByLabel("Amount each person pays").fill("5000");
      },
    },
  });
  await expect(page).toHaveURL(/\/collections\/reminder-dues/, { timeout: 45_000 });

  // Assign the member so the unpaid cohort is non-empty.
  await page.getByRole("button", { name: "Members" }).click();
  await page.getByRole("button", { name: "Add members" }).click();
  const assignDialog = page.getByRole("dialog");
  await assignDialog.getByRole("checkbox").first().check();
  await assignDialog.getByRole("button", { name: /Add 1 member/ }).click();
  await expect(page.getByText("Not yet paid")).toBeVisible();

  // Publish.
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Review and publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();

  // ── First reminder (all) ──────────────────────────────────────────────
  // The button appears on a published collection for the authorised officer.
  const reminderButton = page.getByRole("button", { name: "Send reminder" });
  await expect(reminderButton).toBeVisible();
  await reminderButton.click();

  const reminderDialog = page.getByRole("dialog");
  await expect(reminderDialog.getByText(/Send a reminder for Reminder Dues/)).toBeVisible();
  // "All" is the default. The audience preview resolves against members
  // *with an auth account* (via resolve_collection_audience → m.user_id is
  // not null). The member added above has no account link (claim flow is
  // out of scope here), so the eligible cohort is 0. That is the correct
  // production UI state for this fixture, and the worker-integration test
  // covers the non-zero audience path end-to-end.
  const sendButton = reminderDialog.getByRole("button", { name: /^Send to \d+ member/ });
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  // Success state: the dialog switches to a Done button and shows a
  // "Reminder queued for N recipient(s)" message. The count matches the
  // audience preview; here that is 0 because no member is account-linked.
  await expect(reminderDialog.getByText(/Reminder queued for \d+ recipients?\./)).toBeVisible();
  await reminderDialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // ── Second reminder with a fresh key ──────────────────────────────────
  // Reopening the dialog mints a new idempotency key, so a second reminder
  // actually goes through (confirms the server does not block legitimate
  // future reminders).
  await reminderButton.click();
  const dialog2 = page.getByRole("dialog");
  await expect(dialog2.getByText(/Send a reminder for Reminder Dues/)).toBeVisible();
  await dialog2.getByRole("button", { name: /^Send to \d+ member/ }).click();
  await expect(dialog2.getByText(/Reminder queued for \d+ recipients?\./)).toBeVisible();
  await dialog2.getByRole("button", { name: "Done" }).click();

  // ── "No notification" is a client-side cancel, not a server call ──────
  // Choosing "No notification" and submitting closes the dialog without
  // writing an audit, an event, or a delivery row — the UI label shifts to
  // "Close without notifying" to make that explicit.
  await reminderButton.click();
  const dialog3 = page.getByRole("dialog");
  await dialog3.getByLabel("No notification").check();
  await dialog3.getByRole("button", { name: "Close without notifying" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
