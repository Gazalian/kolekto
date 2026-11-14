/**
 * dead-letter.ts — poison-message detection for pgmq queues (M13.2 P6).
 *
 * pgmq increments read_ct each time a message is read. A message whose
 * read_ct exceeds the threshold has failed every processing attempt and
 * should be archived (moved to pgmq.a_<queue>) rather than retried.
 */

/** A message read more than this many times is treated as poison. */
export const MAX_READ_CT = 5;

/** True when the message should be archived instead of processed. */
export function shouldDeadLetter(readCt: number): boolean {
  return readCt > MAX_READ_CT;
}
