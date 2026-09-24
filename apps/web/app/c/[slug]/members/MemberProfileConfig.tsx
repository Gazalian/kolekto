"use client";

import type { CommunityMemberCodeSettings, MemberAttributeDefinition } from "@kolekto/db";
import { Banner, Button, CheckboxField, Dialog, SelectField, TextField } from "@kolekto/ui";
import { parseFieldOptions } from "@kolekto/validation";
import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { deleteMemberFieldAction, saveMemberCodeSettingsAction, saveMemberFieldAction } from "./actions.ts";

/**
 * How this community identifies its own members (§1–§6).
 *
 * Two separate things, and the panel keeps them separate because they answer
 * different questions:
 *
 *   Member ID    what Kolekto calls this person — KWASU/0021. Issued by the
 *                database, one per member, never reused.
 *   Member fields what the community already calls them — a matric number, a
 *                house number, a membership number — plus anything else it
 *                needs to record. One of them can be marked as the field that
 *                identifies a person, and that one has to be unique.
 */
export function MemberProfileConfig({
  slug,
  communityId,
  definitions,
  codeSettings,
  memberCount,
  onClose,
}: {
  slug: string;
  communityId: string;
  definitions: MemberAttributeDefinition[];
  codeSettings: CommunityMemberCodeSettings | null;
  memberCount: number;
  onClose: () => void;
}) {
  const [prefix, setPrefix] = useState(codeSettings?.prefix ?? "");
  const [padding, setPadding] = useState(String(codeSettings?.padding ?? 4));
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [editing, setEditing] = useState<MemberAttributeDefinition | "new" | null>(null);
  const [isPending, startTransition] = useTransition();

  const nextNumber = codeSettings?.next_number ?? 1;
  const preview = `${prefix}${String(nextNumber).padStart(Number(padding) || 4, "0")}`;

  // One dialog at a time rather than a dialog inside a dialog: the Dialog
  // component gives its title a fixed element id, so two open at once would put
  // duplicate ids in the document and leave both with the same accessible name.
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
    <Dialog open onClose={onClose} title="Member profile" description="How this community identifies its members.">
      <div className="flex flex-col gap-6">
        {message && <Banner tone={message.tone}>{message.text}</Banner>}

        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Member ID format</h3>
            <p className="text-xs text-[var(--color-text-muted)]">
              Every member gets one automatically. Changing the format affects IDs issued from now on — the{" "}
              {memberCount} already issued keep theirs.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Prefix"
              placeholder="KWASU/"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
            <TextField
              label="Digits"
              inputMode="numeric"
              value={padding}
              onChange={(event) => setPadding(event.target.value)}
            />
          </div>

          <p className="text-sm text-[var(--color-text-muted)]">
            Next member will be <span className="font-mono text-[var(--color-text)]">{preview}</span>
          </p>

          <Button
            variant="secondary"
            size="sm"
            loading={isPending}
            onClick={() =>
              startTransition(async () => {
                const result = await saveMemberCodeSettingsAction(slug, {
                  communityId,
                  prefix,
                  padding: Number(padding) || 4,
                });
                setMessage(
                  result.error
                    ? { tone: "danger", text: result.error }
                    : { tone: "success", text: "Member ID format saved." },
                );
              })
            }
          >
            Save ID format
          </Button>
        </section>

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
                      disabled={isPending}
                      className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                      onClick={() =>
                        startTransition(async () => {
                          const result = await deleteMemberFieldAction(slug, definition.id);
                          if (result.error) setMessage({ tone: "danger", text: result.error });
                        })
                      }
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
