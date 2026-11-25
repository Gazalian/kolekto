import type { Locator, Page } from "@playwright/test";

/**
 * A link in the community's sidebar navigation (AppShell's `<aside>` → `<nav>`).
 *
 * The overview page also offers "Members" and "New collection" as shortcuts
 * and cards. Those are deliberate, so a bare `getByRole("link", { name })`
 * matches several. Scoping to the sidebar names the element the test means
 * rather than picking whichever comes first; if the sidebar itself ever
 * grows a duplicate, strict mode still fails.
 */
export function sidebarLink(page: Page, name: string): Locator {
  return page.getByRole("complementary").getByRole("navigation").getByRole("link", { name, exact: true });
}
