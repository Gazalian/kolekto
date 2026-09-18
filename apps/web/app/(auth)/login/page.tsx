import { Suspense } from "react";
import { LoginForm } from "./LoginForm.tsx";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Sign in to Kolekto</h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
