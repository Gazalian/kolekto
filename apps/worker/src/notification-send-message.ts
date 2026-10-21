/**
 * notification-send-message.ts — the message the sender hands the provider.
 *
 * Template rendering is P7 and deliberately out of scope here. This phase (P5)
 * builds the sender runtime, so it needs *a* valid message to exercise the
 * provider seam end to end. That message is a fixed, PII-free placeholder:
 *
 *   · No name, member code, community name, event detail or free text — the
 *     delivery log and any provider echo must never become a place where
 *     someone's details sit (decision record §9.3). Only the recipient address
 *     is used, and only as the envelope `to`; it is never put in the body.
 *   · A non-empty plain-text part, as every adapter requires. No HTML.
 *
 * It passes assertValidEmailRequest. P7 replaces this with real per-event
 * templates; this module is the single place that changes when it does.
 */

import type { EmailMessage } from "@kolekto/adapters";

export const PLACEHOLDER_SUBJECT = "You have a new Kolekto notification";

export const PLACEHOLDER_TEXT = [
  "You have a new notification from your Kolekto community.",
  "",
  "Sign in to Kolekto to read it.",
  "",
  "— Kolekto",
  "",
  "This is an automated message. Please do not reply.",
].join("\n");

/**
 * Build the placeholder message for a recipient. The address is the only
 * input and appears only as the envelope recipient, never in the body.
 */
export function buildPlaceholderMessage(recipientAddress: string): EmailMessage {
  return {
    to: recipientAddress,
    subject: PLACEHOLDER_SUBJECT,
    text: PLACEHOLDER_TEXT,
  };
}
