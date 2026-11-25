/**
 * Display helpers for the community home, the community overview and the
 * personal profile. Pure and shared by server and client components.
 *
 * Nothing here computes money. Kobo arrives from the database as a decimal
 * string and is only formatted (integer arithmetic for a percentage).
 */

import type { BadgeTone } from "@kolekto/ui";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  treasurer: "Treasurer",
  collector: "Collector",
  viewer: "Viewer",
};

/** Roles that run a community (owner, admin, treasurer) versus roles that help or watch. */
const MANAGING_ROLES = new Set(["owner", "admin", "treasurer"]);

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function isManagingRole(role: string): boolean {
  return MANAGING_ROLES.has(role);
}

const TYPE_LABEL: Record<string, string> = {
  personal: "Personal",
  university_association: "University association",
  fellowship: "Fellowship",
  alumni_association: "Alumni association",
  cooperative: "Cooperative",
  estate: "Estate",
  professional_association: "Professional association",
  event_committee: "Event committee",
  social_group: "Social group",
  school_pta: "School PTA",
  community_development: "Community development",
  other: "Community",
};

export function communityTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? "Community";
}

/** `communities.verification_status` → a label and tone. The status itself only ever comes from the database. */
export function communityVerification(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "verified":
      return { label: "Verified", tone: "success" };
    case "pending":
      return { label: "In review", tone: "info" };
    case "rejected":
      return { label: "Not approved", tone: "danger" };
    case "expired":
      return { label: "Verification lapsed", tone: "warning" };
    default:
      return { label: "Not verified", tone: "neutral" };
  }
}

/** `users.identity_level` → what the profile says about personal verification. */
export function identityLevelView(level: string): { label: string; tone: BadgeTone; description: string } {
  switch (level) {
    case "identity_verified":
      return { label: "Identity verified", tone: "success", description: "Kolekto has verified your identity." };
    case "contact_verified":
      return {
        label: "Email confirmed",
        tone: "info",
        description: "Your email address is confirmed. Identity checks are not available yet.",
      };
    default:
      return {
        label: "Not verified",
        tone: "neutral",
        description: "Confirm your email address to start.",
      };
  }
}

/** Up to two initials for an avatar. */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}

/** A kobo decimal string as naira, or an em dash when the caller may not see it (the collection pages' formatter). */
export { naira } from "./collection-display.ts";

/**
 * Progress against a target in whole percent, from kobo strings, in integer
 * arithmetic. Null when there is no positive target or nothing to measure.
 */
export function targetProgress(collected: string | null, target: string | null): { percent: number; bar: number } | null {
  if (collected === null || target === null) return null;
  const t = BigInt(target);
  if (t <= 0n) return null;
  const pct = (BigInt(collected) * 100n) / t;
  const percent = Number(pct);
  return { percent, bar: Math.min(100, percent) };
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos" }).format(
    new Date(iso),
  );
}
