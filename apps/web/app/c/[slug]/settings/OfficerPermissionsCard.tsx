"use client";

import { Banner, Button, SelectField } from "@kolekto/ui";
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

  function act(task: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <section
      aria-labelledby="officer-permissions-heading"
      className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6"
    >
      <div>
        <h2 id="officer-permissions-heading" className="text-base font-semibold text-[var(--color-text)]">
          Extra officer permissions
        </h2>
        <p className="mt-1 max-w-xl text-sm text-[var(--color-text-muted)]">
          Let a specific officer manage membership without changing their role. Permissions end automatically when their
          term ends. Every grant and removal is kept in the audit log.
        </p>
      </div>

      {grants.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No extra permissions granted.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {grants.map((g) => (
            <li key={`${g.officerTermId}:${g.permission}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm text-[var(--color-text)]">
                <strong>{g.officerName}</strong> <span className="text-[var(--color-text-muted)]">({g.role})</span> —{" "}
                {describe(g.permission)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={isPending}
                onClick={() => act(() => revokeOfficerPermissionAction(slug, g.officerTermId, g.permission))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {officers.length === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">Invite another officer first; owners already hold every permission.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
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
            disabled={!termId || !permission}
            onClick={() => act(() => grantOfficerPermissionAction(slug, termId, permission))}
          >
            Grant
          </Button>
        </div>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
    </section>
  );
}
