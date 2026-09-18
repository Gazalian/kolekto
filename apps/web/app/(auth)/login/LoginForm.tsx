"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { createClient } from "../../../lib/supabase/browser.ts";

type Channel = "email" | "phone";

/**
 * Email or phone OTP (ADR: "the invitee signs in with OTP and accepts";
 * supabase/config.toml enables both). Phone is present but untestable in
 * this environment — the local stack has no SMS provider configured
 * (`supabase status` disables phone login without one) — the code path is
 * identical to email's and will work once a provider is configured for
 * staging/production (DEC-17).
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/communities";

  const [channel, setChannel] = useState<Channel>("email");
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: sendError } =
      channel === "email"
        ? await supabase.auth.signInWithOtp({ email: identifier, options: { shouldCreateUser: true } })
        : await supabase.auth.signInWithOtp({ phone: identifier, options: { shouldCreateUser: true } });
    setLoading(false);
    if (sendError) {
      setError(sendError.message);
      return;
    }
    setSent(true);
  }

  async function verifyCode() {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error: verifyError } =
      channel === "email"
        ? await supabase.auth.verifyOtp({ email: identifier, token: code, type: "email" })
        : await supabase.auth.verifyOtp({ phone: identifier, token: code, type: "sms" });
    setLoading(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  if (sent) {
    return (
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void verifyCode();
        }}
      >
        <p className="text-sm text-[var(--color-text-muted)]">
          Enter the code sent to <span className="font-medium text-[var(--color-text)]">{identifier}</span>.
        </p>
        <TextField
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" loading={loading}>
          Verify and sign in
        </Button>
        <Button type="button" variant="ghost" onClick={() => setSent(false)}>
          Use a different {channel === "email" ? "email address" : "phone number"}
        </Button>
      </form>
    );
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void sendCode();
      }}
    >
      <div className="flex gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] p-1 text-sm">
        {(["email", "phone"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setChannel(option);
              setIdentifier("");
            }}
            className={
              "flex-1 rounded-[var(--radius-sm)] py-1.5 font-medium transition-colors " +
              (channel === option ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "text-[var(--color-text-muted)]")
            }
          >
            {option === "email" ? "Email" : "Phone"}
          </button>
        ))}
      </div>
      {channel === "email" ? (
        <TextField
          label="Email address"
          type="email"
          autoComplete="email"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
        />
      ) : (
        <TextField
          label="Phone number"
          type="tel"
          placeholder="+2348012345678"
          autoComplete="tel"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
        />
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" loading={loading}>
        Send code
      </Button>
    </form>
  );
}
