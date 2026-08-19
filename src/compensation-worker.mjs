/**
 * Runs durable Bridge recovery and due-delivery sweeps serially.
 *
 * A chained timeout keeps a slow Taskboard operation from overlapping the
 * next sweep. The Bridge owns delivery state; this module only schedules it.
 */
export function createCompensationWorker({
  bridge,
  pollIntervalMs,
  logger = console,
  timers = globalThis,
}) {
  let timer = null;
  let active = null;
  let stopped = false;
  let started = false;

  function runOnce() {
    if (active) return active;
    active = (async () => {
      await bridge.recover();
      while (await bridge.processDue()) {
        // Drain all records that are due at the time of this sweep.
      }
    })()
      .catch((error) => {
        // Do not include arbitrary error messages or event payloads in logs.
        logger.error?.("Bridge compensation sweep failed");
      })
      .finally(() => {
        active = null;
      });
    return active;
  }

  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      await runOnce();
      schedule();
    }, pollIntervalMs);
  }

  return {
    start() {
      if (started && !stopped) return;
      started = true;
      stopped = false;
      void runOnce();
      schedule();
    },

    async stop() {
      stopped = true;
      started = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      await active;
    },

    runOnce,
  };
}
