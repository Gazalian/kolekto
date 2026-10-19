"use client";

import { Button, EmptyState, ErrorState, Skeleton } from "@kolekto/ui";
import { Bell, Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NotificationItem, type NotificationRow } from "../../components/NotificationItem.tsx";
import { createClient } from "../../lib/supabase/browser.ts";
import { markAllReadAction } from "./actions.ts";

/** One page of history. Bounded loading: the inbox never fetches an unbounded list. */
const PAGE_SIZE = 20;

/**
 * The full notification history. The dropdown shows the most recent slice; this
 * page pages through everything, oldest-bounded by "Load more".
 *
 * Reads go through the browser Supabase client under RLS, scoped explicitly to
 * the signed-in user (same reasoning as NotificationProvider — the officer RLS
 * policy exposes community-wide deliveries, so the personal history must filter
 * by recipient_user_id, not rely on RLS alone). A failed read is shown as an
 * error with retry, never as an empty history.
 */
export function NotificationsPageClient() {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markAllError, setMarkAllError] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  const load = useCallback(async (nextLimit: number) => {
    const supabase = createClient();

    let userId = userIdRef.current;
    if (!userId) {
      const { data } = await supabase.auth.getUser();
      userId = data.user?.id ?? null;
      userIdRef.current = userId;
    }
    if (!userId) {
      setNotifications([]);
      setUnreadCount(0);
      setHasMore(false);
      setError(false);
      setLoading(false);
      return;
    }

    try {
      // Over-fetch by one to learn whether another page exists without a
      // second round trip.
      const { data: rows, error: rowsError } = await supabase
        .from("notification_deliveries")
        .select(
          "id, notification_event_id, community_id, channel, status, read_at, created_at, notification_events(event_type, payload, actor_user_id)",
        )
        .eq("channel", "in_app")
        .eq("recipient_user_id", userId)
        .order("created_at", { ascending: false })
        .range(0, nextLimit);

      const { count, error: countError } = await supabase
        .from("notification_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("channel", "in_app")
        .eq("recipient_user_id", userId)
        .is("read_at", null);

      if (rowsError || countError) {
        setError(true);
        setLoading(false);
        return;
      }

      // postgrest's generic typing widens the to-one `notification_events`
      // embed to an array; the runtime shape is a single object. Cast via unknown.
      const all = (rows as unknown as NotificationRow[] | null) ?? [];
      setHasMore(all.length > nextLimit);
      setNotifications(all.slice(0, nextLimit));
      setUnreadCount(count ?? 0);
      setError(false);
      setLoading(false);
    } catch {
      setError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch when the requested page size changes. `load` only setStates after
    // an await, so this does not cascade synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(limit);
  }, [load, limit]);

  const refresh = useCallback(() => load(limit), [load, limit]);

  async function handleMarkAllRead() {
    setMarkAllError(null);
    setMarkingAll(true);
    const result = await markAllReadAction();
    setMarkingAll(false);
    if (result.error) {
      setMarkAllError(result.error);
      return;
    }
    await refresh();
  }

  const hasAny = notifications.length > 0;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Notifications</h1>
          <p className="mt-0.5 text-sm text-[var(--color-text-muted)]" aria-live="polite">
            {unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up"}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button variant="secondary" onClick={handleMarkAllRead} disabled={markingAll}>
            <Check className="h-4 w-4" aria-hidden="true" />
            {markingAll ? "Marking…" : "Mark all read"}
          </Button>
        )}
      </div>

      {markAllError && (
        <div role="alert" className="rounded-[var(--radius-md)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
          Couldn&apos;t mark all as read. Please try again.
        </div>
      )}

      {loading && !hasAny ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : error && !hasAny ? (
        <ErrorState
          description="We couldn't load your notifications. Check your connection and try again."
          action={
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : !hasAny ? (
        <EmptyState
          icon={<Bell className="h-6 w-6" aria-hidden="true" />}
          title="No notifications yet"
          description="Updates from your communities will appear here."
        />
      ) : (
        <>
          {error && (
            <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning)]" role="status">
              <span>Couldn&apos;t refresh just now.</span>
              <button type="button" onClick={() => void refresh()} className="font-semibold hover:underline focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none">
                Retry
              </button>
            </div>
          )}
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
            {notifications.map((n) => (
              <NotificationItem key={n.id} notification={n} onRefresh={refresh} onClose={() => {}} />
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => {
                  setLoading(true);
                  setLimit((l) => l + PAGE_SIZE);
                }}
                disabled={loading}
              >
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
