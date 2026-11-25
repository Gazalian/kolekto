"use client";

import { Banner, Button, SelectField, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { issueMissingMembershipIdsAction, saveMembershipIdSettingsAction } from "../members/membership-actions.ts";

/**
 * Membership ID format and bulk issue (product doc Part F §F4; M9b).
 *
 * The preview uses a fixed sample suffix, never a real random one: nothing
 * shown here is ever issued. Changing the format affects new IDs only; IDs
 * already issued keep working.
 */

const SAMPLE_SUFFIX = "K7P9QX3M";

export interface MembershipIdSettingsView {
  prefix: string;
  separator: "/" | "-";
  suffixLength: number;
  enabled: boolean;
}

export function MembershipIdSettingsCard({
  slug,
  communityId,
  settings,
  missingCount,
  issuedCount,
  canConfigure,
  canIssue,
}: {
  slug: string;
  communityId: string;
  settings: MembershipIdSettingsView | null;
  /** Members in good standing without an ID, capped by the query (null when unknown). */
  missingCount: number | null;
  issuedCount: number | null;
  canConfigure: boolean;
  canIssue: boolean;
}) {
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
    <section
      aria-labelledby="membership-id-heading"
      className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6"
    >
      <div>
        <h2 id="membership-id-heading" className="text-base font-semibold text-[var(--color-text)]">
          Membership IDs
        </h2>
        <p className="mt-1 max-w-xl text-sm text-[var(--color-text-muted)]">
          A private ID for each member, such as <span className="font-mono">IDS/K7P9Q</span>. Members will use it to
          prove membership on members-only collections. The random part is hard to guess, and the ID is never shown on
          any public page.
        </p>
      </div>

      {canConfigure ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Prefix"
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
          <p className="text-sm text-[var(--color-text)]">
            Format: <span className="font-mono">{`${settings.prefix}${settings.separator}${"•".repeat(settings.suffixLength)}`}</span>
            {settings.enabled ? "" : " (off)"}
          </p>
        )
      )}

      {canConfigure && (
        <p className="text-sm text-[var(--color-text-muted)]" aria-live="polite">
          Preview:{" "}
          <span className="font-mono font-semibold text-[var(--color-text)]" data-testid="membership-id-preview">
            {preview ?? "—"}
          </span>{" "}
          <span className="text-xs">(example only, never issued)</span>
        </p>
      )}

      {canConfigure && (
        <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
          <input type="checkbox" checked={enabled} disabled={isPending} onChange={(event) => setEnabled(event.target.checked)} />
          Membership IDs are on for this community
        </label>
      )}

      {(issuedCount !== null || missingCount !== null) && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {issuedCount !== null && `${issuedCount} member${issuedCount === 1 ? " has" : "s have"} an ID. `}
          {missingCount !== null && missingCount > 0 && `${missingCount > 200 ? "More than 200" : missingCount} without one.`}
        </p>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
      {notice && !error && <Banner tone="success">{notice}</Banner>}

      <div className="flex flex-wrap gap-2">
        {canConfigure && (
          <Button size="sm" loading={isPending} disabled={!cleanPrefix} onClick={save}>
            Save format
          </Button>
        )}
        {canIssue && savedEnabled && (missingCount ?? 0) > 0 && (
          <Button size="sm" variant="secondary" loading={isPending} onClick={issueMissing}>
            Issue IDs to members without one
          </Button>
        )}
      </div>
    </section>
  );
}
