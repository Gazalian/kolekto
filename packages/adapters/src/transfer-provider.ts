/**
 * transfer-provider.ts — the money-out seam: banks, account resolution,
 * transfer recipients, balance, transfers (owner decision 2026-11-17 §18,
 * built 2026-11-18).
 *
 * Same contract as `payment-provider.ts`: uncertainty is a value, never an
 * exception. A timeout on a transfer initiation is `unknown` with
 * `safeToRetry: false` (D-27) — the transfer may exist, and the only safe next
 * step is to verify Kolekto's own reference.
 *
 * Kolekto-owned types only; nothing outside this package interprets
 * Paystack's JSON.
 */

import type { Kobo } from "@kolekto/domain";

import type { ProviderResult } from "./payment-provider.ts";

export interface Bank {
  readonly name: string;
  /** The provider's bank code, sent back on resolution and recipient creation. */
  readonly code: string;
}

export interface ResolvedAccount {
  readonly accountNumber: string;
  /** The account holder's name as the bank reports it. Never typed by a person. */
  readonly accountName: string;
}

export interface TransferRecipient {
  readonly recipientCode: string;
}

/** Kolekto's view of a transfer's state at the provider. */
export type TransferStatus =
  /** Money reached the beneficiary bank. Final. */
  | "success"
  /** No money moved. Final. */
  | "failed"
  /** Money moved and came back. Final. */
  | "reversed"
  /** In flight at the provider or the bank. */
  | "pending"
  /** Waiting for an OTP on the provider dashboard: needs a person. */
  | "otp"
  /** A status Kolekto does not recognise: treated as in flight, never as final. */
  | "unrecognised";

export interface TransferState {
  /** Kolekto's own reference (ktr_…). */
  readonly reference: string;
  readonly transferCode: string | null;
  readonly providerTransferId: string | null;
  readonly status: TransferStatus;
  readonly providerStatusRaw: string;
  readonly amount: Kobo;
  /** The provider's fee for this transfer, when it reports one. */
  readonly fee: Kobo | null;
  /** Failure or reversal reason, when the provider gives one. */
  readonly reason: string | null;
  /** The provider recipient (RCP_…) the transfer pays, when the response names it. */
  readonly recipientCode: string | null;
  /** When the provider created the transfer (ISO), when reported. */
  readonly createdAt: string | null;
}

export interface ListTransfersQuery {
  readonly from: Date;
  readonly to: Date;
  /** 1-based. */
  readonly page: number;
  readonly perPage: number;
}

export interface TransferPage {
  readonly items: readonly TransferState[];
  readonly pageCount: number;
  /** Items on this page Kolekto could not read (counted, never guessed). */
  readonly unparseable: number;
}

export interface InitiateTransferRequest {
  /** Kolekto's own reference. Generated before the call so a timeout can be resolved by verifying it. */
  readonly reference: string;
  readonly amount: Kobo;
  readonly recipientCode: string;
  /** Narration the beneficiary sees. */
  readonly reason: string;
}

export interface CreateRecipientRequest {
  readonly accountName: string;
  readonly accountNumber: string;
  readonly bankCode: string;
}

export interface TransferProvider {
  readonly name: "paystack" | "fake";
  /** True when no real money can move (Paystack test key, or the fake). */
  readonly testMode: boolean;

  listBanks(): Promise<ProviderResult<readonly Bank[]>>;
  /** `not_found` when the bank says no such account. */
  resolveAccount(accountNumber: string, bankCode: string): Promise<ProviderResult<ResolvedAccount>>;
  createRecipient(request: CreateRecipientRequest): Promise<ProviderResult<TransferRecipient>>;
  /** The NGN balance transfers are paid from. */
  getBalance(): Promise<ProviderResult<{ readonly available: Kobo }>>;
  initiateTransfer(request: InitiateTransferRequest): Promise<ProviderResult<TransferState>>;
  /** `not_found` when the provider has no transfer with this reference. */
  verifyTransfer(reference: string): Promise<ProviderResult<TransferState>>;
  /** Read-only list of the provider's transfers in a window (reconciliation, P8-4). */
  listTransfers(query: ListTransfersQuery): Promise<ProviderResult<TransferPage>>;
  /**
   * The signature on a transfer approval-URL request. "absent": no signature
   * header; "invalid": a header that does not verify or cannot be verified
   * here (the caller rejects). Headers are lower-cased names.
   */
  authenticateApprovalRequest(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): ApprovalSignature;
}

export type ApprovalSignature = "valid" | "invalid" | "absent";

/** A Kolekto transfer reference: `ktr_` + 24 lowercase hex (matches withdrawal_transfers). */
export function isTransferReference(value: string): boolean {
  return /^ktr_[0-9a-f]{24}$/.test(value);
}

/**
 * Pulls the Kolekto reference and event name out of a transfer webhook body
 * (`{ event: "transfer.success", data: { reference, transfer_code, … } }`).
 * Only a routing hint: the outcome is always re-read with `verifyTransfer`.
 */
export function parseTransferWebhook(rawBody: Uint8Array): { event: string; reference: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { event?: unknown; data?: { reference?: unknown } };
  const event = typeof body.event === "string" ? body.event : null;
  const reference = typeof body.data?.reference === "string" ? body.data.reference : null;
  if (event === null || !event.startsWith("transfer.") || reference === null) return null;
  return { event, reference };
}

/**
 * Whether a body sent to the transfer approval URL is NOT an outgoing-transfer
 * approval but Paystack's INBOUND credit request ("Inbound Transfer
 * Approvals" for Titan virtual accounts / Pay with Transfer: payer and
 * receiver account fields, a NIP session id, no transfer reference).
 *
 * Seen for real on 2026-11-20 (User-Agent `Paystack Credit Request`, a LIVE
 * customer payment) when that dashboard field held this URL. The two features
 * are separate: Kolekto has no inbound-approval integration, and nothing in
 * the outgoing approval logic may ever decide an incoming payment.
 */
export function isInboundCreditRequest(rawBody: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const top = parsed as Record<string, unknown>;
  if (typeof top["reference"] === "string" || typeof top["transfer_code"] === "string") return false;
  const inner = top["data"];
  if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>)["reference"] === "string") return false;
  return typeof top["session_id"] === "string" && ("receiver_account_number" in top || "payer_account_number" in top);
}

/**
 * Paystack's transfer approval request, as Kolekto reads it.
 *
 * The only shape accepted is the one Paystack actually sent (TEST,
 * 2026-11-20, captured and redacted in
 * `packages/adapters/test/fixtures/paystack-transfer-approval-request.redacted.json`):
 *
 *   { event: "transferrequest.approval-required",
 *     data: { domain, details: { endpoint: "/transfer",
 *                                body: { source, amount: "10000", recipient: "RCP_…",
 *                                        reference: "ktr_…", reason, currency: "NGN" } },
 *             transfers: [ { reference, amount: 10000, currency: "NGN", status: "received",
 *                            transfer_code: "TRF_…", recipient: { recipientCode: "RCP_…", … } } ] } }
 *
 * `details.body` is the request Kolekto's worker sent to POST /transfer;
 * `transfers[]` is Paystack's record of it. Both are required and must
 * describe the same transfer. Paystack's answer (HTTP 200 / 400) covers the
 * whole request, so exactly one transfer is accepted: a 200 for a request
 * holding several would approve transfers Kolekto never checked.
 *
 * Paystack documents the approval payload only as "the payload used to
 * initiate the transfer"; the earlier guesses (fields at the top level or
 * under `data`) were never observed and are no longer accepted.
 */
export interface TransferApprovalRequest {
  /** Kolekto's reference (ktr_…). */
  readonly reference: string;
  readonly amountKobo: bigint;
  /** ISO 4217 code as Paystack sent it (Kolekto only pays NGN; the database checks). */
  readonly currency: string;
  readonly recipientCode: string;
  /** Paystack's transfer code (TRF_…). */
  readonly transferCode: string;
}

/** Why a body was refused before any business check. Recorded as the reason code. */
export type TransferApprovalPayloadRejection =
  /** Not JSON, not an object, not the approval-required event, or `data` missing. */
  | "payload_malformed"
  /** `data.details.body` missing, not an object, or not a /transfer request. */
  | "payload_body_missing"
  /** `data.transfers` missing, not an array, or empty. */
  | "payload_transfers_missing"
  /** More than one transfer in the request. */
  | "payload_multiple_transfers"
  /** A required field (reference, amount, currency, recipient, transfer code, status) is missing or unreadable. */
  | "payload_field_invalid"
  /** `details.body` and the `transfers[]` record disagree (reference, amount, currency or recipient). */
  | "payload_mismatch";

export type TransferApprovalParse =
  | { readonly ok: true; readonly request: TransferApprovalRequest }
  | {
      readonly ok: false;
      readonly rejection: TransferApprovalPayloadRejection;
      /** The request body's reference when it could be read, so the refusal is linked to the transfer. */
      readonly reference: string | null;
    };

const APPROVAL_REQUIRED_EVENT = "transferrequest.approval-required";

export function parseTransferApprovalRequest(rawBody: Uint8Array): TransferApprovalParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    return refuse("payload_malformed", null);
  }
  const top = asRecord(parsed);
  if (top === null || top["event"] !== APPROVAL_REQUIRED_EVENT) return refuse("payload_malformed", null);
  const data = asRecord(top["data"]);
  if (data === null) return refuse("payload_malformed", null);

  const details = asRecord(data["details"]);
  const requestBody = asRecord(details?.["body"]);
  if (details === null || requestBody === null || details["endpoint"] !== "/transfer") return refuse("payload_body_missing", null);
  const bodyReference = readReference(requestBody["reference"]);

  const transfers = data["transfers"];
  if (!Array.isArray(transfers) || transfers.length === 0) return refuse("payload_transfers_missing", bodyReference);
  if (transfers.length !== 1) return refuse("payload_multiple_transfers", bodyReference);
  const record = asRecord(transfers[0]);

  const bodyAmount = readAmountKobo(requestBody["amount"]);
  const bodyCurrency = readCurrency(requestBody["currency"]);
  const bodyRecipient = readRecipientCode(requestBody["recipient"]);
  if (record === null || bodyReference === null || bodyAmount === null || bodyCurrency === null || bodyRecipient === null) {
    return refuse("payload_field_invalid", bodyReference);
  }
  const recReference = readReference(record["reference"]);
  const recAmount = readAmountKobo(record["amount"]);
  const recCurrency = readCurrency(record["currency"]);
  const recRecipient = readRecipientCode(asRecord(record["recipient"])?.["recipientCode"]);
  const transferCode = readTransferCode(record["transfer_code"]);
  if (recReference === null || recAmount === null || recCurrency === null || recRecipient === null
      || transferCode === null || record["status"] !== "received") {
    return refuse("payload_field_invalid", bodyReference);
  }
  if (recReference !== bodyReference || recAmount !== bodyAmount || recCurrency !== bodyCurrency || recRecipient !== bodyRecipient) {
    return refuse("payload_mismatch", bodyReference);
  }
  return {
    ok: true,
    request: { reference: bodyReference, amountKobo: bodyAmount, currency: bodyCurrency, recipientCode: bodyRecipient, transferCode },
  };
}

function refuse(rejection: TransferApprovalPayloadRejection, reference: string | null): TransferApprovalParse {
  return { ok: false, rejection, reference };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Kolekto only ever sends its own `ktr_` references; nothing else is read as one. */
function readReference(value: unknown): string | null {
  return typeof value === "string" && isTransferReference(value) ? value : null;
}

/** A positive whole number of kobo, as a JSON integer or a string of digits (Paystack sent both). */
function readAmountKobo(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9]\d{0,14}$/.test(value)) return BigInt(value);
  return null;
}

function readCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
}

const RECIPIENT_CODE = /^RCP_[0-9A-Za-z]{4,40}$/;
const TRANSFER_CODE = /^TRF_[0-9A-Za-z]{4,40}$/;

function readRecipientCode(value: unknown): string | null {
  return typeof value === "string" && RECIPIENT_CODE.test(value) ? value : null;
}

function readTransferCode(value: unknown): string | null {
  return typeof value === "string" && TRANSFER_CODE.test(value) ? value : null;
}
