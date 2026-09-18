import { JoinForm } from "./JoinForm.tsx";

export const metadata = { title: "Join" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Join the roster</h1>
        <p className="text-sm text-[var(--color-text-muted)]">Enter your details to join. No account needed.</p>
      </div>
      <JoinForm token={token} />
    </main>
  );
}
