"use client";

import { LayoutGrid, LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Avatar } from "./Avatar.tsx";

/**
 * The personal-profile entry point. The profile belongs to the person, not to
 * a community, so this menu is the same everywhere: the community home, the
 * profile itself, notifications, and inside every community workspace.
 */
export function UserMenu({
  userName,
  email,
  avatarUrl,
}: {
  userName: string;
  email?: string | null;
  avatarUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item =
    "flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${userName}`}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
      >
        <Avatar name={userName} url={avatarUrl} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-64 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-md)]"
        >
          <div className="border-b border-[var(--color-border)] px-3 pb-2 pt-1.5">
            <p className="truncate text-sm font-medium text-[var(--color-text)]">{userName}</p>
            {email && <p className="truncate text-xs text-[var(--color-text-muted)]">{email}</p>}
          </div>
          <div className="flex flex-col py-1">
            <Link href="/account" role="menuitem" className={item} onClick={() => setOpen(false)}>
              <UserRound className="h-4 w-4 text-[var(--color-text-muted)]" aria-hidden="true" />
              Your profile
            </Link>
            <Link href="/communities" role="menuitem" className={item} onClick={() => setOpen(false)}>
              <LayoutGrid className="h-4 w-4 text-[var(--color-text-muted)]" aria-hidden="true" />
              Your communities
            </Link>
          </div>
          <form action="/logout" method="post" className="border-t border-[var(--color-border)] pt-1">
            <button type="submit" role="menuitem" className={`${item} w-full`}>
              <LogOut className="h-4 w-4 text-[var(--color-text-muted)]" aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
