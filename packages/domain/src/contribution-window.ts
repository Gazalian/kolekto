/**
 * contribution-window.ts — when a collection accepts contributions.
 *
 * **D-29, 2026-11-11.** A collection opens and closes on **calendar dates in
 * Africa/Lagos**, with no time of day:
 *
 *   · open from **00:00 Lagos** on the opening date (inclusive)
 *   · open **through the end of** the closing date — i.e. until 00:00 Lagos
 *     the following day (exclusive)
 *   · either date may be absent (`null`); absent open means "from publish",
 *     absent close means "until the host closes it"
 *   · same-day open and close is allowed (a one-day window)
 *
 * Enforced when a payment is **started**. A payment started inside the window
 * and completed after it is still recorded — money already taken is never
 * refused by this check (the orchestrator captures and either `completed`s or
 * `needs_review`s, per the money-architecture doc).
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ─────────────────────────────────────
 *
 * The previous shape stored a `timestamptz` entered through a `datetime-local`
 * input with no explicit zone. The server's default zone, whatever it was,
 * decided when the collection actually closed. Two consequences: an identical
 * form ran at two different clocks on local and staging, and nothing enforced
 * the window at payment time in the first place.
 *
 * This module gives the rule one place to live. Pure, total, no hidden clock
 * (packages/domain forbids `Date.now()`, and the caller passes `now`). The SQL
 * check inside `app.create_payment_attempt` mirrors this function against the
 * same fields, so a server action and the database can disagree about many
 * things but not about whether the collection is open.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * Africa/Lagos. Lagos is UTC+01:00 with no DST (assumption A-1 in financial
 * decisions). `lagosDateOf` in settlement.ts resolves the zone through the
 * IANA name, so if that ever stops being true the settlement tests (and these
 * tests) fail rather than quietly shifting the window boundary by an hour.
 */

import { lagosDateOf, nextLagosDay, type LagosDate } from "./settlement.ts";

/** A calendar date in Lagos, as the host typed it. "2026-11-30". */
export type CalendarDate = string;

/** The YYYY-MM-DD format a `<input type="date">` produces and a `date` column stores. */
const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class ContributionWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionWindowError";
  }
}

/**
 * Why a collection is not open, when it is not open. `reason` is a vocabulary
 * the UI can translate; no English leaks into the model, because the public
 * page shows the dates themselves next to its own words.
 */
export type ContributionWindowClosed =
  | { readonly reason: "not_yet_open"; readonly opensOn: CalendarDate }
  | { readonly reason: "closed"; readonly closedOn: CalendarDate };

export type ContributionWindowStatus =
  | { readonly open: true }
  | ({ readonly open: false } & ContributionWindowClosed);

/**
 * Whether a collection is accepting contributions right now.
 *
 * `opensOn` and `closesOn` are YYYY-MM-DD strings in Africa/Lagos. `null` means
 * the corresponding boundary does not exist.
 *
 * Both endpoints are **inclusive by day**: a close on 2026-11-30 accepts
 * contributions at 23:59:59.999 Lagos on that day, and refuses them at
 * 00:00:00 Lagos on 2026-12-01.
 *
 * Throws `ContributionWindowError` only when the inputs cannot describe any
 * window at all — a malformed date string, an invalid `now`, or a `closesOn`
 * strictly before `opensOn`. "Not open yet" and "closed" are not errors; they
 * are statuses, because that is what every caller actually wants to know.
 */
export function isOpenForContributions(
  opensOn: CalendarDate | null,
  closesOn: CalendarDate | null,
  now: Date,
): ContributionWindowStatus {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ContributionWindowError(
      "isOpenForContributions() received something that is not a valid Date. The window is never evaluated from an unparsed value.",
    );
  }

  const opens = opensOn === null ? null : parseIsoDate(opensOn, "opensOn");
  const closes = closesOn === null ? null : parseIsoDate(closesOn, "closesOn");

  if (opens !== null && closes !== null && compareLagosDates(closes, opens) < 0) {
    throw new ContributionWindowError(
      `A collection's closing date (${closesOn}) cannot be before its opening date (${opensOn}).`,
    );
  }

  const today = lagosDateOf(now);

  if (opens !== null && compareLagosDates(today, opens) < 0) {
    return { open: false, reason: "not_yet_open", opensOn: formatLagosDate(opens) };
  }

  // A closes-on of 2026-11-30 means the window is open through all of 2026-11-30.
  // The window closes at 00:00 Lagos on the following day — i.e. when today's
  // Lagos date is strictly AFTER closesOn.
  if (closes !== null && compareLagosDates(today, closes) > 0) {
    return { open: false, reason: "closed", closedOn: formatLagosDate(closes) };
  }

  return { open: true };
}

/**
 * The instant (UTC) at which a collection closes, for callers that need to
 * reason about "when does it close?" in UTC — a reminder worker, a display
 * line like "closes in 3 hours". `null` when the collection has no closing
 * date.
 *
 * Returns the **next day's 00:00 Lagos**, because the window includes all of
 * the closing date. A collection closing on 2026-11-30 closes at
 * 2026-12-01T00:00:00 Lagos, which is 2026-11-30T23:00:00 UTC.
 */
export function closesAt(closesOn: CalendarDate | null): Date | null {
  if (closesOn === null) return null;
  const date = parseIsoDate(closesOn, "closesOn");
  const next = nextLagosDay(date);
  // Lagos is UTC+1 with no DST; 00:00 Lagos is 23:00 UTC the previous day.
  // This is proven by the settlement tests, which compute availability through
  // the same zone; this helper never computes availability, only the close
  // moment, so it does not need the full offset-correction dance.
  return new Date(Date.UTC(next.year, next.month - 1, next.day - 1, 23, 0, 0, 0));
}

function parseIsoDate(value: string, field: string): LagosDate {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new ContributionWindowError(
      `${field} must be YYYY-MM-DD, got ${JSON.stringify(value)}. A collection's dates are not derived from a parse of some other format.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // The regex pins the format but not calendar reality. 2026-02-30 and 2025-02-29
  // both pass the shape, and neither is a date. Round-trip through UTC: the JS
  // Date constructor silently rolls forward (2026-02-30 → 2026-03-02), so a
  // valid date is one whose constructed Date reads back identically.
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new ContributionWindowError(
      `${field} must be a real calendar date, got ${JSON.stringify(value)}.`,
    );
  }

  return { year, month, day };
}

function compareLagosDates(a: LagosDate, b: LagosDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function formatLagosDate(date: LagosDate): CalendarDate {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}
