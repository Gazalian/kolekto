/**
 * index.ts — the worker entrypoint.
 *
 * Deliberately does nothing yet. ADR 0005: this process exists so background
 * work (reminders, recurring collection cycles, reconciliation jobs) runs
 * against `pgmq` rather than as an ungoverned edge function. None of that
 * work exists until Phase 3/4 (docs/adr/0006-ledger-deferred.md) — starting a
 * polling loop against an empty queue now would be a running process with no
 * job to justify it, not a foundation.
 */

console.log("Kolekto worker: no queues are wired up yet (Phase 3/4). Exiting.");
