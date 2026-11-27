"use client";

import type { CommunityMemberCodeSettings } from "@kolekto/db";
import { Badge, Banner, Button, Dialog, SelectField, TextField } from "@kolekto/ui";
import { Hash, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { saveMemberCodeSettingsAction } from "./actions.ts";
import { issueMissingMembershipIdsAction, saveMembershipIdSettingsAction } from "./membership-actions.ts";

/**
 * "IDs & access": the two identities a member can hold, side by side, so an
 * officer sees what each one is for.
 *
 *   Member ID              Kolekto's number for the person — KWASU/0021.
 *                          Issued to everyone automatically, in order. Not
 *                          secret: it is on the roll, receipts and exports.
 *   Private membership ID  A hard-to-guess ID (product doc Part F §F4; M9b) a
 *                          member uses to prove they belong on members-only
 *                          collections. Never shown on a public page.
 *
 * Both sections only decide what is shown; the database re-checks every save.
 */

/** Fixed sample suffix: nothing shown in a preview is ever issued. */
const SAMPLE_SUFFIX = "K7P9QX3M";

export interface MembershipIdSettingsView {
  prefix: string;
  separator: "/" | "-";
  suffixLength: number;
  enabled: boolean;
}

/** Private membership ID state; null on the panel when the caller cannot see it. */
export interface MembershipIdAccess {
  settings: MembershipIdSettingsView | null;
  /** Members in good standing without an ID, capped by the query (null when unknown). */
  missingCount: number | null;
  issuedCount: number | null;
  canConfigure: boolean;
  canIssue: boolean;
}

export function MemberIdsPanel({
  slug,
  communityId,
  codeSettings,
  memberCount,
  canConfigureMemberId,
  membershipIds,
  onClose,
}: {
  slug: string;
  communityId: string;
  codeSettings: CommunityMemberCodeSettings | null;
  memberCount: number;
  canConfigureMemberId: boolean;
  membershipIds: MembershipIdAccess | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="IDs & access"
      description="Two IDs, two jobs: one to find a member, one to prove they belong."
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <MemberIdSection
          slug={slug}
          communityId={communityId}
          codeSettings={codeSettings}
          memberCount={memberCount}
          canConfigure={canConfigureMemberId}
        />
        {membershipIds && <MembershipIdSection slug={slug} communityId={communityId} {...membershipIds} />}
      </div>
    </Dialog>
  );
}

function IdSection({
  headingId,
  icon,
  iconClassName,
  title,
  badge,
  purpose,
  children,
}: {
  headingId: string;
  icon: ReactNode;
  iconClassName: string;
  title: string;
  badge: ReactNode;
  purpose: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-sm)]"
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] ${iconClassName}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="text-sm font-semibold text-[var(--color-text)]">
              {title}
            </h3>
            {badge}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{purpose}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function IdPreview({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string | null;
  note?: string | undefined;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-4 py-3"
      aria-live="polite"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="font-mono text-base font-semibold tracking-wide text-[var(--color-text)]" data-testid={testId}>
          {value ?? "—"}
        </span>
        {note && <span className="text-xs text-[var(--color-text-muted)]">{note}</span>}
      </span>
    </div>
  );
}

function MemberIdSection({
  slug,
  communityId,
  codeSettings,
  memberCount,
  canConfigure,
}: {
  slug: string;
  communityId: string;
  codeSettings: CommunityMemberCodeSettings | null;
  memberCount: number;
  canConfigure: boolean;
}) {
  const [prefix, setPrefix] = useState(codeSettings?.prefix ?? "");
  const [padding, setPadding] = useState(String(codeSettings?.padding ?? 4));
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const nextNumber = codeSettings?.next_number ?? 1;
  const preview = `${prefix}${String(nextNumber).padStart(Number(padding) || 4, "0")}`;

  return (
    <IdSection
      headingId="member-id-heading"
      icon={<Hash className="h-5 w-5" />}
      iconClassName="bg-[var(--color-info-bg)] text-[var(--color-info)]"
      title="Member ID"
      badge={<Badge tone="info">Everyone · not secret</Badge>}
      purpose={
        <>
          Every member gets one automatically, in order. It appears on the members list, receipts and exports, and is
          what a member types to find themselves on a collection. Changing the format affects new members only — the{" "}
          {memberCount} already issued keep theirs.
        </>
      }
    >
      {canConfigure && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Member ID prefix"
            placeholder="KWASU/"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
          />
          <TextField label="Digits" inputMode="numeric" value={padding} onChange={(event) => setPadding(event.target.value)} />
        </div>
      )}

      <IdPreview label="Next member gets" value={preview} />

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      {canConfigure && (
        <Button
          variant="secondary"
          size="sm"
          className="w-fit"
          loading={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await saveMemberCodeSettingsAction(slug, {
                communityId,
                prefix,
                padding: Number(padding) || 4,
              });
              setMessage(
                result.error ? { tone: "danger", text: result.error } : { tone: "success", text: "Member ID format saved." },
              );
            })
          }
        >
          Save member ID format
        </Button>
      )}
    </IdSection>
  );
}

function MembershipIdSection({
  slug,
  communityId,
  settings,
  missingCount,
  issuedCount,
  canConfigure,
  canIssue,
}: { slug: string; communityId: string } & MembershipIdAccess) {
  const router = useRouter();
  const [prefix, setPrefix] = useState(settings?.prefix ?? "");
  const [separator, setSeparator] = useState<"/" | "-">(settings?.separator ?? "/");
  const [suffixLength, setSuffixLength] = useState(settings?.suffixLength ?? 5);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const cleanPrefix = prefix.replace(/\s+/g, "").toUpperCase();
  const preview = cleanPrefix ? `${cleanPrefix}${separator}${SAMPLE_SUFFIX.slice(0, suffixLength)}` : null;
  const savedEnabled = settings?.enabled === true;

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveMembershipIdSettingsAction(slug, { communityId, prefix, separator, suffixLength, enabled });
      if (result.error) setError(result.error);
      else {
        setNotice("Saved. New IDs use this format; IDs already issued keep working.");
        router.refresh();
      }
    });
  }

  function issueMissing() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await issueMissingMembershipIdsAction(slug, communityId);
      if (result.error) setError(result.error);
      else {
        const parts = [`Issued ${result.issued ?? 0} membership ID${result.issued === 1 ? "" : "s"}.`];
        if (result.failed) parts.push(`${result.failed} could not be issued.`);
        if (result.remaining) parts.push("More members still need one — click again to continue.");
        setNotice(parts.join(" "));
        router.refresh();
      }
    });
  }

  return (
    <IdSection
      headingId="membership-id-heading"
      icon={<KeyRound className="h-5 w-5" />}
      iconClassName="bg-[var(--color-success-bg)] text-[var(--color-success)]"
      title="Private membership ID"
      badge={<Badge tone={savedEnabled ? "success" : "neutral"}>{savedEnabled ? "On" : "Off"}</Badge>}
      purpose={
        <>
          A private ID each member keeps to themselves, such as <span className="font-mono">IDS/K7P9Q</span>. They enter
          it to prove membership on members-only collections. The random part is hard to guess, and it is never shown on
          any public page.
        </>
      }
    >
      {canConfigure ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Membership ID prefix"
            name="prefix"
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            hint="2–10 letters or numbers, starting with a letter."
          />
          <SelectField
            label="Separator"
            name="separator"
            value={separator}
            onChange={(event) => setSeparator(event.target.value === "-" ? "-" : "/")}
          >
            <option value="/">/ (slash)</option>
            <option value="-">- (dash)</option>
          </SelectField>
          <SelectField
            label="Random characters"
            name="suffixLength"
            value={String(suffixLength)}
            onChange={(event) => setSuffixLength(Number(event.target.value))}
          >
            {[5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </SelectField>
        </div>
      ) : (
        settings && (
          <IdPreview
            label="Format"
            value={`${settings.prefix}${settings.separator}${"•".repeat(settings.suffixLength)}`}
            note={settings.enabled ? undefined : "(off)"}
          />
        )
      )}

      {canConfigure && (
        <IdPreview label="Example" value={preview} note="example only, never issued" testId="membership-id-preview" />
      )}

      {canConfigure && (
        <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={enabled}
            disabled={isPending}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>
            <span className="font-medium">Membership IDs are on for this community</span>
            <span className="block text-xs text-[var(--color-text-muted)]">
              Needed before you can issue IDs or run members-only collections.
            </span>
          </span>
        </label>
      )}

      {(issuedCount !== null || missingCount !== null) && (
        <div className="grid grid-cols-2 gap-3">
          {issuedCount !== null && <Stat label="Have an ID" value={String(issuedCount)} />}
          {missingCount !== null && <Stat label="Still need one" value={missingCount > 200 ? "200+" : String(missingCount)} />}
        </div>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
      {notice && !error && <Banner tone="success">{notice}</Banner>}

      {(canConfigure || (canIssue && savedEnabled && (missingCount ?? 0) > 0)) && (
        <div className="flex flex-wrap gap-2">
          {canConfigure && (
            <Button size="sm" loading={isPending} disabled={!cleanPrefix} onClick={save}>
              Save membership ID format
            </Button>
          )}
          {canIssue && savedEnabled && (missingCount ?? 0) > 0 && (
            <Button size="sm" variant="secondary" loading={isPending} onClick={issueMissing}>
              Issue IDs to members without one
            </Button>
          )}
        </div>
      )}
    </IdSection>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-bg)] px-4 py-3">
      <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--color-text)]">{value}</p>
    </div>
  );
}
