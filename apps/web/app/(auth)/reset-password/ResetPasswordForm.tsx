"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { createClient } from "../../../lib/supabase/browser.ts";

type Step = "waiting" | "password";

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sent = searchParams.get("sent") === "true";

  const [step, setStep] = useState<Step>("waiting");
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setStep("password");
      setReady(true);
    });
  }, []);

  async function updatePassword() {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setLoading(false);
      setError(mapAuthError(updateError.message));
      return;
    }

    await supabase.auth.signOut();
    router.push("/login?password_reset=success");
    router.refresh();
  }

  if (!ready) return null;

  if (step === "password") {
    return (
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void updatePassword();
        }}
      >
        <p className="text-sm text-[var(--color-text-muted)]">Choose a new password.</p>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={loading}>
          Update password
        </Button>
      </form>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      {sent ? (
        <Banner tone="info">
          Check your email for a password reset link. Click the link to set a new password.
        </Banner>
      ) : (
        <Banner tone="danger">
          No active reset session.{" "}
          <Link href="/forgot-password" className="underline">
            Request a new reset link
          </Link>
          .
        </Banner>
      )}
      <Link href="/forgot-password" className="text-center text-sm text-[var(--color-text-muted)] hover:underline">
        Request a new reset link
      </Link>
    </div>
  );
}
