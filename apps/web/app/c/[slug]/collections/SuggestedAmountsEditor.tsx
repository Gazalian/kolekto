"use client";

import { Button, TextField } from "@kolekto/ui";
import { Plus, Trash2 } from "lucide-react";

/**
 * The one-tap amounts an open collection offers (§26, §29).
 *
 * A suggestion is not a price. A contributor may still type any amount the
 * minimum and maximum allow, and the amount charged is resolved server-side
 * from what they send — these only save people the typing.
 */
export function SuggestedAmountsEditor({
  amounts,
  onChange,
  disabled = false,
}: {
  amounts: string[];
  onChange: (amounts: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {amounts.map((amount, index) => (
        <div key={index} className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label={`Suggestion ${index + 1}`}
              placeholder="e.g. 5000"
              value={amount}
              disabled={disabled}
              onChange={(event) => onChange(amounts.map((a, i) => (i === index ? event.target.value : a)))}
            />
          </div>
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove suggestion ${index + 1}`}
              className="mb-2 text-[var(--color-danger)] hover:opacity-80"
              onClick={() => onChange(amounts.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      ))}

      {!disabled && amounts.length < 6 && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...amounts, ""])}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add a suggested amount
        </Button>
      )}

      <p className="text-xs text-[var(--color-text-muted)]">
        Optional, up to six. Contributors can still enter any amount you allow.
      </p>
    </div>
  );
}
