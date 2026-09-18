"use client";

import type { Community, OfficerInvitation, OfficerRole, OfficerTerm } from "@kolekto/db";
import { OFFICER_ROLES } from "@kolekto/validation";
import { Badge, Banner, Button, CheckboxField, Dialog, SelectField, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import {
  createOfficerInvitationAction,
  endOfficerTermAction,
  revokeOfficerInvitationAction,
  updateCommunityProfileAction,
} from "./actions.ts";

interface OfficerTermWithUser extends OfficerTerm {
  users: { full_name: string } | null;
}

interface Props {
  slug: string;
  community: Community;
  officers: OfficerTermWithUser[];
  invitations: OfficerInvitation[];
  canEditProfile: boolean;
  canInviteOfficers: boolean;
  canRemoveOwner: boolean;
  currentUserId: string;
}

export function SettingsClient(props: Props) {
  const [tab, setTab] = useState<"profile" | "team">("profile");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Settings</h1>

      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {(["profile", "team"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "border-b-2 px-3 py-2 text-sm font-medium capitalize " +
              (tab === t ? "border-[var(--color-primary)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)]")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "profile" ? <ProfileTab {...props} /> : <TeamTab {...props} />}
    </div>
  );
}

function ProfileTab({ slug, community, canEditProfile }: Props) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; ok?: boolean } | null>(null);

  return (
    <form
      className="flex max-w-lg flex-col gap-4"
      action={(formData) =>
        startTransition(async () => {
          formData.set("communityId", community.id);
          setResult(await updateCommunityProfileAction(slug, formData));
        })
      }
    >
      <TextField label="Community name" name="name" defaultValue={community.name} required disabled={!canEditProfile} />
      <TextField label="Description" name="description" defaultValue={community.description ?? ""} disabled={!canEditProfile} />
      <div className="grid grid-cols-2 gap-4">
        <TextField label="State" name="locationState" defaultValue={community.location_state ?? ""} disabled={!canEditProfile} />
        <TextField label="City" name="locationCity" defaultValue={community.location_city ?? ""} disabled={!canEditProfile} />
      </div>
      <TextField label="Institution" name="institution" defaultValue={community.institution ?? ""} disabled={!canEditProfile} />
      <TextField label="Contact email" name="contactEmail" type="email" defaultValue={community.contact_email ?? ""} disabled={!canEditProfile} />
      <TextField label="Contact phone" name="contactPhoneE164" defaultValue={community.contact_phone_e164 ?? ""} disabled={!canEditProfile} />
      <CheckboxField
        label="Show officers publicly"
        name="showOfficersPublicly"
        defaultChecked={community.show_officers_publicly}
        disabled={!canEditProfile}
      />
      {result?.error && <Banner tone="danger">{result.error}</Banner>}
      {result?.ok && <Banner tone="success">Saved.</Banner>}
      {canEditProfile && (
        <Button type="submit" loading={isPending} className="w-fit">
          Save changes
        </Button>
      )}
    </form>
  );
}

function TeamTab({ slug, community, officers, invitations, canInviteOfficers, canRemoveOwner, currentUserId }: Props) {
  const [inviteOpen, setInviteOpen] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Officers</h2>
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
          {officers.map((officer) => (
            <OfficerRow
              key={officer.id}
              slug={slug}
              officer={officer}
              canRemove={officer.user_id === currentUserId || (officer.role === "owner" ? canRemoveOwner : canInviteOfficers)}
              isSelf={officer.user_id === currentUserId}
            />
          ))}
        </div>
      </section>

      {canInviteOfficers && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Pending invitations</h2>
            <Button size="sm" variant="secondary" onClick={() => setInviteOpen(true)}>
              Invite officer
            </Button>
          </div>
          {invitations.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No pending invitations.</p>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
              {invitations.map((invitation) => (
                <InvitationRow key={invitation.id} slug={slug} invitation={invitation} />
              ))}
            </div>
          )}
        </section>
      )}

      {canInviteOfficers && (
        <InviteOfficerDialog open={inviteOpen} onClose={() => setInviteOpen(false)} slug={slug} communityId={community.id} />
      )}
    </div>
  );
}

function OfficerRow({
  slug,
  officer,
  canRemove,
  isSelf,
}: {
  slug: string;
  officer: OfficerTermWithUser;
  canRemove: boolean;
  isSelf: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">
          {officer.users?.full_name ?? officer.actor_name_snapshot}
          {isSelf && <span className="ml-1 text-xs text-[var(--color-text-muted)]">(you)</span>}
        </p>
        <p className="text-xs capitalize text-[var(--color-text-muted)]">{officer.title ?? officer.role}</p>
        {error && <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>}
      </div>
      {canRemove && (
        <button
          type="button"
          disabled={isPending}
          className="text-xs font-medium text-[var(--color-danger)] hover:underline"
          onClick={() =>
            startTransition(async () => {
              const result = await endOfficerTermAction(slug, officer.id, isSelf ? "Resigned" : "Removed by an officer");
              if (result.error) setError(result.error);
            })
          }
        >
          {isSelf ? "Resign" : "Remove"}
        </button>
      )}
    </div>
  );
}

function InvitationRow({ slug, invitation }: { slug: string; invitation: OfficerInvitation }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-[var(--color-text)]">{invitation.invitee_name ?? invitation.invitee_email ?? invitation.invitee_phone_e164}</p>
        <p className="text-xs capitalize text-[var(--color-text-muted)]">{invitation.role}</p>
        {error && <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>}
      </div>
      <button
        type="button"
        disabled={isPending}
        className="text-xs font-medium text-[var(--color-danger)] hover:underline"
        onClick={() =>
          startTransition(async () => {
            const result = await revokeOfficerInvitationAction(slug, invitation.id);
            if (result.error) setError(result.error);
          })
        }
      >
        Revoke
      </button>
    </div>
  );
}

function InviteOfficerDialog({ open, onClose, slug, communityId }: { open: boolean; onClose: () => void; slug: string; communityId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  return (
    <Dialog open={open} onClose={() => { setLink(null); onClose(); }} title="Invite an officer">
      {link ? (
        <div className="flex flex-col gap-3">
          <Banner tone="success">Invitation created. Share this link — it is shown only once.</Banner>
          <TextField label="Invitation link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={() => void navigator.clipboard.writeText(link)}>Copy link</Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          action={(formData) =>
            startTransition(async () => {
              const result = await createOfficerInvitationAction(slug, communityId, formData);
              if (result.error) setError(result.error);
              else if (result.token) {
                setError(null);
                setLink(`${window.location.origin}/accept-invite?token=${result.token}`);
              }
            })
          }
        >
          <SelectField label="Role" name="role" required defaultValue="">
            <option value="" disabled>
              Choose a role
            </option>
            {OFFICER_ROLES.filter((r) => r !== "owner").map((role: OfficerRole) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </SelectField>
          <TextField label="Title" name="title" hint="e.g. Financial Secretary. Optional." />
          <TextField label="Name" name="inviteeName" />
          <TextField label="Email" name="inviteeEmail" type="email" />
          <TextField label="Phone" name="inviteePhoneE164" placeholder="+2348012345678" />
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" loading={isPending}>
            Create invitation
          </Button>
        </form>
      )}
    </Dialog>
  );
}
