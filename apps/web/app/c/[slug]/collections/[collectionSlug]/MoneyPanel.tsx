"use client";

import { fromNaira, MoneyError } from "@kolekto/domain";
import { Badge, Banner, Button, Dialog, Spinner, TextAreaField, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import { nairaText } from "./contributor-register.ts";
import {
  decideWithdrawalAction,
  ledgerPageAction,
  loadMoneyAction,
  requestWithdrawalAction,
  resendWithdrawalOtpAction,
  verifyWithdrawalOtpAction,
  withdrawalOtpStateAction,
  type LedgerEntryView,
  type MoneyView,
  type WithdrawalOtpView,
  type WithdrawalView,
} from "./money-actions.ts";
import {
  headlineChange,
  LEDGER_FILTERS,
  LEDGER_SOURCE_LABEL,
  type LedgerFilterKey,
  type PayoutAccountView,
  type WithdrawBlock,
  WITHDRAWAL_STATUS_LABEL,
  withdrawalCodePhase,
  withdrawalStageLabel,
} from "./money-view.ts";

/** A server action that never answered (network drop, server restart) must end in a message, not a spinner. */
const ACTION_UNREACHABLE = "Kolekto could not be reached. Check your connection and try again.";

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
      let result: Awaited<ReturnType<typeof loadMoneyAction>>;
      try {
        result = await loadMoneyAction(slug, collectionSlug);
      } catch {
        setLoadError(ACTION_UNREACHABLE);
        return;
      }
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
    case "no_payout_account":
      if (block.waiting?.kind === "cooling_off") {
        return `Your bank account can receive withdrawals from ${watText(block.waiting.usableFrom)} (48 hours after it was added, for your security).`;
      }
      if (block.waiting?.kind === "under_review") {
        return "Kolekto is checking your bank account (its name did not match your profile, or your profile name changed). You can withdraw once the check is done, or add another account under Account settings.";
      }
      return "Add your bank account under Account settings to withdraw. Kolekto checks the name on the account matches your profile, and a newly added account can receive withdrawals after 48 hours.";
    case "in_progress":
      return `A withdrawal of ${nairaText(block.amountKobo)} from this collection is already in progress. You can request another once it is finished.`;
    case "settling":
      return block.awaitingProvider
        ? "Your payments have been received successfully. The T+1 period has passed, but these payments are waiting for a Kolekto check before they can be paid out. They become available as soon as the check is done."
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
  payoutAccounts,
  block,
  onClose,
  onDone,
}: {
  slug: string;
  collectionSlug: string;
  collectionName: string;
  availableKobo: string;
  payoutAccounts: PayoutAccountView[];
  block: WithdrawBlock | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [step, setStep] = useState<"form" | "confirm" | "code">("form");
  const [requested, setRequested] = useState<{ id: string; reference: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [now] = useState(() => Date.now());
  const usable = payoutAccounts.filter((a) => Date.parse(a.usableFrom) <= now);
  const waiting = payoutAccounts.filter((a) => Date.parse(a.usableFrom) > now);
  const [bankAccountId, setBankAccountId] = useState<string>(
    () => (usable.find((a) => a.isDefault) ?? usable[0])?.id ?? "",
  );
  const account = usable.find((a) => a.id === bankAccountId) ?? null;
  const [key] = useState(newKey);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
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
  const formReady = amountKobo !== null && amountProblem === null && account !== null;
  const shownAmount = amountKobo !== null ? nairaText(amountKobo.toString()) : "";

  function submit(): void {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof requestWithdrawalAction>>;
      try {
        // Same key on every retry from this dialog: if the first attempt reached
        // the server, the database returns that withdrawal instead of a second one.
        result = await requestWithdrawalAction(slug, collectionSlug, {
          amount,
          bankAccountId,
          idempotencyKey: key,
        });
      } catch {
        setUnconfirmed(true);
        setError(
          "We could not confirm whether your request went through. Press Request withdrawal again: it will not create a second withdrawal or hold the money twice.",
        );
        return;
      }
      if (result.error) {
        setError(result.error);
        setStep("form");
        return;
      }
      if (result.withdrawalId && result.reference) {
        // Next: the member confirms with the emailed code. Not approval, not payment.
        setRequested({ id: result.withdrawalId, reference: result.reference });
        setStep("code");
        return;
      }
      onDone(`Withdrawal ${result.reference ?? ""} was requested.`);
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

  if (step === "code" && requested) {
    return (
      <Dialog
        open
        onClose={() =>
          onDone(`Withdrawal ${requested.reference} is waiting for your emailed code. Open it from the withdrawals list to enter the code.`)
        }
        title="Confirm with your code"
      >
        <WithdrawalCodeEntry
          slug={slug}
          collectionSlug={collectionSlug}
          withdrawalId={requested.id}
          reference={requested.reference}
          onVerified={() =>
            onDone(
              `Withdrawal ${requested.reference} is verified. An authorised community administrator will now review it. It is not approved or paid yet.`,
            )
          }
        />
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
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-[var(--color-text)]">Pay to</legend>
            {usable.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                {waiting.length > 0
                  ? `Your bank account can receive withdrawals from ${watText(waiting[0]!.usableFrom)} (48 hours after it was added, for your security).`
                  : "You have no verified bank account yet."}{" "}
                <Link href="/account#payout-accounts" className="font-medium text-[var(--color-primary)] hover:underline">
                  Manage bank accounts
                </Link>
              </p>
            ) : (
              usable.map((a) => (
                <label
                  key={a.id}
                  className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-2 text-sm has-[:checked]:border-[var(--color-primary)]"
                >
                  <input
                    type="radio"
                    name="payout-account"
                    className="mt-1"
                    checked={bankAccountId === a.id}
                    onChange={() => setBankAccountId(a.id)}
                  />
                  <span>
                    <span className="font-medium text-[var(--color-text)]">{a.accountName}</span>
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      {a.bankName} ••••{a.accountLast4}
                    </span>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)] text-sm">
            <ConfirmRow label="Transfer fee" value="Free — Kolekto pays the bank transfer fee" />
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
            <ConfirmRow label="Transfer fee" value="Free — Kolekto pays the bank transfer fee" />
            <ConfirmRow label="You receive" value={shownAmount} />
            <ConfirmRow
              label="To"
              value={account ? `${account.accountName}, ${account.bankName} (account ending ${account.accountLast4})` : "—"}
            />
          </dl>
          <p className="text-xs text-[var(--color-text-muted)]">
            The amount is held from your available balance straight away. Then: (1) we email you a 6-digit code to
            verify it was you; (2) an authorised community administrator reviews it — never the person who requested
            it (a withdrawal an owner requests is reviewed by their designated second approver); (3) it is sent to
            your own bank account above. Withdrawals over ₦1,000,000 are also checked by Kolekto first. It shows as Successful only
            once the bank transfer is confirmed; if it is rejected, cancelled, fails or the bank returns it, the money
            goes back to this collection&apos;s available balance.
          </p>
          {isPending && <p className="text-xs text-[var(--color-text-muted)]">Processing withdrawal request…</p>}
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button loading={isPending} onClick={submit}>
              Request withdrawal
            </Button>
            {/* After an unanswered attempt the amount and account are locked: a retry must be the same request. */}
            <Button variant="ghost" onClick={() => setStep("form")} disabled={isPending || unconfirmed}>
              Go back
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ── Member one-time code ─────────────────────────────────────────────────────

/**
 * The requesting member enters the 6-digit code emailed to them. States:
 * sending, enter code, incorrect, expired, too many attempts, resend,
 * verified (waiting for administrator review). The code verifies the request; it
 * never approves or pays it.
 */
export function WithdrawalCodeEntry({
  slug,
  collectionSlug,
  withdrawalId,
  reference,
  onVerified,
}: {
  slug: string;
  collectionSlug: string;
  withdrawalId: string;
  reference: string;
  onVerified: () => void;
}) {
  const [otp, setOtp] = useState<WithdrawalOtpView | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState<{ tone: "danger" | "info" | "success"; text: string } | null>(null);
  const [verified, setVerified] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();

  // Status reads run outside the transition, so a background look does not
  // put the member's own buttons into a loading state.
  const refresh = useCallback(async () => {
    try {
      const result = await withdrawalOtpStateAction(withdrawalId);
      if (result.error || !result.otp) {
        setLoadError(result.error ?? "The code status could not be loaded.");
        return;
      }
      setLoadError(null);
      setOtp(result.otp);
      setNow(Date.now());
      if (result.otp.memberVerified) setVerified(true);
    } catch {
      setLoadError(ACTION_UNREACHABLE);
    }
  }, [withdrawalId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { phase, canEnterCode, keepPolling } = withdrawalCodePhase(otp, now);
  // While the email is on its way, look again every few seconds (bounded by
  // the code's validity); keep the clock for "resend in" and the stall check.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (keepPolling) void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [keepPolling, refresh]);

  function verify(): void {
    setNote(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof verifyWithdrawalOtpAction>>;
      try {
        result = await verifyWithdrawalOtpAction(slug, collectionSlug, { withdrawalId, code });
      } catch {
        setNote({ tone: "danger", text: ACTION_UNREACHABLE });
        return;
      }
      if (result.error) {
        setNote({ tone: "danger", text: result.error });
        return;
      }
      switch (result.outcome) {
        case "verified":
        case "already_verified":
          setVerified(true);
          return;
        case "incorrect":
          setNote({
            tone: "danger",
            text: `That code is not right. ${result.attemptsRemaining ?? 0} attempt${result.attemptsRemaining === 1 ? "" : "s"} left.`,
          });
          break;
        case "locked":
          setNote({ tone: "danger", text: "Too many wrong attempts. Request a new code." });
          break;
        case "expired":
          setNote({ tone: "danger", text: "That code has expired. Request a new code." });
          break;
        case "superseded":
          setNote({ tone: "danger", text: "A newer code was sent. Use the code from the latest email." });
          break;
        case "not_sent":
          setNote({ tone: "info", text: "The code is still being sent. Check your email in a moment." });
          break;
        case "withdrawal_closed":
          setNote({ tone: "danger", text: "This withdrawal is no longer waiting for a code (it was cancelled or rejected)." });
          break;
      }
      setCode("");
      await refresh();
    });
  }

  function resend(): void {
    setNote(null);
    startTransition(async () => {
      try {
        const result = await resendWithdrawalOtpAction(withdrawalId);
        if (result.error) setNote({ tone: "danger", text: result.error });
        else setNote({ tone: "info", text: "A new code was requested. Earlier codes no longer work." });
      } catch {
        setNote({ tone: "danger", text: ACTION_UNREACHABLE });
      }
      await refresh();
    });
  }

  if (verified) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <Banner tone="success">
          Withdrawal {reference} is verified. An authorised community administrator will now review it — it is not
          approved or paid yet.
        </Banner>
        <Button onClick={onVerified} className="self-start">
          Done
        </Button>
      </div>
    );
  }

  const resendIn = otp ? Math.max(0, Math.ceil((Date.parse(otp.resendAvailableAt) - now) / 1000)) : 0;
  const email = otp?.emailHint ?? "your email";

  if (phase === "loading" && loadError) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <Banner tone="danger">{loadError}</Banner>
        <p className="text-xs text-[var(--color-text-muted)]">
          Withdrawal {reference} was created and its amount is held. Nothing is approved or paid.
        </p>
        <Button variant="secondary" onClick={() => void refresh()} className="self-start">
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
      <p className="text-xs text-[var(--color-text-muted)]">
        Your withdrawal request {reference} has been submitted. Verify your request using the code sent to your email.
        Once verified, an authorised community administrator will review it.
      </p>
      <p>
        {phase === "loading"
          ? "Loading…"
          : phase === "sending"
            ? `Sending a verification code to ${email}…`
            : phase === "stalled"
              ? canEnterCode
                ? `Sending the code to ${email} is taking longer than usual. If the email has arrived, enter the code; otherwise request a new one.`
                : `Unable to send the verification code to ${email} yet. Request a new code in a moment. Your request is kept and nothing is approved or paid.`
              : phase === "delivery_failed"
                ? "Unable to send the verification code. Request a new code. Your request is kept and nothing is approved or paid."
                : phase === "locked"
                  ? "Too many wrong attempts for this code. Request a new code."
                  : phase === "expired"
                    ? "This code has expired. Request a new code."
                    : phase === "closed"
                      ? "This code is no longer valid. Request a new code if the withdrawal is still open."
                      : `Verification code sent to ${email}. Enter the 6-digit code from that email.`}
      </p>
      {loadError && <Banner tone="danger">{loadError}</Banner>}
      {canEnterCode && (
        <>
          <TextField
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            hint={
              otp?.expiresAt
                ? `Valid until ${watText(otp.expiresAt)}${otp.attemptsRemaining !== null ? ` · ${otp.attemptsRemaining} attempts left` : ""}`
                : "Check your email for the code."
            }
          />
          <Button loading={isPending} disabled={code.replace(/[\s-]/g, "").length !== 6} onClick={verify} className="self-start">
            Confirm code
          </Button>
        </>
      )}
      {phase === "sending" && <Spinner />}
      {note && <Banner tone={note.tone}>{note.text}</Banner>}
      <button
        type="button"
        className="self-start text-xs font-medium text-[var(--color-primary)] hover:underline disabled:text-[var(--color-text-muted)] disabled:no-underline"
        disabled={isPending || resendIn > 0}
        onClick={resend}
      >
        {resendIn > 0 ? `Request a new code in ${resendIn}s` : "Request a new code"}
      </button>
      <p className="text-xs text-[var(--color-text-muted)]">
        This code only verifies that you made this request. It does not approve or pay the withdrawal: an authorised
        community administrator must still review it. Kolekto never asks for this code by phone or chat.
      </p>
    </div>
  );
}

// ── Administrator review (owner, or designated second approver) ──────────────

function OwnerReview({
  w,
  isPending,
  onApprove,
  onReject,
  onClose,
}: {
  w: WithdrawalView;
  isPending: boolean;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const before = w.availableBeforeKobo;
  const after = before === null ? null : (BigInt(before) - BigInt(w.amountKobo) - BigInt(w.feeKobo)).toString();
  const flags: string[] = [];
  if (w.isMine) flags.push("This is your own request. You cannot approve or reject your own withdrawal; another authorised administrator reviews it");
  if (w.isFirst) flags.push("First withdrawal from this collection");
  if (w.requiresManualReview) flags.push("Over ₦1,000,000: Kolekto checks it before payout");
  if (w.accountStatus && w.accountStatus !== "verified") flags.push(`Destination account is now ${w.accountStatus.replace("_", " ")}`);
  if (w.accountCoolingOff) flags.push("Destination account is still in its 48-hour cooling-off period");
  return (
    <Dialog open onClose={onClose} title={`Review withdrawal ${w.reference}`}>
      <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
        {(w.canDecide || w.canReject) && (
          <p>You have a withdrawal request awaiting your review. Confirm the request details before approving or rejecting it.</p>
        )}
        <dl className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <ConfirmRow label="Requested by" value={w.requestedByName ?? "An officer"} />
          <ConfirmRow label="Requested" value={watText(w.requestedAt)} />
          <ConfirmRow label="Amount" value={nairaText(w.amountKobo)} />
          <ConfirmRow label="Available before" value={before === null ? "—" : nairaText(before)} />
          <ConfirmRow label="Available after" value={after === null ? "—" : nairaText(after)} />
          <ConfirmRow label="To" value={`${w.accountName}, ${w.bankName} ••••${w.accountLast4}`} />
          <ConfirmRow
            label="Requester's code"
            value={w.memberVerifiedAt ? `Confirmed ${watText(w.memberVerifiedAt)}` : "Not confirmed yet"}
          />
        </dl>
        <p className="text-xs text-[var(--color-text-muted)]">
          The money goes only to the requester&apos;s own verified bank account shown above. It cannot be changed here.
        </p>
        {flags.length > 0 && (
          <Banner tone="info">
            <ul className="list-disc pl-4">
              {flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Banner>
        )}
        {!w.canDecide && w.canReject && (
          <p className="text-xs text-[var(--color-text-muted)]">
            You can approve once the requester has confirmed with their emailed code. You can reject at any time.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {w.canDecide && (
            <Button loading={isPending} onClick={onApprove}>
              Approve withdrawal
            </Button>
          )}
          {w.canReject && (
            <Button variant="secondary" onClick={onReject}>
              Reject
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
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
  const [reviewing, setReviewing] = useState<WithdrawalView | null>(null);
  const [entering, setEntering] = useState<WithdrawalView | null>(null);
  const [isPending, startTransition] = useTransition();

  function decide(w: WithdrawalView, decision: "approve" | "reject" | "cancel", reason?: string): void {
    setMessage(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof decideWithdrawalAction>>;
      try {
        result = await decideWithdrawalAction(slug, collectionSlug, {
          withdrawalId: w.id,
          decision,
          ...(reason ? { reason } : {}),
        });
      } catch {
        // The decision may or may not have been saved: reload to show where it is.
        setMessage(`${ACTION_UNREACHABLE} Reload to see whether the decision was saved.`);
        onChanged();
        return;
      }
      setRejecting(null);
      setReviewing(null);
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
              <Badge tone={withdrawalStageLabel(w.stage, w.status).tone}>{withdrawalStageLabel(w.stage, w.status).label}</Badge>
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              <span className="font-mono">{w.reference}</span> · {w.accountName} · {w.bankName} ••••{w.accountLast4} ·{" "}
              {w.requestedByName ?? "An officer"} · {formatDistanceToNow(w.requestedAt)}
              {w.requiresManualReview && " · checked by Kolekto before payout"}
            </p>
            {w.approvedAt && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Approved by {w.approvedByName ?? "an authorised administrator"} {watText(w.approvedAt)}
                {w.ownerSelfApproved && " (own request — recorded before independent approval was required)"}
              </p>
            )}
            {w.transferEscalated && (
              <p className="text-xs text-[var(--color-warning)]">
                The bank transfer has not been confirmed yet. Kolekto is checking it; the money stays reserved.
              </p>
            )}
            {w.paidAt && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Paid {watText(w.paidAt)}
                {w.payoutReference && <span className="font-mono"> · {w.payoutReference}</span>}
              </p>
            )}
            {!w.paidAt && w.transferReference && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Bank transfer <span className="font-mono">{w.transferReference}</span>
              </p>
            )}
            {w.reversedAt && (
              <p className="text-xs text-[var(--color-danger)]">
                Returned by the bank {watText(w.reversedAt)}
                {w.reversalReason && ` — ${w.reversalReason}`}. The amount is back in the available balance.
              </p>
            )}
            {w.failureReason && <p className="text-xs text-[var(--color-danger)]">{w.failureReason}</p>}
            {w.decisionReason && <p className="text-xs text-[var(--color-text-muted)]">“{w.decisionReason}”</p>}
            {(w.canReject || w.canCancel || (w.isMine && w.stage === "awaiting_member_verification")) && (
              <div className="flex flex-wrap gap-2">
                {w.isMine && w.stage === "awaiting_member_verification" && (
                  <Button size="sm" onClick={() => setEntering(w)}>
                    Enter code
                  </Button>
                )}
                {w.canReject && (
                  <Button size="sm" variant={w.canDecide ? "primary" : "secondary"} onClick={() => setReviewing(w)}>
                    Review
                  </Button>
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

      {reviewing && (
        <OwnerReview
          w={reviewing}
          isPending={isPending}
          onApprove={() => decide(reviewing, "approve")}
          onReject={() => {
            setRejecting(reviewing);
            setReviewing(null);
          }}
          onClose={() => setReviewing(null)}
        />
      )}

      {entering && (
        <Dialog open onClose={() => setEntering(null)} title={`Confirm withdrawal ${entering.reference}`}>
          <WithdrawalCodeEntry
            slug={slug}
            collectionSlug={collectionSlug}
            withdrawalId={entering.id}
            reference={entering.reference}
            onVerified={() => {
              setEntering(null);
              onChanged();
            }}
          />
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
