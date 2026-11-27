"use client";

import type { User } from "@kolekto/db";
import { Banner, Button, TextField } from "@kolekto/ui";
import { useActionState } from "react";
import { setPasswordAction, updateProfileAction, type SetPasswordState, type UpdateProfileState } from "./actions.ts";

const initialProfileState: UpdateProfileState = {};
const initialPasswordState: SetPasswordState = {};

/** Personal details. The name is checked against bank accounts; changing it re-opens their review (20261118100200). */
export function ProfileSection({ user }: { user: User }) {
  const [state, formAction, pending] = useActionState(updateProfileAction, initialProfileState);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="profile-heading">
      <h2 id="profile-heading" className="text-base font-semibold text-[var(--color-text)]">
        Personal information
      </h2>
      <form action={formAction} className="flex flex-col gap-4">
        <TextField
          label="Legal name"
          name="fullName"
          required
          defaultValue={user.full_name ?? ""}
          hint="Use the name on your bank account. Changing it sends your saved bank accounts back to Kolekto for a check before they can receive withdrawals."
        />
        <TextField label="Phone number" name="phoneE164" type="tel" defaultValue={user.phone_e164 ?? ""} />
        <TextField
          label="Email"
          type="email"
          value={user.email ?? ""}
          disabled
          hint="Your sign-in address. Withdrawal codes are sent here. It cannot be changed from this page."
        />
        {state.error && <Banner tone="danger">{state.error}</Banner>}
        {state.success && <Banner tone="success">Profile updated.</Banner>}
        <Button type="submit" loading={pending} className="self-start">
          Save changes
        </Button>
      </form>
    </section>
  );
}

export function PasswordSection() {
  const [pwState, pwAction, pwPending] = useActionState(setPasswordAction, initialPasswordState);

  return (
    <section className="flex flex-col gap-4" aria-labelledby="password-heading">
      <h2 id="password-heading" className="text-base font-semibold text-[var(--color-text)]">
        Password
      </h2>
      <form action={pwAction} className="flex flex-col gap-4">
        <TextField label="New password" name="password" type="password" autoComplete="new-password" required minLength={8} />
        <TextField label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} />
        {pwState.error && <Banner tone="danger">{pwState.error}</Banner>}
        {pwState.success && <Banner tone="success">Password updated.</Banner>}
        <Button type="submit" loading={pwPending} className="self-start">
          Set password
        </Button>
      </form>
    </section>
  );
}

/** Both sections, as before. */
export function AccountForm({ user }: { user: User }) {
  return (
    <div className="flex flex-col gap-8">
      <ProfileSection user={user} />
      <PasswordSection />
    </div>
  );
}
