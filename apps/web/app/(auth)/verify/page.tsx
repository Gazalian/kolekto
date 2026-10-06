import { Suspense } from "react";
import { VerifyForm } from "./VerifyForm.tsx";

export const metadata = { title: "Verify your email" };

export default function VerifyPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Verify your email</h1>
      <Suspense>
        <VerifyForm />
      </Suspense>
    </main>
  );
}
