import { Button } from "@kolekto/ui";
import Link from "next/link";
import { getCurrentUser } from "../lib/auth.ts";

export default async function HomePage() {
  const user = await getCurrentUser();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">Kolekto</h1>
        <p className="max-w-md text-sm text-[var(--color-text-muted)]">
          Collect money from your community, track every contribution, and manage the collection from one place.
        </p>
      </div>
      <Link href={user ? "/communities" : "/login"}>
        <Button size="lg">{user ? "Go to your communities" : "Sign in"}</Button>
      </Link>
    </main>
  );
}
