"use client";

import type { Community, OfficerRole } from "@kolekto/db";
import { cn } from "@kolekto/ui";
import { Activity, Gift, LayoutGrid, LogOut, Menu, Settings, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { NotificationBell } from "./NotificationBell.tsx";
import { NotificationProvider } from "./NotificationProvider.tsx";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
}

function navItems(slug: string): NavItem[] {
  return [
    { href: `/c/${slug}`, label: "Overview", icon: LayoutGrid },
    { href: `/c/${slug}/collections`, label: "Collections", icon: Gift },
    { href: `/c/${slug}/members`, label: "Members", icon: Users },
    { href: `/c/${slug}/activity`, label: "Activity", icon: Activity },
    { href: `/c/${slug}/settings`, label: "Settings", icon: Settings },
  ];
}

export function AppShell({
  community,
  role,
  userName,
  children,
}: {
  community: Community;
  role: OfficerRole;
  userName: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const items = navItems(community.slug);

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 p-3">
      {items.map((item) => {
        const active = item.href === `/c/${community.slug}` ? pathname === item.href : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <NotificationProvider>
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] sm:flex">
        <SidebarHeader community={community} role={role} />
        {nav}
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <NotificationBell />
        </div>
        <UserFooter userName={userName} />
      </aside>

      {/* Mobile top bar + slide-out */}
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:hidden">
          <span className="font-semibold text-[var(--color-text)]">{community.is_personal ? "My Workspace" : community.name}</span>
          <div className="flex items-center gap-1">
            <NotificationBell />
            <button
              type="button"
              aria-label={mobileOpen ? "Close menu" : "Open menu"}
              onClick={() => setMobileOpen((v) => !v)}
              className="rounded-[var(--radius-sm)] p-2 text-[var(--color-text)] hover:bg-[var(--color-bg)]"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </header>
        {mobileOpen && (
          <div className="flex flex-col border-b border-[var(--color-border)] bg-[var(--color-surface)] sm:hidden">
            {nav}
            <UserFooter userName={userName} />
          </div>
        )}

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
    </div>
    </NotificationProvider>
  );
}

function SidebarHeader({ community, role }: { community: Community; role: OfficerRole }) {
  return (
    <div className="border-b border-[var(--color-border)] p-4">
      <Link href="/communities" className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
        ← All communities
      </Link>
      <p className="mt-2 truncate font-semibold text-[var(--color-text)]" title={community.is_personal ? "My Workspace" : community.name}>
        {community.is_personal ? "My Workspace" : community.name}
      </p>
      <p className="text-xs capitalize text-[var(--color-text-faint)]">{role}</p>
    </div>
  );
}

function UserFooter({ userName }: { userName: string }) {
  return (
    <form action="/logout" method="post" className="flex items-center justify-between border-t border-[var(--color-border)] p-3">
      <span className="truncate text-sm text-[var(--color-text-muted)]">{userName}</span>
      <button
        type="submit"
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        Sign out
      </button>
    </form>
  );
}
