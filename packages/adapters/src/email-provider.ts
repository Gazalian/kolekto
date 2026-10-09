/**
 * email-provider.ts — the seam every outbound email goes through.
 *
 * M13.2 / P1. docs/product/M13.2-EMAIL-NOTIFICATIONS-DECISION-RECORD.md, §10.5.
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 * Contract, a deterministic fake, and a loopback-only SMTP adapter for Mailpit.
 * NO real provider exists and none is selected (D-PROVIDER). Nothing here can
 * send mail to a real mailbox.
 *
 * ── WHAT THE CONTRACT PROMISES, AND WHAT IT DOES NOT ────────────────────────
 * `send` is at-least-once from the caller's point of view. A provider that
 * accepts a message and then loses the connection leaves the caller unable to
 * tell "sent" from "not sent". The caller passes a stable `idempotencyKey`
 * (the delivery id); a provider that can use it to de-duplicate says so via
 * `idempotency: "provider"`, and one that cannot says `"none"`. The sender
 * (P5) must treat the two differently, and a provider reporting `"none"` is
 * not enabled for production until its duplicate mitigation is reviewed
 * (decision record §10.3). This interface never claims exactly-once delivery.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────
 * Every failure is an `EmailProviderError` carrying a stable Kolekto `code` and
 * a `kind` that decides retry behaviour. Messages are written by us and never
 * contain provider response text, recipient addresses or credentials: the
 * delivery table is readable by operators and must not become a place where a
 * provider's echo of someone's address is stored (decision record §9.3).
 */

/** The provider implementations that exist. A real provider is added in P9 after approval. */
export type EmailProviderName = "fake" | "mailpit";

export interface EmailMessage {
  /** A single recipient address. Multiple recipients are deliberately not supported. */
  readonly to: string;
  readonly subject: string;
  /** Plain-text body. Required: every template has a plain-text alternative. */
  readonly text: string;
  /** HTML body. Optional at the contract level; templates (P7) supply it. */
  readonly html?: string;
}

export interface EmailSendRequest {
  /**
   * Stable per logical message — the `notification_deliveries.id`. A retry, a
   * replay and a crash-recovery re-claim of the same delivery all carry the
   * same key.
   */
  readonly idempotencyKey: string;
  readonly message: EmailMessage;
}

export interface EmailSendResult {
  /** The provider's own identifier for the accepted message. Opaque. */
  readonly providerMessageId: string;
}

export type EmailIdempotency =
  /** The provider de-duplicates repeated calls that carry the same key. */
  | "provider"
  /** The provider cannot; a repeat call can deliver a second copy. */
  | "none";

export interface EmailProvider {
  readonly name: EmailProviderName;
  readonly idempotency: EmailIdempotency;
  send(request: EmailSendRequest): Promise<EmailSendResult>;
}

/** Retry class. `transient` may be retried with backoff; `permanent` must not be. */
export type EmailErrorKind = "transient" | "permanent";

/**
 * Stable internal error vocabulary. Codes are append-only: a code is never
 * renamed or reused once shipped, because they are stored.
 */
export type EmailErrorCode =
  | "invalid_message"
  | "provider_unreachable"
  | "provider_timeout"
  | "provider_rejected_transient"
  | "provider_rejected_permanent"
  | "provider_protocol_error"
  | "adapter_misconfigured";

export class EmailProviderError extends Error {
  readonly kind: EmailErrorKind;
  readonly code: EmailErrorCode;

  constructor(kind: EmailErrorKind, code: EmailErrorCode, message: string) {
    super(message);
    this.name = "EmailProviderError";
    this.kind = kind;
    this.code = code;
  }
}

// ── Validation shared by every adapter ───────────────────────────────────────

const MAX_ADDRESS_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 1_000_000;

// Control characters (C0, including CR and LF), DEL, and the Unicode line/paragraph separators.
// Rejecting these anywhere in a header-bound value is what stops header injection. Written as a
// code-unit check, not a regex literal, so the separators never appear in this source file.
function hasForbiddenHeaderChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// Deliberately conservative: a single mailbox, ASCII local part and a dotted
// domain. It refuses quoted local parts, comments and display names — forms we
// never need — rather than trying to parse RFC 5322. A plausible-address check,
// not proof the mailbox exists.
const ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH) return false;
  if (hasForbiddenHeaderChar(value)) return false;
  const local = value.split("@")[0] ?? "";
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return ADDRESS_PATTERN.test(value);
}

/**
 * Reject a request that must never reach a provider. Throws a *permanent*
 * `invalid_message`: retrying a malformed message cannot succeed. The error
 * text names the field, never its value (a value may be an address or a name).
 */
export function assertValidEmailRequest(request: EmailSendRequest): void {
  const { idempotencyKey, message } = request;

  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "" || idempotencyKey.length > 200) {
    throw invalid("idempotencyKey must be a non-empty string of at most 200 characters");
  }
  if (hasForbiddenHeaderChar(idempotencyKey)) {
    throw invalid("idempotencyKey must not contain control or line-break characters");
  }
  if (typeof message.to !== "string" || !isValidEmailAddress(message.to)) {
    throw invalid("message.to is not a single valid email address");
  }
  if (typeof message.subject !== "string" || message.subject.trim() === "") {
    throw invalid("message.subject must not be empty");
  }
  if (message.subject.length > MAX_SUBJECT_LENGTH) {
    throw invalid(`message.subject is longer than ${MAX_SUBJECT_LENGTH} characters`);
  }
  if (hasForbiddenHeaderChar(message.subject)) {
    throw invalid("message.subject must not contain control or line-break characters");
  }
  if (typeof message.text !== "string" || message.text.trim() === "") {
    throw invalid("message.text (the plain-text alternative) must not be empty");
  }
  if (message.text.length > MAX_BODY_LENGTH) throw invalid("message.text is too large");
  if (message.html !== undefined) {
    if (typeof message.html !== "string" || message.html.trim() === "") {
      throw invalid("message.html, when present, must not be empty");
    }
    if (message.html.length > MAX_BODY_LENGTH) throw invalid("message.html is too large");
  }
}

function invalid(message: string): EmailProviderError {
  return new EmailProviderError("permanent", "invalid_message", message);
}
