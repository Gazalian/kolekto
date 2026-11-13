/**
 * itest-worker-preload.mjs — loaded with `node --import` into the real worker in tests only
 * (M13.2 Phase 7). No production file imports it.
 *
 * Two jobs, neither of which changes what the worker does:
 *   1. Orphan safety: if the test process dies, the IPC channel closes and the worker exits, so a
 *      crashed test cannot leave a worker polling the test stack.
 *   2. Stop request: Node on Windows treats child.kill("SIGTERM") as a forced kill, so the worker's
 *      handler would never run. An IPC "stop" raises the same event on the worker's own process.
 *      This proves the handler and the drain, NOT real operating-system signal delivery.
 */

process.on("disconnect", () => process.exit(97));
process.on("message", (message) => {
  if (message === "stop") process.emit("SIGTERM");
});
// The channel must not keep the process alive: the worker's own exit is what the tests observe.
process.channel?.unref();
