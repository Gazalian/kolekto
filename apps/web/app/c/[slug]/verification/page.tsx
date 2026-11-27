import { getCommunityVerificationReadiness, type Community, type CommunityVerificationReadiness } from "@kolekto/db";
import { Badge, ErrorState } from "@kolekto/ui";
import { CheckCircle2, Circle, Info, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requireCallerContext } from "../../../../lib/caller.ts";
import { communityVerification, formatShortDate, naira } from "../../../../lib/community-display.ts";
import { createClient } from "../../../../lib/supabase/server.ts";

export const metadata = { title: "Community verification" };

/**
 * Community verification: the real status (`communities.verification_status`)
 * and a readiness checklist read from real data by
 * `app.community_verification_readiness`.
 *
 * Submitting for review is NOT built: Kolekto has no verification provider or
 * review process yet (DEC-04/DEC-05, docs/product/COMMUNITY-EXPERIENCE-PROFILE-KYC-OVERVIEW.md §8).
 * This page says so plainly instead of offering a form that does nothing.
 */
export default async function VerificationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: community } = await supabase.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (!community) notFound();
  const c = community as Community;

  let readiness: CommunityVerificationReadiness | null = null;
  try {
    readiness = await getCommunityVerificationReadiness(await requireCallerContext(), c.id);
  } catch {
    readiness = null;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link href={`/c/${slug}`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--color-text)]">Community verification</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Verification confirms that {c.name} is a real group run by the people who say they run it. It is separate
          from each officer&apos;s personal verification.
        </p>
      </div>

      {readiness === null ? (
        <ErrorState description="Verification details could not be loaded. Refresh the page to try again." />
      ) : (
        <Readiness readiness={readiness} slug={slug} />
      )}
    </div>
  );
}

function Readiness({ readiness: r, slug }: { readiness: CommunityVerificationReadiness; slug: string }) {
  const status = communityVerification(r.verificationStatus);
  const verified = r.verificationStatus === "verified";
  const panel = "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]";

  return (
    <>
      <section className={`${panel} flex items-start gap-3 p-4`}>
        <ShieldCheck
          className={`mt-0.5 h-5 w-5 shrink-0 ${verified ? "text-[var(--color-success)]" : "text-[var(--color-text-faint)]"}`}
          aria-hidden="true"
        />
        <div className="flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-text)]">
            Status <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {verified
              ? `Verified on ${formatShortDate(r.verifiedAt)}. Daily withdrawal limits for unverified communities no longer apply.`
              : `Until it is verified, this community can withdraw up to ${naira(r.unverifiedDailyLimitKobo)} a day across all its collections.`}
          </p>
          {!verified && r.requestedTodayKobo !== null && (
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Used today: <span className="font-medium tabular-nums text-[var(--color-text)]">{naira(r.requestedTodayKobo)}</span> of{" "}
              {naira(r.unverifiedDailyLimitKobo)} (resets at midnight, Lagos time)
            </p>
          )}
        </div>
      </section>

      {!verified && (
        <section className={panel} aria-labelledby="checklist-heading">
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <h2 id="checklist-heading" className="text-sm font-semibold text-[var(--color-text)]">
              Getting ready
            </h2>
            <p className="text-xs text-[var(--color-text-muted)]">Checked against this community&apos;s records now.</p>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            <Check done={r.hasDescription} title="Describe the community" detail="What the group is and what it collects for.">
              <SettingsLink slug={slug} />
            </Check>
            <Check done={r.hasLocation} title="Add a location" detail="State or city where the community is based.">
              <SettingsLink slug={slug} />
            </Check>
            <Check done={r.contactVerified} title="Confirm the community's contact details" detail="A verified phone number or email for the community." />
            {r.ownerEmailConfirmed !== null && (
              <Check done={r.ownerEmailConfirmed} title="An owner has a confirmed email" detail="The responsible representative must be reachable." />
            )}
            {r.ownerHasVerifiedPayout !== null && (
              <Check
                done={r.ownerHasVerifiedPayout}
                title="An owner has a verified payout account"
                detail="A bank account whose name matches the owner's legal name."
              >
                <Link href="/account#payout-accounts" className="text-xs font-medium text-[var(--color-primary)] hover:underline">
                  Your profile
                </Link>
              </Check>
            )}
          </ul>
        </section>
      )}

      {!verified && (
        <section className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-info-bg)] p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]" aria-hidden="true" />
          <div className="text-sm text-[var(--color-text)]">
            <p className="font-medium">Submitting for verification is not open yet</p>
            <p className="mt-1 text-[var(--color-text-muted)]">
              {r.canSubmit
                ? "Kolekto is setting up its review process. When it opens, you will submit the community's documents here, and Kolekto will review them. Nothing you see on this page changes the community's status by itself."
                : "Only an owner of this community can submit it for verification once submissions open."}
            </p>
          </div>
        </section>
      )}
    </>
  );
}

function Check({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {done ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-label="Done" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-faint)]" aria-label="Not done" />
      )}
      <div className="flex-1">
        <p className="text-sm font-medium text-[var(--color-text)]">{title}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{detail}</p>
      </div>
      {!done && children}
    </li>
  );
}

function SettingsLink({ slug }: { slug: string }) {
  return (
    <Link href={`/c/${slug}/settings`} className="text-xs font-medium text-[var(--color-primary)] hover:underline">
      Settings
    </Link>
  );
}
