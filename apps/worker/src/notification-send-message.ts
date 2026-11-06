/**
 * notification-send-message.ts — the message the sender hands the provider.
 *
 * P7 adds event-specific templates for the four email-evaluation events
 * (member.create, member.approve_join, officer_invitation.accept,
 * officer_term.end). When event context is available the sender calls
 * buildEmailMessage, which renders the appropriate template. The placeholder
 * remains as a fallback for events without a template.
 *
 * Content restrictions (decision record §5, §7, §9.3):
 *   · Community name, member code, officer role, action date only.
 *   · Never: members.id, other members' data, collection/balance data,
 *     contact addresses in the body, internal IDs.
 *   · All user-controlled values are HTML-escaped before insertion.
 */

import type { EmailMessage } from "@kolekto/adapters";

import { buildTemplatedMessage, type EventContext } from "./notification-email-templates.ts";

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

/**
 * Build the email message for a delivery. Uses event-specific templates when
 * the event type has one; falls back to the placeholder otherwise.
 */
export function buildEmailMessage(recipientAddress: string, ctx: EventContext | null): EmailMessage {
  if (!ctx) return buildPlaceholderMessage(recipientAddress);
  return buildTemplatedMessage(recipientAddress, ctx);
}
