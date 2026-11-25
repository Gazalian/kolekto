import { listMyCommunities, type MyCommunity } from "@kolekto/db";
import { Badge, ErrorState } from "@kolekto/ui";
import { ChevronRight, Mail, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { AuthenticatedTopBar } from "../../components/AuthenticatedTopBar.tsx";
import { requireUser } from "../../lib/auth.ts";
import { requireCallerContext } from "../../lib/caller.ts";
import {
  communityTypeLabel,
  communityVerification,
  initials,
  isManagingRole,
  roleLabel,
} from "../../lib/community-display.ts";

export const metadata = { title: "Your communities" };

/**
 * The community home: where every signed-in session starts (middleware sends
 * a signed-in user here from the auth pages).
 *
 * One call, `app.my_communities()`, returns exactly the communities the
 * signed-in user holds an active officer term in — the database reads
 * `auth.uid()` itself; nothing from the browser chooses whose list this is.
 */
export default async function CommunitiesPage() {
  const user = await requireUser();
  const caller = await requireCallerContext();

  let communities: MyCommunity[] | null = null;
  try {
    communities = await listMyCommunities(caller);
  } catch {
    communities = null;
  }

  const personal = communities?.filter((c) => c.isPersonal) ?? [];
  const managed = communities?.filter((c) => !c.isPersonal && isManagingRole(c.role)) ?? [];
  const others = communities?.filter((c) => !c.isPersonal && !isManagingRole(c.role)) ?? [];
  const firstName = user.full_name.trim().split(/\s+/)[0] ?? "";

  return (
    <>
      <AuthenticatedTopBar userName={user.full_name} email={user.email} avatarUrl={user.avatar_url} />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-text)]">
              {firstName ? `Welcome back, ${firstName}` : "Your communities"}
            </h1>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">Choose where you want to work.</p>
          </div>
          <Link
            href="/communities/new"
            className="inline-flex h-10 items-center justify-center gap-1.5 self-start rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-strong)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none sm:self-auto"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New community
          </Link>
        </div>

        {communities === null ? (
          <ErrorState description="Your communities could not be loaded. Refresh the page to try again." />
        ) : communities.length === 0 ? (
          <EmptyHome />
        ) : (
          <>
            {managed.length > 0 && (
              <Section title="Communities you manage" count={managed.length}>
                {managed.map((c) => (
                  <CommunityCard key={c.communityId} community={c} />
                ))}
              </Section>
            )}
            {others.length > 0 && (
              <Section title="Communities you help with" count={others.length}>
                {others.map((c) => (
                  <CommunityCard key={c.communityId} community={c} />
                ))}
              </Section>
            )}
            {personal.length > 0 && (
              <Section title="Your personal space">
                {personal.map((c) => (
                  <CommunityCard key={c.communityId} community={c} />
                ))}
              </Section>
            )}
            <JoinHint />
          </>
        )}
      </main>
    </>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        {title}
        {count !== undefined && <span className="font-normal text-[var(--color-text-faint)]">{count}</span>}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function CommunityCard({ community: c }: { community: MyCommunity }) {
  const verification = communityVerification(c.verificationStatus);
  const name = c.isPersonal ? "My Workspace" : c.name;
  return (
    <Link
      href={`/c/${c.slug}`}
      className="group flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--color-border-strong)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none"
    >
      <CommunityAvatar name={name} logoUrl={c.logoUrl} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--color-text)]">{name}</p>
            <p className="truncate text-xs text-[var(--color-text-muted)]">
              {c.isPersonal ? "Collections you run on your own" : communityTypeLabel(c.type)}
            </p>
          </div>
          <ChevronRight
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-faint)] transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={isManagingRole(c.role) ? "info" : "neutral"}>
            {c.title ? `${c.title} · ${roleLabel(c.role)}` : roleLabel(c.role)}
          </Badge>
          {!c.isPersonal && (
            <Badge tone={verification.tone}>
              {c.verificationStatus === "verified" && <ShieldCheck className="h-3 w-3" aria-hidden="true" />}
              {verification.label}
            </Badge>
          )}
          {c.status !== "active" && <Badge tone="warning">{c.status === "archived" ? "Archived" : c.status === "restricted" ? "Restricted" : "Suspended"}</Badge>}
        </div>
        {c.collectionCount !== null && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {c.collectionCount === 0
              ? "No collections yet"
              : `${c.liveCollectionCount ?? 0} live · ${c.collectionCount} ${c.collectionCount === 1 ? "collection" : "collections"}`}
          </p>
        )}
      </div>
    </Link>
  );
}

function CommunityAvatar({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl && /^https:\/\//.test(logoUrl)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- an officer-supplied logo URL; next/image would need every host allow-listed
      <img
        src={logoUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="h-11 w-11 shrink-0 rounded-[var(--radius-md)] border border-[var(--color-border)] object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-success-bg)] text-sm font-semibold text-[var(--color-primary)]"
    >
      {initials(name)}
    </span>
  );
}

function EmptyHome() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-12 text-center">
      <div className="space-y-1">
        <p className="font-medium text-[var(--color-text)]">You are not part of a community yet</p>
        <p className="mx-auto max-w-md text-sm text-[var(--color-text-muted)]">
          Create a community to start collecting money from a group. If someone runs a community you help with, ask
          them to invite you as an officer — the invitation arrives by email.
        </p>
      </div>
      <Link
        href="/communities/new"
        className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-strong)]"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Create a community
      </Link>
    </div>
  );
}

function JoinHint() {
  return (
    <p className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]">
      <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Looking for another community? Officers join by invitation: ask its owner to invite your email address, then
      open the link in that email.
    </p>
  );
}
