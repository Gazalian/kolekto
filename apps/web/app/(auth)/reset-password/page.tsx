import { Suspense } from "react";
import { ResetPasswordForm } from "./ResetPasswordForm.tsx";

export const metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Set a new password</h1>
      <Suspense>
        <ResetPasswordForm />
      </Suspense>
    </main>
  );
}
