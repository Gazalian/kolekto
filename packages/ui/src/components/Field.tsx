import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, forwardRef, useId } from "react";
import { cn } from "../cn.ts";

const CONTROL_CLASSES =
  "w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] " +
  "px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] " +
  "focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] " +
  "disabled:opacity-50 disabled:cursor-not-allowed aria-[invalid=true]:border-[var(--color-danger)]";

interface FieldWrapperProps {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  htmlFor: string;
  children: ReactNode;
}

/** Wraps any control with a label, optional hint and error text — every field in the app uses this so labelling and error association (a11y section 21) happen once, not per form. */
function FieldWrapper({ label, hint, error, required, htmlFor, children }: FieldWrapperProps) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--color-text)]">
        {label}
        {required && <span className="text-[var(--color-danger)]"> *</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[var(--color-text-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, required, className, ...props },
  ref,
) {
  const id = useId();
  return (
    <FieldWrapper label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <input
        ref={ref}
        id={id}
        required={required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CONTROL_CLASSES, className)}
        {...props}
      />
    </FieldWrapper>
  );
});

export interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { label, hint, error, required, className, ...props },
  ref,
) {
  const id = useId();
  return (
    <FieldWrapper label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <textarea
        ref={ref}
        id={id}
        required={required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CONTROL_CLASSES, "min-h-24 resize-y", className)}
        {...props}
      />
    </FieldWrapper>
  );
});

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, required, className, children, ...props },
  ref,
) {
  const id = useId();
  return (
    <FieldWrapper label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <select
        ref={ref}
        id={id}
        required={required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cn(CONTROL_CLASSES, className)}
        {...props}
      >
        {children}
      </select>
    </FieldWrapper>
  );
});

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: string;
  hint?: string;
}

export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(function CheckboxField(
  { label, hint, className, ...props },
  ref,
) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          "mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)] text-[var(--color-primary)]",
          "focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]",
          className,
        )}
        {...props}
      />
      <label htmlFor={id} className="text-sm text-[var(--color-text)]">
        {label}
        {hint && <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>}
      </label>
    </div>
  );
});
