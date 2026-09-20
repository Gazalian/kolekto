"use client";

import { TextField } from "@kolekto/ui";

/**
 * When and where the event is (§30).
 *
 * Deliberately separate from the collection's own dates. `starts_at` and
 * `deadline_at` say when tickets are on sale; these say when the dinner is. A
 * collection that sells tickets for six weeks for one evening needs both, and
 * collapsing them would make one of the two wrong on the public page.
 */
export interface EventDraft {
  startsAt: string;
  endsAt: string;
  venue: string;
}

export function emptyEvent(): EventDraft {
  return { startsAt: "", endsAt: "", venue: "" };
}

export function EventEditor({
  event,
  onChange,
  disabled = false,
}: {
  event: EventDraft;
  onChange: (event: EventDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="When does it start?"
          type="datetime-local"
          value={event.startsAt}
          disabled={disabled}
          onChange={(e) => onChange({ ...event, startsAt: e.target.value })}
        />
        <TextField
          label="When does it end?"
          type="datetime-local"
          hint="Optional."
          value={event.endsAt}
          disabled={disabled}
          onChange={(e) => onChange({ ...event, endsAt: e.target.value })}
        />
      </div>
      <TextField
        label="Where is it?"
        placeholder="e.g. Ostrich Hall, Ilorin"
        value={event.venue}
        disabled={disabled}
        onChange={(e) => onChange({ ...event, venue: e.target.value })}
      />
      <p className="text-xs text-[var(--color-text-muted)]">
        The date and the venue can still be changed after you publish — a moved event has to be announceable. What
        a ticket costs cannot.
      </p>
    </div>
  );
}
