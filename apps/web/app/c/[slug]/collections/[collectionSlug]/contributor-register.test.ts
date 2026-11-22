import type { ContributorRow } from "@kolekto/db";
import { toCsv } from "@kolekto/domain";
import { describe, expect, it } from "vitest";
import {
  answerEntries,
  contributorCsvColumns,
  contributorExportFields,
  defaultContributorExportKeys,
  describeLines,
  nairaText,
  toContributorView,
  type ContributorFieldDef,
} from "./contributor-register.ts";

const FIELDS: ContributorFieldDef[] = [
  { key: "level", label: "Level", type: "single_select", sort_order: 1 },
  { key: "matric", label: "Matric number", type: "text", sort_order: 0 },
];

function row(overrides: Partial<ContributorRow> = {}): ContributorRow {
  return {
    contributionId: "c-1",
    capturedAt: "2026-11-16T13:00:00.000Z",
    contributionKobo: 500000n,
    totalChargedKobo: 510050n,
    reference: "KLK-00000000000000000000000001",
    name: "Ada Guest",
    isMember: false,
    memberCode: null,
    email: null,
    phone: null,
    answers: { matric: "CSC/001", level: "300" },
    attendeeNames: [],
    lines: [],
    cycleKey: null,
    contributorPaymentCount: 2,
    contributorTotalKobo: 1000000n,
    acknowledgedAt: null,
    acknowledgedByName: null,
    ...overrides,
  };
}

const plain = { fields: FIELDS, hasOptions: false, isEvent: false, isRecurring: false, isManaged: false };

describe("answerEntries", () => {
  it("orders answers by the collection's own question order and labels", () => {
    expect(answerEntries(FIELDS, { level: "300", matric: "CSC/001" })).toEqual([
      { key: "matric", label: "Matric number", value: "CSC/001", removed: false },
      { key: "level", label: "Level", value: "300", removed: false },
    ]);
  });

  it("skips empty answers by default and keeps them when asked", () => {
    expect(answerEntries(FIELDS, { matric: "  " })).toEqual([]);
    expect(answerEntries(FIELDS, {}, { includeEmpty: true }).map((entry) => entry.value)).toEqual(["", ""]);
  });

  it("keeps an answer whose question was removed, readable rather than raw", () => {
    expect(answerEntries(FIELDS, { matric: "X", hall_of_residence: "Jaja" })).toContainEqual({
      key: "hall_of_residence",
      label: "Hall of residence",
      value: "Jaja",
      removed: true,
    });
  });

  it("copes with a collection that has no questions", () => {
    expect(answerEntries([], {})).toEqual([]);
  });
});

describe("describeLines", () => {
  it("names options and shows quantities above one", () => {
    expect(
      describeLines([
        { name: "Regular seat", quantity: 2 },
        { name: "VIP", quantity: 1 },
      ]),
    ).toBe("Regular seat × 2 · VIP");
    expect(describeLines([])).toBe("");
  });
});

describe("nairaText", () => {
  it("formats kobo without inventing decimals", () => {
    expect(nairaText("500000")).toBe("₦5,000");
    expect(nairaText("500050")).toBe("₦5,000.50");
  });
});

describe("toContributorView", () => {
  it("carries money as kobo strings, unchanged", () => {
    const view = toContributorView(row({ lines: [{ kind: "tier", name: "Seat", quantity: 1, amountKobo: 200000n }] }));
    expect(view.amountKobo).toBe("500000");
    expect(view.totalChargedKobo).toBe("510050");
    expect(view.personTotalKobo).toBe("1000000");
    expect(view.lines[0]!.amountKobo).toBe("200000");
    expect(JSON.parse(JSON.stringify(view)).amountKobo).toBe("500000");
  });
});

describe("contributorExportFields", () => {
  it("offers the collection's own questions under their labels, in order", () => {
    const questions = contributorExportFields(plain).filter((field) => field.group === "Questions");
    expect(questions.map((field) => [field.key, field.label])).toEqual([
      ["q:matric", "Matric number"],
      ["q:level", "Level"],
    ]);
  });

  it("offers type-specific columns only where the collection has them", () => {
    const keys = (context: typeof plain) => contributorExportFields(context).map((field) => field.key);
    expect(keys(plain)).not.toContain("options");
    expect(keys(plain)).not.toContain("attendees");
    expect(keys(plain)).not.toContain("period");
    expect(keys(plain)).not.toContain("member_code");
    expect(keys({ ...plain, hasOptions: true, isEvent: true, isRecurring: true, isManaged: true })).toEqual(
      expect.arrayContaining(["options", "attendees", "period", "member_code"]),
    );
  });

  it("marks contact columns sensitive and never ticks them by default", () => {
    const available = contributorExportFields(plain);
    expect(available.filter((field) => field.sensitive).map((field) => field.key)).toEqual(["email", "phone"]);
    const defaults = defaultContributorExportKeys(available);
    expect(defaults).not.toContain("email");
    expect(defaults).not.toContain("phone");
    expect(defaults).toEqual(["name", "amount", "date", "q:matric", "q:level"]);
  });
});

describe("contributorCsvColumns", () => {
  const available = contributorExportFields({ ...plain, hasOptions: true });
  const fmt = (iso: string) => `at ${iso.slice(0, 10)}`;

  it("drops keys the collection cannot answer instead of trusting them", () => {
    const columns = contributorCsvColumns(["name", "drop table", "q:unknown_question", "amount"], available, fmt);
    expect(columns.map((column) => column.header)).toEqual(["Contributor name", "Amount (NGN)"]);
  });

  it("produces labelled columns, formatted amounts and blanks for missing values", () => {
    const columns = contributorCsvColumns(
      ["name", "amount", "date", "options", "q:matric", "q:level", "acknowledged", "email", "person_total"],
      available,
      fmt,
    );
    const csv = toCsv(columns, [
      row({ lines: [{ kind: "tier", name: "Seat", quantity: 2, amountKobo: 400000n }] }),
      row({ name: "Bola", answers: {}, acknowledgedAt: "2026-11-16T14:00:00.000Z", contributorPaymentCount: 1, contributorTotalKobo: 500000n }),
    ]);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    // Columns follow the export's own grouping (Basic, Contact, Questions,
    // Management), not the order the keys arrived in.
    expect(lines[0]).toBe(
      "Contributor name,Amount (NGN),Date paid,Option,Email,Matric number,Level,Acknowledged,Total from this person (NGN)",
    );
    expect(lines[1]).toBe('Ada Guest,"5,000.00",at 2026-11-16,Seat × 2,,CSC/001,300,No,"10,000.00"');
    expect(lines[2]).toBe('Bola,"5,000.00",at 2026-11-16,,,,,Yes,"5,000.00"');
  });

  it("keeps one row per payment for a person who paid twice", () => {
    const columns = contributorCsvColumns(["name", "person_payments"], available, fmt);
    const csv = toCsv(columns, [row({ contributionId: "a" }), row({ contributionId: "b" })]);
    expect(csv.trimEnd().split("\r\n")).toHaveLength(3);
  });
});
