/**
 * notifications.ts — notification read/write functions for M13.1.
 *
 * Mark-as-read goes through app.* SECURITY DEFINER functions, same pattern as
 * every other write in this codebase (ADR 0011). The functions enforce
 * recipient ownership — a user can only mark their own notifications.
 */

import { type CallerContext, runWrite, withCallerContext } from "./client.ts";

async function call<T>(caller: CallerContext, fn: (tx: import("postgres").TransactionSql) => Promise<T>): Promise<T> {
  return runWrite(() => withCallerContext(caller, fn));
}

export async function markNotificationRead(
  caller: CallerContext,
  deliveryId: string,
): Promise<void> {
  await call(caller, (tx) =>
    tx`select app.mark_notification_read(${deliveryId})`,
  );
}

export async function markAllNotificationsRead(
  caller: CallerContext,
): Promise<number> {
  const [row] = await call(caller, (tx) =>
    tx<{ mark_all_notifications_read: number }[]>`select app.mark_all_notifications_read() as mark_all_notifications_read`,
  );
  return row!.mark_all_notifications_read;
}
