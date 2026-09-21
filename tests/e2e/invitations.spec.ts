import { expect, test } from "@playwright/test";
import { signInAsNewUser } from "./helpers/auth.ts";

/**
 * Self-onboarding, end to end (§23): an officer builds a link that knows what
 * their community needs to ask, and someone with no account joins through it
 * and is told the member ID they now hold.
 *
 * The second browser context matters: the joiner is a different person on a
 * different device with no session, which is the whole point of MEM-05.
 */

test.describe.configure({ timeout: 180_000 });

test("invite with preset group and required field, then join as a stranger", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-invite");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  const communityName = `E2E Invites ${Date.now()}`;
  await page.getByLabel("Community name").fill(communityName);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  // ── What this community records, and how it divides people ────────────────
  await page.getByRole("button", { name: "Member profile" }).click();
  await page.getByLabel("Prefix").fill("MIC/");
  await page.getByRole("button", { name: "Save ID format" }).click();
  await expect(page.getByText("Member ID format saved.")).toBeVisible();
  await page.getByRole("button", { name: "Add field" }).click();
  await page.getByLabel("Label").fill("Matric number");
  await page.getByLabel("This field identifies a member").check();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await expect(page.getByText("Field saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Name").fill("300 Level");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group saved.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForLoadState("networkidle");

  // ── The link: preset group, and the matric number required ────────────────
  await page.getByRole("button", { name: "Invite link" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label").fill("Join 300 Level");
  await dialog.locator("label", { hasText: "300 Level" }).getByRole("checkbox").check();
  await dialog.locator("label", { hasText: "Matric number" }).getByRole("checkbox").check();
  await dialog.getByRole("checkbox", { name: "required" }).check();
  await dialog.getByRole("button", { name: "Create link" }).click();

  await expect(page.getByText("shown only once")).toBeVisible();
  // By role: "Invite link" is both the dialog's title and the field's label.
  const inviteUrl = await page.getByRole("textbox", { name: "Invite link" }).inputValue();
  expect(inviteUrl).toContain("/invite/");

  // ── A stranger opens it ───────────────────────────────────────────────────
  const stranger = await browser.newContext();
  const joinPage = await stranger.newPage();
  await joinPage.goto(inviteUrl);
  await joinPage.waitForLoadState("networkidle");

  // The page introduces the community and says where they will land.
  await expect(joinPage.getByRole("heading", { name: communityName })).toBeVisible();
  await expect(joinPage.getByText("You will be added to 300 Level.")).toBeVisible();
  await expect(joinPage.getByText(/does not create a Kolekto account/)).toBeVisible();

  // The community's own field is asked for, because the link says so.
  await joinPage.getByLabel("Full name").fill("Ngozi Stranger");
  await joinPage.getByLabel("Phone number").fill("+2348062220001");
  await joinPage.getByLabel("Matric number").fill("21/SCI/456");
  await joinPage.getByRole("button", { name: "Join" }).click();

  // And they are told who they now are.
  await expect(joinPage.getByText(`Welcome to ${communityName}`)).toBeVisible();
  await expect(joinPage.getByText("MIC/0001")).toBeVisible();

  await stranger.close();

  // ── The officer sees them on the roster, in the group, with the answer ────
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Scoped to their row: "300 Level" also appears in the group filter, and an
  // assertion that cannot say which one it found is not an assertion.
  const row = page.getByRole("row", { name: /Ngozi Stranger/ });
  await expect(row).toContainText("MIC/0001");
  await expect(row).toContainText("21/SCI/456");
  await expect(row).toContainText("300 Level");
});

test("a joiner chooses their own group, and only the groups the link offers", async ({ page, browser }) => {
  await signInAsNewUser(page, "e2e-invite-groups");

  await page.getByRole("link", { name: "+ New community" }).click();
  await page.waitForLoadState("networkidle");
  const communityName = `E2E Group Choice ${Date.now()}`;
  await page.getByLabel("Community name").fill(communityName);
  await page.getByLabel("Type").selectOption("university_association");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page).toHaveURL(/\/c\//);

  await page.getByRole("link", { name: "Members" }).click();
  await page.waitForLoadState("networkidle");

  // Three levels a joiner may pick from, and one group they may not: the
  // difference is "People joining by invite link can put themselves in this
  // group", which is the officer's decision, not the joiner's (§9).
  await page.getByRole("button", { name: "Groups" }).click();
  for (const [name, pickable] of [
    ["100 Level", true],
    ["200 Level", true],
    ["Executive", false],
  ] as const) {
    await page.getByRole("button", { name: "New group" }).click();
    const groupDialog = page.getByRole("dialog");
    await groupDialog.getByLabel("Name").fill(name);
    if (pickable) {
      await groupDialog.getByLabel("People joining by invite link can put themselves in this group").check();
    }
    await groupDialog.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText("Group saved.")).toBeVisible();
  }
  await page.getByRole("button", { name: "Close" }).click();
  await page.waitForLoadState("networkidle");

  // A link that lets joiners choose, one group only.
  await page.getByRole("button", { name: "Invite link" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Label").fill("Choose your level");
  await dialog.getByRole("checkbox", { name: "Let joiners pick a group themselves" }).check();
  await dialog.getByRole("button", { name: "Create link" }).click();

  await expect(page.getByText("shown only once")).toBeVisible();
  const inviteUrl = await page.getByRole("textbox", { name: "Invite link" }).inputValue();
  await page.getByRole("button", { name: "Close" }).click();

  // ── The joiner: a different person, a different device, no session ───────
  const stranger = await browser.newContext();
  const joinPage = await stranger.newPage();
  await joinPage.goto(inviteUrl);
  await joinPage.waitForLoadState("networkidle");

  await expect(joinPage.getByText("Which group suits you?")).toBeVisible();
  await expect(joinPage.getByRole("radio", { name: "100 Level" })).toBeVisible();
  await expect(joinPage.getByRole("radio", { name: "200 Level" })).toBeVisible();
  // The group the officer did not open to joiners is not offered at all — the
  // page never learns it exists.
  await expect(joinPage.getByText("Executive")).toHaveCount(0);

  await joinPage.getByRole("radio", { name: "200 Level" }).check();
  await joinPage.getByLabel("Full name").fill("Tunde Chooser");
  await joinPage.getByLabel("Phone number").fill("+2348062220099");
  await joinPage.getByRole("button", { name: "Join" }).click();

  await expect(joinPage.getByText(`Welcome to ${communityName}`)).toBeVisible();
  await stranger.close();

  // ── The officer sees them in the group they chose, and no other ──────────
  await page.reload();
  await page.waitForLoadState("networkidle");
  const row = page.getByRole("row", { name: /Tunde Chooser/ });
  await expect(row).toContainText("200 Level");
  await expect(row).not.toContainText("100 Level");
});
