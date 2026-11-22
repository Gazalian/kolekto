/**
 * paystack-transfer-provider.ts — `TransferProvider` for Paystack.
 *
 * Endpoints (https://paystack.com/docs/api/transfer/, /transfer-recipient/,
 * /verification/, /miscellaneous/):
 *   GET  /bank?country=nigeria&currency=NGN&use_cursor=true&perPage=100
 *   GET  /bank/resolve?account_number=…&bank_code=…
 *   POST /transferrecipient   { type: "nuban", name, account_number, bank_code, currency: "NGN" }
 *   GET  /balance
 *   POST /transfer            { source: "balance", amount (kobo), recipient, reference, reason, currency: "NGN" }
 *   GET  /transfer/verify/:reference
 *   GET  /transfer?perPage=…&page=…&from=…&to=…   (read-only reconciliation)
 *
 * Same rules as the payment adapter: server only, nothing logged, every
 * outcome a `ProviderResult`. A transfer initiation that times out or gets a
 * 5xx is `unknown` with `safeToRetry: false`: the caller verifies the
 * reference instead of sending again (D-27).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { kobo, type Kobo } from "@kolekto/domain";

import type { ProviderResult } from "./payment-provider.ts";
import type { PaystackConfig } from "./paystack-payment-provider.ts";
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
  TransferStatus,
} from "./transfer-provider.ts";

const DEFAULT_API_BASE = "https://api.paystack.co";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_BANK_PAGES = 10;

type TransferConfig = Pick<PaystackConfig, "secretKey" | "apiBase" | "requestTimeoutMs">;

export class PaystackTransferProvider implements TransferProvider {
  readonly name = "paystack" as const;
  readonly testMode: boolean;
  readonly #secretKey: string;
  readonly #apiBase: string;
  readonly #timeoutMs: number;

  constructor(config: TransferConfig) {
    if (!config.secretKey.startsWith("sk_test_") && !config.secretKey.startsWith("sk_live_")) {
      throw new Error("PaystackTransferProvider needs a Paystack secret key.");
    }
    this.#secretKey = config.secretKey;
    this.#apiBase = config.apiBase ?? DEFAULT_API_BASE;
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.testMode = config.secretKey.startsWith("sk_test_");
  }

  async listBanks(): Promise<ProviderResult<readonly Bank[]>> {
    const banks: Bank[] = [];
    let next: string | null = null;
    for (let page = 0; page < MAX_BANK_PAGES; page++) {
      const query = new URLSearchParams({ country: "nigeria", currency: "NGN", use_cursor: "true", perPage: "100" });
      if (next !== null) query.set("next", next);
      const response = await this.#request("GET", `/bank?${query.toString()}`, null, true);
      if (response.outcome !== "ok") return response;
      const list = Array.isArray(response.value.data) ? response.value.data : null;
      if (list === null) return { outcome: "unknown", reason: "paystack_bank_list_unparseable", safeToRetry: true };
      for (const item of list) {
        if (!isRecord(item)) continue;
        const name = str(item["name"]);
        const code = str(item["code"]);
        if (name === null || code === null) continue;
        if (item["active"] === false || item["is_deleted"] === true) continue;
        if (!banks.some((b) => b.code === code)) banks.push({ name, code });
      }
      const meta = isRecord(response.value.meta) ? response.value.meta : null;
      next = meta !== null ? str(meta["next"]) : null;
      if (next === null) break;
    }
    banks.sort((a, b) => a.name.localeCompare(b.name));
    return { outcome: "ok", value: banks };
  }

  async resolveAccount(accountNumber: string, bankCode: string): Promise<ProviderResult<ResolvedAccount>> {
    const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
    const response = await this.#request("GET", `/bank/resolve?${query.toString()}`, null, true);
    // Paystack answers 422 "Could not resolve account name" for an account
    // the bank does not know: that is a not_found, not an outage. Other
    // refusals (bad key, rate limit) stay refusals.
    if (
      response.outcome === "refused" &&
      (response.providerCode === "http_422" || /could not resolve|invalid account|unknown bank/i.test(response.message))
    ) {
      return { outcome: "not_found" };
    }
    if (response.outcome !== "ok") return response;
    const data = isRecord(response.value.data) ? response.value.data : null;
    const name = data !== null ? str(data["account_name"]) : null;
    const number = data !== null ? str(data["account_number"]) : null;
    if (name === null || number === null) {
      return { outcome: "unknown", reason: "paystack_resolve_unparseable", safeToRetry: true };
    }
    if (number !== accountNumber) {
      return { outcome: "unknown", reason: "paystack_resolve_echoed_other_account", safeToRetry: false };
    }
    return { outcome: "ok", value: { accountNumber: number, accountName: name.trim() } };
  }

  async createRecipient(request: CreateRecipientRequest): Promise<ProviderResult<TransferRecipient>> {
    // Creating the same recipient twice is harmless (Paystack returns a
    // recipient for the same account details), so a timeout is retryable.
    const response = await this.#request(
      "POST",
      "/transferrecipient",
      {
        type: "nuban",
        name: request.accountName,
        account_number: request.accountNumber,
        bank_code: request.bankCode,
        currency: "NGN",
      },
      true,
    );
    if (response.outcome !== "ok") return response;
    const data = isRecord(response.value.data) ? response.value.data : null;
    const code = data !== null ? str(data["recipient_code"]) : null;
    if (code === null || !/^RCP_[0-9A-Za-z]{4,40}$/.test(code)) {
      return { outcome: "unknown", reason: "paystack_recipient_unparseable", safeToRetry: true };
    }
    return { outcome: "ok", value: { recipientCode: code } };
  }

  async getBalance(): Promise<ProviderResult<{ readonly available: Kobo }>> {
    const response = await this.#request("GET", "/balance", null, true);
    if (response.outcome !== "ok") return response;
    const list = Array.isArray(response.value.data) ? response.value.data : null;
    const ngn = list?.find((b) => isRecord(b) && b["currency"] === "NGN");
    const amount = isRecord(ngn) ? toBigInt(ngn["balance"]) : null;
    if (amount === null) return { outcome: "unknown", reason: "paystack_balance_unparseable", safeToRetry: true };
    return { outcome: "ok", value: { available: kobo(amount) } };
  }

  async initiateTransfer(request: InitiateTransferRequest): Promise<ProviderResult<TransferState>> {
    const response = await this.#request(
      "POST",
      "/transfer",
      {
        source: "balance",
        amount: String(request.amount), // kobo, as a string so the bigint survives JSON (as initialize does)
        recipient: request.recipientCode,
        reference: request.reference,
        reason: request.reason,
        currency: "NGN",
      },
      // Money may have moved: never blindly retry (D-27).
      false,
    );
    if (response.outcome !== "ok") return response;
    const state = parseTransfer(response.value.data);
    if (state === null || state.reference !== request.reference) {
      return { outcome: "unknown", reason: "paystack_transfer_response_unparseable", safeToRetry: false };
    }
    return { outcome: "ok", value: state };
  }

  async verifyTransfer(reference: string): Promise<ProviderResult<TransferState>> {
    const response = await this.#request("GET", `/transfer/verify/${encodeURIComponent(reference)}`, null, true);
    if (response.outcome === "refused" && response.providerCode === "http_404") return { outcome: "not_found" };
    if (response.outcome === "refused" && /not\s*found/i.test(response.message)) return { outcome: "not_found" };
    if (response.outcome !== "ok") return response;
    const state = parseTransfer(response.value.data);
    if (state === null || state.reference !== reference) {
      return { outcome: "unknown", reason: "paystack_transfer_verify_unparseable", safeToRetry: true };
    }
    return { outcome: "ok", value: state };
  }

  async listTransfers(query: ListTransfersQuery): Promise<ProviderResult<TransferPage>> {
    const params = new URLSearchParams({
      perPage: String(Math.min(Math.max(query.perPage, 1), 100)),
      page: String(Math.max(query.page, 1)),
      from: query.from.toISOString(),
      to: query.to.toISOString(),
    });
    const response = await this.#request("GET", `/transfer?${params.toString()}`, null, true);
    if (response.outcome !== "ok") return response;
    const list = Array.isArray(response.value.data) ? response.value.data : null;
    if (list === null) return { outcome: "unknown", reason: "paystack_transfer_list_unparseable", safeToRetry: true };
    const items: TransferState[] = [];
    let unparseable = 0;
    for (const item of list) {
      const state = parseTransfer(item);
      if (state === null) unparseable += 1;
      else items.push(state);
    }
    const meta = isRecord(response.value.meta) ? response.value.meta : null;
    const pageCountRaw = meta !== null ? toBigInt(meta["pageCount"]) : null;
    return { outcome: "ok", value: { items, pageCount: pageCountRaw === null ? 1 : Number(pageCountRaw), unparseable } };
  }

  /**
   * Paystack does not document a signature on approval requests. If it sends
   * the webhook's `x-paystack-signature` (HMAC-SHA512 of the raw body with
   * the secret key), it must verify. Any other signature header cannot be
   * checked with this key and is treated as invalid (fail closed).
   */
  authenticateApprovalRequest(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): ApprovalSignature {
    const legacy = headers["x-paystack-signature"];
    if (legacy === undefined) return headers["paystack-signature"] === undefined ? "absent" : "invalid";
    const expected = Buffer.from(createHmac("sha512", this.#secretKey).update(Buffer.from(rawBody)).digest("hex"), "utf8");
    const given = Buffer.from(legacy.trim().toLowerCase(), "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected) ? "valid" : "invalid";
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    safeToRetryOnTimeout: boolean,
  ): Promise<ProviderResult<{ data: unknown; meta: unknown }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#secretKey}`, Accept: "application/json" };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(`${this.#apiBase}${path}`, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return {
        outcome: "unknown",
        reason: name === "AbortError" ? "paystack_request_timeout" : `paystack_transport_error:${name || "unknown"}`,
        safeToRetry: safeToRetryOnTimeout,
      };
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 500) {
      return { outcome: "unknown", reason: `paystack_http_${response.status}`, safeToRetry: safeToRetryOnTimeout };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = null;
    }
    const envelope = isRecord(parsed) ? parsed : null;
    if (response.status >= 200 && response.status < 300) {
      if (envelope === null) {
        return { outcome: "unknown", reason: "paystack_2xx_body_unparseable", safeToRetry: safeToRetryOnTimeout };
      }
      if (envelope["status"] === false) {
        return { outcome: "refused", providerCode: str(envelope["code"]), message: str(envelope["message"]) ?? "paystack_refused" };
      }
      return { outcome: "ok", value: { data: envelope["data"], meta: envelope["meta"] } };
    }
    return {
      outcome: "refused",
      providerCode: (envelope !== null ? str(envelope["code"]) : null) ?? `http_${response.status}`,
      message: (envelope !== null ? str(envelope["message"]) : null) ?? `paystack_http_${response.status}`,
    };
  }
}

export function createPaystackTransferProvider(config: TransferConfig): PaystackTransferProvider {
  return new PaystackTransferProvider(config);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function mapPaystackTransferStatus(raw: string): TransferStatus {
  switch (raw.toLowerCase()) {
    case "success":
      return "success";
    case "failed":
    case "abandoned": // OTP never entered: nothing moved
    case "blocked":
    case "rejected":
      return "failed";
    case "reversed":
      return "reversed";
    case "pending":
    case "processing":
    case "queued":
    case "received":
      return "pending";
    case "otp":
      return "otp";
    default:
      return "unrecognised";
  }
}

function parseTransfer(data: unknown): TransferState | null {
  if (!isRecord(data)) return null;
  const reference = str(data["reference"]);
  const rawStatus = str(data["status"]);
  const amount = toBigInt(data["amount"]);
  if (reference === null || rawStatus === null || amount === null) return null;
  const feeRaw = data["fee_charged"] ?? data["fees_charged"] ?? data["fee"] ?? null;
  const fee = feeRaw === null ? null : toBigInt(feeRaw);
  const failures = data["failures"];
  const reason =
    str(data["reason_for_failure"]) ??
    (isRecord(failures) ? str(failures["reason"]) ?? str(failures["message"]) : null) ??
    str(data["gateway_response"]);
  const transferCode = str(data["transfer_code"]);
  const recipient = data["recipient"];
  const recipientCodeRaw = isRecord(recipient) ? str(recipient["recipient_code"]) : str(recipient);
  return {
    reference,
    transferCode: transferCode !== null && /^TRF_[0-9A-Za-z]{4,40}$/.test(transferCode) ? transferCode : null,
    providerTransferId: data["id"] !== undefined && data["id"] !== null ? String(data["id"]) : null,
    status: mapPaystackTransferStatus(rawStatus),
    providerStatusRaw: rawStatus,
    amount: kobo(amount),
    fee: fee === null || fee < 0n ? null : kobo(fee),
    reason,
    recipientCode: recipientCodeRaw !== null && /^RCP_[0-9A-Za-z]{4,40}$/.test(recipientCodeRaw) ? recipientCodeRaw : null,
    createdAt: str(data["createdAt"]) ?? str(data["created_at"]),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

// ── Loader ──────────────────────────────────────────────────────────────────

/**
 * The transfer adapter from `process.env`, or null when Paystack is not
 * configured. Lives here so no other package names a PAYSTACK_ variable
 * (invariant 4).
 */
export function tryLoadPaystackTransferProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PaystackTransferProvider | null {
  const secretKey = env["PAYSTACK_SECRET_KEY"]?.trim();
  if (!secretKey) return null;
  const apiBase = env["PAYSTACK_API_BASE"]?.trim();
  return new PaystackTransferProvider({ secretKey, ...(apiBase ? { apiBase } : {}) });
}

/**
 * Whether automatic payouts may run (owner decision 2026-11-17 §18: built
 * behind a flag, off by default). `PAYSTACK_TRANSFERS_ENABLED=true` turns them
 * on; with a live key `PAYSTACK_LIVE_TRANSFERS_APPROVED=true` is ALSO
 * required, so a test-mode switch can never start moving real money.
 */
export function paystackTransfersEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env["PAYSTACK_TRANSFERS_ENABLED"]?.trim().toLowerCase() !== "true") return false;
  const secretKey = env["PAYSTACK_SECRET_KEY"]?.trim() ?? "";
  if (secretKey.startsWith("sk_live_")) {
    return env["PAYSTACK_LIVE_TRANSFERS_APPROVED"]?.trim().toLowerCase() === "true";
  }
  return secretKey.startsWith("sk_test_");
}
