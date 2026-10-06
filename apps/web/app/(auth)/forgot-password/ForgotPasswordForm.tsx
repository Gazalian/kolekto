"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { createClient } from "../../../lib/supabase/browser.ts";

export function ForgotPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const urlError = searchParams.get("error");
    if (urlError) setError(urlError);
  }, [searchParams]);

  async function handleSubmit() {
    console.log("[DEBUG forgot-password] handleSubmit called, email:", email.trim());
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      console.log("[DEBUG forgot-password] supabase client created");

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });

      console.log("[DEBUG forgot-password] resetPasswordForEmail returned, error:", resetError);
      setLoading(false);
      if (resetError) {
        setError(mapAuthError(resetError.message));
        return;
      }

      console.log("[DEBUG forgot-password] calling router.push /reset-password?sent=true");
      router.push("/reset-password?sent=true");
      console.log("[DEBUG forgot-password] router.push called");
    } catch (err) {
      console.error("[DEBUG forgot-password] CAUGHT EXCEPTION:", err);
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
