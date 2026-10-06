"use client";

import type { User } from "@kolekto/db";
import { Banner, Button, TextField } from "@kolekto/ui";
import { useActionState } from "react";
import { setPasswordAction, updateProfileAction, type SetPasswordState, type UpdateProfileState } from "./actions.ts";

const initialProfileState: UpdateProfileState = {};
const initialPasswordState: SetPasswordState = {};

export function AccountForm({ user }: { user: User }) {
  const [state, formAction, pending] = useActionState(updateProfileAction, initialProfileState);
  const [pwState, pwAction, pwPending] = useActionState(setPasswordAction, initialPasswordState);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium text-[var(--color-text)]">Profile</h2>
        <form action={formAction} className="flex flex-col gap-4">
          <TextField label="Full name" name="fullName" required defaultValue={user.full_name ?? ""} />
          <TextField label="Phone number" name="phoneE164" type="tel" defaultValue={user.phone_e164 ?? ""} />
          <TextField label="Email" type="email" value={user.email ?? ""} disabled />
          {state.error && <Banner tone="danger">{state.error}</Banner>}
          {state.success && <Banner tone="success">Profile updated.</Banner>}
          <Button type="submit" loading={pending}>
            Save changes
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium text-[var(--color-text)]">Password</h2>
        <form action={pwAction} className="flex flex-col gap-4">
          <TextField label="New password" name="password" type="password" autoComplete="new-password" required minLength={8} />
          <TextField label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} />
          {pwState.error && <Banner tone="danger">{pwState.error}</Banner>}
          {pwState.success && <Banner tone="success">Password updated.</Banner>}
          <Button type="submit" loading={pwPending}>
            Set password
          </Button>
        </form>
      </section>
    </div>
  );
}
