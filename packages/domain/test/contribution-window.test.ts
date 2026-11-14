import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  closesAt,
  ContributionWindowError,
  isOpenForContributions,
} from "../src/contribution-window.ts";

/**
 * D-29, 2026-11-11: opening and closing are **calendar dates in Africa/Lagos**,
 * with no time of day. Lagos is UTC+01:00 with no DST; every boundary vector
 * below is expressed as an instant whose relationship with 00:00 Lagos on each
 * date is explicit.
 *
 *   Africa/Lagos 00:00  =  UTC 23:00 the previous day
 *   Africa/Lagos 23:59  =  UTC 22:59 the same day
 *
 * Boundaries matter more than any other case here — the previous shape stored
 * these as timestamps without a zone, so the boundary silently moved by an
 * hour between servers. The vectors below pin the boundary against the IANA
 * zone, so if Lagos ever gains DST the tests fail rather than the window
 * quietly shifting.
 */

// Helpers: pin the instant through UTC so the expectation is unambiguous.
const atUtc = (iso: string) => new Date(iso);

describe("isOpenForContributions() — D-29, Africa/Lagos calendar dates", () => {
  it("is open with no dates set, at any plausible instant", () => {
    const anytime = atUtc("2026-11-11T12:00:00Z");
    assert.deepEqual(isOpenForContributions(null, null, anytime), { open: true });
  });

  describe("opens_on only — opens AT 00:00 Lagos on the opening date", () => {
    it("is not yet open at 22:59 UTC the day before (23:59 Lagos the day before)", () => {
      const justBefore = atUtc("2026-11-30T22:59:59Z"); // 2026-11-30 23:59:59 Lagos
      assert.deepEqual(isOpenForContributions("2026-12-01", null, justBefore), {
        open: false,
        reason: "not_yet_open",
        opensOn: "2026-12-01",
      });
    });

    it("is open at 23:00 UTC the day before (00:00 Lagos on the opening date)", () => {
      const atBoundary = atUtc("2026-11-30T23:00:00Z"); // 2026-12-01 00:00 Lagos
      assert.deepEqual(isOpenForContributions("2026-12-01", null, atBoundary), { open: true });
    });

    it("is open for the whole opening day", () => {
      const noonLagos = atUtc("2026-12-01T11:00:00Z"); // 12:00 Lagos
      assert.deepEqual(isOpenForContributions("2026-12-01", null, noonLagos), { open: true });
    });
  });

  describe("closes_on only — open THROUGH the end of the closing date", () => {
    it("is open at 22:59 UTC on the closing date (23:59 Lagos — last minute of the window)", () => {
      const lastMinute = atUtc("2026-11-30T22:59:59Z"); // 2026-11-30 23:59:59 Lagos
      assert.deepEqual(isOpenForContributions(null, "2026-11-30", lastMinute), { open: true });
    });

    it("is closed at 23:00 UTC on the closing date (00:00 Lagos the following day)", () => {
      const firstMomentAfter = atUtc("2026-11-30T23:00:00Z"); // 2026-12-01 00:00 Lagos
      assert.deepEqual(isOpenForContributions(null, "2026-11-30", firstMomentAfter), {
        open: false,
        reason: "closed",
        closedOn: "2026-11-30",
      });
    });

    it("is closed on every day after the closing date", () => {
      const twoDaysLater = atUtc("2026-12-02T12:00:00Z");
      assert.deepEqual(isOpenForContributions(null, "2026-11-30", twoDaysLater), {
        open: false,
        reason: "closed",
        closedOn: "2026-11-30",
      });
    });
  });

  describe("same-day open and close — a one-day window", () => {
    const opens = "2026-11-30";
    const closes = "2026-11-30";

    it("refuses at 23:59 Lagos the previous day", () => {
      const before = atUtc("2026-11-29T22:59:59Z");
      const status = isOpenForContributions(opens, closes, before);
      assert.equal(status.open, false);
      assert.equal(status.open === false && status.reason, "not_yet_open");
    });

    it("accepts at 00:00 Lagos on the window day", () => {
      const start = atUtc("2026-11-29T23:00:00Z");
      assert.deepEqual(isOpenForContributions(opens, closes, start), { open: true });
    });

    it("accepts at 23:59 Lagos on the window day", () => {
      const end = atUtc("2026-11-30T22:59:59Z");
      assert.deepEqual(isOpenForContributions(opens, closes, end), { open: true });
    });

    it("refuses at 00:00 Lagos the day after", () => {
      const after = atUtc("2026-11-30T23:00:00Z");
      const status = isOpenForContributions(opens, closes, after);
      assert.equal(status.open, false);
      assert.equal(status.open === false && status.reason, "closed");
    });
  });

  describe("month and year boundaries", () => {
    it("handles the turn of a month", () => {
      // Window: Nov 30 → Dec 1. Last minute of Nov 30 is still open.
      const lastMinuteNov30 = atUtc("2026-11-30T22:59:59Z");
      assert.deepEqual(isOpenForContributions("2026-11-30", "2026-12-01", lastMinuteNov30), { open: true });

      // First minute of Dec 1 is still open; the window closes Dec 2 00:00 Lagos.
      const dec1Start = atUtc("2026-11-30T23:00:00Z");
      assert.deepEqual(isOpenForContributions("2026-11-30", "2026-12-01", dec1Start), { open: true });

      const dec2Start = atUtc("2026-12-01T23:00:00Z");
      const status = isOpenForContributions("2026-11-30", "2026-12-01", dec2Start);
      assert.equal(status.open, false);
    });

    it("handles the turn of a year", () => {
      const end = atUtc("2026-12-31T22:59:59Z"); // 2026-12-31 23:59 Lagos
      assert.deepEqual(isOpenForContributions(null, "2026-12-31", end), { open: true });

      const newYear = atUtc("2026-12-31T23:00:00Z"); // 2027-01-01 00:00 Lagos
      const after = isOpenForContributions(null, "2026-12-31", newYear);
      assert.equal(after.open, false);
    });

    it("handles 29 February on a leap year as a regular Lagos day", () => {
      // 2028 is a leap year. Window: Feb 28 → Feb 29. Each day gets its own
      // full 24-hour window, measured through the Lagos calendar.
      const feb28Noon = atUtc("2028-02-28T11:00:00Z");
      assert.deepEqual(isOpenForContributions("2028-02-28", "2028-02-29", feb28Noon), { open: true });

      const feb29LastMinute = atUtc("2028-02-29T22:59:59Z");
      assert.deepEqual(isOpenForContributions("2028-02-28", "2028-02-29", feb29LastMinute), { open: true });

      const mar1Start = atUtc("2028-02-29T23:00:00Z");
      const status = isOpenForContributions("2028-02-28", "2028-02-29", mar1Start);
      assert.equal(status.open, false);
    });
  });

  describe("refusals that are errors, not statuses", () => {
    it("refuses closes_on before opens_on", () => {
      assert.throws(
        () => isOpenForContributions("2026-12-02", "2026-12-01", atUtc("2026-11-11T12:00:00Z")),
        ContributionWindowError,
      );
    });

    it("refuses a malformed date", () => {
      assert.throws(
        () => isOpenForContributions("2026-13-01", null, atUtc("2026-11-11T12:00:00Z")),
        ContributionWindowError,
      );
      assert.throws(
        () => isOpenForContributions("not-a-date", null, atUtc("2026-11-11T12:00:00Z")),
        ContributionWindowError,
      );
      // No timestamp input — a collection's open/close is a DATE, not a timestamp.
      assert.throws(
        () => isOpenForContributions("2026-12-01T00:00:00Z" as unknown as string, null, atUtc("2026-11-11T12:00:00Z")),
        ContributionWindowError,
      );
    });

    it("refuses an invalid `now`", () => {
      assert.throws(
        () =>
          isOpenForContributions("2026-11-11", null, new Date("not-a-date")),
        ContributionWindowError,
      );
    });

    it("takes `now` as an argument rather than reading a clock", () => {
      // The function must never depend on the ambient clock. Two calls at the
      // same `now` always return the same status, and no non-`now` state
      // changes between them.
      const now = atUtc("2026-11-11T12:00:00Z");
      const once = isOpenForContributions("2026-11-01", "2026-12-31", now);
      const again = isOpenForContributions("2026-11-01", "2026-12-31", now);
      assert.deepEqual(once, again);
    });
  });
});

describe("closesAt() — when does the collection close, in UTC", () => {
  it("returns null when there is no closing date", () => {
    assert.equal(closesAt(null), null);
  });

  it("returns the next day at 00:00 Lagos (23:00 UTC the previous day)", () => {
    const closes = closesAt("2026-11-30");
    assert.ok(closes instanceof Date);
    assert.equal(closes!.toISOString(), "2026-11-30T23:00:00.000Z");
  });

  it("agrees with isOpenForContributions at its own boundary", () => {
    const boundary = closesAt("2026-11-30")!;
    // `boundary` itself is 00:00 Lagos the next day — closed.
    assert.equal(isOpenForContributions(null, "2026-11-30", boundary).open, false);

    // One millisecond earlier is 23:59:59.999 Lagos — still open.
    const oneMsBefore = new Date(boundary.getTime() - 1);
    assert.equal(isOpenForContributions(null, "2026-11-30", oneMsBefore).open, true);
  });

  it("handles month-end cleanly (Nov 30 → Dec 1)", () => {
    const closes = closesAt("2026-11-30");
    assert.equal(closes!.toISOString(), "2026-11-30T23:00:00.000Z");
  });

  it("refuses a malformed date", () => {
    assert.throws(() => closesAt("2026-02-30"), ContributionWindowError);
    assert.throws(() => closesAt("badly-formed"), ContributionWindowError);
  });
});
