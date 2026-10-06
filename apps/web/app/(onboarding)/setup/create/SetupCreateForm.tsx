"use client";

import { Banner, Button, TextAreaField, TextField } from "@kolekto/ui";
import { COMMUNITY_TYPES } from "@kolekto/validation";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { setupCreateCommunityAction, type SetupCreateState } from "./actions.ts";

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

const initialState: SetupCreateState = {};

export function SetupCreateForm() {
  const searchParams = useSearchParams();
  const type = searchParams.get("type") as (typeof COMMUNITY_TYPES)[number] | null;
  const validType = type && (COMMUNITY_TYPES as readonly string[]).includes(type) ? type : null;

  const [state, formAction, pending] = useActionState(setupCreateCommunityAction, initialState);

  if (!validType) {
    return (
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Banner tone="danger">
          No community type selected. Please{" "}
          <Link href="/setup/type" className="underline">
            go back
          </Link>{" "}
          and choose one.
        </Banner>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
      <input type="hidden" name="type" value={validType} />
      <p className="text-sm text-[var(--color-text-muted)]">
        Type: <span className="font-medium text-[var(--color-text)]">{TYPE_LABELS[validType]}</span>{" "}
        <Link href="/setup/type" className="text-[var(--color-primary)] hover:underline">
          Change
        </Link>
      </p>
      <TextField label="Community name" name="name" required placeholder="Ikoyi Residents Association" />
      <TextAreaField label="Description" name="description" hint="Optional, up to 500 characters." />
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <Button type="submit" loading={pending}>
        Create community
      </Button>
    </form>
  );
}
