import { describe, expect, it } from "vitest";
import { flowFor } from "./flows.ts";
import { eventEndProblem, rangeProblem, resumeStep, sectionReady, stepReady, windowProblem, type WizardSnapshot } from "./readiness.ts";

const blank: WizardSnapshot = {
  name: "",
  eventStartsAt: "",
  eventEndsAt: "",
  fixedAmount: "",
  minAmount: "",
  maxAmount: "",
  targetAmount: "",
  suggestedAmounts: [],
  tiers: [{ name: "", price: "" }],
  items: [{ name: "", price: "" }],
  audienceMode: "all_members",
  audienceGroupIds: [],
  startsAt: "",
  deadlineAt: "",
  codes: { enabled: false, prefix: "" },
  canConfigureCodes: true,
  codesLocked: false,
};

const fixed = flowFor("fixed");

describe("what blocks Continue", () => {
  it("needs a name of at least three characters", () => {
    expect(sectionReady("basics", { ...blank, name: "Ab" }, fixed)).toBe(false);
    expect(sectionReady("basics", { ...blank, name: "Levy" }, fixed)).toBe(true);
  });

  it("needs a valid, positive amount — not merely a non-empty one", () => {
    expect(sectionReady("amount", { ...blank, fixedAmount: "" }, fixed)).toBe(false);
    expect(sectionReady("amount", { ...blank, fixedAmount: "0" }, fixed)).toBe(false);
    expect(sectionReady("amount", { ...blank, fixedAmount: "20000" }, fixed)).toBe(true);
    expect(sectionReady("amount", { ...blank, fixedAmount: "20000.5" }, fixed)).toBe(true);
  });

  it("refuses a smallest amount above the largest", () => {
    const open = flowFor("open");
    expect(rangeProblem("5000", "1000")).toBeDefined();
    expect(rangeProblem("1000", "5000")).toBeUndefined();
    expect(sectionReady("openAmount", { ...blank, minAmount: "5000", maxAmount: "1000" }, open)).toBe(false);
    expect(sectionReady("openAmount", { ...blank, minAmount: "1000", maxAmount: "5000" }, open)).toBe(true);
    expect(sectionReady("openAmount", blank, open)).toBe(true);
  });

  it("refuses two packages with the same name, and a package with no price", () => {
    const tiered = flowFor("tiered");
    const tiers = [
      { name: "Gold", price: "50000" },
      { name: "gold", price: "20000" },
    ];
    expect(sectionReady("packages", { ...blank, tiers }, tiered)).toBe(false);
    expect(sectionReady("packages", { ...blank, tiers: [{ name: "Gold", price: "" }] }, tiered)).toBe(false);
    expect(sectionReady("packages", { ...blank, tiers: [{ name: "Gold", price: "50000" }] }, tiered)).toBe(true);
  });

  it("needs a group when the audience is groups", () => {
    expect(sectionReady("audience", { ...blank, audienceMode: "groups" }, fixed)).toBe(false);
    expect(sectionReady("audience", { ...blank, audienceMode: "groups", audienceGroupIds: ["g1"] }, fixed)).toBe(true);
  });

  it("refuses a window that closes before it opens, and an event that ends before it starts", () => {
    expect(windowProblem("2026-12-02T10:00", "2026-12-01T10:00")).toBeDefined();
    expect(windowProblem("2026-12-01T10:00", "")).toBeUndefined();
    expect(eventEndProblem("2026-12-02T10:00", "2026-12-01T10:00")).toBeDefined();
    const ticketing = flowFor("ticketing");
    expect(
      sectionReady("event", { ...blank, name: "Dinner", eventStartsAt: "2026-12-02T10:00", eventEndsAt: "2026-12-01T10:00" }, ticketing),
    ).toBe(false);
  });

  it("only asks for a reference prefix when references are switched on by someone who may", () => {
    expect(sectionReady("reference", { ...blank, codes: { enabled: true, prefix: "A" } }, fixed)).toBe(false);
    expect(sectionReady("reference", { ...blank, codes: { enabled: true, prefix: "AB" } }, fixed)).toBe(true);
    expect(sectionReady("reference", { ...blank, canConfigureCodes: false, codes: { enabled: true, prefix: "" } }, fixed)).toBe(true);
  });

  it("judges a merged step by every section on it", () => {
    const price = fixed.steps[1]!;
    expect(stepReady(price, { ...blank, fixedAmount: "5000" }, fixed)).toBe(true);
    expect(stepReady(price, blank, fixed)).toBe(false);
  });
});

describe("where a resumed draft opens", () => {
  const complete: WizardSnapshot = { ...blank, name: "Levy 2026", fixedAmount: "5000" };

  it("opens where it was left when nothing earlier is missing", () => {
    expect(resumeStep(fixed, 3, complete)).toBe(3);
  });

  it("clamps a position saved by the longer, pre-redesign flow", () => {
    expect(resumeStep(fixed, 9, complete)).toBe(fixed.steps.length);
  });

  it("never opens past a step with something required missing", () => {
    expect(resumeStep(fixed, 4, { ...complete, fixedAmount: "" })).toBe(2);
  });

  it("never opens on the type picker", () => {
    expect(resumeStep(fixed, 0, complete)).toBe(1);
  });
});
