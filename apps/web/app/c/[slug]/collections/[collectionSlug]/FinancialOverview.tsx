import { Banner } from "@kolekto/ui";
import type { ReactNode } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import { nairaText, type OverviewView } from "./contributor-register.ts";
import type { ExpectedView } from "./money-view.ts";

/**
 * The collection's money at a glance: exactly four figures.
 *
 *   Total raised       every successful payment, before fees (contributions)
 *   Available balance  net money released by the automatic T+1 step (ledger)
 *   Pending balance    net money from successful payments not yet released (ledger)
 *   Total withdrawn    completed payouts (ledger)
 *
 * They are NOT four slices of one total: Total raised is gross, the balances
 * are net of fees, and money on hold or being withdrawn sits in neither
 * balance. "How these figures fit together" shows the bridge, every line from
 * the database. This component formats kobo strings and does no arithmetic on
 * money, so the screen cannot disagree with the record.
 */
export function FinancialOverview({
  overview,
  target,
  expected,
  peopleLabel,
  withdrawAction,
  pendingNote,
}: {
  overview: OverviewView;
  /** The collection's target, in kobo, when it has one. */
  target: string | null;
  /** Who is expected to pay; null when this collection has no expected list. */
  expected: ExpectedView | null;
  /** "Members", "Attendees"… — what the people on this collection's list are called. */
  peopleLabel: string;
  /** The Withdraw button and its explanation, under Available. */
  withdrawAction?: ReactNode;
  /** When the next pending money becomes available, if known. */
  pendingNote?: string | null;
}) {
  // Progress in tenths of a percent, in integer arithmetic: the amounts never
  // become floating point, only the finished percentage becomes text.
  const tenths =
    target && BigInt(target) > 0n ? (BigInt(overview.totalRaisedKobo) * 1000n) / BigInt(target) : null;
  const progress =
    tenths === null
      ? null
      : { text: `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}`, bar: `${(tenths > 1000n ? 1000n : tenths) / 10n}` };

  const balances = overview.canViewBalances;

  return (
    <section aria-labelledby="financial-overview-heading" className="flex flex-col gap-4">
      <h2 id="financial-overview-heading" className="sr-only">
        Money
      </h2>

      <div className="overflow-hidden rounded-[var(--radius-lg,var(--radius-md))] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="grid grid-cols-1 divide-y divide-[var(--color-border)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
          <Figure
            label="Total raised"
            value={nairaText(overview.totalRaisedKobo)}
            hint={
              overview.contributionCount === 0
                ? "No successful payments yet"
                : `${overview.contributionCount.toLocaleString()} successful ${overview.contributionCount === 1 ? "payment" : "payments"}, before fees`
            }
            className="sm:border-b sm:border-r lg:border-b-0"
          />
          {balances ? (
            <>
              <Figure
                label="Available balance"
                value={nairaText(overview.availableKobo ?? "0")}
                hint="Ready to withdraw now"
                accent
                className="sm:border-b lg:border-b-0 lg:border-r"
              >
                {withdrawAction}
              </Figure>
              <Figure
                label="Pending balance"
                value={nairaText(overview.pendingKobo ?? "0")}
                hint={pendingNote ?? "Successfully received, becoming available for withdrawal after the T+1 period"}
                className="sm:border-r"
              />
              <Figure label="Total withdrawn" value={nairaText(overview.withdrawnKobo ?? "0")} hint="Paid out to your bank" />
            </>
          ) : (
            <div className="flex items-center p-4 text-xs text-[var(--color-text-muted)] sm:col-span-1 lg:col-span-3">
              Balances and withdrawals are visible to officers with the balance permission.
            </div>
          )}
        </div>

        {progress !== null && target && (
          <div className="flex flex-col gap-1.5 border-t border-[var(--color-border)] px-4 py-3">
            <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
              <span>{progress.text}% of the target</span>
              <span className="tabular-nums">{nairaText(target)}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg)]"
              role="progressbar"
              aria-label="Progress towards target"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${progress.text}%`}
            >
              <div className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-500" style={{ width: `${progress.bar}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* People: who has paid. Basic statistics, not money figures. */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {expected ? (
          <>
            <Stat label={`${peopleLabel} expected`} value={expected.expectedCount.toLocaleString()} hint={expected.exemptCount > 0 ? `${expected.exemptCount} exempt` : undefined} />
            <Stat label="Paid" value={expected.paidCount.toLocaleString()} tone="success" />
            <Stat
              label="Yet to pay"
              value={(expected.unpaidCount + expected.partlyPaidCount).toLocaleString()}
              tone={expected.unpaidCount + expected.partlyPaidCount > 0 ? "warning" : undefined}
              hint={expected.partlyPaidCount > 0 ? `${expected.partlyPaidCount} partly paid` : undefined}
            />
            <Stat
              label="Still expected"
              value={`${expected.outstandingComplete ? "" : "≥ "}${nairaText(expected.outstandingKobo)}`}
              hint="Not yet paid, not money received"
            />
          </>
        ) : (
          <>
            <Stat label="Contributors" value={overview.contributorCount.toLocaleString()} hint="Unique people" />
            <Stat label="Payments" value={overview.contributionCount.toLocaleString()} />
            <Stat
              label="Last payment"
              value={overview.lastContributionAt ? formatDistanceToNow(overview.lastContributionAt) : "—"}
            />
            <Stat label="Fees" value={nairaText(overview.feesDeductedKobo)} hint="Deducted from contributions" />
          </>
        )}
      </dl>

      {balances && (
        <details className="group rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-[var(--color-text)] [&::-webkit-details-marker]:hidden">
            How these figures fit together
            <span className="text-xs text-[var(--color-text-muted)] group-open:hidden">Show</span>
            <span className="hidden text-xs text-[var(--color-text-muted)] group-open:inline">Hide</span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-4 py-3">
            <dl className="flex flex-col text-sm">
              <Bridge label="Total raised (what contributors paid towards the collection)" value={overview.totalRaisedKobo} />
              <Bridge label="Fees deducted" value={overview.feesDeductedKobo} sign="−" />
              <Bridge label="Credited to the collection" value={overview.netRaisedKobo} total />
            </dl>
            <p className="text-xs text-[var(--color-text-muted)]">The credited money is in one of these places:</p>
            <dl className="flex flex-col text-sm">
              <Bridge label="Pending balance" value={overview.pendingKobo ?? "0"} />
              <Bridge label="Available balance" value={overview.availableKobo ?? "0"} />
              {overview.withdrawingKobo && overview.withdrawingKobo !== "0" && (
                <Bridge label="Being withdrawn" value={overview.withdrawingKobo} />
              )}
              {overview.onHoldKobo && overview.onHoldKobo !== "0" && <Bridge label="On hold" value={overview.onHoldKobo} />}
              <Bridge label="Total withdrawn" value={overview.withdrawnKobo ?? "0"} />
            </dl>
            <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
              A payment counts in Total raised the moment the payment provider confirms it. Its amount after fees waits
              in the Pending balance until the T+1 period has passed and the provider has released the funds, then Kolekto
              moves it to your Available balance automatically. When the contributor pays the fees, nothing is deducted
              from the collection; each payment&apos;s fees are shown in Activity.
            </p>
          </div>
        </details>
      )}

      {overview.underReviewCount > 0 && (
        <Banner tone="info">
          {overview.underReviewCount === 1 ? "One payment is" : `${overview.underReviewCount} payments are`} being checked by
          Kolekto. {overview.underReviewCount === 1 ? "It is" : "They are"} not in any figure above until the check is finished.
        </Banner>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
  accent = false,
  className = "",
  children,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`relative flex flex-col gap-1 border-[var(--color-border)] p-4 ${className}`}>
      {accent && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-[var(--color-primary)]" />}
      <p className="text-xs font-medium text-[var(--color-text-muted)]">{label}</p>
      <p
        className={`text-2xl font-semibold tracking-tight tabular-nums ${accent ? "text-[var(--color-primary-strong,var(--color-text))]" : "text-[var(--color-text)]"}`}
      >
        {value}
      </p>
      <p className="text-xs leading-snug text-[var(--color-text-muted)]">{hint}</p>
      {children && <div className="mt-2 flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string | undefined; tone?: "success" | "warning" | undefined }) {
  const color =
    tone === "success" ? "text-[var(--color-success)]" : tone === "warning" ? "text-[var(--color-warning)]" : "text-[var(--color-text)]";
  return (
    <div className="flex flex-col rounded-[var(--radius-md)] bg-[var(--color-bg)] px-3 py-2">
      <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
      <dd className={`text-base font-semibold tabular-nums ${color}`}>{value}</dd>
      {hint && <dd className="text-[11px] leading-snug text-[var(--color-text-faint)]">{hint}</dd>}
    </div>
  );
}

function Bridge({ label, value, sign, total = false }: { label: string; value: string; sign?: string; total?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 py-1 ${total ? "border-t border-[var(--color-border)] font-semibold" : ""}`}>
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="shrink-0 tabular-nums text-[var(--color-text)]">
        {sign && value !== "0" ? `${sign} ` : ""}
        {nairaText(value)}
      </dd>
    </div>
  );
}
