import { Suspense } from "react";
import { requireUser } from "../../../../lib/auth.ts";
import { SetupCreateForm } from "./SetupCreateForm.tsx";

export const metadata = { title: "Create your community" };

export default async function SetupCreatePage() {
  await requireUser();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Name your community</h1>
      <Suspense>
        <SetupCreateForm />
      </Suspense>
    </main>
  );
}
