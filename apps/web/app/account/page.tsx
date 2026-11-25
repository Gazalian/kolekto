import { getMyIdentitySummary, listMyBankAccounts, type MyIdentitySummary, type SavedBankAccount } from "@kolekto/db";
import { Badge } from "@kolekto/ui";
import Link from "next/link";
import { AuthenticatedTopBar } from "../../components/AuthenticatedTopBar.tsx";
import { requireUser } from "../../lib/auth.ts";
import { requireCallerContext } from "../../lib/caller.ts";
import { formatShortDate, identityLevelView } from "../../lib/community-display.ts";
import { AvatarUploader } from "./AvatarUploader.tsx";
import { PasswordSection, ProfileSection } from "./AccountForm.tsx";
import { PayoutAccounts } from "./PayoutAccounts.tsx";
import { PersonalVerification } from "./PersonalVerification.tsx";

export const metadata = { title: "Your profile" };

/**
 * The personal profile: one per person, the same from every community. It
 * holds who you are, your personal verification and your payout bank
 * accounts — none of which belong to a community or a collection. A
 * withdrawal from a collection pays into an account saved here, while the
 * money always comes from that one collection.
 */
export default async function AccountPage() {
  const user = await requireUser();
  const caller = await requireCallerContext();

  const [identity, accounts] = await Promise.all([
    getMyIdentitySummary(caller).catch((): MyIdentitySummary | null => null),
    listMyBankAccounts(caller).catch((): SavedBankAccount[] | null => null),
  ]);
  const level = identityLevelView(identity?.identityLevel ?? "none");
  const panel = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6";

  return (
    <>
      <AuthenticatedTopBar userName={user.full_name} email={user.email} avatarUrl={user.avatar_url} />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
        <Link href="/communities" className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Your communities
        </Link>

        <section className={`${panel} flex items-start gap-4`} aria-label="Your account">
          <AvatarUploader name={user.full_name} avatarUrl={user.avatar_url} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight text-[var(--color-text)]">{user.full_name}</h1>
            <p className="truncate text-sm text-[var(--color-text-muted)]">{user.email ?? user.phone_e164}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Badge tone={level.tone}>{level.label}</Badge>
              <span className="text-xs text-[var(--color-text-faint)]">
                On Kolekto since {formatShortDate(identity?.accountCreated ?? user.created_at)}
              </span>
            </div>
          </div>
        </section>

        <div className={panel}>
          <ProfileSection user={user} />
        </div>
        <div className={panel}>
          <PersonalVerification identity={identity} accounts={accounts} />
        </div>
        <div className={panel}>
          <PayoutAccounts />
          <p className="mt-4 text-xs text-[var(--color-text-muted)]">
            These accounts are yours, not a community&apos;s. When you withdraw from a collection, the money comes only from
            that collection and is paid into the account you choose here.
          </p>
        </div>
        <div className={panel}>
          <PasswordSection />
        </div>
      </main>
    </>
  );
}
