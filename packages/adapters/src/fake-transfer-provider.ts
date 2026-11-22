/**
 * fake-transfer-provider.ts — deterministic, offline `TransferProvider` for
 * local development and tests. No network, no real money.
 *
 * Behaviour is chosen by the account number's last digit, so a tester can
 * pick an outcome from the UI:
 *   …0  resolution fails (not_found)
 *   …9  transfer fails at the bank (verify reports failed)
 *   …8  transfer succeeds, then is reversed on the next verify
 *   …7  transfer stays pending
 *   any other digit: resolves to `accountNames[number] ?? defaultAccountName`
 *        and transfers succeed on the first verify
 */

import { kobo, type Kobo } from "@kolekto/domain";

import type { ProviderResult } from "./payment-provider.ts";
import type {
  ApprovalSignature,
  Bank,
  CreateRecipientRequest,
  InitiateTransferRequest,
  ListTransfersQuery,
  ResolvedAccount,
  TransferPage,
  TransferProvider,
  TransferRecipient,
  TransferState,
} from "./transfer-provider.ts";

export interface FakeTransferProviderOptions {
  /** Name every resolvable account reports unless listed in `accountNames`. */
  readonly defaultAccountName?: string;
  readonly accountNames?: Readonly<Record<string, string>>;
  readonly balance?: Kobo;
  /** Transfer fee reported on success. Default ₦25 (2 500 kobo). */
  readonly transferFee?: Kobo;
  /** Milliseconds since the epoch, for createdAt on stored transfers. */
  readonly clock?: () => number;
}

interface StoredTransfer {
  state: TransferState;
  accountNumber: string;
  verifies: number;
}

export const FAKE_BANKS: readonly Bank[] = [
  { name: "Access Bank", code: "044" },
  { name: "First Bank of Nigeria", code: "011" },
  { name: "Guaranty Trust Bank", code: "058" },
  { name: "Kolekto Test Bank", code: "999" },
  { name: "United Bank For Africa", code: "033" },
  { name: "Zenith Bank", code: "057" },
];

export class FakeTransferProvider implements TransferProvider {
  readonly name = "fake" as const;
  readonly testMode = true;
  readonly #options: FakeTransferProviderOptions;
  readonly #recipients = new Map<string, string>(); // recipient code → account number
  readonly #transfers = new Map<string, StoredTransfer>();
  #balance: bigint;
  #seq = 0;
  readonly #clock: (() => number) | null;

  constructor(options: FakeTransferProviderOptions = {}) {
    this.#options = options;
    this.#balance = options.balance ?? 100_000_000_00n; // ₦100m
    this.#clock = options.clock ?? null;
  }

  async listBanks(): Promise<ProviderResult<readonly Bank[]>> {
    return { outcome: "ok", value: FAKE_BANKS };
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ProviderResult<ResolvedAccount>> {
    if (!/^\d{10}$/.test(accountNumber) || !FAKE_BANKS.some((b) => b.code === bankCode) || accountNumber.endsWith("0")) {
      return { outcome: "not_found" };
    }
    const accountName = this.#options.accountNames?.[accountNumber] ?? this.#options.defaultAccountName ?? "TEST ACCOUNT HOLDER";
    return { outcome: "ok", value: { accountNumber, accountName } };
  }

  async createRecipient(request: CreateRecipientRequest): Promise<ProviderResult<TransferRecipient>> {
    const code = `RCP_fake${request.bankCode}${request.accountNumber}`;
    this.#recipients.set(code, request.accountNumber);
    return { outcome: "ok", value: { recipientCode: code } };
  }

  async getBalance(): Promise<ProviderResult<{ readonly available: Kobo }>> {
    return { outcome: "ok", value: { available: kobo(this.#balance) } };
  }

  async initiateTransfer(request: InitiateTransferRequest): Promise<ProviderResult<TransferState>> {
    const existing = this.#transfers.get(request.reference);
    if (existing !== undefined) return { outcome: "refused", providerCode: "duplicate_reference", message: "Duplicate transfer reference" };
    const accountNumber = this.#recipients.get(request.recipientCode);
    if (accountNumber === undefined) return { outcome: "refused", providerCode: "invalid_recipient", message: "Recipient not found" };
    if (BigInt(request.amount) > this.#balance) {
      return { outcome: "refused", providerCode: "insufficient_balance", message: "Your balance is not enough to fulfil this request" };
    }
    this.#balance -= BigInt(request.amount);
    this.#seq += 1;
    const state: TransferState = {
      reference: request.reference,
      transferCode: `TRF_fake${String(this.#seq).padStart(6, "0")}`,
      providerTransferId: String(9_000_000 + this.#seq),
      status: "pending",
      providerStatusRaw: "pending",
      amount: request.amount,
      fee: null,
      reason: null,
      recipientCode: request.recipientCode,
      createdAt: this.#clock === null ? null : new Date(this.#clock()).toISOString(),
    };
    this.#transfers.set(request.reference, { state, accountNumber, verifies: 0 });
    return { outcome: "ok", value: state };
  }

  async listTransfers(query: ListTransfersQuery): Promise<ProviderResult<TransferPage>> {
    const from = query.from.toISOString();
    const to = query.to.toISOString();
    const inWindow = [...this.#transfers.values()]
      .map((t) => t.state)
      .filter((st) => st.createdAt === null || (st.createdAt >= from && st.createdAt <= to));
    const perPage = Math.min(Math.max(query.perPage, 1), 100);
    const start = (Math.max(query.page, 1) - 1) * perPage;
    return {
      outcome: "ok",
      value: { items: inWindow.slice(start, start + perPage), pageCount: Math.max(1, Math.ceil(inWindow.length / perPage)), unparseable: 0 },
    };
  }

  /** The fake signs nothing: any signature header is invalid. */
  authenticateApprovalRequest(_rawBody: Uint8Array, headers: Readonly<Record<string, string>>): ApprovalSignature {
    return headers["x-paystack-signature"] === undefined && headers["paystack-signature"] === undefined ? "absent" : "invalid";
  }

  async verifyTransfer(reference: string): Promise<ProviderResult<TransferState>> {
    const stored = this.#transfers.get(reference);
    if (stored === undefined) return { outcome: "not_found" };
    stored.verifies += 1;
    const last = stored.accountNumber.slice(-1);
    const fee = this.#options.transferFee ?? kobo(2_500n);
    if (last === "7") return { outcome: "ok", value: stored.state };
    if (last === "9") {
      stored.state = { ...stored.state, status: "failed", providerStatusRaw: "failed", reason: "Beneficiary account could not be credited" };
      this.#balance += BigInt(stored.state.amount);
    } else if (last === "8" && stored.state.status === "success") {
      stored.state = { ...stored.state, status: "reversed", providerStatusRaw: "reversed", reason: "Beneficiary bank returned the funds" };
      this.#balance += BigInt(stored.state.amount);
    } else if (stored.state.status === "pending") {
      stored.state = { ...stored.state, status: "success", providerStatusRaw: "success", fee };
    }
    return { outcome: "ok", value: stored.state };
  }
}
