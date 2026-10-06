import { Suspense } from "react";
import { ForgotPasswordForm } from "./ForgotPasswordForm.tsx";

export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Reset your password</h1>
      <Suspense>
        <ForgotPasswordForm />
      </Suspense>
    </main>
  );
}
