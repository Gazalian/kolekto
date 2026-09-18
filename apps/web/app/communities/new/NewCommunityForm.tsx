"use client";

import { Banner, Button, SelectField, TextAreaField, TextField } from "@kolekto/ui";
import { COMMUNITY_TYPES } from "@kolekto/validation";
import { useActionState } from "react";
import { createCommunityAction, type CreateCommunityState } from "./actions.ts";

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

const initialState: CreateCommunityState = {};

export function NewCommunityForm() {
  const [state, formAction, pending] = useActionState(createCommunityAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <TextField label="Community name" name="name" required placeholder="Computer Science Students' Association" />
      <SelectField label="Type" name="type" required defaultValue="">
        <option value="" disabled>
          Choose a type
        </option>
        {COMMUNITY_TYPES.map((type) => (
          <option key={type} value={type}>
            {TYPE_LABELS[type]}
          </option>
        ))}
      </SelectField>
      <TextAreaField label="Description" name="description" hint="Optional, up to 500 characters." />
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <Button type="submit" loading={pending}>
        Create community
      </Button>
    </form>
  );
}
