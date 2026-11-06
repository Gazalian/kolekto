/**
 * notification-email-templates.ts — event-specific email rendering (M13.2 P7).
 *
 * Pure functions: no database, no clock, no imports beyond this module. Every
 * user-controlled value is escaped before insertion into HTML. Every HTML
 * template has a plain-text equivalent that communicates the same information.
 *
 * Content restrictions (decision record §5, §7, §9.3):
 *   - Community name, member code, officer role, action date only.
 *   - Never: members.id, other members' data, collection/balance data,
 *     officer free-text reasons, contact addresses in the body, internal IDs.
 *   - Unverified contacts are never described as verified.
 *   - The member_code confirms the membership record only.
 */

import type { EmailMessage } from "@kolekto/adapters";

// ── HTML escaping ────────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// ── Payload reading ─────────────────────────────────────────────────────────

export interface EventContext {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function str(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? v : "";
}

// ── Supported event types ───────────────────────────────────────────────────

const TEMPLATE_EVENT_TYPES = [
  "member.create",
  "member.approve_join",
  "officer_invitation.accept",
  "officer_term.end",
] as const;

export type TemplateEventType = (typeof TEMPLATE_EVENT_TYPES)[number];

export function hasTemplate(eventType: string): eventType is TemplateEventType {
  return (TEMPLATE_EVENT_TYPES as readonly string[]).includes(eventType);
}

// ── Template rendering ──────────────────────────────────────────────────────

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderTemplate(ctx: EventContext): RenderedEmail | null {
  if (!hasTemplate(ctx.eventType)) return null;
  switch (ctx.eventType) {
    case "member.create":
      return renderMembershipConfirmation(ctx.payload, "added to");
    case "member.approve_join":
      return renderMembershipConfirmation(ctx.payload, "approved to join");
    case "officer_invitation.accept":
      return renderOfficerAppointment(ctx.payload);
    case "officer_term.end":
      return renderOfficerTermEnd(ctx.payload);
  }
}

export function buildTemplatedMessage(recipientAddress: string, ctx: EventContext): EmailMessage {
  const rendered = renderTemplate(ctx);
  if (!rendered) {
    return {
      to: recipientAddress,
      subject: "You have a new Kolekto notification",
      text: [
        "You have a new notification from your Kolekto community.",
        "",
        "Sign in to Kolekto to read it.",
        "",
        "— Kolekto",
        "",
        "This is an automated message. Please do not reply.",
      ].join("\n"),
    };
  }
  return {
    to: recipientAddress,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
}

// ── Membership confirmation (E1 / E2) ───────────────────────────────────────

function renderMembershipConfirmation(
  payload: Record<string, unknown>,
  verb: string,
): RenderedEmail {
  const communityName = str(payload, "community_name") || "your community";
  const memberCode = str(payload, "member_code");

  const subject = `You have been ${verb} ${communityName}`;

  const textLines = [
    `You have been ${verb} ${communityName}.`,
    "",
  ];
  if (memberCode) {
    textLines.push(`Your community member ID is: ${memberCode}`);
    textLines.push("");
  }
  textLines.push(
    "If this message was not intended for you, please contact the community directly.",
    "",
    "— Kolekto",
    "",
    "This is an automated message. Please do not reply.",
  );

  const eCommunity = escapeHtml(communityName);
  const eCode = memberCode ? escapeHtml(memberCode) : "";
  const codeBlock = eCode
    ? `<p style="margin:16px 0;padding:12px 16px;background-color:#f5f5f5;border-radius:4px;font-family:monospace;font-size:16px;">Your community member ID: <strong>${eCode}</strong></p>`
    : "";

  const html = emailLayout(
    subject,
    `<p style="margin:0 0 16px;">You have been ${escapeHtml(verb)} <strong>${eCommunity}</strong>.</p>` +
    codeBlock +
    `<p style="margin:16px 0 0;font-size:13px;color:#666;">If this message was not intended for you, please contact the community directly.</p>`,
  );

  return { subject, text: textLines.join("\n"), html };
}

// ── Officer appointment (E4) ────────────────────────────────────────────────

function renderOfficerAppointment(payload: Record<string, unknown>): RenderedEmail {
  const communityName = str(payload, "community_name") || "your community";
  const role = str(payload, "officer_role") || "officer";

  const subject = `You are now ${article(role)} ${role} of ${communityName}`;

  const text = [
    `You have been appointed as ${article(role)} ${role} of ${communityName}.`,
    "",
    "Sign in to Kolekto to view your responsibilities.",
    "",
    "— Kolekto",
    "",
    "This is an automated message. Please do not reply.",
  ].join("\n");

  const eCommunity = escapeHtml(communityName);
  const eRole = escapeHtml(role);

  const html = emailLayout(
    subject,
    `<p style="margin:0 0 16px;">You have been appointed as ${escapeHtml(article(role))} <strong>${eRole}</strong> of <strong>${eCommunity}</strong>.</p>` +
    `<p style="margin:16px 0 0;">Sign in to Kolekto to view your responsibilities.</p>`,
  );

  return { subject, text, html };
}

// ── Officer term end (E5) ───────────────────────────────────────────────────

function renderOfficerTermEnd(payload: Record<string, unknown>): RenderedEmail {
  const communityName = str(payload, "community_name") || "your community";
  const role = str(payload, "officer_role") || "officer";

  const subject = `Your ${role} term in ${communityName} has ended`;

  const text = [
    `Your term as ${article(role)} ${role} of ${communityName} has ended.`,
    "",
    "Thank you for your service to the community.",
    "",
    "— Kolekto",
    "",
    "This is an automated message. Please do not reply.",
  ].join("\n");

  const eCommunity = escapeHtml(communityName);
  const eRole = escapeHtml(role);

  const html = emailLayout(
    subject,
    `<p style="margin:0 0 16px;">Your term as ${escapeHtml(article(role))} <strong>${eRole}</strong> of <strong>${eCommunity}</strong> has ended.</p>` +
    `<p style="margin:16px 0 0;">Thank you for your service to the community.</p>`,
  );

  return { subject, text, html };
}

// ── Shared layout ───────────────────────────────────────────────────────────

function emailLayout(title: string, body: string): string {
  const eTitle = escapeHtml(title);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${eTitle}</title>`,
    "</head>",
    '<body style="margin:0;padding:0;background-color:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f9f9;">',
    "<tr><td align=\"center\" style=\"padding:32px 16px;\">",
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;overflow:hidden;">',
    '<tr><td style="padding:32px 24px;">',
    body,
    "</td></tr>",
    '<tr><td style="padding:16px 24px;font-size:12px;color:#999;border-top:1px solid #eee;">',
    "This is an automated message from Kolekto. Please do not reply.",
    "</td></tr>",
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function article(word: string): string {
  if (!word) return "an";
  const first = word[0]!.toLowerCase();
  return "aeiou".includes(first) ? "an" : "a";
}
