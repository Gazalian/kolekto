"use client";

import type { PublicInvite } from "@kolekto/db";
import { Banner, Button, SelectField, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { redeemInviteLinkAction, type JoinResult } from "./actions.ts";

/**
 * The join form, built from the community's own member profile.
 *
 * A school asks for a matric number and a level; an estate asks for a house
 * number. Neither is hardcoded here — the fields come from the invitation,
 * which got them from `member_attribute_definitions`, and the answers are
 * stored against those same definitions.
 *
 * Required-ness is shown here and enforced in the database: the form marking a
 * field optional would not let a joiner skip one the invitation requires.
 */
export function JoinForm({
  token,
  communityName,
  fields,
  approveJoiners,
  pickableGroups,
  allowMultiGroup,
}: {
  token: string;
  communityName: string;
  fields: PublicInvite["fields"];
  approveJoiners: boolean;
  /** The groups this link lets a joiner choose from. Empty when the link does not offer a choice. */
  pickableGroups: PublicInvite["pickable_groups"];
  /** Whether more than one of `pickableGroups` may be selected. When false, choosing one clears any other. */
  allowMultiGroup: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(id: string, on: boolean): void {
    setSelectedGroups((current) => {
      if (!on) {
        const next = new Set(current);
        next.delete(id);
        return next;
      }
      // A single-choice link keeps exactly one id selected, the same way a
      // radio group would — picking a second option replaces the first
      // rather than adding to it.
      return allowMultiGroup ? new Set(current).add(id) : new Set([id]);
    });
  }

  if (joined?.memberCode) {
    return (
      <div className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          {joined.status === "pending_approval" ? "Request sent" : `Welcome to ${communityName}`}
        </h2>

        <div>
          <p className="text-sm text-[var(--color-text-muted)]">Your member ID</p>
          <p className="font-mono text-xl font-semibold text-[var(--color-text)]">{joined.memberCode}</p>
        </div>

        <p className="text-sm text-[var(--color-text-muted)]">
          {joined.status === "pending_approval"
            ? "An officer will review your details before you appear on the roster. Keep your member ID — it is how you will be found."
            : "Keep your member ID. It is how you identify yourself when contributing to a collection."}
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-4"
      action={(formData) =>
        startTransition(async () => {
          const result = await redeemInviteLinkAction(token, formData);
          if (result.error) setError(result.error);
          else setJoined(result);
        })
      }
    >
      <TextField label="Full name" name="fullName" required autoComplete="name" />
      <TextField label="Phone number" name="phoneE164" placeholder="+2348012345678" required autoComplete="tel" />
      <TextField label="Email" name="email" type="email" autoComplete="email" hint="Optional." />

      {pickableGroups.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-[var(--color-text)]">
            {allowMultiGroup ? "Which groups suit you?" : "Which group suits you?"}
          </legend>
          {pickableGroups.map((group) => (
            <label key={group.id} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
              <input
                type={allowMultiGroup ? "checkbox" : "radio"}
                name={allowMultiGroup ? undefined : "pickable-group"}
                className="h-4 w-4"
                checked={selectedGroups.has(group.id)}
                onChange={(event) => toggleGroup(group.id, event.target.checked)}
              />
              {group.name}
              {/* Hidden mirror so the value reaches FormData under one name,
                  `getAll`-able, whichever input type is rendered above. */}
              {selectedGroups.has(group.id) && <input type="hidden" name="groupId" value={group.id} />}
            </label>
          ))}
        </fieldset>
      )}

      {fields.map((field) =>
        field.type === "single_select" ? (
          <SelectField key={field.key} label={field.label} name={`attr:${field.key}`} required={field.required}>
            <option value="">Choose one</option>
            {(field.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </SelectField>
        ) : (
          <TextField
            key={field.key}
            label={field.label}
            name={`attr:${field.key}`}
            required={field.required}
            type={field.type === "date" ? "date" : "text"}
            inputMode={field.type === "number" ? "numeric" : undefined}
          />
        ),
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      <Button type="submit" loading={isPending}>
        {approveJoiners ? "Request to join" : "Join"}
      </Button>
    </form>
  );
}
