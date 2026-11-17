"use client";

import { Badge, Banner, Button, Card, CardBody, Dialog, Spinner, TextAreaField, TextField } from "@kolekto/ui";
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

/**
 * Settlement, withdrawals and the ledger for one collection (design:
 * docs/product/COLLECTION-LEDGER-SETTLEMENT-WITHDRAWALS-REMINDERS.md §8).
 *
 * Every figure arrives from the database already computed; this component
 * formats kobo strings and never adds them up. Requesting a withdrawal sends
 * an amount as typed — the database parses nothing it has not re-checked, locks
 * the available balance and holds the money in one transaction.
 */

const WAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});
const watText = (iso: string) => `${WAT.format(new Date(iso))} WAT`;

/** "+₦4,900" / "−₦4,900" from a signed kobo string; empty for zero. */
function signedNaira(value: string): string {
  if (value === "0") return "";
  const negative = value.startsWith("-");
  return `${negative ? "−" : "+"}${nairaText(negative ? value.slice(1) : value)}`;
}

const STATUS: Record<WithdrawalView["status"], { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  requested: { label: "Waiting for the owner", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  processing: { label: "Being paid out", tone: "info" },
  paid: { label: "Paid", tone: "success" },
  failed: { label: "Failed — money returned", tone: "danger" },
  rejected: { label: "Rejected", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const SOURCE: Record<string, string> = {
  capture: "Payment received",
  fee: "Fees",
  balance_release: "Settled — now available",
  withdrawal: "Withdrawal hold",
  payout: "Withdrawal paid out",
  adjustment: "Adjustment",
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function MoneyPanel({
  slug,
  collectionSlug,
  availableKobo,
  canRequestWithdrawal,
}: {
  slug: string;
  collectionSlug: string;
  /** From the financial overview (ledger). Shown on the request form only. */
  availableKobo: string;
  canRequestWithdrawal: boolean;
}) {
  const [money, setMoney] = useState<MoneyView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerEntryView[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [isPending, startTransition] = useTransition();

  const reload = useCallback(() => {
    startTransition(async () => {
      const result = await loadMoneyAction(slug, collectionSlug);
      if (result.error || !result.money) {
        setLoadError(result.error ?? "The money for this collection could not be loaded.");
        return;
      }
      setLoadError(null);
      setMoney(result.money);
      setLedger(result.money.ledger);
      setLedgerTotal(result.money.ledgerTotal);
    });
  }, [slug, collectionSlug]);

  useEffect(reload, [reload]);

  function moreLedger(): void {
    startTransition(async () => {
      const result = await ledgerPageAction(slug, collectionSlug, ledger.length);
      if (result.rows) {
        setLedger((rows) => [...rows, ...result.rows!]);
        setLedgerTotal(result.total ?? ledgerTotal);
      }
    });
  }

  if (loadError) {
    return (
      <Banner tone="danger">
        {loadError}{" "}
        <button type="button" className="underline" onClick={reload}>
          Try again
        </button>
      </Banner>
    );
  }
  if (!money) {
    return (
      <div className="flex justify-center py-8">
        <Spinner label="Loading money" />
      </div>
    );
  }

  const s = money.settlement;
  return (
    <div className="flex flex-col gap-4">
      {/* ── Settlement ─────────────────────────────────────────────── */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Settlement</h2>
            <p className="text-xs text-[var(--color-text-muted)]">{s.rule}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure
              label="Settling on schedule"
              value={nairaText(s.scheduledKobo)}
              hint={
                s.scheduledCount === 0
                  ? "Nothing waiting"
                  : `${s.scheduledCount} payment${s.scheduledCount === 1 ? "" : "s"}${s.nextReleaseAt ? ` · next ${watText(s.nextReleaseAt)}` : ""}`
              }
            />
            <Figure
              label="Waiting for the provider"
              value={nairaText(s.awaitingProviderKobo)}
              hint={
                s.awaitingProviderCount === 0
                  ? "Nothing delayed"
                  : `${s.awaitingProviderCount} payment${s.awaitingProviderCount === 1 ? " is" : "s are"} past the release time; released as soon as the provider settles`
              }
            />
            <Figure
              label="Settled to available"
              value={nairaText(s.releasedKobo)}
              hint={s.lastReleaseAt ? `Last ${formatDistanceToNow(s.lastReleaseAt)}` : "None yet"}
            />
          </div>
          {s.discrepancyCount > 0 && (
            <Banner tone="info">
              {s.discrepancyCount === 1 ? "One payment" : `${s.discrepancyCount} payments`} ({nairaText(s.discrepancyKobo)}) did
              not settle as expected and {s.discrepancyCount === 1 ? "is" : "are"} held while Kolekto checks with the payment
              provider. {s.discrepancyCount === 1 ? "It stays" : "They stay"} in Pending until resolved.
            </Banner>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">
            {money.reconciliationFailures.length === 0
              ? "✓ Every figure on this page traces to the ledger."
              : `Kolekto is checking this collection's figures (${money.reconciliationFailures.join(", ")}). No money is affected by this message.`}
          </p>
        </CardBody>
      </Card>

      {/* ── Withdrawals ───────────────────────────────────────────── */}
      <Withdrawals
        slug={slug}
        collectionSlug={collectionSlug}
        availableKobo={availableKobo}
        canRequest={canRequestWithdrawal}
        withdrawals={money.withdrawals}
        onChanged={reload}
      />

      {/* ── Ledger ────────────────────────────────────────────────── */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Ledger</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              Every movement of this collection&apos;s money, newest first. Entries are never edited — a correction is a new
              entry that reverses the old one.
            </p>
          </div>
          {ledger.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No money has moved yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {ledger.map((entry) => (
                <li key={entry.journalId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--color-text)]">
                      {SOURCE[entry.sourceType] ?? entry.sourceType.replace(/_/g, " ")}
                      {entry.isReversal && <span className="ml-2 text-xs text-[var(--color-text-muted)]">(reversal)</span>}
                    </p>
                    <p className="truncate text-xs text-[var(--color-text-muted)]">
                      {watText(entry.occurredAt)}
                      {entry.reference && <span className="ml-1 font-mono">· {entry.reference}</span>}
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 text-xs tabular-nums sm:text-right">
                    {(
                      [
                        ["Pending", entry.pendingChangeKobo],
                        ["Available", entry.availableChangeKobo],
                        ["Withdrawing", entry.withdrawingChangeKobo],
                        ["Withdrawn", entry.withdrawnChangeKobo],
                      ] as const
                    )
                      .filter(([, v]) => v !== "0")
                      .map(([label, v]) => (
                        <div key={label} className="contents">
                          <dt className="text-[var(--color-text-muted)]">{label}</dt>
                          <dd className="font-medium text-[var(--color-text)]">{signedNaira(v)}</dd>
                        </div>
                      ))}
                  </dl>
                </li>
              ))}
            </ul>
          )}
          {ledger.length < ledgerTotal && (
            <Button variant="secondary" size="sm" loading={isPending} onClick={moreLedger}>
              Show more ({ledgerTotal - ledger.length} older)
            </Button>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className="text-base font-semibold tabular-nums text-[var(--color-text)]">{value}</p>
      <p className="text-[11px] leading-snug text-[var(--color-text-muted)]">{hint}</p>
    </div>
  );
}

function Withdrawals({
  slug,
  collectionSlug,
  availableKobo,
  canRequest,
  withdrawals,
  onChanged,
}: {
  slug: string;
  collectionSlug: string;
  availableKobo: string;
  canRequest: boolean;
  withdrawals: WithdrawalView[];
  onChanged: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [amount, setAmount] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [key, setKey] = useState(newKey);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [rejecting, setRejecting] = useState<WithdrawalView | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const firstUsed = withdrawals.some((w) => ["requested", "approved", "processing", "paid"].includes(w.status));
  const formReady = amount.trim() !== "" && accountName.trim().length >= 2 && /^[0-9]{10}$/.test(accountNumber.trim()) && bankName.trim().length >= 2;

  function submit(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await requestWithdrawalAction(slug, collectionSlug, { amount, accountName, accountNumber, bankName, idempotencyKey: key });
      setConfirming(false);
      if (result.error) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      setMessage({
        tone: "success",
        text:
          result.status === "approved"
            ? `Withdrawal ${result.reference} is approved and will be paid out by Kolekto.`
            : `Withdrawal ${result.reference} is waiting for the community owner's approval.`,
      });
      setFormOpen(false);
      setAmount("");
      setKey(newKey());
      onChanged();
    });
  }

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
      if (result.error) setMessage({ tone: "danger", text: result.error });
      else onChanged();
    });
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Withdrawals</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              Only the available balance ({nairaText(availableKobo)}) can be withdrawn. The first withdrawal from a
              collection is free.
            </p>
          </div>
          {canRequest && !formOpen && (
            <Button size="sm" onClick={() => setFormOpen(true)} disabled={availableKobo === "0"}>
              Request withdrawal
            </Button>
          )}
        </div>

        {canRequest && firstUsed && !formOpen && (
          <p className="text-xs text-[var(--color-text-muted)]">
            This collection&apos;s free withdrawal is in use. Further withdrawals open once withdrawal fees are published.
          </p>
        )}

        {formOpen && (
          <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
            <TextField
              label="Amount (₦)"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              hint={`Available: ${nairaText(availableKobo)}`}
            />
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
            <div className="flex flex-wrap gap-2">
              <Button disabled={!formReady} onClick={() => setConfirming(true)}>
                Continue
              </Button>
              <Button variant="ghost" onClick={() => setFormOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        {withdrawals.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No withdrawals yet.</p>
        ) : (
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
        )}
      </CardBody>

      {confirming && (
        <Dialog open onClose={() => setConfirming(false)} title="Request this withdrawal?">
          <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
            <p>
              <strong>₦{amount.trim().replace(/^₦/, "")}</strong> to {accountName.trim()}, {bankName.trim()} (account ending{" "}
              {accountNumber.trim().slice(-4)}).
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">
              The amount is held from the available balance straight away. The community owner approves it, then Kolekto
              pays it out. If the payout fails, the money returns to the available balance.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button loading={isPending} onClick={submit}>
                Request withdrawal
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Go back
              </Button>
            </div>
          </div>
        </Dialog>
      )}

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
    </Card>
  );
}
