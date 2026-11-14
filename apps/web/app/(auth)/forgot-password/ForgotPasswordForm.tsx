"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { createClient } from "../../../lib/supabase/browser.ts";

export function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  // Seed from the URL once (e.g. an error bounced back via ?error=…). Reading
  // it in the initializer avoids a setState-in-effect re-render (lint rule
  // react-hooks/set-state-in-effect); the param is only ever set on the
  // redirect that lands here, so it never needs re-reading after mount.
  const [error, setError] = useState<string | null>(() => searchParams.get("error"));

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });

      setLoading(false);
      if (resetError) {
        setError(mapAuthError(resetError.message));
        return;
      }

      router.push("/reset-password?sent=true");
    } catch {
      setLoading(false);
      setError("An unexpected error occurred. Please try again.");
    }
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <p className="text-sm text-[var(--color-text-muted)]">
        Enter your email and we&apos;ll send you a link to reset your password.
      </p>
      <TextField
        label="Email address"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" loading={loading}>
        Send reset link
      </Button>
      <Link href="/login" className="text-center text-sm text-[var(--color-text-muted)] hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
