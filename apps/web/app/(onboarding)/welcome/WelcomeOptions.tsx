"use client";

import { Banner, Button } from "@kolekto/ui";
import { Gift, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { skipOnboardingAction, startCollectionAction } from "./actions.ts";

export function WelcomeOptions() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: () => Promise<{ error?: string }>, key: string) {
    setLoading(key);
    setError(null);
    const result = await action();
    if (result?.error) {
      setError(result.error);
      setLoading(null);
    }
  }

  return (
    <div className="flex w-full max-w-lg flex-col gap-4">
      {error && <Banner tone="danger">{error}</Banner>}

      <button
        type="button"
        disabled={!!loading}
        onClick={() => void handleAction(startCollectionAction, "collection")}
        className="flex items-start gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-60"
      >
        <Gift className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
        <div>
          <p className="font-medium text-[var(--color-text)]">Create a collection</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Collect money from your class, event, association, fundraiser or group.
          </p>
        </div>
        {loading === "collection" && <Spinner />}
      </button>

      <Link
        href="/setup/type"
        className={
          "flex items-start gap-4 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]" +
          (loading ? " pointer-events-none opacity-60" : "")
        }
      >
        <Users className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
        <div>
          <p className="font-medium text-[var(--color-text)]">Set up a community</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Manage members, groups, officers and multiple collections.
          </p>
        </div>
      </Link>

      <div className="pt-2 text-center">
        <Button
          type="button"
          variant="ghost"
          disabled={!!loading}
          loading={loading === "later"}
          onClick={() => void handleAction(skipOnboardingAction, "later")}
        >
          Do this later
        </Button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="ml-auto h-5 w-5 shrink-0 animate-spin text-[var(--color-primary)]"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
