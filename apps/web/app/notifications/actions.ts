"use server";

import { markNotificationRead, markAllNotificationsRead } from "@kolekto/db";
import { requireCallerContext } from "../../lib/caller.ts";

export async function markReadAction(deliveryId: string): Promise<{ error?: string }> {
  try {
    const caller = await requireCallerContext();
    await markNotificationRead(caller, deliveryId);
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to mark as read" };
  }
}

export async function markAllReadAction(): Promise<{ count: number; error?: string }> {
  try {
    const caller = await requireCallerContext();
    const count = await markAllNotificationsRead(caller);
    return { count };
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : "Failed to mark all as read" };
  }
}
