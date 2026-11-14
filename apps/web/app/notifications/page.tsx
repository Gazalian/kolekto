import Link from "next/link";
import { AuthenticatedTopBar } from "../../components/AuthenticatedTopBar.tsx";
import { requireUser } from "../../lib/auth.ts";
import { NotificationsPageClient } from "./NotificationsPageClient.tsx";

export const metadata = { title: "Notifications" };

/**
 * The full notification history. Middleware already gates this route (not a
 * public path, onboarding-required); `requireUser` is the same guard at the
 * page level for defence in depth. The list itself is a client component so it
 * can page through history and reflect mark-as-read without a full reload.
 */
export default async function NotificationsPage() {
  await requireUser();

  return (
    <div className="min-h-screen">
      <AuthenticatedTopBar />
      <div className="mx-auto max-w-2xl px-6 pt-6">
        <Link href="/communities" className="text-sm font-medium text-[var(--color-text-muted)] hover:underline">
          ← All communities
        </Link>
      </div>
      <NotificationsPageClient />
    </div>
  );
}
