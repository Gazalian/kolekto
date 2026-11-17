import { Banner, Card, CardBody } from "@kolekto/ui";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import { nairaText, type OverviewView } from "./contributor-register.ts";

/**
 * The collection's money, as the database reports it (design:
 * docs/product/COLLECTION-FINANCIAL-OVERVIEW-AND-REGISTER.md §2.2).
 *
 * Every figure arrives computed — Raised from contributions, the rest from
 * the ledger. This component formats kobo strings and does no arithmetic, so
 * the screen cannot disagree with the record.
 */
export function FinancialOverview({
  overview,
  target,
}: {
  overview: OverviewView;
  /** The collection's target, in kobo, when it has one. */
  target: string | null;
}) {
  // Progress in tenths of a percent, in integer arithmetic: the amounts never
  // become floating point, only the finished percentage becomes text.
  const tenths =
    target && BigInt(target) > 0n ? (BigInt(overview.totalRaisedKobo) * 1000n) / BigInt(target) : null;
  const progress =
    tenths === null
      ? null
      : { text: `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}`, bar: `${(tenths > 1000n ? 1000n : tenths) / 10n}` };

  const extraBalances = [
    { label: "On hold", value: overview.onHoldKobo },
    { label: "Being withdrawn", value: overview.withdrawingKobo },
  ].filter((entry) => entry.value !== null && entry.value !== "0");

  return (
    <section aria-labelledby="financial-overview-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="financial-overview-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Money
        </h2>
        {overview.lastContributionAt && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Last payment {formatDistanceToNow(overview.lastContributionAt)}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Total raised"
          value={nairaText(overview.totalRaisedKobo)}
          hint="Every successful payment, before fees."
          emphasis
        />
        {overview.canViewBalances ? (
          <>
            <Metric
              label="Available balance"
              value={nairaText(overview.availableKobo ?? "0")}
              hint="Settled and ready to withdraw."
            />
            <Metric
              label="Pending settlement"
              value={nairaText(overview.pendingKobo ?? "0")}
              hint="Paid, not yet settled. Moves to Available once settlement is recorded (T+1)."
            />
            <Metric
              label="Total withdrawn"
              value={nairaText(overview.withdrawnKobo ?? "0")}
              hint="Successful withdrawals only."
            />
          </>
        ) : (
          <div className="col-span-1 flex items-center rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)] lg:col-span-3">
            Balances and withdrawals are visible to officers with the balance permission.
          </div>
        )}
      </div>

      {progress !== null && target && (
        <div className="flex flex-col gap-1">
          <div
            className="h-2 overflow-hidden rounded-full bg-[var(--color-bg)]"
            role="progressbar"
            aria-label="Progress towards target"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${progress.text}%`}
          >
            <div className="h-full bg-[var(--color-primary)]" style={{ width: `${progress.bar}%` }} />
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            {progress.text}% of the {nairaText(target)} target
          </p>
        </div>
      )}

      <Card>
        <CardBody className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <SmallFigure label="Contributors" value={overview.contributorCount.toLocaleString()} hint="Unique people" />
          <SmallFigure
            label="Successful payments"
            value={overview.contributionCount.toLocaleString()}
            hint="One person may pay more than once"
          />
          <SmallFigure
            label="Fees deducted"
            value={nairaText(overview.feesDeductedKobo)}
            hint="Fees you absorbed"
          />
          <SmallFigure
            label="After fees"
            value={nairaText(overview.netRaisedKobo)}
            hint="Raised minus fees deducted"
          />
          {extraBalances.map((entry) => (
            <SmallFigure key={entry.label} label={entry.label} value={nairaText(entry.value!)} />
          ))}
        </CardBody>
      </Card>

      {overview.underReviewCount > 0 && (
        <Banner tone="info">
          {overview.underReviewCount === 1 ? "One payment is" : `${overview.underReviewCount} payments are`} being
          reviewed by Kolekto. {overview.underReviewCount === 1 ? "It is" : "They are"} not in any figure above until
          the review is finished.
        </Banner>
      )}
    </section>
  );
}

function Metric({ label, value, hint, emphasis = false }: { label: string; value: string; hint: string; emphasis?: boolean }) {
  return (
    <div
      className={
        emphasis
          ? "flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-primary)] bg-[var(--color-surface)] p-3"
          : "flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
      }
    >
      <p className="text-xs font-medium text-[var(--color-text-muted)]">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-[var(--color-text)] sm:text-xl">{value}</p>
      <p className="text-xs leading-snug text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );
}

function SmallFigure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{value}</p>
      {hint && <p className="text-[11px] leading-snug text-[var(--color-text-faint)]">{hint}</p>}
    </div>
  );
}
