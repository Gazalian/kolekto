import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  availableAt,
  lagosDateOf,
  nextLagosDay,
  releaseIsDue,
  SETTLEMENT_HOUR,
  SETTLEMENT_TIMEZONE,
  SettlementError,
} from "../src/settlement.ts";

/**
 * D-09: T+1 means the next CALENDAR day, every day, at 05:00 Africa/Lagos.
 *
 * Every vector below is written as a Lagos wall-clock time with its explicit
 * +01:00 offset, and asserted against a UTC instant. Writing the input in Lagos
 * time and the expectation in UTC is deliberate: it means a test passes only if
 * the conversion is right, rather than because the same mistake was made on
 * both sides.
 *
 * 05:00 Africa/Lagos is 04:00Z.
 */
const cases = [
  // A working Monday afternoon.
  ["Monday 14:00", "2026-09-21T14:00:00+01:00", "2026-09-22T04:00:00.000Z"],

  // ── The four the founder named explicitly ──────────────────────────────────
  // These are the cases business-day settlement gets wrong, which is why they
  // are named rather than assumed.
  ["Friday 23:00 → Saturday", "2026-09-25T23:00:00+01:00", "2026-09-26T04:00:00.000Z"],
  ["Saturday 10:00 → Sunday", "2026-09-26T10:00:00+01:00", "2026-09-27T04:00:00.000Z"],
  ["Sunday 23:59 → Monday", "2026-09-27T23:59:00+01:00", "2026-09-28T04:00:00.000Z"],
  ["Monday → Tuesday", "2026-09-28T09:00:00+01:00", "2026-09-29T04:00:00.000Z"],

  // ── Boundaries within a day ────────────────────────────────────────────────
  ["exactly midnight Lagos", "2026-09-21T00:00:00+01:00", "2026-09-22T04:00:00.000Z"],
  ["one second before midnight", "2026-09-21T23:59:59+01:00", "2026-09-22T04:00:00.000Z"],
  // The capture's own hour does not matter. A payment at exactly 05:00 does NOT
  // become available at 05:00 the same morning — it is captured on the 21st, so
  // it lands on the 22nd like everything else captured that day.
  ["exactly 05:00 Lagos", "2026-09-21T05:00:00+01:00", "2026-09-22T04:00:00.000Z"],
  ["one second before 05:00", "2026-09-21T04:59:59+01:00", "2026-09-22T04:00:00.000Z"],
  ["one second after 05:00", "2026-09-21T05:00:01+01:00", "2026-09-22T04:00:00.000Z"],

  // ── Calendar boundaries ────────────────────────────────────────────────────
  ["end of a 30-day month", "2026-09-30T22:00:00+01:00", "2026-10-01T04:00:00.000Z"],
  ["end of a 31-day month", "2026-10-31T22:00:00+01:00", "2026-11-01T04:00:00.000Z"],
  ["end of February, non-leap", "2027-02-28T22:00:00+01:00", "2027-03-01T04:00:00.000Z"],
  ["29 February, leap year", "2028-02-29T22:00:00+01:00", "2028-03-01T04:00:00.000Z"],
  ["28 February into the 29th, leap year", "2028-02-28T22:00:00+01:00", "2028-02-29T04:00:00.000Z"],
  ["new year's eve", "2026-12-31T23:30:00+01:00", "2027-01-01T04:00:00.000Z"],
] as const;

describe("availableAt() — T+1, calendar days, 05:00 Africa/Lagos (D-09)", () => {
  for (const [name, captured, expected] of cases) {
    it(`${name}: ${captured} → ${expected}`, () => {
      assert.equal(availableAt(new Date(captured)).toISOString(), expected);
    });
  }

  it("is 05:00 Lagos time, whatever the runtime's own timezone is", () => {
    const at = availableAt(new Date("2026-09-21T14:00:00+01:00"));
    const shown = new Intl.DateTimeFormat("en-GB", {
      timeZone: SETTLEMENT_TIMEZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
    assert.equal(shown, "05:00");
    assert.equal(SETTLEMENT_HOUR, 5);
  });

  it("gives the same answer for every capture on the same Lagos day", () => {
    // The distinguishing property of calendar-day T+1: the time of capture
    // decides nothing beyond which Lagos date it fell on.
    const sameDay = [
      "2026-09-21T00:00:00+01:00",
      "2026-09-21T04:59:59+01:00",
      "2026-09-21T05:00:00+01:00",
      "2026-09-21T12:00:00+01:00",
      "2026-09-21T23:59:59+01:00",
    ].map((iso) => availableAt(new Date(iso)).toISOString());

    assert.deepEqual(new Set(sameDay), new Set(["2026-09-22T04:00:00.000Z"]));
  });

  it("advances by exactly one day, never by 24 hours from the capture", () => {
    // These differ whenever the capture is not itself at 05:00, and conflating
    // them is the "24 hours after payment" rule D-09 explicitly rejects.
    const captured = new Date("2026-09-21T23:00:00+01:00");
    const available = availableAt(captured);
    const twentyFourHoursLater = new Date(captured.getTime() + 24 * 60 * 60 * 1000);

    assert.notEqual(available.toISOString(), twentyFourHoursLater.toISOString());
    assert.ok(available.getTime() < twentyFourHoursLater.getTime(), "05:00 next day is sooner than +24h here");
  });

  it("never skips a weekend, which is what business-day settlement would do", () => {
    // Friday evening under business-day settlement would land on Monday. Under
    // D-09 it lands on Saturday. This asserts the difference rather than
    // restating the rule.
    const fridayEvening = availableAt(new Date("2026-09-25T23:00:00+01:00"));
    const saturday = new Date("2026-09-26T04:00:00.000Z");
    const monday = new Date("2026-09-28T04:00:00.000Z");

    assert.equal(fridayEvening.toISOString(), saturday.toISOString());
    assert.notEqual(fridayEvening.toISOString(), monday.toISOString());
  });

  it("is a pure function of its input", () => {
    const captured = new Date("2026-09-21T14:00:00+01:00");
    const before = captured.getTime();

    const first = availableAt(captured);
    const second = availableAt(captured);

    assert.equal(first.toISOString(), second.toISOString(), "same input, same answer");
    assert.equal(captured.getTime(), before, "and the input is not mutated");
  });

  it("refuses an invalid date rather than returning one", () => {
    assert.throws(() => availableAt(new Date("not a date")), SettlementError);
    // A settlement boundary computed from an unparsed value would be an
    // Invalid Date silently stored as a null-ish timestamp.
    assert.throws(() => availableAt(new Date(NaN)), SettlementError);
  });
});

describe("lagosDateOf() and nextLagosDay()", () => {
  it("reads the Lagos calendar date, not the UTC one", () => {
    // 23:30Z on the 21st is already 00:30 on the 22nd in Lagos. A rule written
    // against UTC dates would put this capture on the wrong day.
    assert.deepEqual(lagosDateOf(new Date("2026-09-21T23:30:00Z")), { year: 2026, month: 9, day: 22 });
    assert.deepEqual(lagosDateOf(new Date("2026-09-21T22:30:00Z")), { year: 2026, month: 9, day: 21 });
  });

  it("returns months as 1-12, not 0-11", () => {
    assert.deepEqual(lagosDateOf(new Date("2026-01-15T12:00:00+01:00")), { year: 2026, month: 1, day: 15 });
    assert.deepEqual(lagosDateOf(new Date("2026-12-15T12:00:00+01:00")), { year: 2026, month: 12, day: 15 });
  });

  it("crosses month, year and leap-year boundaries", () => {
    assert.deepEqual(nextLagosDay({ year: 2026, month: 9, day: 30 }), { year: 2026, month: 10, day: 1 });
    assert.deepEqual(nextLagosDay({ year: 2026, month: 12, day: 31 }), { year: 2027, month: 1, day: 1 });
    assert.deepEqual(nextLagosDay({ year: 2028, month: 2, day: 28 }), { year: 2028, month: 2, day: 29 });
    assert.deepEqual(nextLagosDay({ year: 2028, month: 2, day: 29 }), { year: 2028, month: 3, day: 1 });
    assert.deepEqual(nextLagosDay({ year: 2027, month: 2, day: 28 }), { year: 2027, month: 3, day: 1 });
  });
});

describe("releaseIsDue() — due, which is not the same as available (D-09c)", () => {
  const captured = new Date("2026-09-21T14:00:00+01:00"); // due 2026-09-22T04:00Z

  it("is false right up to the boundary", () => {
    assert.equal(releaseIsDue(captured, new Date("2026-09-22T03:59:59Z")), false);
  });

  it("is true at the boundary itself", () => {
    assert.equal(releaseIsDue(captured, new Date("2026-09-22T04:00:00Z")), true);
  });

  it("is true afterwards", () => {
    assert.equal(releaseIsDue(captured, new Date("2026-09-30T00:00:00Z")), true);
  });

  it("takes `now` as an argument rather than reading a clock", () => {
    // packages/domain forbids Date.now(). A settlement rule that reads the clock
    // itself cannot be tested at a boundary, and every case above IS a boundary.
    const source = releaseIsDue.toString();
    assert.ok(!source.includes("Date.now"), "releaseIsDue must not read the clock");
  });

  it("refuses an invalid `now`", () => {
    assert.throws(() => releaseIsDue(captured, new Date("nonsense")), SettlementError);
  });
});
