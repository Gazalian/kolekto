"use client";

import { Button, ErrorState } from "@kolekto/ui";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <ErrorState
        description="An unexpected error happened. Nothing was silently retried or hidden."
        action={
          <Button onClick={reset} variant="secondary">
            Try again
          </Button>
        }
      />
    </main>
  );
}
