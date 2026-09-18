import { Banner } from "@kolekto/ui";
import { requireUser } from "../../lib/auth.ts";
import { AcceptInviteForm } from "./AcceptInviteForm.tsx";

export const metadata = { title: "Officer invitation" };

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await requireUser();
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
        <Banner tone="danger">This invitation link is missing its token.</Banner>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Officer invitation</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Accepting adds this role to your account, effective immediately. Declining discards the invitation.
        </p>
      </div>
      <AcceptInviteForm token={token} />
    </main>
  );
}
