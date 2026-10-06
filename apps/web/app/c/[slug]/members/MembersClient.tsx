"use client";

import type {
  CommunityMemberCodeSettings,
  InviteLink,
  Member,
  MemberAttributeDefinition,
  MemberDuplicate,
  MemberGroup,
} from "@kolekto/db";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  SelectField,
  Table,
  Tbody,
  Td,
  TextField,
  Th,
  Thead,
  Tr,
} from "@kolekto/ui";
import { Plus, Settings2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import {
  approveMemberAction,
  archiveMemberAction,
  createMemberAction,
  findDuplicatesAction,
  rejectMemberAction,
  restoreMemberAction,
  revokeInviteLinkAction,
  setMemberGroupsAction,
  updateMemberAction,
} from "./actions.ts";
import { InviteLinkDialog } from "./InviteLinkDialog.tsx";
import { MemberProfileConfig } from "./MemberProfileConfig.tsx";
import { GroupsManager, type GroupRow } from "./GroupsManager.tsx";

export interface MemberRow {
  member: Member;
  /** The community's own fields, keyed by definition key. */
  attributes: Record<string, string>;
  groupIds: string[];
}

const STATUS_TONE: Record<Member["status"], "neutral" | "success" | "warning" | "danger" | "info"> = {
  active: "success",
  unclaimed: "neutral",
  invited: "info",
  pending_approval: "warning",
  archived: "neutral",
  merged: "neutral",
};

export function MembersClient({
  slug,
  communityId,
  rows,
  definitions,
  groups,
  groupRows,
  codeSettings,
  inviteLinks,
  canCreate,
  canEdit,
  canArchive,
  canInvite,
  canApprove,
  canConfigure,
}: {
  slug: string;
  communityId: string;
  rows: MemberRow[];
  definitions: MemberAttributeDefinition[];
  groups: MemberGroup[];
  groupRows: GroupRow[];
  codeSettings: CommunityMemberCodeSettings | null;
  inviteLinks: InviteLink[];
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canInvite: boolean;
  canApprove: boolean;
  canConfigure: boolean;
}) {
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [archiving, setArchiving] = useState<MemberRow | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The field the community identifies people by. It gets its own column,
  // because it is the thing an officer scans the list for (§5, §45).
  const primary = definitions.find((definition) => definition.is_primary_identifier) ?? null;
  const secondary = definitions.filter((definition) => !definition.is_primary_identifier).slice(0, 2);
  const fieldKeys = definitions.map((definition) => definition.key);

  const pending = rows.filter((row) => row.member.status === "pending_approval");
  const roster = rows.filter((row) => row.member.status !== "pending_approval");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster.filter((row) => {
      if (!showArchived && row.member.status === "archived") return false;
      if (showArchived && row.member.status !== "archived") return false;
      if (groupFilter && !row.groupIds.includes(groupFilter)) return false;
      if (!q) return true;

      // Search covers everything that identifies a person: their name, the code
      // Kolekto issued, their contact details, and every community field value —
      // so "KWASU/0021", "20/53A/021" and "John" all find the same member (§18).
      return (
        row.member.full_name.toLowerCase().includes(q) ||
        (row.member.member_code ?? "").toLowerCase().includes(q) ||
        (row.member.phone_e164 ?? "").includes(q) ||
        (row.member.email ?? "").toLowerCase().includes(q) ||
        Object.values(row.attributes).some((value) => value.toLowerCase().includes(q))
      );
    });
  }, [roster, query, groupFilter, showArchived]);

  const fieldValueCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const definition of definitions) {
      counts[definition.id] = rows.filter((row) => row.attributes[definition.key] != null && row.attributes[definition.key] !== "").length;
    }
    return counts;
  }, [rows, definitions]);

  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Members</h1>
        <div className="flex flex-wrap gap-2">
          {canConfigure && (
            <Button variant="secondary" onClick={() => setGroupsOpen(true)}>
              <Users className="h-4 w-4" aria-hidden="true" /> Groups
            </Button>
          )}
          {canConfigure && (
            <Button variant="secondary" onClick={() => setConfigOpen(true)}>
              <Settings2 className="h-4 w-4" aria-hidden="true" /> Member profile
            </Button>
          )}
          {canInvite && (
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden="true" /> Invite link
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Add member
            </Button>
          )}
        </div>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}

      {pending.length > 0 && canApprove && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Pending approval ({pending.length})</h2>
          <div className="flex flex-col gap-2">
            {pending.map((row) => (
              <PendingRow key={row.member.id} slug={slug} row={row} />
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <TextField
          label="Search"
          placeholder={`Search by name, member ID${primary ? `, ${primary.label.toLowerCase()}` : ""} or phone`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {groups.length > 0 && (
          <SelectField label="Group" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            <option value="">All groups</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </SelectField>
        )}
        <Button variant={showArchived ? "primary" : "secondary"} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={showArchived ? "No archived members" : roster.length === 0 ? "No members yet" : "No matches"}
          description={
            roster.length === 0
              ? "Add members directly or share an invite link. Each one gets a member ID automatically."
              : "Try a different search, or clear the filters."
          }
        />
      ) : (
        <Table data-responsive>
          <Thead>
            <Tr>
              <Th>Member ID</Th>
              <Th>Name</Th>
              {primary && <Th>{primary.label}</Th>}
              {secondary.map((definition) => (
                <Th key={definition.id}>{definition.label}</Th>
              ))}
              <Th>Groups</Th>
              <Th>Status</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {filtered.map((row) => (
              <Tr key={row.member.id}>
                <Td data-label="Member ID">
                  <span className="font-mono text-xs text-[var(--color-text)]">{row.member.member_code ?? "—"}</span>
                </Td>
                <Td data-label="Name">
                  <Link
                    href={`/c/${slug}/members/${row.member.id}`}
                    className="font-medium text-[var(--color-primary)] hover:underline"
                  >
                    {row.member.full_name}
                  </Link>
                </Td>
                {primary && <Td data-label={primary.label}>{row.attributes[primary.key] ?? "—"}</Td>}
                {secondary.map((definition) => (
                  <Td key={definition.id} data-label={definition.label}>
                    {row.attributes[definition.key] ?? "—"}
                  </Td>
                ))}
                <Td data-label="Groups">
                  {row.groupIds.length === 0 ? "—" : row.groupIds.map(groupName).filter(Boolean).join(", ")}
                </Td>
                <Td data-label="Status">
                  <Badge tone={STATUS_TONE[row.member.status]}>{row.member.status.replace("_", " ")}</Badge>
                </Td>
                <Td data-label="">
                  <div className="flex justify-end gap-2">
                    {canEdit && row.member.status !== "archived" && (
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        onClick={() => setEditing(row)}
                      >
                        Edit
                      </button>
                    )}
                    {canArchive && row.member.status === "archived" && (
                      <RestoreButton slug={slug} memberId={row.member.id} onError={setError} />
                    )}
                    {canArchive && row.member.status !== "archived" && (
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                        onClick={() => setArchiving(row)}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}

      {canInvite && inviteLinks.length > 0 && <InviteLinksSection slug={slug} inviteLinks={inviteLinks} />}

      {createOpen && (
        <MemberDialog
          title="Add member"
          slug={slug}
          communityId={communityId}
          definitions={definitions}
          groups={groups}
          fieldKeys={fieldKeys}
          onClose={() => setCreateOpen(false)}
        />
      )}

      {editing && (
        <MemberDialog
          title={`Edit ${editing.member.full_name}`}
          slug={slug}
          communityId={communityId}
          definitions={definitions}
          groups={groups}
          fieldKeys={fieldKeys}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      )}

      {archiving && <ArchiveDialog slug={slug} row={archiving} onClose={() => setArchiving(null)} />}

      {canInvite && inviteOpen && (
        <InviteLinkDialog
          slug={slug}
          communityId={communityId}
          definitions={definitions}
          groups={groups}
          onClose={() => setInviteOpen(false)}
        />
      )}

      {canConfigure && groupsOpen && (
        <GroupsManager
          slug={slug}
          communityId={communityId}
          groups={groupRows}
          members={rows.map((row) => ({
            id: row.member.id,
            fullName: row.member.full_name,
            memberCode: row.member.member_code,
          }))}
          onClose={() => setGroupsOpen(false)}
        />
      )}

      {canConfigure && configOpen && (
        <MemberProfileConfig
          slug={slug}
          communityId={communityId}
          definitions={definitions}
          codeSettings={codeSettings}
          memberCount={rows.length}
          fieldValueCounts={fieldValueCounts}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  );
}

function RestoreButton({
  slug,
  memberId,
  onError,
}: {
  slug: string;
  memberId: string;
  onError: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      className="text-xs font-medium text-[var(--color-primary)] hover:underline"
      onClick={() =>
        startTransition(async () => {
          const result = await restoreMemberAction(slug, memberId);
          if (result.error) onError(result.error);
        })
      }
    >
      Restore
    </button>
  );
}

/**
 * One dialog for adding and for editing, because the fields are the same and a
 * community that adds a field should not have to discover it twice.
 *
 * Adding runs a duplicate check first (§7/§43). An exact match is refused by the
 * database whatever this form does; a possible match is shown here, with the
 * existing member named, and the person decides.
 */
function MemberDialog({
  title,
  slug,
  communityId,
  definitions,
  groups,
  fieldKeys,
  existing,
  onClose,
}: {
  title: string;
  slug: string;
  communityId: string;
  definitions: MemberAttributeDefinition[];
  groups: MemberGroup[];
  fieldKeys: string[];
  existing?: MemberRow;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<MemberDuplicate[] | null>(null);
  const [pendingForm, setPendingForm] = useState<FormData | null>(null);

  function submit(formData: FormData, confirmed: boolean): void {
    setError(null);
    startTransition(async () => {
      if (existing) {
        formData.set("memberId", existing.member.id);
        const result = await updateMemberAction(slug, fieldKeys, formData);
        if (result.error) {
          setError(result.error);
          return;
        }

        // Groups are a separate write because they are a separate permission:
        // member.edit changes who someone is, group.manage changes where they
        // belong. An officer may hold one and not the other.
        const groupIds = formData.getAll("groupIds").filter((value): value is string => typeof value === "string");
        const grouped = await setMemberGroupsAction(slug, { memberId: existing.member.id, groupIds });
        if (grouped.error) setError(grouped.error);
        else onClose();
        return;
      }

      formData.set("communityId", communityId);
      formData.set("confirmPossibleDuplicate", confirmed ? "true" : "false");

      if (!confirmed) {
        const attributes: Record<string, string> = {};
        for (const key of fieldKeys) {
          const value = formData.get(`attr:${key}`);
          if (typeof value === "string" && value.trim() !== "") attributes[key] = value;
        }

        const check = await findDuplicatesAction({
          communityId,
          fullName: String(formData.get("fullName") ?? ""),
          phoneE164: String(formData.get("phoneE164") ?? "") || undefined,
          email: String(formData.get("email") ?? "") || undefined,
          attributes,
        });

        if (check.duplicates && check.duplicates.length > 0) {
          setDuplicates(check.duplicates);
          setPendingForm(formData);
          return;
        }
      }

      const result = await createMemberAction(slug, fieldKeys, formData);
      if (result.error) setError(result.error);
      else onClose();
    });
  }

  if (duplicates && pendingForm) {
    const hasExact = duplicates.some((duplicate) => duplicate.match_strength === "exact");
    return (
      <Dialog open onClose={onClose} title={hasExact ? "This member already exists" : "Possible duplicate"}>
        <div className="flex flex-col gap-4">
          <Banner tone={hasExact ? "danger" : "info"}>
            {hasExact
              ? "A member already holds one of these identifying details. Two records for the same person cannot be told apart later."
              : "Someone on this roll looks like the person you are adding. Check before continuing."}
          </Banner>

          <ul className="flex flex-col gap-2">
            {duplicates.map((duplicate) => (
              <li
                key={`${duplicate.member_id}-${duplicate.match_reason}`}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm"
              >
                <p className="font-medium text-[var(--color-text)]">
                  {duplicate.full_name}{" "}
                  <span className="font-mono text-xs text-[var(--color-text-muted)]">{duplicate.member_code ?? ""}</span>
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">{duplicate.match_reason}</p>
              </li>
            ))}
          </ul>

          {error && <Banner tone="danger">{error}</Banner>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDuplicates(null);
                setPendingForm(null);
              }}
            >
              Go back
            </Button>
            {!hasExact && (
              <Button variant="secondary" loading={isPending} onClick={() => submit(pendingForm, true)}>
                They are different people — add anyway
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        action={(formData) => submit(formData, false)}
      >
        <TextField label="Full name" name="fullName" defaultValue={existing?.member.full_name ?? ""} required />
        <TextField
          label="Phone number"
          name="phoneE164"
          placeholder="+2348012345678"
          defaultValue={existing?.member.phone_e164 ?? ""}
        />
        <TextField label="Email" name="email" type="email" defaultValue={existing?.member.email ?? ""} />

        {definitions.map((definition) =>
          definition.type === "single_select" ? (
            <SelectField
              key={definition.id}
              label={`${definition.label}${definition.is_primary_identifier ? " (identifies this member)" : ""}`}
              name={`attr:${definition.key}`}
              defaultValue={existing?.attributes[definition.key] ?? ""}
              {...(definition.is_unique ? { hint: "Must be unique in this community." } : {})}
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
              label={`${definition.label}${definition.is_primary_identifier ? " (identifies this member)" : ""}`}
              name={`attr:${definition.key}`}
              type={definition.type === "date" ? "date" : "text"}
              inputMode={definition.type === "number" ? "numeric" : undefined}
              defaultValue={existing?.attributes[definition.key] ?? ""}
              {...(definition.is_unique ? { hint: "Must be unique in this community." } : {})}
            />
          ),
        )}

        {groups.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-[var(--color-text)]">Groups</legend>
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <input
                  type="checkbox"
                  name="groupIds"
                  value={group.id}
                  defaultChecked={existing?.groupIds.includes(group.id) ?? false}
                  className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                />
                {group.name}
              </label>
            ))}
          </fieldset>
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        <Button type="submit" loading={isPending}>
          {existing ? "Save changes" : "Add member"}
        </Button>
      </form>
    </Dialog>
  );
}

function PendingRow({ slug, row }: { slug: string; row: MemberRow }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-warning-bg)]/40 px-4 py-2.5">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">{row.member.full_name}</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {row.member.member_code} · {row.member.phone_e164}
        </p>
        {error && <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await rejectMemberAction(slug, row.member.id);
              if (result.error) setError(result.error);
            })
          }
        >
          Reject
        </Button>
        <Button
          size="sm"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await approveMemberAction(slug, row.member.id);
              if (result.error) setError(result.error);
            })
          }
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

function ArchiveDialog({ slug, row, onClose }: { slug: string; row: MemberRow; onClose: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Archive ${row.member.full_name}?`}
      description="Their history is kept and they can be restored later. They stop appearing on the active roster."
    >
      <form
        className="flex flex-col gap-4"
        action={(formData) =>
          startTransition(async () => {
            formData.set("memberId", row.member.id);
            const result = await archiveMemberAction(slug, formData);
            if (result.error) setError(result.error);
            else onClose();
          })
        }
      >
        <TextField label="Reason" name="reason" hint="Optional, kept in the audit log." />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="danger" loading={isPending}>
          Archive member
        </Button>
      </form>
    </Dialog>
  );
}

function InviteLinksSection({ slug, inviteLinks }: { slug: string; inviteLinks: InviteLink[] }) {
  const [isPending, startTransition] = useTransition();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Invite links</h2>
      <Table data-responsive>
        <Thead>
          <Tr>
            <Th>Label</Th>
            <Th>Status</Th>
            <Th>Uses</Th>
            <Th />
          </Tr>
        </Thead>
        <Tbody>
          {inviteLinks.map((link) => (
            <Tr key={link.id}>
              <Td data-label="Label">{link.label ?? "—"}</Td>
              <Td data-label="Status">
                <Badge tone={link.status === "active" ? "success" : "neutral"}>{link.status}</Badge>
              </Td>
              <Td data-label="Uses">
                {link.uses}
                {link.max_uses ? ` / ${link.max_uses}` : ""}
              </Td>
              <Td data-label="">
                {link.status === "active" && (
                  <button
                    type="button"
                    disabled={isPending}
                    className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                    onClick={() => startTransition(async () => { await revokeInviteLinkAction(slug, link.id); })}
                  >
                    Revoke
                  </button>
                )}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </section>
  );
}
