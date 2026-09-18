"use client";

import type { InviteLink, Member, MemberGroup } from "@kolekto/db";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Table,
  Tbody,
  Td,
  TextField,
  Th,
  Thead,
  Tr,
} from "@kolekto/ui";
import { Plus, UserPlus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import {
  approveMemberAction,
  archiveMemberAction,
  createInviteLinkAction,
  createMemberAction,
  rejectMemberAction,
  revokeInviteLinkAction,
  updateMemberAction,
} from "./actions.ts";

const STATUS_TONE: Record<Member["status"], "neutral" | "success" | "warning" | "danger" | "info"> = {
  active: "success",
  unclaimed: "neutral",
  invited: "info",
  pending_approval: "warning",
  archived: "neutral",
  merged: "neutral",
};

interface Props {
  slug: string;
  communityId: string;
  members: Member[];
  inviteLinks: InviteLink[];
  groups: MemberGroup[];
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canInvite: boolean;
  canApprove: boolean;
  communitySlugForLink: string;
}

export function MembersClient(props: Props) {
  const { slug, communityId, members, inviteLinks, canCreate, canEdit, canArchive, canInvite, canApprove } = props;
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [archiving, setArchiving] = useState<Member | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const pending = members.filter((m) => m.status === "pending_approval");
  const roster = members.filter((m) => m.status !== "pending_approval");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (m) => m.full_name.toLowerCase().includes(q) || m.phone_e164?.includes(q) || m.identifier?.toLowerCase().includes(q),
    );
  }, [roster, query]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Members</h1>
        <div className="flex gap-2">
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

      {pending.length > 0 && canApprove && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Pending approval ({pending.length})</h2>
          <div className="flex flex-col gap-2">
            {pending.map((member) => (
              <PendingRow key={member.id} slug={slug} member={member} />
            ))}
          </div>
        </section>
      )}

      <TextField label="Search" placeholder="Search by name, phone or identifier" value={query} onChange={(e) => setQuery(e.target.value)} />

      {filtered.length === 0 ? (
        <EmptyState
          title={roster.length === 0 ? "No members yet" : "No matches"}
          description={roster.length === 0 ? "Add members directly or share an invite link." : "Try a different search."}
        />
      ) : (
        <Table data-responsive>
          <Thead>
            <Tr>
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Identifier</Th>
              <Th>Status</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {filtered.map((member) => (
              <Tr key={member.id}>
                <Td data-label="Name">{member.full_name}</Td>
                <Td data-label="Phone">{member.phone_e164 ?? "—"}</Td>
                <Td data-label="Identifier">{member.identifier ?? "—"}</Td>
                <Td data-label="Status">
                  <Badge tone={STATUS_TONE[member.status]}>{member.status.replace("_", " ")}</Badge>
                </Td>
                <Td data-label="">
                  <div className="flex justify-end gap-2">
                    {canEdit && (
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                        onClick={() => setEditing(member)}
                      >
                        Edit
                      </button>
                    )}
                    {canArchive && member.status !== "archived" && (
                      <button
                        type="button"
                        className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                        onClick={() => setArchiving(member)}
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

      {canInvite && inviteLinks.length > 0 && <InviteLinksSection slug={slug} inviteLinks={inviteLinks} communitySlug={props.communitySlugForLink} />}

      <CreateMemberDialog open={createOpen} onClose={() => setCreateOpen(false)} slug={slug} communityId={communityId} />
      {editing && <EditMemberDialog member={editing} onClose={() => setEditing(null)} slug={slug} />}
      {archiving && <ArchiveMemberDialog member={archiving} onClose={() => setArchiving(null)} slug={slug} />}
      {canInvite && <CreateInviteLinkDialog open={inviteOpen} onClose={() => setInviteOpen(false)} slug={slug} communityId={communityId} />}
    </div>
  );
}

function PendingRow({ slug, member }: { slug: string; member: Member }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-warning-bg)]/40 px-4 py-2.5">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">{member.full_name}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{member.phone_e164}</p>
        {error && <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await rejectMemberAction(slug, member.id);
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
              const result = await approveMemberAction(slug, member.id);
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

function CreateMemberDialog({ open, onClose, slug, communityId }: { open: boolean; onClose: () => void; slug: string; communityId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onClose={onClose} title="Add member">
      <form
        className="flex flex-col gap-4"
        action={(formData) =>
          startTransition(async () => {
            formData.set("communityId", communityId);
            const result = await createMemberAction(slug, formData);
            if (result.error) setError(result.error);
            else {
              setError(null);
              onClose();
            }
          })
        }
      >
        <TextField label="Full name" name="fullName" required />
        <TextField label="Phone number" name="phoneE164" placeholder="+2348012345678" />
        <TextField label="Email" name="email" type="email" />
        <TextField label="Member identifier" name="identifier" hint="Matric number, member ID, etc. Optional." />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={isPending}>
          Add member
        </Button>
      </form>
    </Dialog>
  );
}

function EditMemberDialog({ member, onClose, slug }: { member: Member; onClose: () => void; slug: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onClose={onClose} title={`Edit ${member.full_name}`}>
      <form
        className="flex flex-col gap-4"
        action={(formData) =>
          startTransition(async () => {
            formData.set("memberId", member.id);
            const result = await updateMemberAction(slug, formData);
            if (result.error) setError(result.error);
            else {
              setError(null);
              onClose();
            }
          })
        }
      >
        <TextField label="Full name" name="fullName" defaultValue={member.full_name} required />
        <TextField label="Phone number" name="phoneE164" defaultValue={member.phone_e164 ?? ""} />
        <TextField label="Email" name="email" type="email" defaultValue={member.email ?? ""} />
        <TextField label="Member identifier" name="identifier" defaultValue={member.identifier ?? ""} />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={isPending}>
          Save changes
        </Button>
      </form>
    </Dialog>
  );
}

function ArchiveMemberDialog({ member, onClose, slug }: { member: Member; onClose: () => void; slug: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onClose={onClose} title={`Archive ${member.full_name}?`} description="Their history is kept. They will no longer appear on the active roster.">
      <form
        className="flex flex-col gap-4"
        action={(formData) =>
          startTransition(async () => {
            formData.set("memberId", member.id);
            const result = await archiveMemberAction(slug, formData);
            if (result.error) setError(result.error);
            else {
              setError(null);
              onClose();
            }
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

function CreateInviteLinkDialog({ open, onClose, slug, communityId }: { open: boolean; onClose: () => void; slug: string; communityId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  return (
    <Dialog open={open} onClose={() => { setLink(null); onClose(); }} title="Create invite link">
      {link ? (
        <div className="flex flex-col gap-3">
          <Banner tone="success">Link created. Copy it now — it is shown only once.</Banner>
          <TextField label="Invite link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(link);
            }}
          >
            Copy link
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          action={(formData) =>
            startTransition(async () => {
              const approveJoiners = formData.get("approveJoiners") === "on";
              const label = (formData.get("label") as string) || undefined;
              const result = await createInviteLinkAction(slug, communityId, { approveJoiners, label });
              if (result.error) setError(result.error);
              else if (result.token) {
                setError(null);
                setLink(`${window.location.origin}/invite/${result.token}`);
              }
            })
          }
        >
          <TextField label="Label" name="label" hint="Optional, for your own reference." />
          <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
            <input type="checkbox" name="approveJoiners" className="h-4 w-4 rounded border-[var(--color-border-strong)]" />
            Require officer approval before joiners appear on the roster
          </label>
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" loading={isPending}>
            Create link
          </Button>
        </form>
      )}
    </Dialog>
  );
}

function InviteLinksSection({ slug, inviteLinks, communitySlug }: { slug: string; inviteLinks: InviteLink[]; communitySlug: string }) {
  const [isPending, startTransition] = useTransition();
  void communitySlug;

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
