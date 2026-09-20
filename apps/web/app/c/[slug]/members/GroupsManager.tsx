"use client";

import type { MemberGroup } from "@kolekto/db";
import { Badge, Banner, Button, CheckboxField, Dialog, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addMembersToGroupAction,
  archiveGroupAction,
  createGroupAction,
  deleteGroupAction,
  removeMemberFromGroupAction,
  updateGroupAction,
} from "./actions.ts";

/**
 * Groups, and who is in them.
 *
 * Groups are how a collection will say who it is for — "300 Level", "Block B",
 * "Youth" — which is why this screen does not offer a tidy "delete" on
 * everything. A group that has ever held a member is archived, not removed: the
 * membership rows are how an audience gets read later, and an audience whose
 * groups have vanished is one nobody can explain. Only a group nobody was ever
 * in can be deleted, because that is a typo rather than history.
 *
 * Nothing here treats membership as exclusive. A person is Youth and Choir.
 */

export interface GroupRow {
  group: MemberGroup;
  memberIds: string[];
}

export interface GroupMemberOption {
  id: string;
  fullName: string;
  memberCode: string | null;
}

export function GroupsManager({
  slug,
  communityId,
  groups,
  members,
  onClose,
}: {
  slug: string;
  communityId: string;
  groups: GroupRow[];
  members: GroupMemberOption[];
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<MemberGroup | "new" | null>(null);
  const [assigning, setAssigning] = useState<GroupRow | null>(null);
  const [viewing, setViewing] = useState<GroupRow | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // Every mutation here changes what the members page behind this dialog should
  // show — a new group in the filter, a member now inside one. The server action
  // revalidates the route, but this component is holding props that were
  // rendered before it ran, so the refresh has to be asked for.
  const router = useRouter();

  // One dialog at a time: the Dialog component gives its title a fixed element
  // id, so two open at once would put duplicate ids in the document.
  if (editing) {
    return (
      <GroupEditor
        slug={slug}
        communityId={communityId}
        group={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setMessage({ tone: "success", text: "Group saved." });
          router.refresh();
        }}
      />
    );
  }

  if (assigning) {
    return (
      <AssignToGroup
        slug={slug}
        row={assigning}
        members={members}
        onClose={() => setAssigning(null)}
        onSaved={(added) => {
          setAssigning(null);
          setMessage({ tone: "success", text: `${added} member${added === 1 ? "" : "s"} added.` });
          router.refresh();
        }}
      />
    );
  }

  if (viewing) {
    return (
      <GroupMembers
        slug={slug}
        row={viewing}
        members={members}
        onClose={() => setViewing(null)}
        onError={(text) => setMessage({ tone: "danger", text })}
      />
    );
  }

  const active = groups.filter((row) => row.group.archived_at === null);
  const archived = groups.filter((row) => row.group.archived_at !== null);

  return (
    <Dialog open onClose={onClose} title="Groups" description="How this community divides its members.">
      <div className="flex flex-col gap-4">
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-[var(--color-text-muted)]">
            A member can be in several groups at once — 300 Level and Microbiology, Youth and Choir.
          </p>
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            New group
          </Button>
        </div>

        {groups.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No groups yet. A school might add levels and departments; an estate, blocks.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {[...active, ...archived].map((row) => (
              <li
                key={row.group.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
              >
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                    {row.group.name}
                    {row.group.archived_at && <Badge tone="neutral">Archived</Badge>}
                    {row.group.pickable_at_join && <Badge tone="info">Joinable</Badge>}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {row.memberIds.length} member{row.memberIds.length === 1 ? "" : "s"}
                    {row.group.description ? ` · ${row.group.description}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  {row.memberIds.length > 0 && (
                    <button
                      type="button"
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                      onClick={() => setViewing(row)}
                    >
                      View members
                    </button>
                  )}
                  {row.group.archived_at === null && (
                    <>
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        onClick={() => setAssigning(row)}
                      >
                        Add members
                      </button>
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        onClick={() => setEditing(row.group)}
                      >
                        Edit
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={isPending}
                    className="text-xs font-medium text-[var(--color-text-muted)] hover:underline"
                    onClick={() =>
                      startTransition(async () => {
                        const result = await archiveGroupAction(slug, {
                          groupId: row.group.id,
                          archived: row.group.archived_at === null,
                        });
                        if (result.error) setMessage({ tone: "danger", text: result.error });
                        else router.refresh();
                      })
                    }
                  >
                    {row.group.archived_at === null ? "Archive" : "Restore"}
                  </button>
                  {row.memberIds.length === 0 && (
                    <button
                      type="button"
                      disabled={isPending}
                      className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                      onClick={() =>
                        startTransition(async () => {
                          const result = await deleteGroupAction(slug, row.group.id);
                          if (result.error) setMessage({ tone: "danger", text: result.error });
                          else router.refresh();
                        })
                      }
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function GroupEditor({
  slug,
  communityId,
  group,
  onClose,
  onSaved,
}: {
  slug: string;
  communityId: string;
  group: MemberGroup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [pickable, setPickable] = useState(group?.pickable_at_join ?? false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog open onClose={onClose} title={group ? `Edit ${group.name}` : "New group"}>
      <div className="flex flex-col gap-4">
        <TextField
          label="Name"
          placeholder="300 Level"
          value={name}
          required
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Description"
          hint="Optional."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <CheckboxField
          label="People joining by invite link can put themselves in this group"
          checked={pickable}
          onChange={(event) => setPickable(event.target.checked)}
        />

        {error && <Banner tone="danger">{error}</Banner>}

        <Button
          loading={isPending}
          onClick={() =>
            startTransition(async () => {
              const payload = {
                name,
                ...(description.trim() ? { description } : {}),
                pickableAtJoin: pickable,
                sortOrder: group?.sort_order ?? 0,
              };
              const result = group
                ? await updateGroupAction(slug, { groupId: group.id, ...payload })
                : await createGroupAction(slug, { communityId, ...payload });
              if (result.error) setError(result.error);
              else onSaved();
            })
          }
        >
          {group ? "Save group" : "Create group"}
        </Button>
      </div>
    </Dialog>
  );
}

function AssignToGroup({
  slug,
  row,
  members,
  onClose,
  onSaved,
}: {
  slug: string;
  row: GroupRow;
  members: GroupMemberOption[];
  onClose: () => void;
  onSaved: (added: number) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const candidates = members.filter((member) => {
    if (row.memberIds.includes(member.id)) return false;
    const q = query.trim().toLowerCase();
    return !q || member.fullName.toLowerCase().includes(q) || (member.memberCode ?? "").toLowerCase().includes(q);
  });

  return (
    <Dialog open onClose={onClose} title={`Add members to ${row.group.name}`}>
      <div className="flex flex-col gap-4">
        <TextField
          label="Search"
          placeholder="Search by name or member ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {candidates.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Everyone on the roll is already in this group.</p>
        ) : (
          <ul className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            {candidates.map((member) => (
              <li key={member.id} className="border-b border-[var(--color-border)] last:border-b-0">
                <label className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                    checked={selected.has(member.id)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(member.id);
                        else next.delete(member.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    {member.fullName}
                    {member.memberCode && (
                      <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">{member.memberCode}</span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <Banner tone="danger">{error}</Banner>}

        <Button
          loading={isPending}
          disabled={selected.size === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await addMembersToGroupAction(slug, {
                groupId: row.group.id,
                memberIds: [...selected],
              });
              if (result.error) setError(result.error);
              else onSaved(result.added ?? 0);
            })
          }
        >
          Add {selected.size > 0 ? selected.size : ""} member{selected.size === 1 ? "" : "s"}
        </Button>
      </div>
    </Dialog>
  );
}

function GroupMembers({
  slug,
  row,
  members,
  onClose,
  onError,
}: {
  slug: string;
  row: GroupRow;
  members: GroupMemberOption[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const router = useRouter();

  // `row` came from the page render that opened this dialog, so a removal has
  // to be reflected here as well as asked for from the server.
  const inGroup = members.filter((member) => row.memberIds.includes(member.id) && !removed.has(member.id));

  return (
    <Dialog open onClose={onClose} title={row.group.name} description={`${inGroup.length} member${inGroup.length === 1 ? "" : "s"}`}>
      <ul className="flex flex-col gap-2">
        {inGroup.map((member) => (
          <li key={member.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-[var(--color-text)]">
              {member.fullName}
              {member.memberCode && (
                <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">{member.memberCode}</span>
              )}
            </span>
            <button
              type="button"
              disabled={isPending}
              className="text-xs font-medium text-[var(--color-danger)] hover:underline"
              onClick={() =>
                startTransition(async () => {
                  const result = await removeMemberFromGroupAction(slug, {
                    groupId: row.group.id,
                    memberId: member.id,
                  });
                  if (result.error) onError(result.error);
                  else {
                    setRemoved((current) => new Set(current).add(member.id));
                    router.refresh();
                  }
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
