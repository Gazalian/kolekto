"use client";

import { Badge, Banner, Button, Card, CardBody, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkInAction, checkOutAction } from "./check-in-actions.ts";

/**
 * The door (M7.5 part E).
 *
 * Built for a phone held by somebody standing at an entrance with a queue
 * behind them, not for an admin table: one search box, big rows, one button
 * per row, and the state of each person visible without opening anything.
 *
 * WHO IS ON THIS LIST. The collection's own roll — the members an officer
 * added to it. No purchase is recorded anywhere in this phase (ADR
 * 0006/0012), so a public ticket sale has nobody here yet and says so
 * plainly rather than showing an empty table that looks broken.
 */

export interface CheckInPerson {
  obligationId: string;
  name: string;
  identifier: string | null;
  /** The most recent visit, if any. */
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function CheckInPanel({
  slug,
  collectionSlug,
  people,
  canCheckIn,
}: {
  slug: string;
  collectionSlug: string;
  people: CheckInPerson[];
  canCheckIn: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const inside = people.filter((person) => person.checkedInAt && !person.checkedOutAt);
  const left = people.filter((person) => person.checkedOutAt);
  const notYet = people.filter((person) => !person.checkedInAt);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? people.filter(
        (person) =>
          person.name.toLowerCase().includes(needle) || (person.identifier ?? "").toLowerCase().includes(needle),
      )
    : people;

  function run(person: CheckInPerson, direction: "in" | "out"): void {
    setError(null);
    setBusyId(person.obligationId);
    startTransition(async () => {
      const result =
        direction === "in"
          ? await checkInAction(slug, collectionSlug, person.obligationId)
          : await checkOutAction(slug, collectionSlug, person.obligationId);
      setBusyId(null);
      if (result.error) setError(result.error);
      else router.refresh();
    });
  }

  if (people.length === 0) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Check-in</h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            Nobody is on this collection&apos;s list yet. Add the people you expect under Members, and they appear here to
            check in at the door.
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            Tickets bought online are not recorded yet — online payment is not switched on — so a public ticket sale
            has nobody to check in until it is.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xl font-semibold text-[var(--color-text)]">{people.length}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Expected</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-[var(--color-text)]">{inside.length}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Inside now</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-[var(--color-text)]">{notYet.length}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Not arrived</p>
            </div>
          </div>
          {left.length > 0 && (
            <p className="text-center text-xs text-[var(--color-text-muted)]">{left.length} have left</p>
          )}
        </CardBody>
      </Card>

      <TextField
        label="Find someone"
        placeholder="Name or member ID"
        value={query}
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />

      {error && <Banner tone="danger">{error}</Banner>}

      {!canCheckIn && (
        <Banner tone="info">
          You can see who is expected, but checking people in needs the check-in permission. An owner, admin, treasurer
          or collector can do it.
        </Banner>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Nobody on this list matches “{query}”.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((person) => {
            const isInside = Boolean(person.checkedInAt && !person.checkedOutAt);
            return (
              <li
                key={person.obligationId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-text)]">{person.name}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {person.identifier ?? "No member ID"}
                    {isInside && person.checkedInAt && ` · in at ${timeOf(person.checkedInAt)}`}
                    {person.checkedOutAt && ` · left at ${timeOf(person.checkedOutAt)}`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {isInside ? (
                    <Badge tone="success">Inside</Badge>
                  ) : person.checkedOutAt ? (
                    <Badge tone="neutral">Left</Badge>
                  ) : (
                    <Badge tone="neutral">Not arrived</Badge>
                  )}

                  {canCheckIn && (
                    <Button
                      size="sm"
                      variant={isInside ? "secondary" : "primary"}
                      loading={isPending && busyId === person.obligationId}
                      onClick={() => run(person, isInside ? "out" : "in")}
                    >
                      {isInside ? "Check out" : "Check in"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
