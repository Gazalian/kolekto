import { Suspense } from "react";
import { SignupForm } from "./SignupForm.tsx";

export const metadata = { title: "Create your Kolekto account" };

export default function SignupPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Create your Kolekto account</h1>
      <Suspense>
        <SignupForm />
      </Suspense>
    </main>
  );
}
