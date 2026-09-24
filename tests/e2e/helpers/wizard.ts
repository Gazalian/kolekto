import { expect, type Page } from "@playwright/test";
import { flowFor, type StepKind } from "../../../apps/web/app/c/[slug]/collections/new/flows.ts";

/**
 * Walking the collection wizard, one flow at a time (M7.7 §33).
 *
 * ── WHY THIS IS DRIVEN BY THE APP'S OWN DATA ────────────────────────────────
 *
 * Before M7.7 every spec counted Continue clicks — `// cover image — skipped`,
 * `// who pays`, `// no questions` — because every collection walked the same
 * seven screens. That was already brittle (four specs sat one Continue short
 * of a step for a whole milestone and were red every run), and now that the
 * flows genuinely differ in length it would be unworkable.
 *
 * So this imports `FLOWS` — the same module the wizard renders from — and
 * walks whatever that flow says. A step added to a flow is walked by every
 * journey that uses it without a spec being touched, and a spec cannot drift
 * out of step with the product because there is only one list.
 *
 * That makes the helper's own assertions worth something too: it checks each
 * step's heading as it arrives, in order. A flow that silently reverted to a
 * shared sequence, or lost its vocabulary, fails here rather than passing
 * quietly.
 */

/** What to do on one step before continuing. Absent means "accept the defaults". */
export type StepFiller = (page: Page) => Promise<void>;

export interface WizardWalk {
  /** A key from FLOWS — "fixed", "open", "tiered", "items", "ticketing", "fundraiser", "recurring". */
  flowKey: string;
  /** The intent card to click, as its title reads on screen. */
  intent: RegExp;
  fill?: Partial<Record<StepKind, StepFiller>>;
  /** Stop before this step instead of finishing — for the drafts that are meant to be abandoned. */
  stopBefore?: StepKind;
}

const CONTINUE = { name: "Continue", exact: true } as const;

/** Opens the wizard from anywhere inside a community. */
export async function openWizard(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Collections" }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("link", { name: "New collection" }).click();
  await page.waitForLoadState("networkidle");
}

/**
 * Walks one flow from the intent picker to the end, filling what it is told
 * to fill.
 *
 * Leaves the browser on the draft's own page, which is where "Open this
 * draft" lands.
 */
export async function walkWizard(page: Page, walk: WizardWalk): Promise<void> {
  const flow = flowFor(walk.flowKey);

  await expect(page.getByRole("heading", { name: "What are you collecting for?" })).toBeVisible();
  await page.getByRole("button", { name: walk.intent }).click();

  for (const [index, step] of flow.steps.entries()) {
    if (walk.stopBefore && step.kind === walk.stopBefore) return;

    // The heading is the flow's own, in the flow's own words. Arriving at the
    // wrong one means the sequence has drifted.
    await expect(
      page.getByRole("heading", { name: step.heading, exact: true }),
      `${flow.key} step ${index + 1} should ask "${step.heading}"`,
    ).toBeVisible({ timeout: 45_000 });

    await walk.fill?.[step.kind]?.(page);

    if (step.kind === "review") {
      await page.getByRole("button", { name: "Open this draft" }).click();
      await page.waitForLoadState("networkidle");
      return;
    }

    await page.getByRole("button", CONTINUE).click();
  }
}

/** The progress line, e.g. "Step 3 of 9 · Fees". Asserted where a flow's shape is the point. */
export async function expectStep(page: Page, position: number, of: number, label: string): Promise<void> {
  await expect(page.getByText(`Step ${position} of ${of} · ${label}`)).toBeVisible({ timeout: 45_000 });
}

/** How long a flow is, including the intent picker — what the progress line counts. */
export function stepCount(flowKey: string): number {
  return flowFor(flowKey).steps.length + 1;
}

/** Fills a tier row (a package or a ticket type) by its position. */
export function fillTier(
  index: number,
  tier: { name: string; price: string; limit?: string; prefix?: string },
  vocabulary: "Package" | "Ticket type" | "Option" = "Option",
): StepFiller {
  return async (page) => {
    if (index > 0) await page.getByRole("button", { name: new RegExp(`Add another`) }).click();
    // Not `exact`: a required field's accessible name carries the asterisk
    // from its label, so the name here is "Price *", not "Price".
    const rows = page.getByRole("textbox", { name: `${vocabulary} name` });
    await rows.nth(index).fill(tier.name);
    await page.getByRole("textbox", { name: "Price" }).nth(index).fill(tier.price);
    if (tier.limit !== undefined) {
      const label = vocabulary === "Ticket type" ? "How many exist" : "Limit";
      await page.getByRole("textbox", { name: label }).nth(index).fill(tier.limit);
    }
    if (tier.prefix !== undefined) {
      await page.getByRole("textbox", { name: "Reference prefix" }).nth(index).fill(tier.prefix);
    }
  };
}

/** Turns on contributor references and sets the format. */
export function configureReferences(options: {
  prefix: string;
  digits?: string;
  startNumber?: string;
  style?: "sequential" | "random";
}): StepFiller {
  return async (page) => {
    await page.getByRole("checkbox", { name: /Give each/ }).check();
    await page.getByLabel("Prefix").fill(options.prefix);
    if (options.style) await page.getByLabel("Style").selectOption(options.style);
    if (options.digits) await page.getByLabel("Number of digits").fill(options.digits);
    if (options.startNumber) await page.getByLabel("Starting number").fill(options.startNumber);
  };
}

/** Chooses who bears the fees on the fee step. */
export function chooseFeeBearer(bearer: "Contributor pays" | "You absorb fees"): StepFiller {
  return async (page) => {
    await page.getByRole("radio", { name: bearer }).check();
  };
}
