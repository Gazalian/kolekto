"use client";

import { COMMUNITY_TYPES } from "@kolekto/validation";
import { useRouter } from "next/navigation";

const TYPE_LABELS: Record<(typeof COMMUNITY_TYPES)[number], string> = {
  university_association: "University association",
  fellowship: "Fellowship",
  alumni_association: "Alumni association",
  cooperative: "Cooperative",
  estate: "Estate",
  professional_association: "Professional association",
  event_committee: "Event committee",
  social_group: "Social group",
  school_pta: "School PTA",
  community_development: "Community development",
  other: "Other",
};

export function TypePicker() {
  const router = useRouter();

  return (
    <div className="grid w-full max-w-lg grid-cols-2 gap-3">
      {COMMUNITY_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => {
            const params = new URLSearchParams({ type });
            router.push(`/setup/create?${params.toString()}`);
          }}
          className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-4 py-3 text-left text-sm font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]"
        >
          {TYPE_LABELS[type]}
        </button>
      ))}
    </div>
  );
}
