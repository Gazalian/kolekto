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
  refresh: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const POLL_INTERVAL_MS = 15_000;

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
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
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
      setLoading(false);
      return;
    }

    const { data: rows } = await supabase
      .from("notification_deliveries")
      .select(
        "id, notification_event_id, community_id, channel, status, read_at, created_at, notification_events(event_type, payload, actor_user_id)",
      )
      .eq("channel", "in_app")
      .eq("recipient_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);

    const { count } = await supabase
      .from("notification_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("channel", "in_app")
      .eq("recipient_user_id", userId)
      .is("read_at", null);

    setNotifications((rows as NotificationRow[] | null) ?? []);
    setUnreadCount(count ?? 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, loading, refresh }}>
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
