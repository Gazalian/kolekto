"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createClient } from "../lib/supabase/browser.ts";

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

interface NotificationContextValue {
  notifications: NotificationRow[];
  unreadCount: number;
  loading: boolean;
  /** Set when the last fetch failed. The bell keeps showing the last good data
   * rather than a false "all caught up", and the panel offers a retry. */
  error: boolean;
  refresh: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const POLL_INTERVAL_MS = 15_000;

/** The inbox holds the most recent slice; the full history lives at /notifications. */
const INBOX_LIMIT = 30;

/**
 * A single polling loop for the whole shell. Both the desktop (sidebar) and
 * mobile (header) bells render the same component but share this one source, so
 * there is exactly one 15s interval regardless of how many bells are mounted
 * (QA BUG-9).
 *
 * The query is scoped explicitly to the signed-in user (QA BUG-2): the officer
 * RLS policy deliberately exposes community-wide deliveries for a future officer
 * history view, so the personal bell must not rely on RLS alone to isolate the
 * inbox. The unread count is a separate COUNT query, not a slice of the first
 * page (QA BUG-8).
 *
 * A failed fetch is never shown as success (brief: "Do not ... show a
 * successful state when the backend operation failed"). On error the last good
 * snapshot is kept and `error` is raised so the panel can show a retry instead
 * of an empty "all caught up" that would mislead. Polling also pauses while the
 * tab is hidden and refreshes once on return, so a backgrounded dashboard does
 * not keep two bells hammering the stack.
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const userIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
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
      setError(false);
      setLoading(false);
      return;
    }

    try {
      const { data: rows, error: rowsError } = await supabase
        .from("notification_deliveries")
        .select(
          "id, notification_event_id, community_id, channel, status, read_at, created_at, notification_events(event_type, payload, actor_user_id)",
        )
        .eq("channel", "in_app")
        .eq("recipient_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(INBOX_LIMIT);

      const { count, error: countError } = await supabase
        .from("notification_deliveries")
        .select("id", { count: "exact", head: true })
        .eq("channel", "in_app")
        .eq("recipient_user_id", userId)
        .is("read_at", null);

      if (rowsError || countError) {
        // Keep the last good snapshot; do not blank the inbox or the badge.
        setError(true);
        setLoading(false);
        return;
      }

      // postgrest's generic typing widens the to-one `notification_events`
      // embed to an array; the runtime shape is a single object. Cast via unknown.
      setNotifications((rows as unknown as NotificationRow[] | null) ?? []);
      setUnreadCount(count ?? 0);
      setError(false);
      setLoading(false);
    } catch {
      // Network/transport failure: show the error, keep the last good snapshot.
      setError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    };

    // Initial inbox fetch on mount. `refresh` only setStates after an await, so
    // this does not cascade synchronously; the lint rule can't see across the
    // async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const interval = setInterval(tick, POLL_INTERVAL_MS);

    function onVisible() {
      if (!cancelled && typeof document !== "undefined" && !document.hidden) {
        void refresh();
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, loading, error, refresh }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within a NotificationProvider");
  }
  return ctx;
}
