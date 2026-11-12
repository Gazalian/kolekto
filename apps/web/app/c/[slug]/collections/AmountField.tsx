"use client";

import {
  AMOUNT_MAX_WHOLE_DIGITS,
  amountWholeDigits,
  formatAmountDisplay,
  formatAmountInput,
} from "@kolekto/domain";
import { TextField, type TextFieldProps } from "@kolekto/ui";
import { nairaAmountSchema } from "@kolekto/validation";
import { useState, type KeyboardEvent } from "react";

/**
 * An amount in naira, grouped in thousands as it is typed: 1000 reads 1,000.
 *
 * The parent holds the CANONICAL value ("1234567.5" — digits, at most two
 * decimals, no separators) and this field shows the formatted one. What the
 * parent sends to the server is therefore exactly what was sent before the
 * separators existed; the server validates and converts it as it always has
 * (`nairaAmountSchema`, `fromNaira`).
 *
 * Quantities — stock, limits, counts — are not amounts and must not use this:
 * they are read with `Number()`, which cannot read "1,000".
 */
export type AmountFieldProps = Omit<
  TextFieldProps,
  "value" | "onChange" | "type" | "inputMode" | "leading" | "defaultValue"
> & {
  /** Canonical naira text, e.g. "25000" or "25000.50". */
  value: string;
  onValueChange: (value: string) => void;
};

/** The message an amount would be refused with, or undefined. Blank is not an error here — "required" is the step's business. */
export function amountError(value: string): string | undefined {
  if (value.trim() === "") return undefined;
  const parsed = nairaAmountSchema.safeParse(value);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

export function AmountField({ value, onValueChange, error, onBlur, onKeyDown, ...rest }: AmountFieldProps) {
  const [touched, setTouched] = useState(false);
  const display = formatAmountDisplay(value);

  function apply(input: HTMLInputElement, raw: string, caret: number): void {
    const next = formatAmountInput(raw, caret);

    if (amountWholeDigits(next.value) > AMOUNT_MAX_WHOLE_DIGITS) {
      // Refuse the edit outright rather than trimming digits off somewhere
      // the person is not looking.
      const back = Math.max(0, Math.min(display.length, caret - (raw.length - display.length)));
      input.value = display;
      input.setSelectionRange(back, back);
      return;
    }

    // Written straight to the element, cursor included, before React
    // re-renders: React then finds the element already showing the formatted
    // text and leaves it — and the cursor — alone.
    input.value = next.display;
    input.setSelectionRange(next.caret, next.caret);
    if (next.value !== value) onValueChange(next.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const input = event.currentTarget;
    const start = input.selectionStart;
    if (start === null || start !== input.selectionEnd) return;

    // Backspace just after a separator deletes the digit before it, and
    // Delete just before one deletes the digit after it. Without this the key
    // removes the comma, formatting puts it straight back, and nothing seems
    // to happen.
    if (event.key === "Backspace" && start > 1 && input.value[start - 1] === ",") {
      event.preventDefault();
      apply(input, input.value.slice(0, start - 2) + input.value.slice(start), start - 2);
    } else if (event.key === "Delete" && input.value[start] === ",") {
      event.preventDefault();
      apply(input, input.value.slice(0, start) + input.value.slice(start + 2), start);
    }
  }

  const shownError = error ?? (touched ? amountError(value) : undefined);

  return (
    <TextField
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      leading="₦"
      value={display}
      {...(shownError ? { error: shownError } : {})}
      onChange={(event) => {
        const input = event.currentTarget;
        apply(input, input.value, input.selectionStart ?? input.value.length);
      }}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        setTouched(true);
        // "12." is a moment in typing "12.50", not an amount.
        if (value.endsWith(".")) onValueChange(value.slice(0, -1));
        onBlur?.(event);
      }}
    />
  );
}
