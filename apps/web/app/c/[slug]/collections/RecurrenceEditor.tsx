"use client";

import { SelectField, TextField } from "@kolekto/ui";
import type { RecurrenceFrequency } from "@kolekto/validation";

/**
 * How a recurring charge repeats (§32).
 *
 * A recurring collection is not "a fixed collection with a frequency". It
 * produces periods, and a member owes once per period — which is why nothing
 * here creates an obligation. Opening October and expecting people to pay for
 * October are two separate acts, and both are things an officer does on purpose.
 */
export interface RecurrenceDraft {
  frequency: RecurrenceFrequency;
  intervalCount: string;
  startsOn: string;
  dueAfterDays: string;
}

export function emptyRecurrence(): RecurrenceDraft {
  return { frequency: "monthly", intervalCount: "1", startsOn: "", dueAfterDays: "0" };
}

const EVERY_LABEL: Record<RecurrenceFrequency, string> = {
  weekly: "week",
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

export function RecurrenceEditor({
  recurrence,
  onChange,
  disabled = false,
}: {
  recurrence: RecurrenceDraft;
  onChange: (recurrence: RecurrenceDraft) => void;
  disabled?: boolean;
}) {
  const every = Number(recurrence.intervalCount) || 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="How often"
          value={recurrence.frequency}
          disabled={disabled}
          onChange={(event) => onChange({ ...recurrence, frequency: event.target.value as RecurrenceFrequency })}
        >
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="yearly">Yearly</option>
        </SelectField>
        <TextField
          label="Every"
          hint={`Every ${every} ${EVERY_LABEL[recurrence.frequency]}${every === 1 ? "" : "s"}.`}
          inputMode="numeric"
          value={recurrence.intervalCount}
          disabled={disabled}
          onChange={(event) => onChange({ ...recurrence, intervalCount: event.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First period starts"
          type="date"
          hint="Optional. Today if you leave it empty."
          value={recurrence.startsOn}
          disabled={disabled}
          onChange={(event) => onChange({ ...recurrence, startsOn: event.target.value })}
        />
        <TextField
          label="Due this many days into the period"
          hint="e.g. bill on the 1st, expect payment by the 10th → 9."
          inputMode="numeric"
          value={recurrence.dueAfterDays}
          disabled={disabled}
          onChange={(event) => onChange({ ...recurrence, dueAfterDays: event.target.value })}
        />
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Nothing is charged automatically. After publishing, you open each period yourself, and adding that period&apos;s
        obligations is a separate step — Kolekto never creates a debt while nobody is looking.
      </p>
    </div>
  );
}
