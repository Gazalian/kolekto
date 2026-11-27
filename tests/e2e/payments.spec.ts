import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  attemptState,
  expectPaymentReview,
  FLOW_NAMES,
  type FlowName,
  nairaTextToKobo,
  type ReviewFigures,
  type SeededFlow,
  seedPaymentFlow,
} from "./helpers/payments.ts";
import { identifyWithMembershipId } from "./helpers/membership-id.ts";

/**
 * M8.5 acceptance: every collection flow can be paid end to end in a browser,
 * signed out, through the local fake checkout page (KOLEKTO_ENV=local only).
 *
 *   public page → order → Continue → fee review → Pay ₦… → fake checkout →
 *   "Pay successfully" → callback "Payment Successful"
 *
 * and the database agrees: one completed attempt, exactly one contribution
 * with the frozen amounts, stock converted, the obligation paid, the attendee
 * names kept. A reload of the callback must not record a second contribution.
 * Declined and cancelled payments must leave no contribution and give their
 * stock back.
 *
 * The collections are seeded (helpers/payments.ts) from the same fixtures as
 * the worker's payments-orchestrator integration test, so the amounts below
 * are that file's: fixed ₦5,000, open ₦2,500, tiered ₦3,000, items
 * 2 × Cap + 1 × Scarf = ₦3,800, ticketing VIP + 2 × Regular = ₦9,000,
 * fundraiser ₦4,000, recurring ₦2,000.
 */

const CONTRIBUTOR = { name: "Ngozi Payer", email: "ngozi.payer@example.test", phone: "+2348011113333" };

type Order = (page: Page, seeded: SeededFlow) => Promise<void>;

/** A managed collection asks who is paying, by membership ID, before it shows the form. */
const identifyAsAda: Order = async (page, seeded) => {
  if (!seeded.membershipId) throw new Error("a managed flow was seeded without a membership ID");
  await identifyWithMembershipId(page, seeded.membershipId);
};

const giveAmount =
  (naira: string): Order =>
  async (page) => {
    await page.getByLabel("How much would you like to contribute?").fill(naira);
  };

/** What each flow's contributor does on the form, matching the fixture's resolved order. */
const ORDER: Record<FlowName, Order> = {
  fixed: identifyAsAda,
  recurring: identifyAsAda,
  open: giveAmount("2500"),
  fundraiser: giveAmount("4000"),
  tiered: async (page) => {
    await page.getByRole("radio", { name: /Supporter/ }).check();
  },
  items: async (page) => {
    await page.getByRole("checkbox", { name: /Cap/ }).check();
    await page.getByLabel("How many Cap?").fill("2");
    await page.getByRole("checkbox", { name: /Scarf/ }).check();
  },
  ticketing: async (page) => {
    await page.getByRole("checkbox", { name: /VIP/ }).check();
    await page.getByRole("checkbox", { name: /Regular/ }).check();
    await page.getByLabel("How many Regular?").fill("2");
    // One name per ticket, in the order the fixture expects.
    await page.getByLabel("VIP — attendee 1").fill("Ada Guest");
    await page.getByLabel("Regular — attendee 1").fill("Bola Guest");
    await page.getByLabel("Regular — attendee 2").fill("Chidi Guest");
  },
};

const naira = (kobo: bigint): string => `₦${(kobo / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

interface AtCheckout {
  page: Page;
  seeded: SeededFlow;
  review: ReviewFigures;
  reference: string;
  close: () => Promise<void>;
}

/** Signed out: order, review, Pay, and arrive on the fake checkout page with an initialized attempt holding its stock. */
async function orderAndOpenCheckout(browser: Browser, name: FlowName): Promise<AtCheckout> {
  const seeded = await seedPaymentFlow(name);
  const { flow } = seeded;
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(seeded.path);
  await page.waitForLoadState("networkidle");
  await ORDER[name](page, seeded);
  await page.getByLabel("Full name").fill(CONTRIBUTOR.name);
  await page.getByLabel("Email address").fill(CONTRIBUTOR.email);
  await page.getByLabel("Phone number").fill(CONTRIBUTOR.phone);
  await page.getByRole("button", { name: "Continue" }).click();

  const review = await expectPaymentReview(page, {
    contributorName: CONTRIBUTOR.name,
    contribution: naira(flow.resolved.amountKobo),
  });
  expect(review.processingFee !== null, "fee rows show exactly when the contributor pays the fees").toBe(
    flow.feeBearer === "contributor",
  );

  await page.getByRole("button", { name: `Pay ${review.total}`, exact: true }).click();
  await expect(page).toHaveURL(/\/payment\/fake-checkout\?reference=KLK-[0-9A-Z]{26}$/);
  const reference = new URL(page.url()).searchParams.get("reference")!;
  await expect(page.getByText(`Reference ${reference}`)).toBeVisible();

  // The page showed the attempt's frozen figures, and the attempt holds its stock until paid.
  const attempt = await attemptState(reference);
  expect(attempt.status).toBe("initialized");
  expect(attempt.contributionKobo).toBe(flow.resolved.amountKobo);
  expect(attempt.amountKobo).toBe(nairaTextToKobo(review.total));
  expect(attempt.feeBearer).toBe(flow.feeBearer === "contributor" ? "contributor_pays" : "community_absorbs");
  if (review.processingFee !== null && review.kolektoFee !== null) {
    expect(attempt.totalFeesKobo).toBe(nairaTextToKobo(review.processingFee) + nairaTextToKobo(review.kolektoFee));
  }
  expect(attempt.obligationId).toBe(flow.obligationId);
  expect(attempt.contributions).toHaveLength(0);
  const limitedUnits = flow.limitedLines.reduce((sum, line) => sum + line.quantity, 0);
  expect(attempt.stock).toEqual(limitedUnits > 0 ? { reserved: limitedUnits } : {});

  return { page, seeded, review, reference, close: () => context.close() };
}

// A managed flow now identifies by membership ID first (validate, summary,
// confirm: three more round trips). On the 4-CPU itest machine the fixed flow
// reached the fake checkout page with the 60s default and ran out there.
test.describe.configure({ timeout: 120_000 });

for (const name of FLOW_NAMES) {
  test(`${name}: a signed-out contributor pays through the fake checkout, and exactly one contribution is recorded`, async ({
    browser,
  }) => {
    const { page, seeded, review, reference, close } = await orderAndOpenCheckout(browser, name);
    const { flow } = seeded;

    await page.getByRole("button", { name: "Pay successfully" }).click();
    await expect(page).toHaveURL(new RegExp(`/payment/callback\\?(trxref=${reference}&)?reference=${reference}$`));
    await expect(page.getByRole("heading", { name: "Payment Successful" })).toBeVisible();

    // The receipt shows on the page and downloads as a PDF (20261116100000).
    await expect(page.getByText(reference, { exact: true })).toBeVisible();
    const download = page.getByRole("link", { name: "Download receipt (PDF)" });
    await expect(download).toBeVisible();
    const pdf = await page.request.get((await download.getAttribute("href"))!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

    const paid = await attemptState(reference);
    expect(paid.status).toBe("completed");
    expect(paid.contributions).toHaveLength(1);
    const [contribution] = paid.contributions;
    expect(contribution!.contributionKobo).toBe(flow.resolved.amountKobo);
    expect(contribution!.totalChargedKobo).toBe(nairaTextToKobo(review.total));
    expect(contribution!.memberId).toBe(flow.memberId);
    expect(paid.contributionLines).toBe(flow.resolved.lines?.length ?? flow.resolved.itemLines?.length ?? (flow.resolved.tierId ? 1 : 0));
    const limitedUnits = flow.limitedLines.reduce((sum, line) => sum + line.quantity, 0);
    expect(paid.stock).toEqual(limitedUnits > 0 ? { converted: limitedUnits } : {});
    expect(paid.obligationStatus).toBe(flow.obligationId ? "paid" : null);
    expect(paid.attendeeNames).toEqual(flow.attendeeNames);

    // Coming back to the callback (a refresh, a second tab) confirms the same payment, never a second one.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Payment Successful" })).toBeVisible();
    const again = await attemptState(reference);
    expect(again.contributions.map((c) => c.id)).toEqual([contribution!.id]);

    await close();
  });
}

test("a declined card records no contribution and gives the stock back", async ({ browser }) => {
  const { page, reference, close } = await orderAndOpenCheckout(browser, "items");

  await page.getByRole("button", { name: "Card declined" }).click();
  await expect(page).toHaveURL(new RegExp(`/payment/callback\\?(trxref=${reference}&)?reference=${reference}$`));
  await expect(page.getByRole("heading", { name: "Payment Failed" })).toBeVisible();
  await expect(page.getByText("Your payment was not successful. Please try again.")).toBeVisible();

  const state = await attemptState(reference);
  expect(state.status).toBe("failed");
  expect(state.contributions).toHaveLength(0);
  expect(state.stock).toEqual({ released: 2 });

  await close();
});

test("a cancelled payment records no contribution and stays pending during its hold", async ({ browser }) => {
  const { page, reference, close } = await orderAndOpenCheckout(browser, "items");

  await page.getByRole("button", { name: "Cancel payment" }).click();
  await expect(page).toHaveURL(new RegExp(`/payment/callback\\?(trxref=${reference}&)?reference=${reference}$`));
  // Abandoned inside the 30-minute hold is pending, not failed (20261114110000):
  // the payer may still finish. The sweep marks it abandoned after the hold.
  await expect(page.getByRole("heading", { name: "Payment Pending" })).toBeVisible();

  const state = await attemptState(reference);
  expect(state.status).toBe("initialized");
  expect(state.contributions).toHaveLength(0);
  expect(state.stock).toEqual({ reserved: 2 });

  await close();
});
