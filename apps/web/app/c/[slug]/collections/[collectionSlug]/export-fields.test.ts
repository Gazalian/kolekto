import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELDS,
  EXPORT_FIELD_GROUP_ORDER,
  EXPORT_FIELDS,
  EXPORT_SUBJECTS,
  SUBJECT_LOCKS,
  type ExportSubjectKey,
} from "./export-fields.ts";

/**
 * The export catalogue, pinned (M7.6 hardening, item 3).
 *
 * Two jobs.
 *
 * ONE: keep the catalogue honest. Nothing in this phase records a
 * contribution, a purchase or an order — ADR 0012 rejected a
 * pending-contribution table on purpose and ADR 0006 gates the real one — so
 * no column here may offer money received, a payment status, or an order
 * line. A column of blanks in a spreadsheet reads as "nobody has paid", which
 * is a materially worse statement than "this does not exist yet". These tests
 * fail the moment somebody adds one ahead of the rows behind it.
 *
 * TWO: keep it a catalogue. Phase 4 should be able to add a subject and a few
 * columns by appending rows to two arrays, without touching the builder, the
 * filters, the CSV writer or the PDF renderer. That is only true while every
 * subject and every field is data — so the shape is asserted, not assumed.
 */

/** Words that would each be a claim about money this system cannot yet make. */
const FORBIDDEN = [
  "paid",
  "payment",
  "amount_received",
  "received",
  "contribution",
  "balance",
  "outstanding_amount",
  "settled",
  "refund",
  "wallet",
  "payout",
  "ledger",
  "transaction",
];

describe("the export catalogue makes no claim about money received", () => {
  it("offers no column whose key names a payment", () => {
    for (const field of EXPORT_FIELDS) {
      for (const word of FORBIDDEN) {
        expect(field.key, `field "${field.key}" names ${word}`).not.toContain(word);
      }
    }
  });

  it("offers no column whose label names a payment", () => {
    for (const field of EXPORT_FIELDS) {
      const label = field.label.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(label, `column "${field.label}" names ${word}`).not.toContain(word);
      }
    }
  });

  it("offers no subject that would be a file of empty amounts", () => {
    for (const subject of EXPORT_SUBJECTS) {
      const text = `${subject.key} ${subject.label} ${subject.reportTitle}`.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(text, `subject "${subject.label}" names ${word}`).not.toContain(word);
      }
    }
  });

  it("keeps the two amount columns it does have labelled as what was ASKED for", () => {
    // "Expected amount" and "Waived amount" are both configuration: what the
    // collection asks, and what an officer forgave. Neither is money that
    // arrived, and both say so in their own names.
    const money = EXPORT_FIELDS.filter((field) => field.align === "right");
    expect(money.map((field) => field.label)).toEqual(["Expected amount", "Waived amount"]);
  });
});

describe("the catalogue is data, so Phase 4 can extend it by appending", () => {
  it("has a unique key per field", () => {
    const keys = EXPORT_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a unique key per subject", () => {
    const keys = EXPORT_SUBJECTS.map((subject) => subject.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("puts every field in a group the builder renders", () => {
    for (const field of EXPORT_FIELDS) {
      expect(EXPORT_FIELD_GROUP_ORDER).toContain(field.group);
    }
  });

  it("gives every field a printable width, so a new column lays itself out", () => {
    for (const field of EXPORT_FIELDS) {
      expect(field.weight, `field "${field.key}" has no usable weight`).toBeGreaterThan(0);
    }
  });

  it("defaults every subject to columns that exist", () => {
    const keys = new Set(EXPORT_FIELDS.map((field) => field.key));
    for (const [subject, defaults] of Object.entries(DEFAULT_FIELDS)) {
      for (const key of defaults) {
        expect(keys.has(key), `${subject} defaults to "${key}", which is not a field`).toBe(true);
      }
    }
  });

  it("locks a control for exactly the subjects that have already answered it", () => {
    // "Still expected to pay" has decided the status; "only those who
    // arrived" has decided the door. Nothing else has decided either.
    const locked = Object.entries(SUBJECT_LOCKS).filter(([, lock]) => lock.status || lock.attendance);
    expect(locked.map(([key]) => key as ExportSubjectKey).sort()).toEqual(["arrived", "outstanding"]);
  });

  it("offers the event-only subjects only on an event", () => {
    const eventOnly = EXPORT_SUBJECTS.filter((subject) => subject.needs === "event").map((s) => s.key);
    expect(eventOnly.sort()).toEqual(["arrived", "attendees"]);
  });

  it("marks exactly the two contact columns as personal", () => {
    // They carry a separate permission (RPT-06). If a third contact column is
    // ever added, this fails until somebody decides whether it is personal.
    const sensitive = EXPORT_FIELDS.filter((field) => field.sensitive).map((field) => field.key);
    expect(sensitive.sort()).toEqual(["email", "phone"]);
  });
});
