import { EmptyState } from "@kolekto/ui";
import { Gift } from "lucide-react";

export const metadata = { title: "Collections" };

export default function CollectionsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[var(--color-text)]">Collections</h1>
      {/* Collection creation and the contributor payment flow are Phase 3
          (ADR 0006 gates money on DEC-01/DEC-02/DEC-03). This is the
          architectural placeholder the brief asks for, not a stub feature. */}
      <EmptyState
        icon={<Gift className="h-8 w-8" aria-hidden="true" />}
        title="Collections are coming in the next phase"
        description="Creating a collection and accepting contributions is being built on top of this foundation next."
      />
    </div>
  );
}
