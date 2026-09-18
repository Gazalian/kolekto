import { requireUser } from "../../../lib/auth.ts";
import { NewCommunityForm } from "./NewCommunityForm.tsx";

export const metadata = { title: "New community" };

export default async function NewCommunityPage() {
  await requireUser();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-10">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Create a community</h1>
      <NewCommunityForm />
    </main>
  );
}
