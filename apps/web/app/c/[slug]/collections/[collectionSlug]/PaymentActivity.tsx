"use client";

import { Badge, Banner, Button, Dialog, Spinner } from "@kolekto/ui";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import { nairaText } from "./contributor-register.ts";
import { activityPageAction, type ActivityRowView } from "./money-actions.ts";
import {
  ACTIVITY_FILTERS,
  eligibilityText,
  FEE_BEARER_LABEL,
  PAYMENT_STATUS_LABEL,
  WITHDRAWAL_STATUS_LABEL,
  type ActivityFilterKey,
} from "./money-view.ts";

/**
 * Who paid, how much, and what happened — from app.collection_payment_activity
 * (20261117130000). Each payment row names the payer and the amount; its badge
 * is the PAYMENT's status, which is "Successful" the moment the payment is
 * verified. When the money can be withdrawn (T+1) is a separate line, never a
 * status. Amounts arrive as kobo strings and are only formatted here.
 */

const WAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});
const watText = (iso: string) => `${WAT.format(new Date(iso))} WAT`;

function useActivity(slug: string, collectionSlug: string, filter: ActivityFilterKey, limit: number) {
  const [rows, setRows] = useState<ActivityRowView[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Switching filters quickly can leave an older request still in flight; only
  // the newest request's answer may replace the rows.
  const latest = useRef(0);

  const load = useCallback(
    (offset: number) => {
      const request = ++latest.current;
      startTransition(async () => {
        const result = await activityPageAction(slug, collectionSlug, { filter, offset, limit });
        if (request !== latest.current) return;
        if (result.error || !result.rows) {
          setError(result.error ?? "The activity could not be loaded.");
          return;
        }
        setError(null);
        setRows((current) => (offset === 0 ? result.rows! : [...current, ...result.rows!]));
        setTotal(result.total ?? 0);
        setLoaded(true);
      });
    },
    [slug, collectionSlug, filter, limit],
  );

  useEffect(() => load(0), [load]);
  return { rows, total, loaded, error, isPending, load };
}

/** The status badge for a row: the payment's status, or the withdrawal's. */
function rowBadge(row: ActivityRowView) {
  const entry =
    row.kind === "payment"
      ? PAYMENT_STATUS_LABEL[row.paymentStatus ?? "pending"]
      : WITHDRAWAL_STATUS_LABEL[row.withdrawalStatus ?? "requested"];
  return entry ? <Badge tone={entry.tone}>{entry.label}</Badge> : null;
}

export function ActivityRows({ rows, onOpen }: { rows: ActivityRowView[]; onOpen: (row: ActivityRowView) => void }) {
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)]">
      {rows.map((row) => {
        const isPayment = row.kind === "payment";
        const muted = isPayment && row.paymentStatus === "failed";
        return (
          <li key={`${row.kind}-${row.id}`}>
            <button
              type="button"
              onClick={() => onOpen(row)}
              className="flex w-full items-center gap-3 rounded-[var(--radius-md)] px-1 py-3 text-left transition-colors hover:bg-[var(--color-bg)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            >
              <span
                aria-hidden="true"
                className={
                  isPayment
                    ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)]"
                    : "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                }
              >
                {isPayment ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`truncate text-sm font-medium ${muted ? "text-[var(--color-text-muted)]" : "text-[var(--color-text)]"}`}>
                  {isPayment ? row.name : "Withdrawal"}
                </span>
                <span className="truncate text-xs text-[var(--color-text-muted)]">
                  {formatDistanceToNow(row.occurredAt)}
                  {isPayment && row.paymentStatus === "successful" && row.totalFeesKobo && row.totalFeesKobo !== "0"
                    ? ` · ${nairaText(row.totalFeesKobo)} fee`
                    : ""}
                  {!isPayment && row.destination ? ` · ${row.destination}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={`text-sm font-semibold tabular-nums ${muted ? "text-[var(--color-text-muted)] line-through" : "text-[var(--color-text)]"}`}
                >
                  {isPayment ? "" : "−"}
                  {nairaText(row.amountKobo)}
                </span>
                {rowBadge(row)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The latest few rows for the Overview. */
export function RecentActivity({
  slug,
  collectionSlug,
  onSeeAll,
}: {
  slug: string;
  collectionSlug: string;
  onSeeAll: () => void;
}) {
  const { rows, total, loaded, error } = useActivity(slug, collectionSlug, "all", 6);
  const [open, setOpen] = useState<ActivityRowView | null>(null);

  return (
    <section aria-labelledby="recent-activity-heading" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2 id="recent-activity-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Recent activity
        </h2>
        {total > rows.length && (
          <button type="button" className="text-xs font-medium text-[var(--color-primary)] hover:underline" onClick={onSeeAll}>
            See all {total.toLocaleString()} →
          </button>
        )}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {!loaded && !error ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading activity" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-sm text-[var(--color-text-muted)]">
          No payments yet. Share the collection link to start receiving contributions.
        </p>
      ) : (
        <ActivityRows rows={rows} onOpen={setOpen} />
      )}
      {open && <ActivityDetailDialog row={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Every payment and withdrawal, filtered and paged by the database. */
export function PaymentActivity({
  slug,
  collectionSlug,
  showWithdrawals,
}: {
  slug: string;
  collectionSlug: string;
  /** Withdrawals need balance.view; without it the filter is not offered. */
  showWithdrawals: boolean;
}) {
  const [filter, setFilter] = useState<ActivityFilterKey>("all");
  const { rows, total, loaded, error, isPending, load } = useActivity(slug, collectionSlug, filter, 25);
  const [open, setOpen] = useState<ActivityRowView | null>(null);
  const filters = ACTIVITY_FILTERS.filter((option) => showWithdrawals || option.key !== "withdrawals");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 overflow-x-auto pb-1 [contain:inline-size]" role="group" aria-label="Filter activity">
        {filters.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={
              filter === option.key
                ? "shrink-0 rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
                : "shrink-0 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {!loaded && !error ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading activity" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-sm text-[var(--color-text-muted)]">
          {filter === "all" ? "Nothing has happened yet." : "Nothing matches this filter."}
        </p>
      ) : (
        <>
          <ActivityRows rows={rows} onOpen={setOpen} />
          {rows.length < total && (
            <Button variant="secondary" size="sm" className="self-start" loading={isPending} onClick={() => load(rows.length)}>
              Show more ({(total - rows.length).toLocaleString()} older)
            </Button>
          )}
        </>
      )}
      {open && <ActivityDetailDialog row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

export function ActivityDetailDialog({ row, onClose }: { row: ActivityRowView; onClose: () => void }) {
  return row.kind === "payment" ? (
    <PaymentDetail row={row} onClose={onClose} />
  ) : (
    <WithdrawalDetail row={row} onClose={onClose} />
  );
}

function PaymentDetail({ row, onClose }: { row: ActivityRowView; onClose: () => void }) {
  const status = PAYMENT_STATUS_LABEL[row.paymentStatus ?? "pending"];
  const successful = row.paymentStatus === "successful";
  const eligibility = eligibilityText(row.eligibility, row.eligibleAt, watText);
  const payerPays = row.feeBearer === "contributor_pays";

  return (
    <Dialog open onClose={onClose} title={row.name} description={`Payment · ${watText(row.occurredAt)}`} className="max-w-md">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-end justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-bg)] p-3">
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">{successful ? "Contribution" : "Amount"}</p>
            <p className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{nairaText(row.amountKobo)}</p>
          </div>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </div>

        {successful ? (
          <>
            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Fees</h3>
              <dl className="divide-y divide-[var(--color-border)]">
                {payerPays && row.chargedKobo && <Line label="Contributor paid in total" value={nairaText(row.chargedKobo)} />}
                <Line label="Contribution" value={nairaText(row.amountKobo)} />
                {row.processingFeeKobo && <Line label="Processing fee" value={nairaText(row.processingFeeKobo)} />}
                {row.kolektoFeeKobo && <Line label="Kolekto fee" value={nairaText(row.kolektoFeeKobo)} />}
                {row.totalFeesKobo && <Line label="Total fees" value={nairaText(row.totalFeesKobo)} />}
                {row.feeBearer && <Line label="Fee paid by" value={FEE_BEARER_LABEL[row.feeBearer] ?? row.feeBearer} />}
                {row.netKobo && <Line label="Credited to the collection" value={nairaText(row.netKobo)} strong />}
              </dl>
              <p className="text-xs text-[var(--color-text-muted)]">
                {payerPays
                  ? "The fees were added on top of the contribution, so the collection receives the full contribution."
                  : "You absorb the fees, so they are taken from the contribution before it is credited."}{" "}
                Fee amounts are fixed when the contributor pays.
              </p>
            </section>

            <section className="flex flex-col gap-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Withdrawal</h3>
              <p className="text-[var(--color-text)]">{eligibility}</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                This payment is successful. T+1 only decides when its money can be withdrawn; Kolekto moves it to your
                available balance automatically.
              </p>
            </section>
          </>
        ) : (
          <p className="text-[var(--color-text-muted)]">
            {row.paymentStatus === "failed"
              ? "This payment did not go through. No money was taken and no fee applies."
              : row.paymentStatus === "under_review"
                ? "The payment provider reported this payment, and Kolekto is checking it before it is counted. It is not in any total yet."
                : "The contributor started paying, and the payment provider has not confirmed it yet. It is counted the moment it is confirmed."}
          </p>
        )}

        <dl className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          <Line label="Reference" value={row.reference} mono />
          {row.verifiedAt && <Line label="Confirmed" value={watText(row.verifiedAt)} />}
          <Line label="Saved member" value={row.isMember ? "Yes" : "No (guest)"} />
        </dl>

        <Button variant="secondary" onClick={onClose} className="self-end">
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function WithdrawalDetail({ row, onClose }: { row: ActivityRowView; onClose: () => void }) {
  const status = WITHDRAWAL_STATUS_LABEL[row.withdrawalStatus ?? "requested"];
  const fee = row.totalFeesKobo ?? "0";
  return (
    <Dialog open onClose={onClose} title="Withdrawal" description={watText(row.occurredAt)} className="max-w-md">
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex items-end justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--color-bg)] p-3">
          <div>
            <p className="text-xs text-[var(--color-text-muted)]">Amount</p>
            <p className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{nairaText(row.amountKobo)}</p>
          </div>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </div>
        <dl className="divide-y divide-[var(--color-border)]">
          <Line label="Transfer fee" value={fee === "0" ? "Free" : nairaText(fee)} />
          {row.destination && <Line label="To" value={row.destination} />}
          <Line label="Requested by" value={row.name} />
          {row.completedAt && <Line label={row.withdrawalStatus === "paid" ? "Paid out" : "Decided"} value={watText(row.completedAt)} />}
          <Line label="Reference" value={row.reference} mono />
        </dl>
        {row.detail && <p className="text-xs text-[var(--color-text-muted)]">“{row.detail}”</p>}
        <p className="text-xs text-[var(--color-text-muted)]">
          A withdrawal is marked Successful only after the payout is confirmed. If it fails, the money returns to your
          available balance.
        </p>
        <Button variant="secondary" onClick={onClose} className="self-end">
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function Line({ label, value, mono = false, strong = false }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd
        className={
          mono
            ? "break-all font-mono text-xs text-[var(--color-text)]"
            : `text-right tabular-nums text-[var(--color-text)] ${strong ? "font-semibold" : ""}`
        }
      >
        {value}
      </dd>
    </div>
  );
}
