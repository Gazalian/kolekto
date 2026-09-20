"use client";

import type { AuditLog, Member, MemberAttributeDefinition, MemberGroup } from "@kolekto/db";
import { Badge, Banner, Button, Card, CardBody, Dialog, SelectField, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatDistanceToNow } from "../../../../../lib/format.ts";
import {
  archiveMemberAction,
  restoreMemberAction,
  setMemberGroupsAction,
  updateMemberAction,
} from "../actions.ts";

/**
 * One member, as the community actually thinks about them (§20, §41).
 *
 * The ordering is the argument: who they are to Kolekto and to this community
 * first, then how to reach them, then whatever this community records about its
 * people, then where they belong, then what has happened to their record.
 *
 * What is NOT here: anything about money. No balance, no "total paid", no
 * contribution history — not as an empty state, not as a zero. Contributions do
 * not exist yet (ADR 0006) and a zero is a claim.
 */

export interface DefinitionValue {
  definition: MemberAttributeDefinition;
  value: string | null;
}

export function MemberDetailClient({
  slug,
  member,
  definitions,
  groups,
  groupIds,
  activity,
  canEdit,
  canArchive,
  canManageGroups,
}: {
  slug: string;
  member: Member;
  definitions: DefinitionValue[];
  groups: MemberGroup[];
  groupIds: string[];
  activity: AuditLog[];
  canEdit: boolean;
  canArchive: boolean;
  canManageGroups: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editingGroups, setEditingGroups] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const primary = definitions.find((entry) => entry.definition.is_primary_identifier) ?? null;
  const others = definitions.filter((entry) => !entry.definition.is_primary_identifier);
  const isArchived = member.status === "archived";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href={`/c/${slug}/members`} className="text-xs font-medium text-[var(--color-text-muted)] hover:underline">
          ← Members
        </Link>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-semibold text-[var(--color-text)]">{member.full_name}</h1>
            <Badge tone={isArchived ? "neutral" : member.status === "active" ? "success" : "info"}>
              {member.status.replace("_", " ")}
            </Badge>
          </div>

          <div className="flex flex-wrap gap-2">
            {canEdit && !isArchived && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            )}
            {canManageGroups && !isArchived && (
              <Button variant="secondary" onClick={() => setEditingGroups(true)}>
                Change groups
              </Button>
            )}
            {canArchive &&
              (isArchived ? (
                <Button
                  loading={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await restoreMemberAction(slug, member.id);
                      if (result.error) setError(result.error);
                      else router.refresh();
                    })
                  }
                >
                  Restore member
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setArchiving(true)}>
                  Archive
                </Button>
              ))}
          </div>
        </div>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      {isArchived && (
        <Banner tone="info">
          This member is archived. Their record and everything attached to it is kept — restoring brings them back to
          the active roster.
        </Banner>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Identity</h2>
            <dl className="divide-y divide-[var(--color-border)]">
              <Row label="Member ID" value={member.member_code ?? "—"} mono />
              {primary && <Row label={primary.definition.label} value={primary.value ?? "—"} />}
              <Row label="Joined via" value={member.joined_via.replace("_", " ")} />
              <Row label="On the roll since" value={new Date(member.created_at).toLocaleDateString()} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Contact</h2>
            <dl className="divide-y divide-[var(--color-border)]">
              <Row label="Phone" value={member.phone_e164 ?? "—"} />
              <Row label="Email" value={member.email ?? "—"} />
              <Row label="Account" value={member.user_id ? "Claimed" : "Not claimed"} />
            </dl>
          </CardBody>
        </Card>
      </div>

      {others.length > 0 && (
        <Card>
          <CardBody className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              What {"this community"} records
            </h2>
            <dl className="divide-y divide-[var(--color-border)]">
              {others.map((entry) => (
                <Row key={entry.definition.id} label={entry.definition.label} value={entry.value ?? "—"} />
              ))}
            </dl>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Groups</h2>
          {groupIds.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">Not in any group.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {groupIds.map((id) => {
                const group = groups.find((candidate) => candidate.id === id);
                return group ? <Badge key={id}>{group.name}</Badge> : null;
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Activity</h2>
          {activity.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">Nothing has happened to this record yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap justify-between gap-2 text-sm">
                  <span className="text-[var(--color-text)]">
                    {entry.action.replace(/^[a-z_]+\./, "").replace(/_/g, " ")} — {entry.actor_name_snapshot}
                    {entry.reason && (
                      <span className="block text-xs text-[var(--color-text-muted)]">{entry.reason}</span>
                    )}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">{formatDistanceToNow(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Contributions, balances and receipts belong here, and are deliberately
          absent rather than shown as zero: no payment has been recorded by any
          part of this system yet (ADR 0006). */}
      <p className="text-xs text-[var(--color-text-muted)]">
        Payment history will appear here once Kolekto is taking payments. Nothing is shown in the meantime, because
        nothing has been paid.
      </p>

      {editing && (
        <EditDetailsDialog
          slug={slug}
          member={member}
          definitions={definitions}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}

      {editingGroups && (
        <EditGroupsDialog
          slug={slug}
          memberId={member.id}
          groups={groups}
          groupIds={groupIds}
          onClose={() => setEditingGroups(false)}
          onSaved={() => {
            setEditingGroups(false);
            router.refresh();
          }}
        />
      )}

      {archiving && (
        <Dialog
          open
          onClose={() => setArchiving(false)}
          title={`Archive ${member.full_name}?`}
          description="Their record and history are kept, and they can be restored at any time."
        >
          <form
            className="flex flex-col gap-4"
            action={(formData) =>
              startTransition(async () => {
                formData.set("memberId", member.id);
                const result = await archiveMemberAction(slug, formData);
                if (result.error) setError(result.error);
                else {
                  setArchiving(false);
                  router.refresh();
                }
              })
            }
          >
            <TextField label="Reason" name="reason" hint="Optional, kept in the audit log." />
            <Button type="submit" variant="danger" loading={isPending}>
              Archive member
            </Button>
          </form>
        </Dialog>
      )}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-2">
      <dt className="text-sm text-[var(--color-text-muted)]">{label}</dt>
      <dd className={mono ? "font-mono text-sm text-[var(--color-text)]" : "text-sm font-medium text-[var(--color-text)]"}>
        {value}
      </dd>
    </div>
  );
}

function EditDetailsDialog({
  slug,
  member,
  definitions,
  onClose,
  onSaved,
}: {
  slug: string;
  member: Member;
  definitions: DefinitionValue[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fieldKeys = definitions.map((entry) => entry.definition.key);

  return (
    <Dialog open onClose={onClose} title={`Edit ${member.full_name}`}>
      <form
        className="flex flex-col gap-4"
        action={(formData) =>
          startTransition(async () => {
            formData.set("memberId", member.id);
            const result = await updateMemberAction(slug, fieldKeys, formData);
            if (result.error) setError(result.error);
            else onSaved();
          })
        }
      >
        <TextField label="Full name" name="fullName" defaultValue={member.full_name} required />
        <TextField label="Phone number" name="phoneE164" defaultValue={member.phone_e164 ?? ""} />
        <TextField label="Email" name="email" type="email" defaultValue={member.email ?? ""} />

        {definitions.map(({ definition, value }) =>
          definition.type === "single_select" ? (
            <SelectField
              key={definition.id}
              label={definition.label}
              name={`attr:${definition.key}`}
              defaultValue={value ?? ""}
            >
              <option value="">—</option>
              {(definition.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
          ) : (
            <TextField
              key={definition.id}
              label={definition.label}
              name={`attr:${definition.key}`}
              type={definition.type === "date" ? "date" : "text"}
              defaultValue={value ?? ""}
              {...(definition.is_unique ? { hint: "Must be unique in this community." } : {})}
            />
          ),
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        <Button type="submit" loading={isPending}>
          Save changes
        </Button>
      </form>
    </Dialog>
  );
}

function EditGroupsDialog({
  slug,
  memberId,
  groups,
  groupIds,
  onClose,
  onSaved,
}: {
  slug: string;
  memberId: string;
  groups: MemberGroup[];
  groupIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(groupIds));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title="Groups" description="A member can be in as many groups as the community needs.">
      <div className="flex flex-col gap-4">
        {groups.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">This community has no groups yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {groups.map((group) => (
              <li key={group.id}>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                    checked={selected.has(group.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(group.id);
                        else next.delete(group.id);
                        return next;
                      })
                    }
                  />
                  {group.name}
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        <Button
          loading={isPending}
          disabled={groups.length === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await setMemberGroupsAction(slug, { memberId, groupIds: [...selected] });
              if (result.error) setError(result.error);
              else onSaved();
            })
          }
        >
          Save groups
        </Button>
      </div>
    </Dialog>
  );
}
