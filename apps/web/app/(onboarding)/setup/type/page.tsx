import { requireUser } from "../../../../lib/auth.ts";
import { TypePicker } from "./TypePicker.tsx";

export const metadata = { title: "Choose community type" };

export default async function SetupTypePage() {
  await requireUser();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">What kind of community are you setting up?</h1>
      <TypePicker />
    </main>
  );
}
