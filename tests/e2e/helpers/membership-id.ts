import { expect, type Page } from "@playwright/test";

/**
 * Membership IDs in a real browser (M9b officer side, A2.5 contributor side).
 *
 * A managed collection identifies a contributor by the private membership ID
 * an officer issued them, never by name or phone. These helpers do what an
 * officer and a member would: turn IDs on, issue one, read it off the member's
 * page, and type it into the public collection page.
 *
 * The ID is returned to the test, never logged: the specs pass it straight to
 * `fill` and assert on what the page shows instead.
 */

/** The ID the generic "not recognised" message is shown for, whatever the reason. */
export const INVALID_MEMBERSHIP_ID_MESSAGE = "We couldn't find a member with this ID. Please check and try again.";

/** Turns membership IDs on for the community with the given prefix (2–10 letters or numbers, starting with a letter). */
export async function enableMembershipIds(page: Page, communitySlug: string, prefix: string): Promise<void> {
  await page.goto(`/c/${communitySlug}/settings`);
  await page.waitForLoadState("networkidle");

  const card = page.locator("section", { has: page.getByRole("heading", { name: "Membership IDs" }) });
  await card.getByLabel("Prefix").fill(prefix);
  await card.getByRole("checkbox", { name: "Membership IDs are on for this community" }).check();
  await card.getByRole("button", { name: "Save format" }).click();
  await expect(card.getByText(/^Saved\. New IDs use this format/)).toBeVisible();
}

/**
 * Issues a membership ID to one member from their own page and returns it.
 *
 * `row` picks the member on the roll by any text in their row — a name when it
 * is unique, an identifier when two people share a name.
 */
export async function issueMembershipId(page: Page, communitySlug: string, row: string): Promise<string> {
  await page.goto(`/c/${communitySlug}/members`);
  await page.waitForLoadState("networkidle");
  // The row's link to the member's own page (the Name column), not any other link in the row.
  await page.locator("tr").filter({ hasText: row }).locator(`a[href^="/c/${communitySlug}/members/"]`).click();
  await expect(page).toHaveURL(new RegExp(`/c/${communitySlug}/members/[0-9a-f-]{36}`));
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Issue membership ID" }).click();
  const shown = page.getByTestId("membership-id");
  await expect(shown).toBeVisible();
  const id = (await shown.textContent())?.trim() ?? "";
  if (!/^[A-Z][A-Z0-9]{1,9}[/-][0-9A-Z]{5,8}$/.test(id)) throw new Error("issued membership ID was not in the expected format");
  return id;
}

/** Screen 1 → Screen 2: types the ID and waits for "Are these your details?". */
export async function enterMembershipId(page: Page, id: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Identify yourself" })).toBeVisible();
  await page.getByLabel("Membership ID").fill(id);
  // Typing clears the previous attempt's message, so whatever appears next
  // answers this attempt and not the last one.
  await expect(page.getByText(INVALID_MEMBERSHIP_ID_MESSAGE)).toBeHidden();
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Screen 1 → Screen 3: enters the ID, answers "Yes, continue", and waits for the form. */
export async function identifyWithMembershipId(page: Page, id: string): Promise<void> {
  await enterMembershipId(page, id);
  await expect(page.getByRole("heading", { name: "Are these your details?" })).toBeVisible();
  await page.getByRole("button", { name: "Yes, continue" }).click();
  await expect(page.getByText("Contributing as")).toBeVisible();
}
