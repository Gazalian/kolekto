/**
 * notification-display.ts — pure presentation logic for in-app notifications.
 *
 * Extracted from NotificationItem so the title/description/deep-link mapping
 * can be unit-tested without a browser. The component keeps the icon mapping
 * (which pulls in React components) and this module stays free of JSX so it is
 * cheap to test.
 *
 * Every reader is a client-side render of `notification_events.payload`, which
 * is user/community-controlled text. The strings below are always rendered as
 * text (never as HTML), and the deep links are built only from a slug the
 * payload supplies; an absent slug yields no link rather than a broken one.
 */

export const NOTIFICATION_LABELS: Record<string, string> = {
  "collection.publish": "Collection published",
  "member.approve_join": "Membership approved",
  "member.join_via_invite": "New member joined",
};

export function getNotificationLabel(eventType: string): string {
  return NOTIFICATION_LABELS[eventType] ?? "Notification";
}

/**
 * The in-app destination for a notification, or null when the payload lacks the
 * slug needed to build one (the item then renders as a non-navigating button).
 */
export function getNotificationDeepLink(eventType: string, payload: Record<string, unknown>): string | null {
  const slug = typeof payload.community_slug === "string" ? payload.community_slug : undefined;
  if (!slug) return null;

  switch (eventType) {
    case "collection.publish": {
      const colSlug = typeof payload.collection_slug === "string" ? payload.collection_slug : undefined;
      return colSlug ? `/c/${slug}/collections/${colSlug}` : `/c/${slug}/collections`;
    }
    case "member.approve_join":
      return `/c/${slug}/members`;
    case "member.join_via_invite":
      return `/c/${slug}/members`;
    default:
      return null;
  }
}

/** A human description built from the event payload, with a safe fallback when a field is missing. */
export function getNotificationDescription(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "collection.publish": {
      const name = typeof payload.collection_name === "string" ? payload.collection_name : undefined;
      return name ? `${name} is now live` : "A collection is now live";
    }
    case "member.approve_join":
      return "Your membership has been approved";
    case "member.join_via_invite": {
      const name = typeof payload.member_name === "string" ? payload.member_name : undefined;
      return name ? `${name} joined the community` : "Someone joined the community";
    }
    default:
      return "New notification";
  }
}
