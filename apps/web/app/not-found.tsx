import { Button } from "@kolekto/ui";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Page not found</h1>
      <p className="max-w-sm text-sm text-[var(--color-text-muted)]">
        This page does not exist, or you do not have access to it.
      </p>
      <Link href="/communities">
        <Button variant="secondary">Back to your communities</Button>
      </Link>
    </main>
  );
}
