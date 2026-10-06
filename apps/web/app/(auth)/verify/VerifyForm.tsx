"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { createClient } from "../../../lib/supabase/browser.ts";
import { setContactVerifiedAction } from "./actions.ts";

export function VerifyForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(60);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  async function verifyCode() {
    if (!email) {
      setError("Missing email address. Please go back and sign up again.");
      return;
    }

    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });

    if (verifyError) {
      setLoading(false);
      setError(mapAuthError(verifyError.message));
      return;
    }

    await setContactVerifiedAction();

    setLoading(false);
    router.push("/welcome");
    router.refresh();
  }

  async function resendCode() {
    if (!email || resendCooldown > 0) return;

    setResending(true);
    setError(null);
    const supabase = createClient();

    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
    });

    setResending(false);
    if (resendError) {
      setError(mapAuthError(resendError.message));
      return;
    }
    setResendCooldown(60);
  }

  if (!email) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Banner tone="danger">
          No email address found. Please{" "}
          <Link href="/signup" className="underline">
            sign up
          </Link>{" "}
          first.
        </Banner>
      </div>
    );
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void verifyCode();
      }}
    >
      <p className="text-sm text-[var(--color-text-muted)]">
        We sent a 6-digit code to <span className="font-medium text-[var(--color-text)]">{email}</span>.
      </p>
      <TextField
        label="Verification code"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        required
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" loading={loading}>
        Verify
      </Button>
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => void resendCode()}
          disabled={resendCooldown > 0 || resending}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
        </button>
        <Link href="/signup" className="text-sm text-[var(--color-text-muted)] hover:underline">
          Use a different email
        </Link>
      </div>
    </form>
  );
}
