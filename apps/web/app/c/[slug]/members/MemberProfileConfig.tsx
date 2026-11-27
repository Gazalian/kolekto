"use client";

import type { MemberAttributeDefinition } from "@kolekto/db";
import { Banner, Button, CheckboxField, Dialog, SelectField, TextField } from "@kolekto/ui";
import { parseFieldOptions } from "@kolekto/validation";
import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { deleteMemberFieldAction, saveMemberFieldAction } from "./actions.ts";

/**
 * What this community records about its members (§1–§6): what it already
 * calls them — a matric number, a house number — plus anything else it needs
 * to record. One field can be marked as the one that identifies a person, and
 * that one has to be unique.
 *
 * Kolekto's own Member ID format (KWASU/0021) lives with the private
 * membership ID in "IDs & access" (MemberIdsPanel.tsx).
 */
export function MemberProfileConfig({
  slug,
  communityId,
  definitions,
  fieldValueCounts,
  onClose,
}: {
  slug: string;
  communityId: string;
  definitions: MemberAttributeDefinition[];
  fieldValueCounts: Record<string, number>;
  onClose: () => void;
}) {
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [editing, setEditing] = useState<MemberAttributeDefinition | "new" | null>(null);
  const [deleting, setDeleting] = useState<MemberAttributeDefinition | null>(null);

  // One dialog at a time rather than a dialog inside a dialog: the Dialog
  // component gives its title a fixed element id, so two open at once would put
  // duplicate ids in the document and leave both with the same accessible name.
  if (deleting) {
    return (
      <DeleteFieldConfirmation
        slug={slug}
        definition={deleting}
        valueCount={fieldValueCounts[deleting.id] ?? 0}
        onCancel={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          setMessage({ tone: "success", text: `"${deleting.label}" removed.` });
        }}
        onError={(errorMessage) => {
          setDeleting(null);
          setMessage({ tone: "danger", text: errorMessage });
        }}
      />
    );
  }

  if (editing) {
    return (
      <FieldEditor
        slug={slug}
        communityId={communityId}
        definition={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          setMessage({ tone: "success", text: "Field saved." });
        }}
      />
    );
  }

  return (
    <Dialog open onClose={onClose} title="Member profile" description="What this community records about each member.">
      <div className="flex flex-col gap-6">
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Member fields</h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                What this community records about a member, beyond name and contact details.
              </p>
            </div>
            {definitions.length < 10 && (
              <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
                Add field
              </Button>
            )}
          </div>

          {definitions.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No fields yet. A school might add a matric number and a level; an estate, a house number and a block.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {definitions.map((definition) => (
                <li
                  key={definition.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
                >
                  <div>
                    <p className="text-sm font-medium text-[var(--color-text)]">
                      {definition.label}
                      {definition.is_primary_identifier && (
                        <span className="ml-2 text-xs font-normal text-[var(--color-primary)]">
                          identifies members
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      <span className="font-mono">{definition.key}</span> · {definition.type.replace("_", " ")}
                      {definition.is_unique && " · unique"}
                      {definition.required_at_join && " · required when joining"}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline"
                      onClick={() => setEditing(definition)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                      onClick={() => setDeleting(definition)}
                    >
                      <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </Dialog>
  );
}

function FieldEditor({
  slug,
  communityId,
  definition,
  onClose,
  onSaved,
}: {
  slug: string;
  communityId: string;
  definition: MemberAttributeDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(definition?.label ?? "");
  const [key, setKey] = useState(definition?.key ?? "");
  const [type, setType] = useState<MemberAttributeDefinition["type"]>(definition?.type ?? "text");
  const [options, setOptions] = useState((definition?.options ?? []).join(", "));
  const [isUnique, setIsUnique] = useState(definition?.is_unique ?? false);
  const [isPrimary, setIsPrimary] = useState(definition?.is_primary_identifier ?? false);
  const [requiredAtJoin, setRequiredAtJoin] = useState(definition?.required_at_join ?? false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // The key is what stored answers are filed under, so it is derived from the
  // label once and then fixed — renaming a field's label is presentation;
  // renaming its key would orphan every answer already given.
  function onLabelChange(value: string): void {
    setLabel(value);
    if (!definition && key === "") return;
    if (!definition) {
      setKey(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 39),
      );
    }
  }

  return (
    <Dialog open onClose={onClose} title={definition ? `Edit ${definition.label}` : "Add member field"}>
      <div className="flex flex-col gap-4">
        <TextField
          label="Label"
          placeholder="House number"
          value={label}
          onChange={(event) => {
            onLabelChange(event.target.value);
            if (!definition && event.target.value !== "" && key === "") {
              setKey(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
            }
          }}
          required
        />

        <TextField
          label="Key"
          hint={definition ? "Fixed once created — answers are stored against it." : "Used internally. Set once."}
          value={key}
          disabled={definition !== null}
          onChange={(event) => setKey(event.target.value)}
        />

        <SelectField
          label="Answer type"
          value={type}
          onChange={(event) => setType(event.target.value as MemberAttributeDefinition["type"])}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="single_select">Choose one</option>
          <option value="date">Date</option>
        </SelectField>

        {type === "single_select" && (
          <TextField
            label="Options"
            hint="Separate each option with a comma."
            placeholder="100, 200, 300"
            value={options}
            onChange={(event) => setOptions(event.target.value)}
          />
        )}

        <CheckboxField
          label="Must be unique"
          hint="No two members in this community can share a value."
          checked={isUnique}
          onChange={(event) => {
            setIsUnique(event.target.checked);
            if (!event.target.checked) setIsPrimary(false);
          }}
        />

        <CheckboxField
          label="This field identifies a member"
          hint="Used for search, duplicate checks, and for a contributor finding themselves. Only one field can do this."
          checked={isPrimary}
          onChange={(event) => {
            setIsPrimary(event.target.checked);
            if (event.target.checked) setIsUnique(true);
          }}
        />

        <CheckboxField
          label="Required when joining"
          checked={requiredAtJoin}
          onChange={(event) => setRequiredAtJoin(event.target.checked)}
        />

        {error && <Banner tone="danger">{error}</Banner>}

        <Button
          loading={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await saveMemberFieldAction(slug, {
                communityId,
                ...(definition ? { definitionId: definition.id } : {}),
                key,
                label,
                type,
                ...(type === "single_select" ? { options: parseFieldOptions(options) } : {}),
                requiredAtJoin,
                isUnique,
                isPrimaryIdentifier: isPrimary,
                sortOrder: definition?.sort_order ?? 0,
              });
              if (result.error) setError(result.error);
              else onSaved();
            })
          }
        >
          {definition ? "Save field" : "Add field"}
        </Button>
      </div>
    </Dialog>
  );
}

function DeleteFieldConfirmation({
  slug,
  definition,
  valueCount,
  onCancel,
  onDeleted,
  onError,
}: {
  slug: string;
  definition: MemberAttributeDefinition;
  valueCount: number;
  onCancel: () => void;
  onDeleted: () => void;
  onError: (message: string) => void;
}) {
  const [isPending, startTransition] = useTransition();

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Remove "${definition.label}"?`}
      description="This cannot be undone."
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-text)]">
          {valueCount > 0 ? (
            <>
              <strong>{valueCount}</strong> member{valueCount === 1 ? " has" : "s have"} a value
              recorded for this field. Removing the field deletes all of those values permanently.
            </>
          ) : (
            <>No members have a value for this field yet, so nothing else will be lost.</>
          )}
        </p>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={isPending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteMemberFieldAction(slug, definition.id);
                if (result.error) onError(result.error);
                else onDeleted();
              })
            }
          >
            Remove field
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
