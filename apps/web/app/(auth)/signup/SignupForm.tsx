"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapAuthError } from "../../../lib/auth-errors.ts";
import { normalizePhone } from "../../../lib/phone.ts";
import { createClient } from "../../../lib/supabase/browser.ts";

export function SignupForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    const trimmedName = fullName.trim();
    if (!trimmedName) return "Full name is required.";
    if (trimmedName.length > 120) return "Full name must be at most 120 characters.";

    if (!email.trim()) return "Email address is required.";

    const normalized = normalizePhone(phone);
    if (!phone.trim()) return "Phone number is required.";
    if (!normalized) return "Please enter a valid Nigerian phone number (e.g. 08031234567).";

    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirmPassword) return "Passwords don't match.";

    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);

    const normalized = normalizePhone(phone)!;
    const supabase = createClient();

    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone_e164: normalized,
        },
      },
    });

    setLoading(false);

    if (signUpError) {
      setError(mapAuthError(signUpError.message));
      return;
    }

    const params = new URLSearchParams({ email: email.trim() });
    router.push(`/verify?${params.toString()}`);
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <TextField
        label="Full name"
        autoComplete="name"
        value={fullName}
        onChange={(event) => setFullName(event.target.value)}
        required
      />
      <TextField
        label="Email address"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <TextField
        label="Phone number"
        type="tel"
        placeholder="+2348031234567"
        autoComplete="tel"
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        required
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />
      <TextField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        required
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" loading={loading}>
        Create account
      </Button>
      <p className="text-center text-sm text-[var(--color-text-muted)]">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-[var(--color-primary)] hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
