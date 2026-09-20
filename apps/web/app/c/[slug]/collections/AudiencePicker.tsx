"use client";

import type { MemberGroup } from "@kolekto/db";
import type { CollectionAudienceMode } from "@kolekto/validation";

/**
 * "Who should this collection be available to?" (§37).
 *
 * Everyone is the default, because it is the common case: a community creating
 * dues usually means its members. The other answers exist so that a collection
 * for 300 Level does not require clicking three hundred names.
 *
 * What this control decides is CONFIGURATION. Choosing "300 Level" does not
 * create an obligation for anybody — obligations are materialised separately,
 * by an officer pressing a button, so that becoming eligible never quietly
 * becomes owing money.
 */
export const AUDIENCE_LABELS: Record<CollectionAudienceMode, { title: string; description: string }> = {
  all_members: {
    title: "Everyone on the roll",
    description: "Every active member of this community is expected to contribute.",
  },
  groups: {
    title: "Specific groups",
    description: "Only members of the groups you choose — 300 Level, Block B, Youth.",
  },
  selected_members: {
    title: "Members I pick",
    description: "You choose the people one by one, after the collection is created.",
  },
  public: {
    title: "Anyone with the link",
    description: "No member list. Anyone who opens the link can contribute.",
  },
};

export function AudiencePicker({
  value,
  groups,
  selectedGroupIds,
  onChange,
  onGroupsChange,
  disabled = false,
  allowPublic = true,
}: {
  value: CollectionAudienceMode;
  groups: MemberGroup[];
  selectedGroupIds: string[];
  onChange: (mode: CollectionAudienceMode) => void;
  onGroupsChange: (groupIds: string[]) => void;
  disabled?: boolean;
  allowPublic?: boolean;
}) {
  const modes: CollectionAudienceMode[] = allowPublic
    ? ["all_members", "groups", "selected_members", "public"]
    : ["all_members", "groups", "selected_members"];

  return (
    <div className="flex flex-col gap-3">
      {modes.map((mode) => (
        <label
          key={mode}
          className={
            value === mode
              ? "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border-2 border-[var(--color-primary)] p-3"
              : "flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
          }
        >
          <input
            type="radio"
            name="audienceMode"
            value={mode}
            checked={value === mode}
            disabled={disabled}
            onChange={() => onChange(mode)}
            className="mt-1 h-4 w-4"
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-[var(--color-text)]">{AUDIENCE_LABELS[mode].title}</span>
            <span className="text-sm text-[var(--color-text-muted)]">{AUDIENCE_LABELS[mode].description}</span>
          </span>
        </label>
      ))}

      {value === "groups" && (
        <fieldset className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <legend className="text-sm font-medium text-[var(--color-text)]">Which groups?</legend>
          {groups.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              This community has no groups yet. Create one from Members first.
            </p>
          ) : (
            groups.map((group) => (
              <label key={group.id} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                  checked={selectedGroupIds.includes(group.id)}
                  disabled={disabled}
                  onChange={(event) =>
                    onGroupsChange(
                      event.target.checked
                        ? [...selectedGroupIds, group.id]
                        : selectedGroupIds.filter((id) => id !== group.id),
                    )
                  }
                />
                {group.name}
              </label>
            ))
          )}
        </fieldset>
      )}
    </div>
  );
}
