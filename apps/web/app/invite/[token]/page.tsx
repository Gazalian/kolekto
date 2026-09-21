import { getPublicInvite } from "@kolekto/db";
import { JoinForm } from "./JoinForm.tsx";

export const metadata = { title: "Join" };

/**
 * The self-onboarding page (§23): community introduction, then the form that
 * community actually needs filled in.
 *
 * Everything shown here comes from `app.get_public_invite`, a whitelist for an
 * anonymous caller — the community's name, the groups this link puts people in,
 * and which fields to ask. No member data, no counts, no officer names. An
 * invitation page is not a window into the community.
 *
 * An invalid, revoked, expired or used-up link returns nothing, and all four
 * look the same from out here.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getPublicInvite(token);

  if (!invite) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-6">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">This link does not work</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          It may have expired, been used up, or been withdrawn. Ask whoever sent it for a new one.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-[var(--color-text-muted)]">You have been invited to join</p>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">{invite.community_name}</h1>
        {invite.label && <p className="text-sm text-[var(--color-text-muted)]">{invite.label}</p>}
        {invite.preset_group_names.length > 0 && (
          <p className="text-sm text-[var(--color-text-muted)]">
            You will be added to {invite.preset_group_names.join(" and ")}.
          </p>
        )}
      </div>

      <JoinForm
        token={token}
        communityName={invite.community_name}
        fields={invite.fields}
        approveJoiners={invite.approve_joiners}
        pickableGroups={invite.pickable_groups}
        allowMultiGroup={invite.allow_multi_group}
      />

      <p className="text-xs text-[var(--color-text-muted)]">
        Joining does not create a Kolekto account and asks for no password.
      </p>
    </main>
  );
}
