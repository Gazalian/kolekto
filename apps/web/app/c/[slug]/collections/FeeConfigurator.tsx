"use client";

import { useState } from "react";
import { calculateFees, formatNaira, fromNaira, SCHEDULE_2026_09_PROVISIONAL, type Kobo } from "@kolekto/domain";
import { Banner } from "@kolekto/ui";

/**
 * Who bears the fees (M7.7 Parts 2 and 3).
 *
 * ── ONE IMPLEMENTATION, DELIBERATELY ────────────────────────────────────────
 *
 * This is the only fee control in the product and the only place a breakdown
 * is rendered. Every flow — fixed, open, packages, items, tickets,
 * fundraising, recurring — mounts this same component. Seven copies with seven
 * sets of rounding is exactly how the previous system ended up telling an
 * organiser ₦200 of fees on one screen and ₦350 on another for the same
 * ₦10,000 collection (audit F8).
 *
 * ── WHAT THIS STORES, AND WHAT IT DOES NOT DECIDE ───────────────────────────
 *
 * The creation flow stores one thing: the organiser's chosen POLICY, in
 * `collections.fee_mode`. It does not store an amount, a fee, or a net. When
 * Phase 4 exists it will compute the actual figures from the authoritative
 * schedule at the time of payment, and record the schedule version alongside
 * them.
 *
 * ── WHY THE HEADLINE SAYS "APPLICABLE FEES" ─────────────────────────────────
 *
 * Kolekto's production fee schedule is NOT finalised — that is DEC-11, and
 * whether a platform fee may lawfully be passed to a contributor at all is
 * DEC-12, a legal question. `SCHEDULE_2026_09_PROVISIONAL` is what the
 * previous system charged, carried across so the arithmetic could be tested
 * against known behaviour. Printing figures from it as though they were
 * settlement amounts would be inventing pricing the business has not
 * committed to.
 *
 * So the default presentation is the honest one:
 *
 *     Contributor pays   ₦10,000 + applicable fees
 *     You receive        ₦10,000
 *
 * The computed split is still available, because an organiser deciding
 * whether to absorb fees is entitled to see the shape of the arithmetic — but
 * only behind an explicit disclosure that names the schedule version and says
 * it is an estimate, not a settlement amount.
 *
 * ── THE ARITHMETIC IS NOT HERE ──────────────────────────────────────────────
 *
 * No rate appears in this file. `calculateFees` from `@kolekto/domain` is the
 * single authority — integer kobo, rates as basis points, rounding half away
 * from zero applied exactly once per fee, each fee capped independently, and
 * golden-vector tested. Two properties that matter are the domain's, not this
 * component's:
 *
 *   · fees are calculated on the CONTRIBUTION, never on the payable, so a
 *     contributor-borne total cannot inflate recursively
 *   · each fee is capped independently
 *
 * ── THIS IS NOT A CHARGE ────────────────────────────────────────────────────
 *
 * Phase 4 is not implemented. Nothing here initiates a payment, records a
 * contribution or posts to a ledger.
 */

export type FeeBearerChoice = "contributor_pays" | "community_absorbs";

/** One amount worth illustrating, named the way the organiser named it. */
export interface FeePreviewAmount {
  readonly label: string;
  /** In naira, as typed. Blank or unparseable amounts are skipped. */
  readonly naira: string;
}

export function FeeConfigurator({
  bearer,
  onBearerChange,
  category,
  amounts,
  contributionNoun,
  organiserNoun = "You",
  disabled = false,
}: {
  bearer: FeeBearerChoice;
  onBearerChange: (bearer: FeeBearerChoice) => void;
  /** The collection's category — the platform rate can differ by it. */
  category: string;
  /** What to illustrate. One row for a fixed amount; one per package, item or ticket type. */
  amounts: readonly FeePreviewAmount[];
  /** "contribution", "donation", "order", "ticket purchase" — the flow's own word. */
  contributionNoun: string;
  organiserNoun?: string;
  disabled?: boolean;
}) {
  const [showEstimate, setShowEstimate] = useState(false);

  const priced = amounts
    .map((entry) => {
      const kobo = safeKobo(entry.naira);
      return kobo === null ? null : { label: entry.label, kobo };
    })
    .filter((entry): entry is { label: string; kobo: Kobo } => entry !== null);

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-[var(--color-text)]">Who should cover payment fees?</legend>

        <label
          className={
            bearer === "contributor_pays"
              ? "mt-1 flex cursor-pointer gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
              : "mt-1 flex cursor-pointer gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)]"
          }
        >
          <input
            type="radio"
            name="fee-bearer"
            className="mt-0.5 h-4 w-4"
            checked={bearer === "contributor_pays"}
            disabled={disabled}
            onChange={() => onBearerChange("contributor_pays")}
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-[var(--color-text)]">Contributor pays</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              The contributor pays the {contributionNoun} amount plus applicable fees.
            </span>
          </span>
        </label>

        <label
          className={
            bearer === "community_absorbs"
              ? "flex cursor-pointer gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
              : "flex cursor-pointer gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 hover:border-[var(--color-border-strong)]"
          }
        >
          <input
            type="radio"
            name="fee-bearer"
            className="mt-0.5 h-4 w-4"
            checked={bearer === "community_absorbs"}
            disabled={disabled}
            onChange={() => onBearerChange("community_absorbs")}
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-[var(--color-text)]">{organiserNoun} absorb fees</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              Contributors pay the {contributionNoun} amount. Applicable fees are deducted from what you receive.
            </span>
          </span>
        </label>
      </fieldset>

      {priced.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Set an amount and an example appears here.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {priced.map((entry) => (
            <PolicyExample
              key={entry.label}
              label={priced.length > 1 ? entry.label : null}
              amount={entry.kobo}
              bearer={bearer}
              organiserNoun={organiserNoun}
            />
          ))}
        </div>
      )}

      {priced.length > 0 && (
        <div>
          <button
            type="button"
            className="text-sm font-medium text-[var(--color-primary)] hover:underline"
            aria-expanded={showEstimate}
            onClick={() => setShowEstimate((open) => !open)}
          >
            {showEstimate ? "Hide the estimate" : "Show an estimate of the fees"}
          </button>

          {showEstimate && (
            <div className="mt-2 flex flex-col gap-3">
              <Banner tone="info">
                An estimate only, using Kolekto&apos;s provisional rates ({SCHEDULE_2026_09_PROVISIONAL.version}).
                These are not final and this is not a settlement amount — what is actually charged is calculated at
                the time of payment, and online payment is not switched on yet.
              </Banner>

              {priced.map((entry) => (
                <FeeEstimate
                  key={entry.label}
                  label={priced.length > 1 ? entry.label : null}
                  amount={entry.kobo}
                  category={category}
                  bearer={bearer}
                  organiserNoun={organiserNoun}
                  contributionNoun={contributionNoun}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <Banner tone="info">
        This choice is saved with the {contributionNoun === "donation" ? "campaign" : "collection"} as your fee
        policy. Nothing has been charged and nothing will be until online payment is switched on.
      </Banner>
    </div>
  );
}

/**
 * What the chosen policy means, without asserting a figure.
 *
 * The only number here is the organiser's own amount. Everything else is
 * "applicable fees", which is precisely as much as Kolekto can honestly say
 * before DEC-11 fixes the schedule.
 */
function PolicyExample({
  label,
  amount,
  bearer,
  organiserNoun,
}: {
  label: string | null;
  amount: Kobo;
  bearer: FeeBearerChoice;
  organiserNoun: string;
}) {
  const figure = naira(amount);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      {label && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      )}
      <dl className="flex flex-col gap-1 text-sm">
        <Line term="Contributor pays" value={bearer === "contributor_pays" ? `${figure} + applicable fees` : figure} />
        <Line
          term={`${organiserNoun} receive`}
          value={bearer === "contributor_pays" ? figure : `${figure} − applicable fees`}
        />
      </dl>
    </div>
  );
}

/**
 * The computed split, shown only when the organiser asks for it.
 *
 * The two fees are named separately and never summed into a single "fee"
 * line: one is the payment processor's and one is Kolekto's, and somebody
 * deciding whether to absorb them is entitled to know which is which.
 */
function FeeEstimate({
  label,
  amount,
  category,
  bearer,
  organiserNoun,
  contributionNoun,
}: {
  label: string | null;
  amount: Kobo;
  category: string;
  bearer: FeeBearerChoice;
  organiserNoun: string;
  contributionNoun: string;
}) {
  const fees = calculateFees({
    amount,
    category,
    bearer: bearer === "contributor_pays" ? "contributor" : "community",
  });

  return (
    <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] p-3">
      {label && (
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{label}</p>
      )}

      <dl className="flex flex-col gap-1 text-sm">
        <Line term={`${capitalise(contributionNoun)} amount`} value={naira(fees.contribution)} />
        <Line term="Estimated payment processing fee" value={naira(fees.gatewayFee)} muted />
        <Line term="Estimated Kolekto service fee" value={naira(fees.platformFee)} muted />
        <Line term="Estimated total fees" value={naira(fees.totalFees)} muted />

        <div className="mt-1 border-t border-[var(--color-border)] pt-2">
          <Line term="Contributor would pay" value={naira(fees.totalPayable)} strong />
          <Line term={`${organiserNoun} would receive`} value={naira(fees.net)} strong />
        </div>
      </dl>
    </div>
  );
}

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function Line({
  term,
  value,
  muted = false,
  strong = false,
}: {
  term: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-3">
      <dt className={muted ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}>{term}</dt>
      <dd
        className={
          strong
            ? "font-semibold text-[var(--color-text)]"
            : muted
              ? "text-[var(--color-text-muted)]"
              : "font-medium text-[var(--color-text)]"
        }
      >
        {value}
      </dd>
    </div>
  );
}

const naira = (value: Kobo): string => formatNaira(value, { decimals: false });

/**
 * Naira as typed, to kobo — or null.
 *
 * `fromNaira` throws on anything it cannot read, which is correct for a money
 * path and wrong for a field somebody is still halfway through typing. A
 * half-typed amount should show no example, not an error.
 */
function safeKobo(input: string): Kobo | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  try {
    const value = fromNaira(trimmed);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** The schedule any estimate is computed against. Named so a screen can say which one. */
export const PREVIEW_SCHEDULE_VERSION = SCHEDULE_2026_09_PROVISIONAL.version;
