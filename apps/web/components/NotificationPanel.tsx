"use client";

import { cn } from "@kolekto/ui";
import { Bell, Check } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
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
  id,
  notifications,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  id?: string;
  notifications: NotificationRow[];
  loading: boolean;
  error: boolean;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const hasUnread = notifications.some((n) => !n.read_at);
  const hasAny = notifications.length > 0;

  function handleMarkAllRead() {
    setMarkAllError(null);
    startTransition(async () => {
      const result = await markAllReadAction();
      if (result.error) {
        // Never report a read that did not happen. Keep the items unread and
        // surface the failure so the officer can retry.
        setMarkAllError(result.error);
        return;
      }
      await onRefresh();
    });
  }

  return (
    <div
      id={id}
      role="region"
      aria-label="Notifications"
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
            className="flex items-center gap-1 rounded-[var(--radius-sm)] text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            {isPending ? "Marking…" : "Mark all read"}
          </button>
        )}
      </div>

      {markAllError && (
        <div role="alert" className="border-b border-[var(--color-border)] bg-[var(--color-danger-bg)] px-4 py-2 text-xs text-[var(--color-danger)]">
          Couldn&apos;t mark all as read. Please try again.
        </div>
      )}

      {/* A failed refresh keeps the cached list but admits it is stale. */}
      {error && hasAny && (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning-bg)] px-4 py-2 text-xs text-[var(--color-warning)]">
          <span>Couldn&apos;t refresh just now.</span>
          <button type="button" onClick={() => void onRefresh()} className="font-semibold hover:underline focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none">
            Retry
          </button>
        </div>
      )}

      <div className="max-h-96 overflow-y-auto">
        {loading && !hasAny ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-text-faint)]" role="status">
            Loading…
          </div>
        ) : error && !hasAny ? (
          <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <p className="text-sm font-medium text-[var(--color-text)]">We couldn&apos;t load your notifications</p>
            <p className="text-xs text-[var(--color-text-faint)]">Check your connection and try again.</p>
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="mt-1 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-3 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
            >
              Try again
            </button>
          </div>
        ) : !hasAny ? (
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

      <div className="border-t border-[var(--color-border)] px-4 py-2 text-center">
        <Link
          href="/notifications"
          onClick={onClose}
          className="text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        >
          View all notifications
        </Link>
      </div>
    </div>
  );
}
