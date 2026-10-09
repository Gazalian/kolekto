"use client";

import { cn } from "@kolekto/ui";
import { Bell, Check } from "lucide-react";
import { useTransition } from "react";
import { markAllReadAction } from "../app/notifications/actions.ts";
import { NotificationItem } from "./NotificationItem.tsx";

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

export function NotificationPanel({
  notifications,
  loading,
  onRefresh,
  onClose,
}: {
  notifications: NotificationRow[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const hasUnread = notifications.some((n) => !n.read_at);

  function handleMarkAllRead() {
    startTransition(async () => {
      await markAllReadAction();
      onRefresh();
    });
  }

  return (
    <div
      className={cn(
        "absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-md)]",
        "sm:w-96",
      )}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Notifications</h2>
        {hasUnread && (
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={isPending}
            className="flex items-center gap-1 text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-50"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            Mark all read
          </button>
        )}
      </div>

      <div className="max-h-96 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-faint)]">Loading…</div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-bg)] text-[var(--color-text-muted)]">
              <Bell className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-[var(--color-text)]">You&apos;re all caught up</p>
            <p className="text-xs text-[var(--color-text-faint)]">
              Updates from your communities will appear here.
            </p>
          </div>
        ) : (
          notifications.map((n) => (
            <NotificationItem key={n.id} notification={n} onRefresh={onRefresh} onClose={onClose} />
          ))
        )}
      </div>
    </div>
  );
}
