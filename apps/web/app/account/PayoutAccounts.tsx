"use client";

import { Badge, Banner, Button, SelectField, Spinner, TextField } from "@kolekto/ui";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  addBankAccountAction,
  type BankAccountView,
  loadBankAccountsAction,
  removeBankAccountAction,
  setDefaultBankAccountAction,
} from "./bank-actions.ts";

/**
 * Bank accounts withdrawals are paid to. The browser sends a bank code and
 * an account number; the server asks the bank for the account holder's name
 * and compares it with the profile name. Nothing here decides verification.
 */

const WAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Lagos",
});
const watText = (iso: string) => `${WAT.format(new Date(iso))} WAT`;

const STATUS: Record<BankAccountView["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  verified: { label: "Verified", tone: "success" },
  needs_review: { label: "Being reviewed", tone: "warning" },
  rejected: { label: "Not accepted", tone: "neutral" },
};

export function PayoutAccounts() {
  const [accounts, setAccounts] = useState<BankAccountView[] | null>(null);
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bankCode, setBankCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "info" | "danger"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [now] = useState(() => Date.now());

  const reload = useCallback(() => {
    startTransition(async () => {
      const result = await loadBankAccountsAction();
      if (result.error) {
        setLoadError(result.error);
        return;
      }
      setLoadError(null);
      setAccounts(result.accounts ?? []);
      setBanks(result.banks ?? []);
      setAvailable(result.available ?? false);
    });
  }, []);
  useEffect(reload, [reload]);

  function add(): void {
    setMessage(null);
    startTransition(async () => {
      const result = await addBankAccountAction({ bankCode, accountNumber });
      if (result.error) {
        setMessage({ tone: "danger", text: result.error });
        return;
      }
      setAccountNumber("");
      if (result.outcome === "needs_review") {
        setMessage({
          tone: "info",
          text: "The name on this account does not match your profile name, so Kolekto will review it before it can receive withdrawals.",
        });
      } else {
        const when = result.usableFrom && Date.parse(result.usableFrom) > Date.now() ? ` It can receive withdrawals from ${watText(result.usableFrom)}.` : "";
        setMessage({
          tone: "success",
          text: `${result.outcome === "reused" ? "This account is already saved" : "Account verified"}${result.accountName ? ` — ${result.accountName}` : ""}.${when}`,
        });
      }
      reload();
    });
  }

  function act(fn: () => Promise<{ error?: string }>): void {
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setMessage({ tone: "danger", text: result.error });
      reload();
    });
  }

  return (
    <section id="payout-accounts" className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-medium text-[var(--color-text)]">Bank accounts for withdrawals</h2>
        <p className="text-sm text-[var(--color-text-muted)]">
          Withdrawals are paid only to your own account. Kolekto checks with your bank that the account name matches
          your profile name. For your security, an account added after your first can receive withdrawals 48 hours
          after it is added.
        </p>
      </div>

      {loadError && <Banner tone="danger">{loadError}</Banner>}
      {accounts === null && !loadError ? (
        <Spinner label="Loading bank accounts" />
      ) : (
        accounts && (
          <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {accounts.length === 0 && <li className="p-3 text-sm text-[var(--color-text-muted)]">No bank accounts yet.</li>}
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-[var(--color-text)]">
                    {a.bankName} ••••{a.accountLast4}
                    {a.isDefault && <span className="ml-2 text-xs text-[var(--color-text-muted)]">Default</span>}
                  </span>
                  <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                </div>
                {a.accountName && <span className="text-xs text-[var(--color-text-muted)]">{a.accountName}</span>}
                {a.status === "verified" && Date.parse(a.usableFrom) > now && (
                  <span className="text-xs text-[var(--color-text-muted)]">Can receive withdrawals from {watText(a.usableFrom)}</span>
                )}
                {a.status === "needs_review" && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    Kolekto is checking this account (the name did not match your profile, or your profile name changed).
                    It can receive withdrawals once the check is done.
                  </span>
                )}
                {a.reviewNote && <span className="text-xs text-[var(--color-text-muted)]">{a.reviewNote}</span>}
                <div className="flex flex-wrap gap-2">
                  {a.status === "verified" && !a.isDefault && (
                    <Button size="sm" variant="secondary" disabled={isPending} onClick={() => act(() => setDefaultBankAccountAction(a.id))}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={isPending} onClick={() => act(() => removeBankAccountAction(a.id))}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      {available ? (
        <div className="flex flex-col gap-3">
          <SelectField label="Bank" value={bankCode} onChange={(event) => setBankCode(event.target.value)}>
            <option value="">Choose your bank</option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Account number"
            inputMode="numeric"
            maxLength={10}
            value={accountNumber}
            onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))}
            hint="10 digits (NUBAN)"
          />
          <Button
            className="self-start"
            loading={isPending}
            disabled={bankCode === "" || !/^[0-9]{10}$/.test(accountNumber)}
            onClick={add}
          >
            Check and add account
          </Button>
        </div>
      ) : (
        accounts !== null && <Banner tone="info">Bank accounts cannot be added right now. Try again later.</Banner>
      )}
      {message && <Banner tone={message.tone}>{message.text}</Banner>}
    </section>
  );
}
