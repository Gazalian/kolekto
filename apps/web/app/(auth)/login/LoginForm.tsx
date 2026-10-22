"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { safeRedirectPath } from "../../../lib/safe-redirect.ts";
import { createClient } from "../../../lib/supabase/browser.ts";

type Mode = "password" | "otp";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeRedirectPath(searchParams.get("next"));
  const passwordReset = searchParams.get("password_reset") === "success";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // OTP state. Email channel only: phone OTP is inert without an SMS provider
  // (DEC-17), and signup stores the phone on public.users, not auth.users, so
  // signInWithOtp({ phone }) could never match an email+password account.
  const [otpIdentifier, setOtpIdentifier] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePasswordLogin() {
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    setLoading(false);
    if (signInError) {
      setError(mapAuthError(signInError.message));
      return;
    }
    router.push(next);
    router.refresh();
  }

  async function sendOtpCode() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: otpIdentifier.trim(),
      options: { shouldCreateUser: false },
    });
    setLoading(false);
    if (sendError) {
      setError(mapAuthError(sendError.message));
      return;
    }
    setOtpSent(true);
  }

  async function verifyOtpCode() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: otpIdentifier.trim(),
      token: otpCode,
      type: "email",
    });
    setLoading(false);
    if (verifyError) {
      setError(mapAuthError(verifyError.message));
      return;
    }
    router.push(next);
    router.refresh();
  }

  // OTP verification screen
  if (mode === "otp" && otpSent) {
    return (
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void verifyOtpCode();
        }}
      >
        <p className="text-sm text-[var(--color-text-muted)]">
          Enter the code sent to <span className="font-medium text-[var(--color-text)]">{otpIdentifier}</span>.
        </p>
        <TextField
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={otpCode}
          onChange={(event) => setOtpCode(event.target.value)}
          required
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={loading}>
          Verify and sign in
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setOtpSent(false);
            setOtpCode("");
            setError(null);
          }}
        >
          Use a different email address
        </Button>
      </form>
    );
  }

  // OTP send screen
  if (mode === "otp") {
    return (
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void sendOtpCode();
        }}
      >
        <TextField
          label="Email address"
          type="email"
          autoComplete="email"
          value={otpIdentifier}
          onChange={(event) => setOtpIdentifier(event.target.value)}
          required
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={loading}>
          Send code
        </Button>
        <button
          type="button"
          onClick={() => {
            setMode("password");
            setError(null);
          }}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Sign in with password
        </button>
        <p className="text-center text-sm text-[var(--color-text-muted)]">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-[var(--color-primary)] hover:underline">
            Create account
          </Link>
        </p>
      </form>
    );
  }

  // Password login (default)
  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handlePasswordLogin();
      }}
    >
      {passwordReset && <Banner tone="success">Password updated. Sign in with your new password.</Banner>}
      <TextField
        label="Email address"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" loading={loading}>
        Sign in
      </Button>
      <Link href="/forgot-password" className="text-center text-sm text-[var(--color-text-muted)] hover:underline">
        Forgot password?
      </Link>
      <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
        <span className="h-px flex-1 bg-[var(--color-border)]" />
        OR
        <span className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setMode("otp");
          setError(null);
        }}
      >
        Sign in with OTP
      </Button>
      <p className="text-center text-sm text-[var(--color-text-muted)]">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-medium text-[var(--color-primary)] hover:underline">
          Create account
        </Link>
      </p>
    </form>
  );
}
