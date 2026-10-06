import { requireUser } from "../../lib/auth.ts";
import { AccountForm } from "./AccountForm.tsx";

export const metadata = { title: "Account settings" };

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-8 px-6 py-12">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Account settings</h1>
      <AccountForm user={user} />
    </main>
  );
}
