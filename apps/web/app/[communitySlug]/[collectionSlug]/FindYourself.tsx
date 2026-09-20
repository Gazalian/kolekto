"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import { Search } from "lucide-react";
import { useState, useTransition } from "react";
import {
  confirmMemberAction,
  findMemberAction,
  forgetMemberAction,
  type MemberContextResult,
  type MemberLookupResult,
} from "./actions.ts";

/**
 * "Find yourself" — how a contributor proves which member of a community they
 * are, without an account (§3–§5).
 *
 * The shape of this screen is a security decision, not a design one:
 *
 *   · One box. The person types what they already know — their member ID, the
 *     community's identifier, their phone, or their full name. There is no
 *     browse, no list, and no "show all members".
 *   · One result, or none, or a count. When several people answer to a name,
 *     this screen shows a number and asks for something more specific. It never
 *     shows candidates, because a list of people who share a name is a list of
 *     somebody else's neighbours.
 *   · The confirmation is explicit. Kolekto says who it thinks you are; you say
 *     yes. Nothing about what you owe appears until you have.
 *
 * The member's id is never in this component. The server sets a signed httpOnly
 * cookie and re-checks it on every call — so nothing on this page can decide to
 * be somebody else.
 */

export interface IdentifiedMember {
  fullName: string;
  memberCode: string | null;
  identifierLabel: string | null;
  identifierValue: string | null;
  cycleLabel: string | null;
  cycleKey: string | null;
  expectedAmount: string | null;
  waivedAmount: string | null;
  obligationStatus: string | null;
  dueAt: string | null;
}

export function FindYourself({
  communitySlug,
  collectionSlug,
  organiser,
  onIdentified,
}: {
  communitySlug: string;
  collectionSlug: string;
  organiser: string;
  onIdentified: (member: IdentifiedMember) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<MemberLookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function search(): void {
    setError(null);
    startTransition(async () => {
      const found = await findMemberAction(communitySlug, collectionSlug, query);
      if (found.status === "error") {
        setError(found.error ?? "That search could not be completed.");
        setResult(null);
        return;
      }
      setResult(found);
    });
  }

  function confirm(): void {
    setError(null);
    startTransition(async () => {
      const confirmed: MemberContextResult = await confirmMemberAction(communitySlug, collectionSlug);
      if (confirmed.error || !confirmed.member) {
        setError(confirmed.error ?? "That could not be confirmed. Search again.");
        setResult(null);
        return;
      }
      onIdentified(confirmed.member);
    });
  }

  function reject(): void {
    startTransition(async () => {
      await forgetMemberAction();
      setResult(null);
      setQuery("");
    });
  }

  const identifierHint = result?.identifierLabel ?? result?.candidate?.identifierLabel ?? null;

  return (
    <section className="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-[var(--color-text)]">Find yourself on the list</h2>
        <p className="text-sm text-[var(--color-text-muted)]">
          {organiser} is collecting this from a list of members. Enter your
          {identifierHint ? ` ${identifierHint.toLowerCase()}, ` : " "}
          member ID, phone number or full name to continue.
        </p>
      </div>

      {result?.status !== "one" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <TextField
            label="Your member ID, identifier, phone or name"
            placeholder="e.g. KWASU/0001"
            value={query}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" loading={isPending} disabled={query.trim().length < 3}>
            <Search className="h-4 w-4" aria-hidden="true" /> Find me
          </Button>
        </form>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      {result?.status === "none" && (
        <Banner tone="info">
          Nobody on this list matches that. Check what you typed, or ask {organiser} for your member ID.
        </Banner>
      )}

      {result?.status === "many" && (
        <Banner tone="info">
          {result.matchCount} people on this list match that.{" "}
          {identifierHint
            ? `Enter your ${identifierHint.toLowerCase()} or your member ID instead — those are unique to you.`
            : "Enter your member ID or phone number instead — those are unique to you."}
        </Banner>
      )}

      {result?.status === "one" && result.candidate && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Is this you?</p>
            <p className="text-lg font-semibold text-[var(--color-text)]">{result.candidate.fullName}</p>
            <dl className="flex flex-col gap-1 text-sm">
              {result.candidate.memberCode && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Member ID</dt>
                  <dd className="font-medium text-[var(--color-text)]">{result.candidate.memberCode}</dd>
                </div>
              )}
              {result.candidate.identifierLabel && result.candidate.identifierValue && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">{result.candidate.identifierLabel}</dt>
                  <dd className="font-medium text-[var(--color-text)]">{result.candidate.identifierValue}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button loading={isPending} onClick={confirm}>
              Yes, this is me
            </Button>
            <Button variant="secondary" disabled={isPending} onClick={reject}>
              No, search again
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
