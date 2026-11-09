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
 *
 * Member announcements (collection.publish / collection.remind /
 * collection.announce_update) carry collection-level facts only: name,
 * description excerpt, fixed amount, deadline, what changed, and the public
 * collection link. They are sent only for collections whose page anyone with
 * the link can already open (public / unlisted), so the email reveals nothing
 * the link does not. Never: a member's personal balance, payment status,
 * obligation, other members, or internal ids. A reminder never claims the
 * recipient has not paid — payment status is not known.
 */

import type { EmailMessage } from "@kolekto/adapters";
import { formatNaira, kobo } from "@kolekto/domain";

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
  /** Origin for links in the message (APP_BASE_URL). Required for collection announcements. */
  readonly appBaseUrl?: string;
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
  "collection.publish",
  "collection.remind",
  "collection.announce_update",
] as const;

/** Collection announcements: these must link to the collection, so they never fall back to the placeholder. */
const COLLECTION_TEMPLATE_EVENT_TYPES: readonly string[] = [
  "collection.publish",
  "collection.remind",
  "collection.announce_update",
];

export function isCollectionTemplateEvent(eventType: string): boolean {
  return COLLECTION_TEMPLATE_EVENT_TYPES.includes(eventType);
}

/**
 * False when this event must not be sent as rendered: a collection
 * announcement whose link cannot be built (no base URL, or a missing or
 * malformed slug). The sender resolves such a delivery dead rather than
 * sending a placeholder that tells an account-less member to "sign in".
 */
export function canSend(ctx: EventContext): boolean {
  return !isCollectionTemplateEvent(ctx.eventType) || renderTemplate(ctx) !== null;
}

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
    case "collection.publish":
    case "collection.remind":
    case "collection.announce_update":
      return renderCollectionAnnouncement(ctx);
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

// ── Collection announcements (member announcements) ─────────────────────────

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/i;

/** The public collection page: {origin}/{community-slug}/{collection-slug}. Null if any part is unusable. */
export function collectionUrl(appBaseUrl: string | undefined, communitySlug: string, collectionSlug: string): string | null {
  if (!appBaseUrl || !SLUG.test(communitySlug) || !SLUG.test(collectionSlug)) return null;
  let origin: string;
  try {
    const u = new URL(appBaseUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return `${origin}/${communitySlug}/${collectionSlug}`;
}

const CHANGE_LABELS: Readonly<Record<string, string>> = {
  name: "the collection name",
  description: "the description",
  deadline: "the payment deadline",
  start_date: "the start date",
  story: "the collection details",
  other: "other details",
};

/** "the payment deadline and the description" from "deadline,description". Unknown names are dropped. */
export function describeChanges(raw: string): string {
  const labels = raw
    .split(",")
    .map((c) => CHANGE_LABELS[c.trim()])
    .filter((l): l is string => typeof l === "string");
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** A date as "7 November 2026", in Africa/Lagos (the platform's settlement timezone). */
export function formatDeadline(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" }).format(d);
}

/** "₦5,000.00" for a fixed-amount collection; empty otherwise. Uses the domain formatter (integer kobo, no float). */
export function formatFixedAmount(payload: Record<string, unknown>): string {
  if (str(payload, "amount_model") !== "fixed") return "";
  const raw = str(payload, "fixed_amount_kobo");
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) return "";
  return formatNaira(kobo(raw));
}

function renderCollectionAnnouncement(ctx: EventContext): RenderedEmail | null {
  const p = ctx.payload;
  const name = str(p, "collection_name");
  const link = collectionUrl(ctx.appBaseUrl, str(p, "community_slug"), str(p, "collection_slug"));
  if (!name || !link) return null;

  const community = str(p, "community_name") || "Your community";
  const description = str(p, "collection_description").trim();
  const amount = formatFixedAmount(p);
  const deadline = str(p, "deadline_at") ? formatDeadline(str(p, "deadline_at")) : "";
  // Member announcements v2: optional organiser-authored message. Already
  // address-stripped at the DB (app.strip_email_addresses) and clamped. The
  // template re-trims and renders it as a quoted block so it never visually
  // merges with the platform copy.
  const customMessage = str(p, "announcement_body").trim();
  // A fixed-amount collection is the only time "pay" is unambiguous — nothing
  // in Kolekto moves obligations to paid yet, so even then we say "View & pay"
  // (never "You have not paid" or an amount owed), aligned with the gap
  // analysis (G3). Open-amount collections still say "View and contribute".
  const paymentPossible = amount.length > 0;

  let subject: string;
  let lead: string;
  let cta: string;
  switch (ctx.eventType) {
    case "collection.remind":
      subject = `Reminder from ${community}: ${name}`;
      lead = `This is a reminder from ${community} about ${name}.`;
      cta = paymentPossible ? "View & pay" : "View the collection";
      break;
    case "collection.announce_update": {
      const changes = describeChanges(str(p, "changed_fields"));
      subject = `Update from ${community}: ${name}`;
      lead = changes
        ? `${community} has updated ${name}. What changed: ${changes}.`
        : `${community} has updated ${name}.`;
      cta = paymentPossible ? "View & pay" : "View the updated collection";
      break;
    }
    default:
      subject = `New collection from ${community}: ${name}`;
      lead = `${community} has opened a new collection: ${name}.`;
      cta = paymentPossible ? "View & pay" : "View and contribute";
  }

  const details: [string, string][] = [];
  if (amount) details.push(["Amount", amount]);
  if (deadline) details.push(["Deadline", deadline]);

  const footer = [
    `You are receiving this because you are on the member list of ${community}.`,
    `To stop receiving these messages, contact the organisers of ${community}.`,
  ];

  const textLines = [lead, ""];
  if (customMessage) {
    // Prefix each line with "> " so even a plain-text mail client shows it as a quote.
    const quoted = customMessage
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    textLines.push(`Message from ${community}:`, quoted, "");
  }
  if (description) textLines.push(description, "");
  for (const [k, v] of details) textLines.push(`${k}: ${v}`);
  if (details.length) textLines.push("");
  textLines.push(`${cta}: ${link}`, "No Kolekto account is needed to open this link.", "", ...footer, "", "— Kolekto", "", "This is an automated message. Please do not reply.");

  const eLink = escapeHtml(link);
  const detailRows = details
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;">${escapeHtml(k)}</td><td style="padding:4px 0;"><strong>${escapeHtml(v)}</strong></td></tr>`)
    .join("");
  // The custom message is HTML-escaped and `white-space:pre-line` preserves
  // the organiser's line breaks without any HTML in the stored text being
  // rendered.
  const customHtml = customMessage
    ? `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #ddd;background-color:#fafafa;white-space:pre-line;font-size:14px;color:#333;"><strong style="display:block;margin:0 0 8px;font-size:12px;color:#666;">Message from ${escapeHtml(community)}</strong>${escapeHtml(customMessage)}</blockquote>`
    : "";
  const html = emailLayout(
    subject,
    `<p style="margin:0 0 16px;">${escapeHtml(lead)}</p>` +
      customHtml +
      (description ? `<p style="margin:0 0 16px;white-space:pre-line;">${escapeHtml(description)}</p>` : "") +
      (detailRows ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${detailRows}</table>` : "") +
      `<p style="margin:24px 0;"><a href="${eLink}" style="display:inline-block;padding:12px 20px;background-color:#111;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(cta)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#666;">Or open this link: <a href="${eLink}" style="color:#333;">${eLink}</a><br>No Kolekto account is needed to open this link.</p>` +
      `<p style="margin:16px 0 0;font-size:12px;color:#999;">${footer.map(escapeHtml).join("<br>")}</p>`,
  );

  // A header value: never let a name carry a line break into the Subject.
  return { subject: subject.replace(/[\r\n]+/g, " "), text: textLines.join("\n"), html };
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
