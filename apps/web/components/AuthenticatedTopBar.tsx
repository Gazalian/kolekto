"use client";

import Link from "next/link";
import { NotificationBell } from "./NotificationBell.tsx";
import { NotificationProvider } from "./NotificationProvider.tsx";

/**
 * Top bar for authenticated pages that live OUTSIDE a community workspace
 * (`/communities`, `/account`, `/notifications`). The community-scoped layout
 * (`app/c/[slug]/layout.tsx` → `AppShell`) already renders its own bell inside
 * its sidebar/mobile header; this bar fills the gap on every other
 * authenticated route so a signed-in user who has not navigated into a
 * specific community still has a notification entry point.
 *
 * The bar wraps its own `NotificationProvider`. Each page that uses the bar
 * owns its own polling loop — one per route — rather than sharing a global
 * provider, which keeps the shell consistent with how `AppShell` already
 * mounts its provider per community page.
 */
export function AuthenticatedTopBar() {
  return (
    <NotificationProvider>
      <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:px-6">
        <Link
          href="/communities"
          className="text-sm font-semibold text-[var(--color-text)] hover:underline focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
        >
          Kolekto
        </Link>
        <NotificationBell />
      </header>
    </NotificationProvider>
  );
}
