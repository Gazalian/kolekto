"use client";

import { Button, CheckboxField, SelectField, TextField } from "@kolekto/ui";
import { Plus, Trash2 } from "lucide-react";

/**
 * The collection's own questions (PRD 4.3) — a house number, a shirt size, a
 * dietary requirement.
 *
 * Deliberately separate from the contributor's payment contact details, which
 * are the same three fields on every collection and are not configurable. The
 * previous system mixed the two into one structure, and organisers ended up
 * re-asking for a name and phone number inside their custom fields.
 */
export interface QuestionDraft {
  key: string;
  label: string;
  type: "text" | "number" | "single_select" | "date";
  options: string;
  required: boolean;
}

export function emptyQuestion(): QuestionDraft {
  return { key: "", label: "", type: "text", options: "", required: false };
}

/** A label becomes a key once, when the key is still empty — so renaming a question later never silently changes what its answers are stored against. */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([^a-z])/, "q_$1")
    .slice(0, 39);
}

export function QuestionsEditor({
  questions,
  onChange,
  disabled = false,
}: {
  questions: QuestionDraft[];
  onChange: (questions: QuestionDraft[]) => void;
  disabled?: boolean;
}) {
  function update(index: number, patch: Partial<QuestionDraft>): void {
    onChange(questions.map((question, i) => (i === index ? { ...question, ...patch } : question)));
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.length === 0 && (
        <p className="text-sm text-[var(--color-text-muted)]">
          No extra questions. Contributors will be asked for their name and contact details only.
        </p>
      )}

      {questions.map((question, index) => (
        <div key={index} className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Question"
              placeholder="e.g. House number"
              value={question.label}
              disabled={disabled}
              onChange={(event) =>
                update(index, {
                  label: event.target.value,
                  key: question.key || keyFromLabel(event.target.value),
                })
              }
            />
            <SelectField
              label="Answer type"
              value={question.type}
              disabled={disabled}
              onChange={(event) => update(index, { type: event.target.value as QuestionDraft["type"] })}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="single_select">Choose one</option>
              <option value="date">Date</option>
            </SelectField>
          </div>

          {question.type === "single_select" && (
            <TextField
              label="Options"
              hint="Separate each option with a comma."
              placeholder="100, 200, 300"
              value={question.options}
              disabled={disabled}
              onChange={(event) => update(index, { options: event.target.value })}
            />
          )}

          <CheckboxField
            label="Required"
            checked={question.required}
            disabled={disabled}
            onChange={(event) => update(index, { required: event.target.checked })}
          />

          {!disabled && (
            <button
              type="button"
              className="self-start text-xs font-medium text-[var(--color-danger)] hover:underline"
              onClick={() => onChange(questions.filter((_, i) => i !== index))}
            >
              <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
              Remove question
            </button>
          )}
        </div>
      ))}

      {!disabled && questions.length < 10 && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...questions, emptyQuestion()])}>
          <Plus className="h-4 w-4" aria-hidden="true" /> Add a question
        </Button>
      )}
    </div>
  );
}

/** Turns the editor's drafts into what `setCollectionFieldsSchema` expects. */
export function questionsToFields(questions: QuestionDraft[]) {
  return questions
    .filter((question) => question.label.trim() !== "")
    .map((question, index) => ({
      key: question.key || keyFromLabel(question.label),
      label: question.label.trim(),
      type: question.type,
      ...(question.type === "single_select"
        ? {
            options: question.options
              .split(",")
              .map((option) => option.trim())
              .filter((option) => option !== ""),
          }
        : {}),
      required: question.required,
      sortOrder: index,
    }));
}
