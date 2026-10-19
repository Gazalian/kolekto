"use client";

import { cn } from "@kolekto/ui";
import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNotifications } from "./NotificationProvider.tsx";
import { NotificationPanel } from "./NotificationPanel.tsx";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { notifications, unreadCount, loading, error, refresh } = useNotifications();

  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;

    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
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

      {open && (
        <NotificationPanel
          id={panelId}
          notifications={notifications}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onClose={() => close()}
        />
      )}
    </div>
  );
}
