"use server";

/**
 * Saved payout bank accounts (Account settings). Owner decision Q3,
 * 2026-11-18: an account is verified when the name the bank reports matches
 * the profile name; otherwise it goes to Kolekto for review.
 *
 * SECURITY.
 *   · The user is the signed-in session's user, never a value from the browser.
 *   · The bank name, the account holder's name and the match are decided here,
 *     on the server, from Paystack's answer. The browser sends only a bank
 *     code and an account number.
 *   · The bank-reported name of an account that does NOT match is never sent
 *     back, so this screen is not a way to learn whose an account number is.
 *   · Nothing here logs. The full account number leaves this file only towards
 *     Paystack and the database.
 *   · Registration limits (5 active, 10 per day) and the 48-hour cooling-off
 *     are enforced by app.register_bank_account.
 */

import type { Bank } from "@kolekto/adapters";
import {
  DatabaseError,
  disableBankAccount,
  getProfileName,
  listMyBankAccounts,
  ownerPaymentDb,
  registerBankAccount,
  setBankAccountRecipient,
  setDefaultBankAccount,
  type SavedBankAccount,
} from "@kolekto/db";
import { matchBankAccountName } from "@kolekto/domain";
import { revalidatePath } from "next/cache";

import { requireCallerContext } from "../../lib/caller.ts";
import { getTransferProvider } from "../../lib/payments/transfers.ts";

/** One saved account as the screen shows it. The bank-reported name only once verified. */
export interface BankAccountView {
  id: string;
  bankName: string;
  accountLast4: string;
  accountName: string | null;
  status: SavedBankAccount["status"];
  isDefault: boolean;
  usableFrom: string;
  reviewNote: string | null;
}

const BANKS_KEY = Symbol.for("kolekto.payments.bankList");
const BANKS_TTL_MS = 6 * 60 * 60_000;
type WithBanks = typeof globalThis & { [BANKS_KEY]?: { at: number; banks: readonly Bank[] } };

async function banks(): Promise<readonly Bank[] | null> {
  const store = globalThis as WithBanks;
  const cached = store[BANKS_KEY];
  if (cached && Date.now() - cached.at < BANKS_TTL_MS) return cached.banks;
  const provider = getTransferProvider();
  if (provider === null) return null;
  const result = await provider.listBanks();
  if (result.outcome !== "ok") return cached?.banks ?? null;
  store[BANKS_KEY] = { at: Date.now(), banks: result.value };
  return result.value;
}

function toView(a: SavedBankAccount): BankAccountView {
  return {
    id: a.id,
    bankName: a.bankName,
    accountLast4: a.accountLast4,
    accountName: a.status === "verified" ? a.accountName : null,
    status: a.status,
    isDefault: a.isDefault,
    usableFrom: a.usableFrom,
    reviewNote: a.reviewNote,
  };
}

function messageFor(error: unknown, fallback: string): string {
  if (!(error instanceof DatabaseError)) return fallback;
  switch (error.code) {
    case "TOO_MANY_BANK_ACCOUNTS":
      return "You can keep at most 5 bank accounts. Remove one first.";
    case "BANK_ACCOUNT_RATE_LIMITED":
      return "Too many bank accounts were added today. Try again tomorrow.";
    case "PROFILE_NAME_CHANGED":
      return "Your profile name changed while this was being checked. Try again.";
    case "BANK_ACCOUNT_IN_USE":
      return "A withdrawal to this account is still in progress. Remove it once that is finished.";
    case "BANK_ACCOUNT_NOT_VERIFIED":
      return "Only a verified account can be the default.";
    case "NOT_FOUND":
      return "That bank account could not be found.";
    default:
      return fallback;
  }
}

export async function loadBankAccountsAction(): Promise<{
  error?: string;
  accounts?: BankAccountView[];
  banks?: { code: string; name: string }[];
  available?: boolean;
}> {
  const caller = await requireCallerContext();
  try {
    const [accounts, bankList] = await Promise.all([listMyBankAccounts(caller), banks()]);
    return {
      accounts: accounts.map(toView),
      banks: (bankList ?? []).map((b) => ({ code: b.code, name: b.name })),
      available: bankList !== null,
    };
  } catch (error) {
    return { error: messageFor(error, "Your bank accounts could not be loaded.") };
  }
}

export async function addBankAccountAction(input: { bankCode: string; accountNumber: string }): Promise<{
  error?: string;
  outcome?: "verified" | "needs_review" | "reused";
  usableFrom?: string;
  accountName?: string;
}> {
  const caller = await requireCallerContext();
  const userId = caller.userId;
  if (userId === null) return { error: "Sign in again to add a bank account." };
  const accountNumber = String(input.accountNumber ?? "").replace(/\s/g, "");
  if (!/^[0-9]{10}$/.test(accountNumber)) return { error: "Enter the 10-digit account number (NUBAN)." };

  const provider = getTransferProvider();
  const bankList = await banks();
  if (provider === null || bankList === null) return { error: "Bank accounts cannot be added right now. Try again later." };
  const bank = bankList.find((b) => b.code === String(input.bankCode ?? ""));
  if (!bank) return { error: "Choose your bank from the list." };

  try {
    // A cheap stop before asking the bank: the database refuses past these
    // limits anyway, but only after a resolution has been spent.
    const existing = await listMyBankAccounts(caller);
    if (existing.length >= 5) return { error: "You can keep at most 5 bank accounts. Remove one first." };
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    if (existing.filter((a) => Date.parse(a.createdAt) > dayAgo).length >= 10) {
      return { error: "Too many bank accounts were added today. Try again tomorrow." };
    }

    const resolved = await provider.resolveAccount(accountNumber, bank.code);
    if (resolved.outcome === "not_found") return { error: "The bank could not find that account number. Check it and the bank, then try again." };
    if (resolved.outcome !== "ok") return { error: "The bank could not be reached to check this account. Try again in a few minutes." };

    const profileName = await getProfileName(ownerPaymentDb, userId);
    if (profileName === null) return { error: "Add your full name to your profile first." };
    const match = matchBankAccountName(profileName, resolved.value.accountName);

    const registered = await registerBankAccount(ownerPaymentDb, {
      userId,
      bankCode: bank.code,
      bankName: bank.name,
      accountNumber,
      resolvedName: resolved.value.accountName,
      profileName,
      nameMatched: match.matched,
    });

    // Register the Paystack recipient now for a verified account. Not fatal:
    // the payout stage creates it before the first transfer if this fails.
    if (registered.status === "verified" && registered.outcome !== "reused") {
      const recipient = await provider.createRecipient({ accountName: resolved.value.accountName, accountNumber, bankCode: bank.code });
      if (recipient.outcome === "ok") {
        await setBankAccountRecipient(ownerPaymentDb, registered.bankAccountId, recipient.value.recipientCode).catch(() => undefined);
      }
    }

    revalidatePath("/account");
    return {
      outcome: registered.outcome,
      usableFrom: registered.usableFrom,
      ...(registered.status === "verified" ? { accountName: resolved.value.accountName } : {}),
    };
  } catch (error) {
    return { error: messageFor(error, "That bank account could not be added.") };
  }
}

export async function setDefaultBankAccountAction(bankAccountId: string): Promise<{ error?: string }> {
  const caller = await requireCallerContext();
  try {
    await setDefaultBankAccount(caller, String(bankAccountId));
    revalidatePath("/account");
    return {};
  } catch (error) {
    return { error: messageFor(error, "That could not be saved.") };
  }
}

export async function removeBankAccountAction(bankAccountId: string): Promise<{ error?: string }> {
  const caller = await requireCallerContext();
  try {
    await disableBankAccount(caller, String(bankAccountId));
    revalidatePath("/account");
    return {};
  } catch (error) {
    return { error: messageFor(error, "That bank account could not be removed.") };
  }
}
