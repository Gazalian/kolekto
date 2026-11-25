"use client";

import { Button, TextField } from "@kolekto/ui";
import { type Ref, useEffect, useRef, useState, useTransition } from "react";
import {
  confirmMembershipPassAction,
  membershipPassSummaryAction,
  rejectMembershipPassAction,
  validateMembershipIdAction,
} from "./actions.ts";
import {
  ENTER_SCREEN,
  MAX_MEMBERSHIP_ID_INPUT_LENGTH,
  canSubmitMembershipId,
  confirmIdentity,
  createSingleFlight,
  normaliseMembershipIdInput,
  rejectIdentity,
  submitMembershipId,
  type IdentifiedMember,
  type IdentifyActions,
  type IdentifyScreen,
  type MaskedMemberSummary,
} from "./membership-id-flow.ts";

export type { IdentifiedMember };

/**
 * "Identify yourself" — how a contributor says which member of a community
 * they are on a managed collection, without an account (A2.5).
 *
 *   1. They type their community membership ID. Every way an ID can fail —
 *      unknown, revoked, suspended, archived, outside this collection's
 *      audience — gives the same sentence, so the box cannot be used to learn
 *      which IDs exist.
 *   2. Kolekto shows the member's name with a masked email and phone, and asks
 *      "Are these your details?". The full contact details never leave the
 *      database on this path.
 *   3. "Yes, continue" confirms on the server and hands the member context to
 *      the form; "No, that's not me" clears the pass and starts again.
 *
 * The membership ID is an identifier, not a password. The access token and the
 * member's id never reach this component: the server keeps them in httpOnly
 * cookies and re-checks them on every call. Nothing here is persisted in the
 * browser, so a refresh always starts again at step 1.
 */
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
  const [membershipId, setMembershipId] = useState("");
  const [screen, setScreen] = useState<IdentifyScreen>(ENTER_SCREEN);
  const [isPending, startTransition] = useTransition();
  // Claimed synchronously, before React re-renders with `isPending`: a fast
  // double Enter or double tap must not send a second request.
  const [singleFlight] = useState(createSingleFlight);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // Move focus to the new screen's heading when the step changes, so keyboard
  // and screen-reader users land on what just appeared.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [screen.step]);

  const actions: IdentifyActions = {
    validate: (typedId) => validateMembershipIdAction(communitySlug, collectionSlug, typedId),
    summary: () => membershipPassSummaryAction(communitySlug, collectionSlug),
    confirm: () => confirmMembershipPassAction(communitySlug, collectionSlug),
    reject: () => rejectMembershipPassAction(),
  };

  function run(step: () => Promise<void>): void {
    singleFlight(
      () =>
        new Promise<void>((settle) => {
          startTransition(async () => {
            try {
              await step();
            } finally {
              settle();
            }
          });
        }),
    );
  }

  function submit(): void {
    if (!canSubmitMembershipId(membershipId)) return;
    run(async () => {
      setScreen(await submitMembershipId(actions, membershipId));
    });
  }

  function confirm(): void {
    run(async () => {
      const outcome = await confirmIdentity(actions);
      if ("member" in outcome) {
        setMembershipId("");
        onIdentified(outcome.member);
        return;
      }
      setScreen(outcome.screen);
    });
  }

  function reject(): void {
    run(async () => {
      setScreen(await rejectIdentity(actions));
      setMembershipId("");
    });
  }

  return screen.step === "confirm" ? (
    <ConfirmMemberDetails
      summary={screen.summary}
      pending={isPending}
      headingRef={headingRef}
      onConfirm={confirm}
      onReject={reject}
    />
  ) : (
    <MembershipIdEntry
      value={membershipId}
      error={screen.error}
      pending={isPending}
      organiser={organiser}
      headingRef={headingRef}
      onChange={(value) => {
        setMembershipId(normaliseMembershipIdInput(value));
        // A new attempt: the old error no longer describes what is typed.
        if (screen.error) setScreen(ENTER_SCREEN);
      }}
      onSubmit={submit}
    />
  );
}

const CARD = "flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5";
const HEADING = "text-base font-semibold text-[var(--color-text)] focus:outline-none";

/** Screen 1. Presentational: state lives in FindYourself. */
export function MembershipIdEntry({
  value,
  error,
  pending,
  organiser,
  headingRef,
  onChange,
  onSubmit,
}: {
  value: string;
  error: string | null;
  pending: boolean;
  organiser: string;
  headingRef?: Ref<HTMLHeadingElement>;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section className={CARD} aria-labelledby="identify-heading">
      <div className="flex flex-col gap-1">
        <h2 id="identify-heading" ref={headingRef} tabIndex={-1} className={HEADING}>
          Identify yourself
        </h2>
        <p className="text-sm text-[var(--color-text-muted)]">
          Enter your community membership ID to continue with your contribution.
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <TextField
          label="Membership ID"
          name="membershipId"
          placeholder="e.g. ABC/K7P9Q"
          value={value}
          required
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={MAX_MEMBERSHIP_ID_INPUT_LENGTH}
          readOnly={pending}
          hint={`Ask ${organiser} if you don't know your membership ID.`}
          {...(error ? { error } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button type="submit" loading={pending} disabled={!canSubmitMembershipId(value)}>
          {pending ? "Checking…" : "Continue"}
        </Button>
      </form>
    </section>
  );
}

/** Screen 2. Shows only the masked summary; there is no field here that could carry full contact details. */
export function ConfirmMemberDetails({
  summary,
  pending,
  headingRef,
  onConfirm,
  onReject,
}: {
  summary: MaskedMemberSummary;
  pending: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <section className={CARD} aria-labelledby="confirm-heading">
      <h2 id="confirm-heading" ref={headingRef} tabIndex={-1} className={HEADING}>
        Are these your details?
      </h2>

      <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <p className="text-lg font-semibold break-words text-[var(--color-text)]">{summary.fullName}</p>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-[var(--color-text-muted)]">Email</dt>
            <dd className="font-medium break-all text-[var(--color-text)]">{summary.emailMasked ?? "Not on record"}</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-[var(--color-text-muted)]">Phone</dt>
            <dd className="font-medium text-[var(--color-text)]">{summary.phoneMasked ?? "Not on record"}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button loading={pending} onClick={onConfirm}>
          Yes, continue
        </Button>
        <Button variant="secondary" disabled={pending} onClick={onReject}>
          No, that&apos;s not me
        </Button>
      </div>
    </section>
  );
}
