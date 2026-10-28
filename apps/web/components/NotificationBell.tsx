"use client";

import { cn } from "@kolekto/ui";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { computePanelCoords, type PanelCoords } from "../lib/notification-panel-placement.ts";
import { useNotifications } from "./NotificationProvider.tsx";
import { NotificationPanel } from "./NotificationPanel.tsx";

/**
 * The bell button and its dropdown panel.
 *
 * The panel is `position: fixed` with coordinates computed from the button's
 * viewport-rect on open: `absolute right-0 top-full` cannot work for every
 * mount site this bell is used in (the sidebar bell sits at the bottom-left
 * of the viewport, so top-full pushed the panel off the bottom and right-0
 * pushed it off the left — QA LAYOUT-1). We re-measure on resize and on
 * window scroll so a scroll or orientation change does not strand the panel.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<PanelCoords | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { notifications, unreadCount, loading, error, refresh } = useNotifications();

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  const reposition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setCoords(computePanelCoords(rect, window.innerWidth, window.innerHeight));
  }, []);

  // Compute coordinates synchronously before the panel paints so the first
  // frame already lands in the right place (no flicker from an initial render
  // at (0,0) followed by a corrective layout pass). The panel is only
  // rendered when `open && coords` so stale coordinates from a previous open
  // never reach the DOM.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    }
    function handleResize() {
      reposition();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    // scroll uses capture so a scroll inside any ancestor also fires.
    window.addEventListener("scroll", handleResize, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize, true);
    };
  }, [open, reposition]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={cn(
          "relative rounded-[var(--radius-sm)] p-2 text-[var(--color-text-muted)] transition-colors",
          "hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]",
          "focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none",
          open && "bg-[var(--color-bg)] text-[var(--color-text)]",
        )}
      >
        <Bell className="h-4.5 w-4.5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && coords && (
        <NotificationPanel
          id={panelId}
          panelRef={panelRef}
          notifications={notifications}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onClose={() => close()}
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            width: coords.width,
            maxHeight: coords.maxHeight,
          }}
        />
      )}
    </div>
  );
}
