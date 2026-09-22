"use client";

import { Badge, Banner, Button, Card, CardBody, TextField } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { checkInAction, checkOutAction, searchAttendeesAction } from "./check-in-actions.ts";

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
  /** "VIP-0021", when this collection issues references. What somebody reads off their phone at the door. */
  reference: string | null;
  /** Which ticket they hold, on a tiered event. */
  tierName: string | null;
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
  totals,
  canCheckIn,
}: {
  slug: string;
  collectionSlug: string;
  /** The first page of the guest list. Searching past it asks the server (part P). */
  people: CheckInPerson[];
  totals: { expected: number; inside: number; left: number; notArrived: number };
  canCheckIn: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [matches, setMatches] = useState<CheckInPerson[] | null>(null);

  /**
   * Every keystroke past the first page is a question for the server (part
   * P). Debounced, because a person typing a name at a door should produce
   * one query and not six, and the previous answer stays on screen while the
   * next one is in flight — a list that blanks between keystrokes is a list
   * somebody taps the wrong row in.
   */
  useEffect(() => {
    const needle = query.trim();
    // An empty box goes back to the first page, and that is decided where the
    // box is typed in rather than here — an effect that calls setState on its
    // own first run is a cascading render, and React says so.
    if (needle === "") return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void searchAttendeesAction(slug, collectionSlug, needle).then((result) => {
        if (cancelled) return;
        if (result.error) setError(result.error);
        else setMatches(result.matches ?? []);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [collectionSlug, query, slug]);

  const shown = matches ?? people;

  function run(person: CheckInPerson, direction: "in" | "out"): void {
    setError(null);
    setBusyId(person.obligationId);
    startTransition(async () => {
      const result =
        direction === "in"
          ? await checkInAction(slug, collectionSlug, person.obligationId)
          : await checkOutAction(slug, collectionSlug, person.obligationId);
      setBusyId(null);
      if (result.error) {
        setError(result.error);
        return;
      }

      // router.refresh() updates the first page, which is the props. It does
      // NOT update search results, which are this component's own state — so
      // admitting somebody found by searching left their badge reading "Not
      // arrived" until the box was cleared. At a door that is the whole
      // screen being wrong.
      if (matches !== null) {
        const again = await searchAttendeesAction(slug, collectionSlug, query.trim());
        if (!again.error) setMatches(again.matches ?? []);
      }
      router.refresh();
    });
  }

  if (totals.expected === 0) {
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
              <p className="text-xl font-semibold text-[var(--color-text)]">{totals.expected}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Expected</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-[var(--color-text)]">{totals.inside}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Inside now</p>
            </div>
            <div>
              <p className="text-xl font-semibold text-[var(--color-text)]">{totals.notArrived}</p>
              <p className="text-xs text-[var(--color-text-muted)]">Not arrived</p>
            </div>
          </div>
          {totals.left > 0 && (
            <p className="text-center text-xs text-[var(--color-text-muted)]">{totals.left} have left</p>
          )}
        </CardBody>
      </Card>

      <TextField
        label="Find someone"
        placeholder="Name, member ID or reference"
        value={query}
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          if (event.target.value.trim() === "") setMatches(null);
        }}
      />

      {error && <Banner tone="danger">{error}</Banner>}

      {!canCheckIn && (
        <Banner tone="info">
          You can see who is expected, but checking people in needs the check-in permission. An owner, admin, treasurer
          or collector can do it.
        </Banner>
      )}

      {matches === null && totals.expected > people.length && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Showing the first {people.length} of {totals.expected}. Search to find anybody else.
        </p>
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
                  {person.reference && (
                    <p className="font-mono text-sm text-[var(--color-text)]">{person.reference}</p>
                  )}
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {person.identifier ?? "No member ID"}
                    {person.tierName && ` · ${person.tierName}`}
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
