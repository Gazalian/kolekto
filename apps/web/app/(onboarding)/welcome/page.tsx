import { requireUser } from "../../../lib/auth.ts";
import { WelcomeOptions } from "./WelcomeOptions.tsx";

export const metadata = { title: "Welcome to Kolekto" };

export default async function WelcomePage() {
  const user = await requireUser();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">
          Welcome, {user.full_name?.split(" ")[0] ?? "there"}!
        </h1>
        <p className="mt-2 max-w-md text-[var(--color-text-muted)]">What would you like to do first?</p>
      </div>
      <WelcomeOptions />
    </main>
  );
}
