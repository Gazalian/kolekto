import { describe, expect, it } from "vitest";
import { calculateFees, fromNaira } from "@kolekto/domain";
import { FLOWS, feePreviewRows, flowFor, flowKeyFor, type Flow, type StepKind } from "./flows.ts";

/**
 * The seven flows, pinned (M7.7 §3, §4, §12–22, §28).
 *
 * These tests exist because the failure this milestone corrects is not the
 * kind a typechecker catches. A wizard can compile perfectly while asking a
 * ticket seller for a "contribution amount" and giving a recurring plan a
 * closing date. What went wrong before was a PRODUCT property, so it is
 * pinned as one: the flows must differ in what they ask, in what order, and
 * in whose words — not merely in their labels.
 */

const kindsOf = (flow: Flow): StepKind[] => flow.steps.map((step) => step.kind);
const has = (flow: Flow, kind: StepKind): boolean => kindsOf(flow).includes(kind);

describe("the catalogue of flows", () => {
  it("offers exactly the seven types the schema can express", () => {
    // §3: "Do not invent additional collection types." Seven is the whole
    // list, and this test is what stops an eighth being added quietly.
    expect(FLOWS).toHaveLength(7);
    expect(FLOWS.map((flow) => flow.key).sort()).toEqual([
      "fixed",
      "fundraiser",
      "items",
      "open",
      "recurring",
      "ticketing",
      "tiered",
    ]);
  });

  it("gives every flow a distinct key", () => {
    expect(new Set(FLOWS.map((flow) => flow.key)).size).toBe(FLOWS.length);
  });

  it("falls back to the first flow rather than throwing on an unknown key", () => {
    // A resumed draft whose rows match nothing should still open.
    expect(flowFor("no-such-flow").key).toBe("fixed");
    expect(flowFor("ticketing").key).toBe("ticketing");
  });
});

describe("every flow is complete", () => {
  it.each(FLOWS.map((flow) => [flow.key, flow] as const))("%s asks the required questions", (_key, flow) => {
    // §5 makes the fee decision required at collection level, on every type.
    expect(has(flow, "fees")).toBe(true);
    // §9 puts reference configuration in creation, not only in Settings.
    expect(has(flow, "reference")).toBe(true);
    // §26 preserves invitation-group selection.
    expect(has(flow, "audience")).toBe(true);
    // §23 requires a review, and it is always last.
    expect(kindsOf(flow).at(-1)).toBe("review");
  });

  it.each(FLOWS.map((flow) => [flow.key, flow] as const))("%s names itself and its people", (_key, flow) => {
    expect(flow.vocabulary.noun.length).toBeGreaterThan(0);
    expect(flow.vocabulary.contribution.length).toBeGreaterThan(0);
    expect(flow.vocabulary.people.length).toBeGreaterThan(0);
    expect(flow.namePlaceholder.length).toBeGreaterThan(0);
  });

  it("never repeats a step kind within one flow", () => {
    for (const flow of FLOWS) {
      const kinds = kindsOf(flow);
      expect(new Set(kinds).size, `${flow.key} asks something twice`).toBe(kinds.length);
    }
  });

  it("gives every step a label and a heading", () => {
    for (const flow of FLOWS) {
      for (const step of flow.steps) {
        expect(step.label.length, `${flow.key}/${step.kind} label`).toBeGreaterThan(0);
        expect(step.heading.length, `${flow.key}/${step.kind} heading`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the flows are genuinely different, not renamed", () => {
  it("does not give every flow the same sequence of steps", () => {
    // §28: "Do NOT solve this by merely renaming Step 1, renaming Step 2,
    // hiding some fields, keeping identical step ordering." A single shared
    // sequence would pass every other test in this file.
    const sequences = new Set(FLOWS.map((flow) => kindsOf(flow).join(">")));
    expect(sequences.size).toBe(FLOWS.length);
  });

  it("does not give every flow the same length", () => {
    const lengths = new Set(FLOWS.map((flow) => flow.steps.length));
    expect(lengths.size).toBeGreaterThan(1);
  });

  it("opens each flow on the thing that flow is about", () => {
    const opening = Object.fromEntries(FLOWS.map((flow) => [flow.key, kindsOf(flow)[0]]));
    // A ticket seller thinks about the event; a fundraiser thinks about the
    // story. Neither opens on a generic "basics".
    expect(opening.ticketing).toBe("event");
    expect(opening.fundraiser).toBe("story");
    expect(opening.items).toBe("basics");
  });

  it("asks a ticketed event about its tickets and never about a plain amount", () => {
    const ticketing = flowFor("ticketing");
    expect(has(ticketing, "tickets")).toBe(true);
    expect(has(ticketing, "amount")).toBe(false);
    expect(has(ticketing, "packages")).toBe(false);
    // §18: the flyer belongs with the event, which is the first step.
    expect(has(ticketing, "cover")).toBe(false);
  });

  it("asks a catalogue about items and order rules", () => {
    const items = flowFor("items");
    expect(has(items, "items")).toBe(true);
    expect(has(items, "orderRules")).toBe(true);
    expect(has(items, "purchaseRules")).toBe(false);
  });

  it("asks a fundraiser for a goal and never for a fixed amount", () => {
    const fundraiser = flowFor("fundraiser");
    expect(has(fundraiser, "goal")).toBe(true);
    expect(has(fundraiser, "amount")).toBe(false);
    expect(has(fundraiser, "story")).toBe(true);
  });

  it("asks a recurring plan how often, and never when it closes", () => {
    const recurring = flowFor("recurring");
    expect(has(recurring, "schedule")).toBe(true);
    // §21: a plan that repeats does not close, so it is not asked for a date.
    expect(has(recurring, "timing")).toBe(false);
    expect(recurring.timing).toBe("none");
  });
});

describe("timing is type-aware (§21)", () => {
  it("gives each flow the shape of deadline its type actually has", () => {
    expect(flowFor("fixed").timing).toBe("closing_date");
    expect(flowFor("open").timing).toBe("closing_date");
    expect(flowFor("tiered").timing).toBe("closing_date");
    // Orders and ticket sales are windows: they open as well as close.
    expect(flowFor("items").timing).toBe("order_window");
    expect(flowFor("ticketing").timing).toBe("sales_window");
    expect(flowFor("fundraiser").timing).toBe("campaign_end");
    expect(flowFor("recurring").timing).toBe("none");
  });

  it("gives a timing step to every flow that has dates, and only those", () => {
    for (const flow of FLOWS) {
      expect(has(flow, "timing"), `${flow.key}`).toBe(flow.timing !== "none");
    }
  });

  it("keeps the event's own date separate from when its tickets sell", () => {
    // The dinner is one date; sales closing is another. Collapsing them makes
    // one of the two wrong on the public page.
    const ticketing = flowFor("ticketing");
    const sales = ticketing.steps.find((step) => step.kind === "timing");
    expect(sales?.hint ?? "").toMatch(/not when the event is/i);
  });
});

describe("vocabulary (§22)", () => {
  it("does not call an event a collection, or a ticket buyer a member", () => {
    expect(flowFor("ticketing").vocabulary).toMatchObject({
      noun: "event",
      contribution: "ticket purchase",
      people: "attendees",
      offerings: "tickets",
    });
    expect(flowFor("fundraiser").vocabulary).toMatchObject({
      noun: "campaign",
      contribution: "donation",
      people: "supporters",
    });
    expect(flowFor("items").vocabulary).toMatchObject({ noun: "catalogue", contribution: "order", people: "customers" });
    expect(flowFor("recurring").vocabulary.noun).toBe("plan");
  });

  it("names the priced things wherever a flow has priced things", () => {
    for (const flow of FLOWS) {
      if (flow.amountModel === "tiers" || flow.amountModel === "items") {
        expect(flow.vocabulary.offerings, `${flow.key}`).toBeTruthy();
      }
    }
  });
});

describe("example copy is neutral (§27)", () => {
  // The previous copy assumed a university department: matric numbers, class
  // sizes, a students' association. An estate, a trade association and a
  // conference are all equally Kolekto's customer, and the examples should
  // not decide which one is the default.
  const STUDENT_WORDS =
    /\b(matric|student|classmate|pupil|lecture|faculty|hostel|semester|undergrad|school fees|class of)\b/i;

  it.each(FLOWS.map((flow) => [flow.key, flow] as const))("%s uses no classroom examples", (_key, flow) => {
    const copy = [
      flow.title,
      flow.description,
      flow.example,
      flow.namePlaceholder,
      flow.descriptionPlaceholder,
      ...flow.steps.flatMap((step) => [step.label, step.heading, step.hint ?? ""]),
    ].join(" | ");
    expect(copy).not.toMatch(STUDENT_WORDS);
  });
});

describe("resuming a draft finds the flow it was made from (§25)", () => {
  it("round-trips every flow through its configuration axes", () => {
    // There is no collection_type column (ADR 0013), so the flow has to be
    // recoverable from the four axes alone. If two flows collapsed onto one
    // key, a resumed draft would reopen as the wrong kind of thing.
    for (const flow of FLOWS) {
      const key = flowKeyFor({
        schedule: flow.schedule,
        category: flow.category,
        amount_model: flow.amountModel,
      });
      expect(key, `${flow.key} did not round-trip`).toBe(flow.key);
    }
  });

  it("puts a collection it cannot place into the fixed flow rather than failing", () => {
    expect(flowKeyFor({ schedule: "one_time", category: "other", amount_model: "per_member" })).toBe("fixed");
  });
});

describe("what the fee step prices (§6)", () => {
  const base = { fixedAmount: "", minAmount: "", suggestedAmounts: [] as string[], tiers: [], items: [] };

  it("prices the one amount a fixed collection has", () => {
    const rows = feePreviewRows({ ...base, flow: flowFor("fixed"), fixedAmount: "5000" });
    expect(rows).toEqual([{ label: "", naira: "5000" }]);
  });

  it("shows nothing until there is an amount to show", () => {
    expect(feePreviewRows({ ...base, flow: flowFor("fixed") })).toEqual([]);
  });

  it("prices every ticket type separately", () => {
    const rows = feePreviewRows({
      ...base,
      flow: flowFor("ticketing"),
      tiers: [
        { name: "VIP", price: "90000" },
        { name: "Regular", price: "25000" },
      ],
    });
    expect(rows).toEqual([
      { label: "VIP", naira: "90000" },
      { label: "Regular", naira: "25000" },
    ]);
  });

  it("prices every item separately", () => {
    const rows = feePreviewRows({
      ...base,
      flow: flowFor("items"),
      items: [
        { name: "Polo shirt", price: "12000" },
        { name: "Cap", price: "3500" },
      ],
    });
    expect(rows.map((row) => row.label)).toEqual(["Polo shirt", "Cap"]);
  });

  it("skips a row that is only half filled in", () => {
    const rows = feePreviewRows({
      ...base,
      flow: flowFor("tiered"),
      tiers: [
        { name: "Gold", price: "" },
        { name: "", price: "500000" },
        { name: "Silver", price: "250000" },
      ],
    });
    expect(rows).toEqual([{ label: "Silver", naira: "250000" }]);
  });

  it("prices an open collection at its suggestions when it has them", () => {
    const rows = feePreviewRows({ ...base, flow: flowFor("open"), suggestedAmounts: ["2000", " 5000 ", ""] });
    expect(rows.map((row) => row.naira)).toEqual(["2000", "5000"]);
  });

  it("falls back to the minimum, then to a labelled example", () => {
    expect(feePreviewRows({ ...base, flow: flowFor("open"), minAmount: "1000" })).toEqual([
      { label: "At the smallest amount", naira: "1000" },
    ]);

    const [example] = feePreviewRows({ ...base, flow: flowFor("fundraiser") });
    expect(example?.naira).toBe("10000");
    // It has to read as an illustration, not as a figure the organiser set.
    expect(example?.label).toMatch(/for example/i);
  });
});

describe("the fee preview cannot compound (§6)", () => {
  /**
   * The property that matters: whatever the wizard hands the fee engine is a
   * CONTRIBUTION — the price of the thing — and never a payable from an
   * earlier breakdown. This walks every flow, prices whatever it offers, and
   * checks that feeding the result back through changes nothing.
   *
   * There is one fee implementation in the product (`calculateFees`), and
   * these tests call it directly for the same reason the UI does: a second
   * one written to make a test pass is exactly the defect being guarded
   * against.
   */
  it.each(FLOWS.map((flow) => [flow.key, flow] as const))("%s never charges a fee on a fee", (_key, flow) => {
    const rows = feePreviewRows({
      flow,
      fixedAmount: "20000",
      minAmount: "",
      suggestedAmounts: ["2000", "20000"],
      tiers: [
        { name: "VIP", price: "90000" },
        { name: "Regular", price: "25000" },
      ],
      items: [{ name: "Polo shirt", price: "12000" }],
    });
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const amount = fromNaira(row.naira);
      for (const bearer of ["contributor", "community"] as const) {
        const first = calculateFees({ amount, category: flow.category, bearer });
        const again = calculateFees({ amount: first.contribution, category: flow.category, bearer });

        expect(again.totalPayable, `${flow.key}/${row.naira}/${bearer} drifted`).toBe(first.totalPayable);
        expect(first.contribution, `${flow.key}/${row.naira} priced the payable`).toBe(amount);
      }
    }
  });

  it("splits a contributor-borne and an absorbed charge around the same contribution", () => {
    const amount = fromNaira("25000");
    const passed = calculateFees({ amount, category: "event", bearer: "contributor" });
    const absorbed = calculateFees({ amount, category: "event", bearer: "community" });

    // Same fees either way. All that moves is which side of the line they sit.
    expect(passed.totalFees).toBe(absorbed.totalFees);
    expect(passed.totalPayable).toBe(amount + passed.totalFees);
    expect(passed.net).toBe(amount);
    expect(absorbed.totalPayable).toBe(amount);
    expect(absorbed.net).toBe(amount - absorbed.totalFees);
  });
});
