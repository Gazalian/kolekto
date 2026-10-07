"use client";

import { cn } from "@kolekto/ui";
import { Gift, UserCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { markReadAction } from "../app/notifications/actions.ts";
import { formatDistanceToNow } from "../lib/format.ts";

interface NotificationRow {
  id: string;
  notification_event_id: string;
  community_id: string;
  channel: string;
  status: string;
  read_at: string | null;
  created_at: string;
  notification_events: {
    event_type: string;
    payload: Record<string, unknown>;
    actor_user_id: string | null;
  } | null;
}

const EVENT_CONFIG: Record<string, { icon: typeof Gift; label: string }> = {
  "collection.publish": { icon: Gift, label: "Collection published" },
  "member.approve_join": { icon: UserCheck, label: "Membership approved" },
  "member.join_via_invite": { icon: UserPlus, label: "New member joined" },
};

function getDeepLink(eventType: string, payload: Record<string, unknown>): string | null {
  const slug = payload.community_slug as string | undefined;
  if (!slug) return null;

  switch (eventType) {
    case "collection.publish": {
      const colSlug = payload.collection_slug as string | undefined;
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

function getDescription(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "collection.publish": {
      const name = payload.collection_name as string | undefined;
      return name ? `${name} is now live` : "A collection is now live";
    }
    case "member.approve_join":
      return "Your membership has been approved";
    case "member.join_via_invite": {
      const name = payload.member_name as string | undefined;
      return name ? `${name} joined the community` : "Someone joined the community";
    }
    default:
      return "New notification";
  }
}

export function NotificationItem({
  notification,
  onRefresh,
  onClose,
}: {
  notification: NotificationRow;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const event = notification.notification_events;
  const eventType = event?.event_type ?? "unknown";
  const payload = (event?.payload ?? {}) as Record<string, unknown>;
  const config = EVENT_CONFIG[eventType] ?? { icon: Gift, label: "Notification" };
  const Icon = config.icon;
  const isUnread = !notification.read_at;
  const deepLink = getDeepLink(eventType, payload);
  const description = getDescription(eventType, payload);

  function handleClick() {
    if (isUnread) {
      startTransition(async () => {
        await markReadAction(notification.id);
        onRefresh();
      });
    }
    onClose();
  }

  const content = (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 transition-colors",
        isUnread ? "bg-[var(--color-info-bg)]" : "hover:bg-[var(--color-bg)]",
        isPending && "opacity-50",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUnread ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
        )}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm", isUnread ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]")}>
          {config.label}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-faint)] line-clamp-2">{description}</p>
        <p className="mt-1 text-xs text-[var(--color-text-faint)]">{formatDistanceToNow(notification.created_at)}</p>
      </div>
      {isUnread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" />}
    </div>
  );

  if (deepLink) {
    return (
      <Link href={deepLink} onClick={handleClick} className="block border-b border-[var(--color-border)] last:border-b-0">
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={handleClick} className="block w-full border-b border-[var(--color-border)] text-left last:border-b-0">
      {content}
    </button>
  );
}
