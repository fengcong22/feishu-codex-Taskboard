/** Keep task-bound approvals on the same durable queue and worker as manual downloads. */
export function createVmTaskDownloadAdapter(downloads) {
  if (typeof downloads?.requestFor !== "function" || typeof downloads.lookupExact !== "function"
    || typeof downloads.enqueue !== "function" || typeof downloads.wake !== "function") {
    throw new TypeError("Task-bound downloads require an active VM download service");
  }
  return {
    requestFor: (input) => downloads.requestFor(input),
    lookup: (input) => downloads.lookupExact(input),
    enqueue: (input) => downloads.enqueue(input),
    wake: () => downloads.wake(),
  };
}
