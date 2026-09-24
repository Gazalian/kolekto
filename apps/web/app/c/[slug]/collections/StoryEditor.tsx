"use client";

import { TextAreaField } from "@kolekto/ui";

/**
 * A fundraiser's story (§5/§19) — three guided prompts rather than one blank
 * description textarea, so a campaign reads as a campaign rather than "fixed
 * collection + description + target field" (the previous experience's own
 * shape, described verbatim in the milestone brief).
 *
 * Structure kept from the legacy fundraising wizard (see the audit doc,
 * docs/history/2026-09-21-…), because it produced a more readable page than
 * one free-text box: what it is for, why it matters, what it funds.
 */
export interface StoryDraft {
  what: string;
  why: string;
  impact: string;
}

export function emptyStory(): StoryDraft {
  return { what: "", why: "", impact: "" };
}

export function StoryEditor({
  story,
  onChange,
  disabled = false,
}: {
  story: StoryDraft;
  onChange: (story: StoryDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <TextAreaField
        label="What is this for?"
        hint="Clearly explain what you are raising money for and how it will be used."
        placeholder="We are raising funds to rebuild the health post on Sobi Road…"
        value={story.what}
        disabled={disabled}
        onChange={(event) => onChange({ ...story, what: event.target.value })}
      />
      <TextAreaField
        label="Why does this matter?"
        hint="The reason behind it — donors give to causes they understand."
        placeholder="The nearest clinic is now forty minutes away, and it is the only one for six streets…"
        value={story.why}
        disabled={disabled}
        onChange={(event) => onChange({ ...story, why: event.target.value })}
      />
      <TextAreaField
        label="What will donations fund?"
        hint="Concrete outcomes a donor can expect from their contribution."
        placeholder="₦500,000 roofs the building, ₦1,200,000 fits it out, ₦2,000,000 staffs it for a year…"
        value={story.impact}
        disabled={disabled}
        onChange={(event) => onChange({ ...story, impact: event.target.value })}
      />
      <p className="text-xs text-[var(--color-text-muted)]">
        All optional, but a campaign with a clear story reads as a campaign rather than a generic collection.
      </p>
    </div>
  );
}
