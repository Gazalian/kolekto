"use client";

import { fromNaira, MoneyError } from "@kolekto/domain";
import { Badge, Banner, Button, Dialog, Spinner, TextAreaField, TextField } from "@kolekto/ui";
import { useCallback, useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import { nairaText } from "./contributor-register.ts";
import {
  decideWithdrawalAction,
  ledgerPageAction,
  loadMoneyAction,
  requestWithdrawalAction,
  type LedgerEntryView,
  type MoneyView,
  type WithdrawalView,
} from "./money-actions.ts";
import {
  headlineChange,
  LEDGER_FILTERS,
  LEDGER_SOURCE_LABEL,
  type LedgerFilterKey,
  type WithdrawBlock,
  WITHDRAWAL_STATUS_LABEL,
} from "./money-view.ts";

/**
 * The pieces of a collection's money — withdrawals and the balance ledger
 * (design: docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md
 * §8, §14). The Overview tab shows the withdraw action and withdrawals in
 * progress; the Activity tab keeps the balance ledger, collapsed. There is no
 * settlement screen: moving money from pending to available is automatic.
 *
 * Every figure arrives from the database already computed; these components
 * format kobo strings and never add them up. Requesting a withdrawal sends an
 * amount as typed — the database locks the available balance, re-checks it
 * and holds the money in one transaction.
 */

const WAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});
export const watText = (iso: string) => `${WAT.format(new Date(iso))} WAT`;

/** "+₦4,900" / "−₦4,900" from a signed kobo string; empty for zero. */
function signedNaira(value: string): string {
  if (value === "0") return "";
  const negative = value.startsWith("-");
  return `${negative ? "−" : "+"}${nairaText(negative ? value.slice(1) : value)}`;
}

const STATUS = WITHDRAWAL_STATUS_LABEL;

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

// ── Loading ──────────────────────────────────────────────────────────────────

export function useCollectionMoney(slug: string, collectionSlug: string, enabled: boolean) {
  const [money, setMoney] = useState<MoneyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const reload = useCallback(() => {
    if (!enabled) return;
    startTransition(async () => {
      const result = await loadMoneyAction(slug, collectionSlug);
      if (result.error || !result.money) {
        setLoadError(result.error ?? "The money for this collection could not be loaded.");
        return;
      }
      setLoadError(null);
      setMoney(result.money);
    });
  }, [slug, collectionSlug, enabled]);

  useEffect(reload, [reload]);
  return { money, loadError, reload, isLoading: isPending };
}

// ── Why a withdrawal cannot be made now ──────────────────────────────────────

export function withdrawBlockText(block: WithdrawBlock): string {
  switch (block.kind) {
    case "identity":
      return "Withdrawals need an identity-verified officer account, and yours is not verified yet. Contact Kolekto support to verify your identity.";
    case "in_progress":
      return `A withdrawal of ${nairaText(block.amountKobo)} from this collection is already in progress. You can request another once it is finished.`;
    case "free_used":
      return "This collection's free withdrawal has been used. Further withdrawals open once withdrawal fees are published.";
    case "settling":
      return block.awaitingProvider
        ? "Your payments have been received successfully. The T+1 period has passed, but the payment provider has not yet released these funds to Kolekto, so they cannot be paid out yet. They become available automatically as soon as it does."
        : `Your payments have been received successfully. Some funds are still within the T+1 eligibility period and will become available automatically${
            block.nextReleaseAt ? ` (next from ${watText(block.nextReleaseAt)})` : ""
          }.`;
    case "nothing_received":
      return "No payments have been received yet, so there is nothing to withdraw.";
    case "empty":
      return "There is no available balance to withdraw right now.";
  }
}

// ── Withdraw dialog ──────────────────────────────────────────────────────────

export function WithdrawDialog({
  slug,
  collectionSlug,
  collectionName,
  availableKobo,
  block,
  onClose,
  onDone,
}: {
  slug: string;
  collectionSlug: string;
  collectionName: string;
  availableKobo: string;
  block: WithdrawBlock | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [amount, setAmount] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Parsed only to stop an amount above the available balance before it is
  // sent; app.request_withdrawal locks the balance and checks it again.
  let amountKobo: bigint | null = null;
  try {
    amountKobo = amount.trim() === "" ? null : BigInt(fromNaira(amount));
  } catch (parseError) {
    if (!(parseError instanceof MoneyError)) throw parseError;
    amountKobo = null;
  }
  const amountProblem =
    amount.trim() === ""
      ? null
      : amountKobo === null
        ? "Enter an amount in naira, e.g. 25,000."
        : amountKobo <= 0n
          ? "Enter an amount above zero."
          : amountKobo > BigInt(availableKobo)
            ? `You can withdraw up to ${nairaText(availableKobo)}.`
            : null;
  const formReady =
    amountKobo !== null &&
    amountProblem === null &&
    accountName.trim().length >= 2 &&
    /^[0-9]{10}$/.test(accountNumber.trim()) &&
    bankName.trim().length >= 2;
  const shownAmount = amountKobo !== null ? nairaText(amountKobo.toString()) : "";

  function submit(): void {
    setError(null);
    startTransition(async () => {
      const result = await requestWithdrawalAction(slug, collectionSlug, {
        amount,
        accountName,
        accountNumber,
        bankName,
        idempotencyKey: key,
      });
      if (result.error) {
        setError(result.error);
        setStep("form");
        return;
      }
      onDone(
        result.status === "approved"
          ? `Withdrawal ${result.reference} is processing. Kolekto pays it out, usually within 24 hours, and marks it Successful once the transfer is confirmed.`
          : `Withdrawal ${result.reference} is waiting for the community owner's approval.`,
      );
    });
  }

  if (block) {
    return (
      <Dialog open onClose={onClose} title="You can't withdraw yet">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">{withdrawBlockText(block)}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            Available to withdraw from {collectionName}: <strong>{nairaText(availableKobo)}</strong>
          </p>
          <Button variant="secondary" onClick={onClose} className="self-start">
            OK
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={step === "form" ? `Withdraw from ${collectionName}` : "Confirm this withdrawal"}
    >
      {step === "form" ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-[var(--radius-md)] bg-[var(--color-bg)] p-3">
            <p className="text-xs text-[var(--color-text-muted)]">Available to withdraw</p>
            <p className="text-lg font-semibold tabular-nums text-[var(--color-text)]">{nairaText(availableKobo)}</p>
          </div>
          <div className="flex flex-col gap-1">
            <TextField
              label="Amount (₦)"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint={amountProblem ?? "Up to your available balance. Pending money becomes available automatically after T+1."}
            />
            <button
              type="button"
              className="self-start text-xs font-medium text-[var(--color-primary)] hover:underline"
              onClick={() => setAmount(nairaText(availableKobo).replace(/^₦/, ""))}
            >
              Withdraw all ({nairaText(availableKobo)})
            </button>
          </div>
          <TextField label="Account name" value={accountName} onChange={(event) => setAccountName(event.target.value)} />
          <TextField
            label="Account number"
            inputMode="numeric"
            maxLength={10}
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
            hint="10 digits (NUBAN)"
          />
          <TextField label="Bank" value={bankName} onChange={(event) => setBankName(event.target.value)} />
          <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)] text-sm">
            <ConfirmRow label="Transfer fee" value="Free — first withdrawal from this collection" />
            <ConfirmRow label="You receive" value={shownAmount || "—"} />
          </dl>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!formReady} onClick={() => setStep("confirm")}>
              Continue
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
          <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <ConfirmRow label="From" value={collectionName} />
            <ConfirmRow label="Amount" value={shownAmount} />
            <ConfirmRow label="Transfer fee" value="Free — first withdrawal from this collection" />
            <ConfirmRow label="You receive" value={shownAmount} />
            <ConfirmRow
              label="To"
              value={`${accountName.trim()}, ${bankName.trim()} (account ending ${accountNumber.trim().slice(-4)})`}
            />
          </dl>
          <p className="text-xs text-[var(--color-text-muted)]">
            The amount is held from your available balance straight away. Kolekto pays it out, usually within 24 hours
            (a request by another officer first needs the community owner&apos;s approval). It shows as Successful only
            once the transfer is confirmed; if it fails, the money returns to your available balance. Check the account
            details: a payout to a wrong account may not be recoverable.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button loading={isPending} onClick={submit}>
              Request withdrawal
            </Button>
            <Button variant="ghost" onClick={() => setStep("form")} disabled={isPending}>
              Go back
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 px-3 py-2">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

export function WithdrawalsList({
  slug,
  collectionSlug,
  withdrawals,
  onChanged,
}: {
  slug: string;
  collectionSlug: string;
  withdrawals: WithdrawalView[];
  onChanged: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<WithdrawalView | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [isPending, startTransition] = useTransition();

  function decide(w: WithdrawalView, decision: "approve" | "reject" | "cancel", reason?: string): void {
    setMessage(null);
    startTransition(async () => {
      const result = await decideWithdrawalAction(slug, collectionSlug, {
        withdrawalId: w.id,
        decision,
        ...(reason ? { reason } : {}),
      });
      setRejecting(null);
      setRejectReason("");
      if (result.error) setMessage(result.error);
      else onChanged();
    });
  }

  if (withdrawals.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">No withdrawals yet.</p>;
  }

  return (
    <>
      {message && <Banner tone="danger">{message}</Banner>}
      <ul className="flex flex-col divide-y divide-[var(--color-border)]">
        {withdrawals.map((w) => (
          <li key={w.id} className="flex flex-col gap-2 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold tabular-nums text-[var(--color-text)]">
                {nairaText(w.amountKobo)}
                {w.feeKobo !== "0" && (
                  <span className="ml-1 text-xs font-normal text-[var(--color-text-muted)]">+ {nairaText(w.feeKobo)} fee</span>
                )}
              </p>
              <Badge tone={STATUS[w.status].tone}>{STATUS[w.status].label}</Badge>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              <span className="font-mono">{w.reference}</span> · {w.accountName} · {w.bankName} ••••{w.accountLast4} ·{" "}
              {w.requestedByName ?? "An officer"} · {formatDistanceToNow(w.requestedAt)}
              {w.requiresManualReview && " · checked by Kolekto before payout"}
            </p>
            {w.paidAt && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Paid {watText(w.paidAt)}
                {w.payoutReference && <span className="font-mono"> · {w.payoutReference}</span>}
              </p>
            )}
            {w.failureReason && <p className="text-xs text-[var(--color-danger)]">{w.failureReason}</p>}
            {w.decisionReason && <p className="text-xs text-[var(--color-text-muted)]">“{w.decisionReason}”</p>}
            {(w.canDecide || w.canCancel) && (
              <div className="flex flex-wrap gap-2">
                {w.canDecide && (
                  <>
                    <Button size="sm" loading={isPending} onClick={() => decide(w, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRejecting(w)}>
                      Reject
                    </Button>
                  </>
                )}
                {w.canCancel && (
                  <Button size="sm" variant="ghost" loading={isPending} onClick={() => decide(w, "cancel")}>
                    Cancel request
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {rejecting && (
        <Dialog open onClose={() => setRejecting(null)} title={`Reject ${rejecting.reference}?`}>
          <div className="flex flex-col gap-3">
            <TextAreaField
              label="Reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              hint="The requester sees this. The held money returns to the available balance."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                loading={isPending}
                disabled={rejectReason.trim() === ""}
                onClick={() => decide(rejecting, "reject", rejectReason)}
              >
                Reject
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(null)}>
                Go back
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}

// ── Ledger ───────────────────────────────────────────────────────────────────

/** Readable ledger rows; each opens to show its reference and every bucket it moved. */
export function LedgerRows({ entries }: { entries: LedgerEntryView[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">No money has moved yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--color-border)]">
      {entries.map((entry) => {
        const headline = headlineChange(entry);
        return (
          <li key={entry.journalId}>
            <details className="group py-2">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text)]">
                    {LEDGER_SOURCE_LABEL[entry.sourceType] ?? entry.sourceType.replace(/_/g, " ")}
                    {entry.isReversal && <span className="ml-2 text-xs text-[var(--color-text-muted)]">(reversal)</span>}
                  </p>
                  <p className="truncate text-xs text-[var(--color-text-muted)]">
                    {watText(entry.occurredAt)}
                    {entry.reference && <span className="ml-1 font-mono">· {entry.reference}</span>}
                  </p>
                </div>
                {headline && (
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{signedNaira(headline.kobo)}</p>
                    <p className="text-[11px] text-[var(--color-text-muted)]">{headline.bucket}</p>
                  </div>
                )}
              </summary>
              <div className="mt-2 flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--color-bg)] p-2 text-xs">
                {entry.reason && <p className="text-[var(--color-text-muted)]">{entry.reason}</p>}
                {entry.reference && (
                  <p>
                    <span className="text-[var(--color-text-muted)]">Reference </span>
                    <span className="font-mono text-[var(--color-text)]">{entry.reference}</span>
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-x-3 tabular-nums sm:grid-cols-4">
                  {(
                    [
                      ["Pending", entry.pendingChangeKobo],
                      ["Available", entry.availableChangeKobo],
                      ["Being withdrawn", entry.withdrawingChangeKobo],
                      ["Withdrawn", entry.withdrawnChangeKobo],
                    ] as const
                  )
                    .filter(([, v]) => v !== "0")
                    .map(([label, v]) => (
                      <div key={label} className="flex flex-col">
                        <dt className="text-[var(--color-text-muted)]">{label}</dt>
                        <dd className="font-medium text-[var(--color-text)]">{signedNaira(v)}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** The whole ledger, filtered and paged by the database. */
export function LedgerActivity({ slug, collectionSlug }: { slug: string; collectionSlug: string }) {
  const [filter, setFilter] = useState<LedgerFilterKey>("all");
  const [rows, setRows] = useState<LedgerEntryView[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(
    (offset: number, kind: LedgerFilterKey) => {
      startTransition(async () => {
        const result = await ledgerPageAction(slug, collectionSlug, offset, kind);
        if (result.error || !result.rows) {
          setError(result.error ?? "The ledger could not be loaded.");
          return;
        }
        setError(null);
        setRows((current) => (offset === 0 ? result.rows! : [...current, ...result.rows!]));
        setTotal(result.total ?? 0);
        setLoaded(true);
      });
    },
    [slug, collectionSlug],
  );

  useEffect(() => load(0, filter), [load, filter]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Filter money movements">
        {LEDGER_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={filter === option.key}
            onClick={() => setFilter(option.key)}
            className={
              filter === option.key
                ? "rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary-fg)]"
                : "rounded-full border border-[var(--color-border)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {!loaded && !error ? (
        <div className="flex justify-center py-6">
          <Spinner label="Loading money movements" />
        </div>
      ) : (
        <>
          <LedgerRows entries={rows} />
          {rows.length < total && (
            <Button variant="secondary" size="sm" loading={isPending} onClick={() => load(rows.length, filter)}>
              Show more ({total - rows.length} older)
            </Button>
          )}
        </>
      )}
      <p className="text-xs text-[var(--color-text-muted)]">
        Entries are never edited. A correction is a new entry that reverses the old one.
      </p>
    </div>
  );
}
