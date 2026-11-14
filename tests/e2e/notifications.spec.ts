import { expect, type Page, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";
import {
  createForeignUser,
  readStateOf,
  resolveSeedContext,
  type SeedContext,
  seedForeignNotification,
  seedNotifications,
} from "./helpers/notifications.ts";

/**
 * Browser coverage for the in-app notification bell, panel and full page.
 *
 * The inbox is populated with the deterministic fixtures in
 * helpers/notifications.ts (the service-role seed that stands in for the
 * worker's INSERTs), never by waiting on the queue or the 15s poll. Each test
 * signs up its own user, so fixtures are isolated. Reading and mark-as-read
 * still go through the real browser client and the real `app.*` functions.
 *
 * The bell lives only inside the community shell (AppShell), so these tests
 * seed first, then open `/c/{slug}` — the provider's mount refresh shows the
 * seeded state immediately, with no sleep.
 */

/** The visible bell. Both the desktop (sidebar) and mobile (header) bells are in the DOM; only one is visible per viewport. */
function bell(page: Page) {
  return page.locator('button[aria-label^="Notifications"]:visible');
}

async function setUp(page: Page, prefix: string): Promise<SeedContext> {
  const email = await signInAsNewUser(page, prefix);
  return resolveSeedContext(email);
}

test("empty inbox, then an accurate unread count and a listed panel", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-count");

  // 3. Empty state first — a brand-new user has nothing.
  await page.goto(`/c/${ctx.communitySlug}`);
  await bell(page).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");

  // 1. Seed two unread; the badge and aria-label must reflect exactly two.
  await seedNotifications(ctx, [
    { eventType: "member.approve_join", payload: { community_slug: ctx.communitySlug }, createdAt: "2026-01-01T10:00:00Z" },
    {
      eventType: "collection.publish",
      payload: { community_slug: ctx.communitySlug, collection_name: "Annual Dues", collection_slug: "annual-dues" },
      createdAt: "2026-01-02T10:00:00Z",
    },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(2 unread\)/);

  // 2. Open the panel and see both items with their descriptions.
  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("[data-notification-item]")).toHaveCount(2);
  await expect(panel.getByText("Annual Dues is now live")).toBeVisible();
  await expect(panel.getByText("Your membership has been approved")).toBeVisible();
});

test("marks a single notification as read", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-one");
  // No community_slug → the item renders as a non-navigating button, so the
  // click marks read without leaving the page.
  const [deliveryId] = await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { collection_name: "Standalone" } },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(1 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await panel.locator("[data-notification-item]").first().click();

  // The badge clears and the server row is actually read — not a faked success.
  await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");
  await expect.poll(() => readStateOf(deliveryId!).then((r) => r.read)).toBe(true);
});

test("marks all notifications as read", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-all");
  const ids = await seedNotifications(ctx, [
    { eventType: "member.approve_join", payload: { community_slug: ctx.communitySlug } },
    { eventType: "member.join_via_invite", payload: { community_slug: ctx.communitySlug, member_name: "Ada" } },
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Dues" } },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(3 unread\)/);

  await bell(page).click();
  await page.getByRole("button", { name: /Mark all read/ }).click();

  await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");
  for (const id of ids) {
    await expect.poll(() => readStateOf(id).then((r) => r.read)).toBe(true);
  }
});

test("navigates from a notification to its destination", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-nav");
  await seedNotifications(ctx, [
    { eventType: "member.approve_join", payload: { community_slug: ctx.communitySlug } },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await panel.locator("[data-notification-item]").first().click();

  await page.waitForURL(new RegExp(`/c/${ctx.communitySlug}/members`));
  await expect(page).toHaveURL(new RegExp(`/c/${ctx.communitySlug}/members`));
});

test("full page shows an error and recovers on retry", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-error");

  // Force the inbox reads to fail. The page must show an honest error with a
  // retry, never an empty "all caught up".
  await page.route("**/rest/v1/notification_deliveries**", (route) => route.abort());
  await page.goto("/notifications");
  await expect(page.getByText("We couldn't load your notifications")).toBeVisible();

  // Recover: let the reads through and retry.
  await page.unroute("**/rest/v1/notification_deliveries**");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("No notifications yet")).toBeVisible();

  // Sanity: seeding then reloading the full page shows the item.
  await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Recovered" } },
  ]);
  await page.reload();
  await expect(page.getByText("Recovered is now live")).toBeVisible();
});

test("panel stays on screen when the bell sits bottom-left (sidebar) and closes cleanly", async ({ page }) => {
  // The sidebar bell renders at the bottom-left of the viewport inside a wide
  // relative wrapper; the previous `absolute right-0 top-full` placement sent
  // the panel ~140px off the left and past the viewport bottom. The fix is
  // viewport-fixed positioning with a vertical flip when below runs out of
  // room (NotificationBell.computePanelCoords).
  const ctx = await setUp(page, "e2e-notif-layout");
  await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Layout Dues" } },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(1 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toBeVisible();

  // The panel must sit inside the viewport on every edge.
  const geom = await page.evaluate(() => {
    const p = document.querySelector('[role="region"][aria-label="Notifications"]') as HTMLElement | null;
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  expect(geom, "panel not rendered").not.toBeNull();
  expect(geom!.x, "panel left edge off-screen").toBeGreaterThanOrEqual(0);
  expect(geom!.right, "panel right edge off-screen").toBeLessThanOrEqual(geom!.vw);
  expect(geom!.y, "panel top above viewport").toBeGreaterThanOrEqual(0);
  expect(geom!.bottom, "panel bottom below viewport").toBeLessThanOrEqual(geom!.vh);

  // Pressing Escape closes it and returns focus to the bell.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(bell(page)).toBeFocused();

  // Opening then clicking outside also closes.
  await bell(page).click();
  await expect(panel).toBeVisible();
  await page.locator("main").first().click({ position: { x: 50, y: 50 } });
  await expect(panel).toHaveCount(0);
});

test("mobile: the bell and panel work at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ctx = await setUp(page, "e2e-notif-mobile");
  await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Mobile Dues" } },
  ]);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(1 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Mobile Dues is now live")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow at 390px").toBeLessThanOrEqual(1);
});

// ─── AuthenticatedTopBar coverage ────────────────────────────────────────────
// The three authenticated pages outside the community shell (/communities,
// /account, /notifications) mount an `AuthenticatedTopBar` with its own
// `NotificationProvider` + `NotificationBell`. The specs below prove the bell
// is actually rendered on each of those pages, reflects the seeded unread count,
// and opens the panel — the gap that made notifications invisible to a signed-in
// user who had not yet clicked into a specific community.

test("the bell is visible on /communities (outside the community shell)", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-communities");
  await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Communities Page Item" } },
  ]);

  await page.goto("/communities");
  await expect(bell(page)).toHaveAttribute("aria-label", /\(1 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Communities Page Item is now live")).toBeVisible();
});

test("the bell is visible on /account", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-account");
  await seedNotifications(ctx, [
    { eventType: "member.approve_join", payload: { community_slug: ctx.communitySlug } },
  ]);

  await page.goto("/account");
  await expect(bell(page)).toHaveAttribute("aria-label", /\(1 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Your membership has been approved")).toBeVisible();
});

test("the bell is visible on /notifications and does not duplicate the inbox count", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-notifications-page");
  await seedNotifications(ctx, [
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Page Item A" } },
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Page Item B" } },
  ]);

  await page.goto("/notifications");

  // The top bar bell and the page's own header both agree there are two unread —
  // but the page lists the items only once, not duplicated by the bar's provider.
  await expect(bell(page)).toHaveAttribute("aria-label", /\(2 unread\)/);
  await expect(page.getByText("2 unread")).toBeVisible();
  await expect(page.locator("[data-notification-item]")).toHaveCount(2);
});

test("the inbox is scoped to the recipient, not the community", async ({ page }) => {
  const ctx = await setUp(page, "e2e-notif-isolation");

  // Two notifications for the signed-in user …
  await seedNotifications(ctx, [
    { eventType: "member.approve_join", payload: { community_slug: ctx.communitySlug } },
    { eventType: "collection.publish", payload: { community_slug: ctx.communitySlug, collection_name: "Mine" } },
  ]);
  // … and one in the SAME community addressed to someone else. The officer RLS
  // policy would expose it community-wide, so a correctly scoped bell must not
  // show it (QA BUG-2).
  const foreignUserId = await createForeignUser();
  await seedForeignNotification(ctx, foreignUserId);

  await page.goto(`/c/${ctx.communitySlug}`);
  await expect(bell(page)).toHaveAttribute("aria-label", /\(2 unread\)/);

  await bell(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await expect(panel.locator("[data-notification-item]")).toHaveCount(2);
  await expect(panel.getByText("Private to someone else")).toHaveCount(0);
});
