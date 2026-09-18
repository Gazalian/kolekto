"use client";

import { Banner, Button, TextField } from "@kolekto/ui";
import { useState, useTransition } from "react";
import { redeemInviteLinkAction, type JoinResult } from "./actions.ts";

export function JoinForm({ token }: { token: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<JoinResult | null>(null);

  if (result?.status) {
    return (
      <Banner tone="success">
        {result.status === "pending_approval"
          ? "You're on the list — an officer needs to approve your request before you appear on the roster."
          : "You've joined the roster."}
      </Banner>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      action={(formData) =>
        startTransition(async () => {
          setResult(await redeemInviteLinkAction(token, formData));
        })
      }
    >
      <TextField label="Full name" name="fullName" required />
      <TextField label="Phone number" name="phoneE164" placeholder="+2348012345678" required />
      <TextField label="Email" name="email" type="email" hint="Optional." />
      {result?.error && <Banner tone="danger">{result.error}</Banner>}
      <Button type="submit" loading={isPending}>
        Join
      </Button>
    </form>
  );
}
