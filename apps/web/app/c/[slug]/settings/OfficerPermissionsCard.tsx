"use client";

import { Banner, Button, SelectField } from "@kolekto/ui";
import { ShieldCheck, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { grantOfficerPermissionAction, revokeOfficerPermissionAction } from "../members/membership-actions.ts";

/**
 * Owner-only: give individual officers specific membership powers on top of
 * their role (owner decision Q2; M9b). Only permissions the database marks
 * delegable are offered, and the database refuses anything else — including
 * granting to another owner, or by anyone who is not an owner.
 */

export interface DelegableOption {
  permission: string;
  description: string;
}

export interface OfficerOption {
  termId: string;
  name: string;
  role: string;
}

export interface GrantRow {
  officerTermId: string;
  officerName: string;
  role: string;
  permission: string;
  grantedAt: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

export function OfficerPermissionsCard({
  slug,
  officers,
  delegable,
  grants,
}: {
  slug: string;
  officers: OfficerOption[];
  delegable: DelegableOption[];
  grants: GrantRow[];
}) {
  const router = useRouter();
  const [termId, setTermId] = useState(officers[0]?.termId ?? "");
  const [permission, setPermission] = useState(delegable[0]?.permission ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const describe = (p: string) => delegable.find((d) => d.permission === p)?.description ?? p;

  // One row per officer, their extra permissions as chips.
  const byOfficer = new Map<string, { name: string; role: string; grants: GrantRow[] }>();
  for (const g of grants) {
    const entry = byOfficer.get(g.officerTermId) ?? { name: g.officerName, role: g.role, grants: [] };
    entry.grants.push(g);
    byOfficer.set(g.officerTermId, entry);
  }

  const alreadyGranted = grants.some((g) => g.officerTermId === termId && g.permission === permission);

  function act(task: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <section aria-labelledby="officer-permissions-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="officer-permissions-heading" className="text-sm font-semibold text-[var(--color-text)]">
          Extra officer permissions
        </h2>
        <p className="mt-0.5 max-w-xl text-xs text-[var(--color-text-muted)]">
          Let a specific officer manage membership without changing their role. Permissions end automatically when their
          term ends. Every grant and removal is kept in the audit log.
        </p>
      </div>

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        {byOfficer.size === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <span
              className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-bg)] text-[var(--color-text-muted)]"
              aria-hidden="true"
            >
              <ShieldCheck className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-[var(--color-text)]">No extra permissions granted</p>
            <p className="max-w-sm text-xs text-[var(--color-text-muted)]">
              Officers can only do what their role allows. Grant a permission below to let one do a little more.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {[...byOfficer.entries()].map(([officerTermId, officer]) => (
              <li key={officerTermId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
                <div className="flex min-w-0 items-center gap-3 sm:w-48 sm:shrink-0">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-info-bg)] text-xs font-semibold text-[var(--color-info)]"
                    aria-hidden="true"
                  >
                    {initials(officer.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--color-text)]">{officer.name}</p>
                    <p className="text-xs capitalize text-[var(--color-text-muted)]">{officer.role}</p>
                  </div>
                </div>
                <ul className="flex flex-1 flex-wrap gap-2 sm:pt-1">
                  {officer.grants.map((g) => (
                    <li
                      key={g.permission}
                      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-3 pr-1 text-xs font-medium text-[var(--color-text)]"
                    >
                      <ShieldCheck className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden="true" />
                      {describe(g.permission)}
                      <button
                        type="button"
                        disabled={isPending}
                        aria-label={`Remove "${describe(g.permission)}" from ${officer.name}`}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
                        onClick={() => act(() => revokeOfficerPermissionAction(slug, g.officerTermId, g.permission))}
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
          {officers.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              Invite another officer first; owners already hold every permission.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">Grant a permission</p>
              <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
                <SelectField label="Officer" name="officer" value={termId} onChange={(event) => setTermId(event.target.value)}>
                  {officers.map((o) => (
                    <option key={o.termId} value={o.termId}>
                      {o.name} ({o.role})
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Permission"
                  name="permission"
                  value={permission}
                  onChange={(event) => setPermission(event.target.value)}
                >
                  {delegable.map((d) => (
                    <option key={d.permission} value={d.permission}>
                      {d.description}
                    </option>
                  ))}
                </SelectField>
                <Button
                  size="sm"
                  loading={isPending}
                  disabled={!termId || !permission || alreadyGranted}
                  onClick={() => act(() => grantOfficerPermissionAction(slug, termId, permission))}
                >
                  {alreadyGranted ? "Already granted" : "Grant"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}
