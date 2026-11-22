import type { Page } from "@playwright/test";

/**
 * Navigating a collection's detail page after the four-money-figures redesign.
 *
 * The page has three sections (Overview, the people section, Activity) and a
 * Settings screen toggled from the header that replaces the sections while it
 * is open. Inside the people section a row of tabs picks the view: "Who has
 * paid", "Payments", "Manage <roll>", "Check-in", "Export". The roll — where
 * "Add members" and the obligations live — is no longer what the section
 * shows first, so a spec that wants it has to ask for it.
 */

/**
 * The people section's name: "Members" on dues, "Attendees" at an event,
 * "Orders" on an item collection (the roll's own label).
 */
export type PeopleSection = "Members" | "Attendees" | "Orders";

/** Leave the Settings screen if it is open, so the section navigation is back. */
export async function closeSettings(page: Page): Promise<void> {
  const back = page.getByRole("button", { name: "← Back to the collection" });
  if (await back.isVisible()) await back.click();
}

/** Open one of the people section's views. */
export async function openPeopleView(page: Page, section: PeopleSection, view: string): Promise<void> {
  await closeSettings(page);
  await page.getByRole("navigation", { name: "Collection sections" }).getByRole("button", { name: section, exact: true }).click();
  await page.getByRole("tablist", { name: `${section} views` }).getByRole("tab", { name: view, exact: true }).click();
}

/** Open the roll: who is expected to pay, with "Add members" and the obligations. */
export async function openRoll(page: Page, section: PeopleSection = "Members"): Promise<void> {
  await openPeopleView(page, section, `Manage ${section.toLowerCase()}`);
}

/**
 * An event start safely in the future, as the wizard's datetime-local input
 * takes it. A hard-coded date turns into a past date as the calendar moves,
 * and a published collection whose deadline has passed cannot be published.
 */
export function futureEventStart(daysAhead = 60, time = "18:00"): { input: string; date: string; time: string } {
  const day = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const date = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
  return { input: `${date}T${time}`, date, time };
}
