"use client";

import type { MemberAttributeDefinition, MemberGroup } from "@kolekto/db";
import { Banner, Button, Dialog, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { createInviteLinkAction } from "./actions.ts";

/**
 * Creating an invite link (§22).
 *
 * The link carries three decisions that belong to the officer, not the joiner:
 * which groups people land in, which of the community's own fields the form
 * asks for, and which of those must be answered. All three are enforced by the
 * database at redemption — a joiner cannot pick a different group, skip a
 * required answer, or write a field the link never asked for.
 *
 * A member invite never grants a role. Officer roles come from officer
 * invitations, which are a different table and require a signed-in invitee.
 */
export function InviteLinkDialog({
  slug,
  communityId,
  definitions,
  groups,
  onClose,
}: {
  slug: string;
  communityId: string;
  definitions: MemberAttributeDefinition[];
  groups: MemberGroup[];
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [approveJoiners, setApproveJoiners] = useState(false);
  const [presetGroups, setPresetGroups] = useState<Set<string>>(new Set());
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [required, setRequired] = useState<Set<string>>(new Set());

  function toggle(set: Set<string>, id: string, on: boolean): Set<string> {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }

  if (link) {
    return (
      <Dialog open onClose={onClose} title="Invite link">
        <div className="flex flex-col gap-3">
          <Banner tone="success">Link created. Copy it now — it is shown only once.</Banner>
          <TextField label="Invite link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <Button onClick={() => void navigator.clipboard.writeText(link)}>Copy link</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create invite link"
      description="Anyone with the link can join. What it asks for, and where they land, is decided here."
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Label"
          hint="Optional, for your own reference."
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />

        {groups.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-[var(--color-text)]">Add joiners to</legend>
            <p className="text-xs text-[var(--color-text-muted)]">
              Everyone who uses this link lands in these groups.
            </p>
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                  checked={presetGroups.has(group.id)}
                  onChange={(event) => setPresetGroups((current) => toggle(current, group.id, event.target.checked))}
                />
                {group.name}
              </label>
            ))}
          </fieldset>
        )}

        {definitions.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-[var(--color-text)]">Ask joiners for</legend>
            <p className="text-xs text-[var(--color-text-muted)]">
              Your own member fields. Tick to ask; tick again to require an answer.
            </p>
            {definitions.map((definition) => (
              <div key={definition.id} className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2 text-[var(--color-text)]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-[var(--color-border-strong)]"
                    checked={asked.has(definition.key)}
                    onChange={(event) => {
                      setAsked((current) => toggle(current, definition.key, event.target.checked));
                      if (!event.target.checked) setRequired((current) => toggle(current, definition.key, false));
                    }}
                  />
                  {definition.label}
                </label>
                {asked.has(definition.key) && (
                  <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-[var(--color-border-strong)]"
                      checked={required.has(definition.key)}
                      onChange={(event) =>
                        setRequired((current) => toggle(current, definition.key, event.target.checked))
                      }
                    />
                    required
                  </label>
                )}
              </div>
            ))}
          </fieldset>
        )}

        <label className="flex items-center gap-2 text-sm text-[var(--color-text)]">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-[var(--color-border-strong)]"
            checked={approveJoiners}
            onChange={(event) => setApproveJoiners(event.target.checked)}
          />
          Require officer approval before joiners appear on the roster
        </label>

        {error && <Banner tone="danger">{error}</Banner>}

        <Button
          loading={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await createInviteLinkAction(slug, {
                communityId,
                groupIds: [...presetGroups],
                approveJoiners,
                ...(label.trim() ? { label } : {}),
                askedAttributeKeys: [...asked],
                requiredAttributeKeys: [...required],
              });
              if (result.error) setError(result.error);
              else if (result.token) {
                setError(null);
                setLink(`${window.location.origin}/invite/${result.token}`);
              }
            })
          }
        >
          Create link
        </Button>
      </div>
    </Dialog>
  );
}
