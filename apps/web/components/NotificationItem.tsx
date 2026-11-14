"use client";

import { cn } from "@kolekto/ui";
import { Gift, UserCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { markReadAction } from "../app/notifications/actions.ts";
import { formatDistanceToNow } from "../lib/format.ts";
import { getNotificationDeepLink, getNotificationDescription, getNotificationLabel } from "../lib/notification-display.ts";

export interface NotificationRow {
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

/** Event-type → icon. Labels and descriptions live in lib/notification-display.ts (unit-tested, JSX-free). */
const EVENT_ICONS: Record<string, typeof Gift> = {
  "collection.publish": Gift,
  "member.approve_join": UserCheck,
  "member.join_via_invite": UserPlus,
};

export function NotificationItem({
  notification,
  onRefresh,
  onClose,
}: {
  notification: NotificationRow;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const event = notification.notification_events;
  const eventType = event?.event_type ?? "unknown";
  const payload = (event?.payload ?? {}) as Record<string, unknown>;
  const Icon = EVENT_ICONS[eventType] ?? Gift;
  const label = getNotificationLabel(eventType);
  const isUnread = !notification.read_at;
  const deepLink = getNotificationDeepLink(eventType, payload);
  const description = getNotificationDescription(eventType, payload);

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
          {label}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-faint)] line-clamp-2 break-words">{description}</p>
        <time
          dateTime={notification.created_at}
          title={new Date(notification.created_at).toLocaleString()}
          className="mt-1 block text-xs text-[var(--color-text-faint)]"
        >
          {formatDistanceToNow(notification.created_at)}
        </time>
      </div>
      {isUnread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--color-primary)]" />}
    </div>
  );

  const ariaLabel = `${label}. ${description}. ${formatDistanceToNow(notification.created_at)}.${isUnread ? " Unread." : ""}`;

  if (deepLink) {
    return (
      <Link
        href={deepLink}
        onClick={handleClick}
        data-notification-item=""
        aria-label={ariaLabel}
        className="block border-b border-[var(--color-border)] last:border-b-0 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none focus-visible:-outline-offset-2"
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      data-notification-item=""
      aria-label={ariaLabel}
      className="block w-full border-b border-[var(--color-border)] text-left last:border-b-0 focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none focus-visible:-outline-offset-2"
    >
      {content}
    </button>
  );
}
