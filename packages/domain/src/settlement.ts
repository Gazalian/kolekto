/**
 * settlement.ts — when captured money becomes available.
 *
 * D-09: **T+1 means the next calendar day. Every day.**
 *
 * A successfully captured payment becomes available at **05:00 Africa/Lagos on
 * the following calendar day.**
 *
 *   Monday 14:00      → Tuesday 05:00
 *   Friday 23:00      → Saturday 05:00
 *   Saturday 10:00    → Sunday 05:00
 *   Sunday 23:59      → Monday 05:00
 *
 * It is not business-day settlement. It is not weekday-only. It is not "24
 * hours after payment". It is not "the next settlement run".
 *
 * ── WHY THIS IS A PURE FUNCTION AND NOT A QUERY ─────────────────────────────
 *
 * The previous system computed availability as `created_at < getSettlementCutoff()`
 * — a comparison against the clock, evaluated at read time, in more than one
 * place, by more than one executor, one of which was gated on an environment
 * variable and one of which was a database function not in the repository. A
 * payment that had aged past the cutoff was available *in theory* and pending
 * *in the cache*, and which one an operator saw depended on whether a refresh
 * had happened.
 *
 * So the rule is split in two, and the split is the design:
 *
 *   · `availableAt(capturedAt)` — THIS FILE. When a release becomes DUE.
 *     Deterministic, total, testable, and the same answer for ever.
 *   · a `balance_release` journal  — LATER MILESTONE. That it HAPPENED.
 *
 * Money is available because a journal says so, never because this function
 * says the time has passed (D-09c). If the release job has not run, nothing is
 * available, and the absence is visible rather than inferred.
 *
 * ── NO HIDDEN CLOCK ─────────────────────────────────────────────────────────
 *
 * `packages/domain` forbids `Date.now()`. A caller passes `now` when it needs
 * one. A settlement rule that reads the clock itself cannot be tested at a
 * boundary, and every interesting case here IS a boundary.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * `Africa/Lagos`, explicitly (D-09b). Lagos is UTC+01:00 and has never observed
 * daylight saving, so the offset is in practice constant — but this file
 * resolves it through the IANA zone rather than hardcoding `+01:00`, so if that
 * ever stops being true the tests fail instead of the availability dates
 * quietly shifting by an hour (assumption A-1).
 */

/** The zone every settlement boundary is computed in. */
export const SETTLEMENT_TIMEZONE = "Africa/Lagos";

/** The hour, in `SETTLEMENT_TIMEZONE`, at which the following day's release becomes due. */
export const SETTLEMENT_HOUR = 5;

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/** A calendar date in `SETTLEMENT_TIMEZONE`. Not an instant — a date somebody in Lagos would name. */
export interface LagosDate {
  readonly year: number;
  /** 1–12. Not the 0–11 a `Date` would give, because an off-by-one month is a silent error. */
  readonly month: number;
  /** 1–31. */
  readonly day: number;
}

const LAGOS_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: SETTLEMENT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface LagosClock extends LagosDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** What the wall clock in Lagos read at a given instant. */
function lagosClock(at: Date): LagosClock {
  const parts = new Map(LAGOS_PARTS.formatToParts(at).map((p) => [p.type, p.value]));

  const read = (key: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.get(key);
    if (value === undefined) {
      throw new SettlementError(`Africa/Lagos time could not be resolved: the runtime gave no ${key}.`);
    }
    return Number(value);
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The UTC instant of a given wall-clock time in Lagos.
 *
 * Found by correcting a UTC guess by the zone's offset at that guess. One
 * correction is enough for a fixed-offset zone; the assertion that follows is
 * what would catch it not being enough, rather than trusting that it is.
 */
function lagosInstant(date: LagosDate, hour: number): Date {
  const guess = new Date(Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0, 0));
  const atGuess = lagosClock(guess);

  const wanted = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0, 0);
  const shown = Date.UTC(atGuess.year, atGuess.month - 1, atGuess.day, atGuess.hour, atGuess.minute, atGuess.second, 0);

  const corrected = new Date(guess.getTime() - (shown - wanted));

  // A-1: if Lagos ever gains daylight saving, a single correction can land on
  // the wrong side of a transition. Refuse loudly rather than return an
  // availability timestamp that is an hour out.
  const check = lagosClock(corrected);
  if (
    check.year !== date.year ||
    check.month !== date.month ||
    check.day !== date.day ||
    check.hour !== hour ||
    check.minute !== 0 ||
    check.second !== 0
  ) {
    throw new SettlementError(
      `Could not resolve ${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")} ` +
        `${String(hour).padStart(2, "0")}:00 in ${SETTLEMENT_TIMEZONE}. ` +
        `This means the zone no longer has a fixed offset — the settlement rule needs revisiting, not working around.`,
    );
  }

  return corrected;
}

/** The calendar date in Lagos on which a given instant falls. */
export function lagosDateOf(at: Date): LagosDate {
  assertValidDate(at, "lagosDateOf");
  const { year, month, day } = lagosClock(at);
  return { year, month, day };
}

/** The calendar day after a Lagos date. Handles month, year and leap-year boundaries. */
export function nextLagosDay(date: LagosDate): LagosDate {
  // Built through UTC arithmetic on a date-only value, which has no zone and no
  // DST, so "the next day" cannot be 23 or 25 hours by accident.
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

/**
 * When money captured at `capturedAt` becomes available.
 *
 * **05:00 Africa/Lagos on the following calendar day, every day of the week.**
 *
 * The rule takes the calendar date in Lagos on which the capture happened,
 * advances it by exactly one day, and returns 05:00 on that day. The capture's
 * own time of day is irrelevant beyond which Lagos date it fell on — which is
 * why a payment at 00:00 and a payment at 23:59 on the same Lagos day both
 * become available at the same moment, and a payment at 05:00 does not become
 * available later that same morning.
 *
 * Returns an instant (UTC), because that is what a timestamp column stores.
 */
export function availableAt(capturedAt: Date): Date {
  assertValidDate(capturedAt, "availableAt");
  return lagosInstant(nextLagosDay(lagosDateOf(capturedAt)), SETTLEMENT_HOUR);
}

/**
 * Whether a release is DUE — never whether money is available.
 *
 * Availability is a posted journal (D-09c). This answers only "should the
 * release job have acted by now?", which is what a release job asks and what a
 * monitor checking for an overdue release asks. Nothing that authorises money
 * may call it.
 */
export function releaseIsDue(capturedAt: Date, now: Date): boolean {
  assertValidDate(now, "releaseIsDue");
  return now.getTime() >= availableAt(capturedAt).getTime();
}

function assertValidDate(value: Date, caller: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SettlementError(
      `${caller}() received something that is not a valid Date. A settlement boundary is never computed from an unparsed value.`,
    );
  }
}
