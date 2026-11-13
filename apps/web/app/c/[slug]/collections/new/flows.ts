import { formatAmountDisplay } from "@kolekto/domain";

/**
 * What each kind of collection asks, in what order, and in whose words.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Until M7.7 the wizard had seven fixed positions and one body per position.
 * Each kind of collection could rename its steps and hide a field, and that is
 * all. An organiser selling tickets and an organiser collecting estate dues
 * walked the same seven screens in the same order, which is why the product
 * felt like one form with a costume on.
 *
 * The fix is not more renaming. A flow is now an **ordered list of step
 * kinds**, and the renderer renders by kind. A ticketed event opens on the
 * event itself — name, date, venue and flyer together, because that is what an
 * organiser has in their head — and never sees a step called "Contribution".
 * A fundraiser opens on its story. A recurring plan has no closing date at
 * all, because a plan that repeats does not close.
 *
 * The lengths differ, the kinds differ, the order differs and the vocabulary
 * differs. What is shared is the machinery underneath: the same editors, the
 * same server actions, the same draft persistence, the same collection row.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 *
 * No new collection type. These are the seven the schema already expresses
 * through its four configuration axes (ADR 0013: there is no type column). A
 * flow is a preset over those axes plus the questions only that preset needs.
 */

export type AmountModelKey = "fixed" | "open_amount" | "tiers" | "per_member" | "items";

/**
 * One block of questions — the unit that is rendered, validated and saved.
 *
 * A step shows one or more sections. Until the 2026-11 redesign every section
 * was its own screen, which is how a flow came to be ten screens long with
 * several holding a single optional control. Sections that answer one
 * question together now share a screen: the price beside who bears the fees
 * on it, who can pay beside until when, the image beside the name.
 *
 * `purpose` is the type picker and belongs to no flow. It is shown before the
 * steps and is not counted as one.
 */
export type SectionKind =
  | "purpose"
  | "basics" // name, description — a collection, a campaign, a plan
  | "event" // ticketing only: name, description, the flyer, date, venue
  | "story" // fundraising only: title, the image, what, why, what it funds
  | "cover" // the collection's image, beside its name
  | "amount" // one price everyone pays
  | "openAmount" // a range and some suggestions
  | "goal" // a target, and what to suggest
  | "packages" // tiers, in the language of packages
  | "tickets" // tiers, in the language of tickets, with per-ticket prefixes
  | "items" // a catalogue, each item with its own image
  | "purchaseRules" // whose names are needed per ticket
  | "schedule" // how often a recurring plan charges
  | "fees" // who bears the fees, with a live breakdown
  | "audience" // who it is for, and whether it is listed
  | "questions" // what else to ask a contributor
  | "reference" // contributor references
  | "timing" // type-aware dates; absent entirely from some flows
  | "review";

/** One screen of the wizard. */
export type StepKind =
  | "purpose"
  | "details" // name, description, image
  | "event" // the event, flyer included
  | "story" // the campaign, image included
  | "price" // one amount, and who bears the fees on it
  | "plan" // a recurring amount, how often, and who bears the fees
  | "giving" // what people may give, and who bears the fees
  | "goal" // a target and suggestions, and who bears the fees
  | "packages"
  | "tickets" // ticket types, and whether each ticket needs a name
  | "items" // the catalogue
  | "fees" // who bears the fees — its own screen where there is one price per row
  | "whoWhen" // who can pay, whether it is listed, and the dates
  | "extras" // optional: extra questions and contributor references
  | "review";

export interface FlowStep {
  readonly kind: StepKind;
  /** What this screen asks, in the order it asks it. Saved in this order too. */
  readonly sections: readonly SectionKind[];
  /** The word in the progress line. Short. */
  readonly label: string;
  /** The heading on the step itself. A question wherever a question is what is being asked. */
  readonly heading: string;
  readonly hint?: string;
}

/**
 * The words a flow uses for the things it has.
 *
 * The backend calls everything a collection (ADR 0004 — a collection belongs
 * to a community). This is the layer that stops an organiser being told their
 * event is a "collection" and their ticket types are "options".
 */
export interface Vocabulary {
  /** "collection", "event", "campaign", "catalogue", "plan" */
  readonly noun: string;
  /** What a contributor gives: "contribution", "donation", "order", "ticket purchase" */
  readonly contribution: string;
  /** What the roll is called: "members", "attendees", "customers", "supporters" */
  readonly people: string;
  /** What the priced things are: "options", "packages", "tickets", "items" */
  readonly offerings?: string;
}

export type TimingShape =
  /** One optional date after which nothing more is taken. */
  | "closing_date"
  /** An optional end for a campaign. */
  | "campaign_end"
  /** A window: orders open and orders close. */
  | "order_window"
  /** A window: ticket sales open and close. Separate from the event's own date. */
  | "sales_window"
  /** No dates at all. A plan that repeats does not close. */
  | "none";

export interface Flow {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** Shown on the intent card. Neutral, and never a classroom. */
  readonly example: string;
  readonly category: "dues" | "contribution" | "event" | "fundraiser" | "items" | "other";
  readonly participationMode: "open" | "managed";
  readonly amountModel: AmountModelKey;
  readonly schedule: "one_time" | "recurring";
  readonly vocabulary: Vocabulary;
  readonly timing: TimingShape;
  /** The placeholder in the name field. Changes with the intent. */
  readonly namePlaceholder: string;
  /** The placeholder in the description field. */
  readonly descriptionPlaceholder: string;
  /** What a contributor reference is, in this flow's words. Shown in the references section. */
  readonly referenceHint: string;
  /** Everything after the type picker. The picker is not a step. */
  readonly steps: readonly FlowStep[];
}

const REFERENCE_HINT =
  "A short code you can quote on a receipt, read out at a door, or search for when somebody rings up about their money.";

/** Optional configuration, on one screen. Both parts can be changed later in Settings. */
const EXTRAS_STEP: FlowStep = {
  kind: "extras",
  sections: ["questions", "reference"],
  label: "Extras",
  heading: "Anything else to set up?",
  hint: "Optional. Skip this and both can be set later in Settings.",
};

const FEES_STEP: FlowStep = {
  kind: "fees",
  sections: ["fees"],
  label: "Fees",
  heading: "Who pays the fees?",
};

/**
 * The seven, in the order the intent picker offers them.
 *
 * Neutral examples throughout (§27): associations, estates, clubs, conferences,
 * merchandise, appeals, memberships. A university department is one kind of
 * Kolekto customer and was never meant to be the default one.
 *
 * Every flow opens on its identity — the name and the image together — and
 * keeps money in one place: one price sits beside the fee decision on it,
 * while a flow with a price per row (packages, tickets, items) keeps the fee
 * decision on its own screen, because one breakdown per row does not fit
 * under the rows on a phone.
 */
export const FLOWS: readonly Flow[] = [
  {
    key: "fixed",
    title: "Fixed contribution",
    description: "Everyone pays the same amount.",
    example: "An annual levy, a membership fee, a joining fee",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
    schedule: "one_time",
    vocabulary: { noun: "collection", contribution: "contribution", people: "members" },
    timing: "closing_date",
    namePlaceholder: "Ikoyi Residents Annual Levy 2026",
    descriptionPlaceholder: "What the levy covers this year, and what it is for.",
    referenceHint: REFERENCE_HINT,
    steps: [
      { kind: "details", sections: ["basics", "cover"], label: "Details", heading: "What are you collecting?" },
      { kind: "price", sections: ["amount", "fees"], label: "Amount", heading: "How much does each person pay?" },
      {
        kind: "whoWhen",
        sections: ["audience", "timing"],
        label: "Who & when",
        heading: "Who is expected to contribute?",
      },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check this over" },
    ],
  },

  {
    key: "open",
    title: "Open contribution",
    description: "Let contributors choose how much to give.",
    example: "A welfare fund, a condolence collection, a community project",
    category: "contribution",
    participationMode: "open",
    amountModel: "open_amount",
    schedule: "one_time",
    vocabulary: { noun: "collection", contribution: "contribution", people: "contributors" },
    timing: "closing_date",
    namePlaceholder: "Ilorin Traders Welfare Fund",
    descriptionPlaceholder: "What the fund is for, and who it helps.",
    referenceHint: REFERENCE_HINT,
    steps: [
      { kind: "details", sections: ["basics", "cover"], label: "Purpose", heading: "What are people giving to?" },
      {
        kind: "giving",
        sections: ["openAmount", "fees"],
        label: "Giving",
        heading: "What may people give?",
        hint: "Leave the limits empty to accept any amount.",
      },
      { kind: "whoWhen", sections: ["audience", "timing"], label: "Who can give", heading: "Who can contribute?" },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check this over" },
    ],
  },

  {
    key: "tiered",
    title: "Packages",
    description: "Offer different contribution levels or packages.",
    example: "Sponsorship tiers, membership grades, table packages",
    category: "contribution",
    participationMode: "open",
    amountModel: "tiers",
    schedule: "one_time",
    vocabulary: {
      noun: "collection",
      contribution: "contribution",
      people: "contributors",
      offerings: "packages",
    },
    timing: "closing_date",
    namePlaceholder: "Lagos Business Forum Sponsorship 2026",
    descriptionPlaceholder: "What sponsors get, and what the forum is for.",
    referenceHint:
      "A code per contributor. Give a package its own prefix and it gets its own series — GOLD-0001 beside SILVER-0001.",
    steps: [
      {
        kind: "details",
        sections: ["basics", "cover"],
        label: "Basics",
        heading: "What are you offering packages for?",
      },
      {
        kind: "packages",
        sections: ["packages"],
        label: "Packages",
        heading: "What packages are you offering?",
        hint: "Each package is a name, a price and what it includes. A contributor picks one.",
      },
      FEES_STEP,
      { kind: "whoWhen", sections: ["audience", "timing"], label: "Who can choose", heading: "Who can take a package?" },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check this over" },
    ],
  },

  {
    key: "items",
    title: "Items",
    description: "Collect orders for products or merchandise.",
    example: "Aso-ebi, branded kit, a conference pack, an anniversary souvenir",
    category: "items",
    participationMode: "open",
    amountModel: "items",
    schedule: "one_time",
    vocabulary: {
      noun: "catalogue",
      contribution: "order",
      people: "customers",
      offerings: "items",
    },
    timing: "order_window",
    namePlaceholder: "Association Anniversary Merchandise",
    descriptionPlaceholder: "What is on offer, and when orders will be delivered.",
    referenceHint: REFERENCE_HINT,
    steps: [
      { kind: "details", sections: ["basics", "cover"], label: "Basics", heading: "What are you taking orders for?" },
      {
        kind: "items",
        sections: ["items"],
        label: "Items",
        heading: "What is in the catalogue?",
        hint:
          "Each item takes a photo, a price, how many are available and the most one person may take. " +
          "Nothing is reserved until an order is paid for, so stock is not held while somebody browses.",
      },
      FEES_STEP,
      {
        kind: "whoWhen",
        sections: ["audience", "timing"],
        label: "Who can order",
        heading: "Who can place an order?",
      },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check the catalogue" },
    ],
  },

  {
    key: "ticketing",
    title: "Tickets",
    description: "Create an event and sell tickets.",
    example: "A conference, a dinner, a workshop, a product launch",
    category: "event",
    participationMode: "open",
    amountModel: "tiers",
    schedule: "one_time",
    vocabulary: {
      noun: "event",
      contribution: "ticket purchase",
      people: "attendees",
      offerings: "tickets",
    },
    timing: "sales_window",
    namePlaceholder: "West Africa Founders Dinner 2026",
    descriptionPlaceholder: "What the evening is, who it is for, and what a ticket includes.",
    referenceHint:
      "A code per ticket holder. Give a ticket type its own prefix and it gets its own series — VIP-0001 beside REG-0001.",
    steps: [
      {
        kind: "event",
        sections: ["event"],
        label: "The event",
        heading: "Tell us about the event",
        hint: "The flyer goes here, with the rest of it — it is the first thing anybody sees.",
      },
      {
        kind: "tickets",
        sections: ["tickets", "purchaseRules"],
        label: "Tickets",
        heading: "What tickets are you selling?",
        hint: "Each type takes a name, a price and how many exist. Give one its own prefix and its references start at one.",
      },
      FEES_STEP,
      {
        kind: "whoWhen",
        sections: ["audience", "timing"],
        label: "Who can buy",
        heading: "Who can buy a ticket?",
        hint: "The sales dates here are when people can buy — not when the event is. The event's own date is on the first step.",
      },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check the event" },
    ],
  },

  {
    key: "fundraiser",
    title: "Fundraising",
    description: "Raise money for a cause or project.",
    example: "A medical appeal, a building fund, a relief drive",
    category: "fundraiser",
    participationMode: "open",
    amountModel: "open_amount",
    schedule: "one_time",
    vocabulary: {
      noun: "campaign",
      contribution: "donation",
      people: "supporters",
    },
    timing: "campaign_end",
    namePlaceholder: "Rebuild the Community Health Post",
    descriptionPlaceholder: "One line people will see beside the title.",
    referenceHint: REFERENCE_HINT,
    steps: [
      {
        kind: "story",
        sections: ["story"],
        label: "The story",
        heading: "Tell your story",
        hint: "This is the first thing a supporter reads, and it is what decides whether they give.",
      },
      {
        kind: "goal",
        sections: ["goal", "fees"],
        label: "Goal",
        heading: "What are you working toward?",
        hint: "A target gives people something to get behind. Suggested amounts make giving one tap.",
      },
      { kind: "whoWhen", sections: ["audience", "timing"], label: "Who can give", heading: "Who can donate?" },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check the campaign" },
    ],
  },

  {
    key: "recurring",
    title: "Recurring",
    description: "Collect recurring dues or charges.",
    example: "Monthly service charge, quarterly subscriptions, annual dues",
    category: "dues",
    participationMode: "managed",
    amountModel: "fixed",
    schedule: "recurring",
    vocabulary: { noun: "plan", contribution: "payment", people: "members" },
    timing: "none",
    namePlaceholder: "Estate Service Charge",
    descriptionPlaceholder: "What the charge covers each period.",
    referenceHint: REFERENCE_HINT,
    steps: [
      { kind: "details", sections: ["basics", "cover"], label: "Basics", heading: "What is being charged for?" },
      {
        kind: "plan",
        sections: ["amount", "schedule", "fees"],
        label: "Amount",
        heading: "How much, and how often?",
        hint: "Each period is asked for separately. Paying one does not settle the next.",
      },
      // No dates: a plan that repeats does not close (§21).
      { kind: "whoWhen", sections: ["audience"], label: "Who's included", heading: "Who is expected to pay?" },
      EXTRAS_STEP,
      { kind: "review", sections: ["review"], label: "Review", heading: "Check the plan" },
    ],
  },
];

/** Whether a step asks the given section. */
export function stepHas(step: FlowStep, section: SectionKind): boolean {
  return step.sections.includes(section);
}

/** Whether any step of the flow asks the given section. */
export function flowHas(flow: Flow, section: SectionKind): boolean {
  return flow.steps.some((step) => stepHas(step, section));
}

export function flowFor(key: string): Flow {
  return FLOWS.find((flow) => flow.key === key) ?? FLOWS[0]!;
}

/** One priced row as the editors hold it. `TierDraft` and `ItemDraft` both satisfy it. */
export interface PricedRow {
  readonly name: string;
  readonly price: string;
}

/** What the fee step prices, and what each line is called. */
export interface FeePreviewRow {
  readonly label: string;
  /** Naira, exactly as typed. The caller converts; a half-typed amount is skipped there. */
  readonly naira: string;
}

/**
 * What the fee step should show a breakdown for (§6).
 *
 * Every flow has money somewhere; what differs is where it lives. A fixed
 * collection has one amount, a package collection has one per package, a
 * catalogue has one per item. Each gets its own breakdown, because absorbing
 * fees on a ₦2,000 souvenir and on a ₦90,000 table are two different
 * decisions and one averaged line would hide that.
 *
 * Every figure returned is a CONTRIBUTION amount — what the organiser typed as
 * the price of the thing. It is never a payable, and never a previous
 * breakdown's total, so the fee calculation downstream cannot compound.
 */
export function feePreviewRows(input: {
  flow: Flow;
  fixedAmount: string;
  minAmount: string;
  suggestedAmounts: readonly string[];
  tiers: readonly PricedRow[];
  items: readonly PricedRow[];
}): FeePreviewRow[] {
  const { flow } = input;

  if (flow.amountModel === "tiers") {
    return input.tiers
      .filter((tier) => tier.name.trim() !== "" && tier.price.trim() !== "")
      .map((tier) => ({ label: tier.name.trim(), naira: tier.price }));
  }

  if (flow.amountModel === "items") {
    return input.items
      .filter((item) => item.name.trim() !== "" && item.price.trim() !== "")
      .map((item) => ({ label: item.name.trim(), naira: item.price }));
  }

  if (flow.amountModel === "open_amount") {
    const suggestions = input.suggestedAmounts.map((amount) => amount.trim()).filter((amount) => amount !== "");
    if (suggestions.length > 0) {
      return suggestions.map((amount) => ({ label: `If somebody gives ₦${formatAmountDisplay(amount)}`, naira: amount }));
    }
    if (input.minAmount.trim() !== "") return [{ label: "At the smallest amount", naira: input.minAmount }];
    // Nothing to go on yet — an open collection may never name a figure. Price
    // a round number so the SHAPE of the split is visible, labelled as the
    // example it is.
    return [{ label: "For example, on ₦10,000", naira: "10000" }];
  }

  return input.fixedAmount.trim() === "" ? [] : [{ label: "", naira: input.fixedAmount }];
}

/**
 * Which flow a collection that already exists was made from.
 *
 * Derived, never stored — the configuration axes are the source of truth
 * (ADR 0013), and a stored flow key would be a second one that could disagree
 * with them. The order matters: the more specific match comes first, because a
 * ticketed event and a plain package collection differ only by category.
 */
export function flowKeyFor(collection: {
  schedule: string;
  category: string;
  amount_model: string;
}): string {
  if (collection.schedule === "recurring") return "recurring";
  if (collection.category === "event") return "ticketing";
  if (collection.category === "fundraiser") return "fundraiser";
  if (collection.amount_model === "items") return "items";
  if (collection.amount_model === "tiers") return "tiered";
  if (collection.amount_model === "open_amount") return "open";
  return "fixed";
}
