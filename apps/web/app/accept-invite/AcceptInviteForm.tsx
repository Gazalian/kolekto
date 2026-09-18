"use client";

import { Banner, Button } from "@kolekto/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptInvitationAction, declineInvitationAction } from "./actions.ts";

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await declineInvitationAction(token);
              if (result.error) setError(result.error);
              else router.push("/communities");
            })
          }
        >
          Decline
        </Button>
        <Button
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              const result = await acceptInvitationAction(token);
              if (result.error) setError(result.error);
              else router.push("/communities");
            })
          }
        >
          Accept
        </Button>
      </div>
    </div>
  );
}
