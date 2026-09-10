import assert from "node:assert/strict";
import { test } from "node:test";

import { createFeishuExecutionCoordinator } from "../server/feishu-execution-coordinator.mjs";

function createClock(start = 1_000) {
  let current = start;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: current + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      current += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort(([, left], [, right]) => left.at - right.at);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.callback();
      }
    },
  };
}

function task(id, packageAlias = "Auto-cut-copyA") {
  return { id, version: 1, status: "todo", archivedAt: null, packageAlias };
}

function metadata(packageAlias, overrides = {}) {
  return {
    packageAlias,
    packageRevision: 1,
    executionMode: "manual",
    concurrencyGroup: `autocut:${packageAlias}`,
    resourceGroups: [],
    ...overrides,
  };
}

function automaticMetadata(packageAlias, overrides = {}) {
  return metadata(packageAlias, {
    executionMode: "automatic",
    stageId: "initial",
    packageSource: "subject-config",
    stageSnapshot: { stageId: "initial" },
    controlledContext: { recordId: "rec_fixture" },
    ...overrides,
  });
}

function isCanonicalAutomaticMetadata(value) {
  return Boolean(
    value
    && !Object.hasOwn(value, "deliverySource")
    && value.executionMode === "automatic"
    && typeof value.stageId === "string"
    && value.packageSource === "subject-config"
    && value.stageSnapshot
    && typeof value.stageSnapshot === "object"
    && value.controlledContext
    && typeof value.controlledContext === "object"
  );
}

function createFixture({
  packages = {},
  maxConcurrent = 1,
  allowAutomaticExecution = true,
  failStarts = 0,
  startError = null,
  packageStore: packageStoreOverride = null,
} = {}) {
  const clock = createClock();
  const tasks = new Map();
  const origins = new Map();
  const resolutionErrors = new Map();
  const executionReadErrors = new Map();
  const executions = new Map();
  const starts = [];
  const waiters = new Map();
  const active = new Map();
  let requestCount = 0;
  let leaseNumber = 0;
  let remainingStartFailures = failStarts;

  const database = {
    createFeishuExecution(input) {
      if (executions.has(input.taskId)) {
        throw Object.assign(new Error("execution already exists"), { code: "EXECUTION_EXISTS" });
      }
      const row = {
        taskId: input.taskId,
        state: "delayed",
        mode: input.mode,
        readyAt: input.readyAt,
        pumpRetries: 0,
        launchRetries: 0,
        packageAlias: input.packageAlias,
        packageRevision: input.packageRevision,
        trigger: input.trigger,
        leaseId: null,
        version: 1,
      };
      executions.set(input.taskId, row);
      return { ...row };
    },
    getFeishuExecution(taskId) {
      if (executionReadErrors.has(taskId)) throw executionReadErrors.get(taskId);
      return executions.get(taskId) ? { ...executions.get(taskId) } : null;
    },
    listPendingFeishuExecutions() { return [...executions.values()].filter((row) => row.state !== "running").map((row) => ({ ...row })); },
    setFeishuExecutionState(taskId, expectedVersion, state, patch = {}) {
      const row = executions.get(taskId);
      assert.equal(row?.version, expectedVersion);
      Object.assign(row, patch, { state, version: row.version + 1 });
      return { ...row };
    },
    clearFeishuExecution(taskId) { executions.delete(taskId); },
    getTask(taskId) { return tasks.get(taskId) ?? null; },
    setTaskStatus(taskId, status) {
      const current = tasks.get(taskId);
      current.status = status;
      current.version += 1;
      return { ...current };
    },
  };

  const scheduler = {
    request(request) {
      requestCount += 1;
      const existing = active.get(request.requestId);
      if (existing) return Promise.resolve(existing.lease);
      const pending = waiters.get(request.requestId);
      if (pending) return pending.promise;
      const limit = request.maxConcurrent ?? maxConcurrent;
      const count = [...active.values()].filter((entry) => entry.request.concurrencyGroup === request.concurrencyGroup).length;
      if (count < limit) {
        const lease = { requestId: request.requestId, leaseId: `lease-${++leaseNumber}`, concurrencyGroup: request.concurrencyGroup, resourceGroups: [] };
        active.set(request.requestId, { request, lease });
        return Promise.resolve(lease);
      }
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      waiters.set(request.requestId, { request, resolve, reject, promise });
      return promise;
    },
    release(lease) {
      active.delete(lease.requestId);
      const next = [...waiters.values()].find((entry) => entry.request.concurrencyGroup === lease.concurrencyGroup);
      if (!next) return;
      waiters.delete(next.request.requestId);
      const nextLease = { requestId: next.request.requestId, leaseId: `lease-${++leaseNumber}`, concurrencyGroup: next.request.concurrencyGroup, resourceGroups: [] };
      active.set(next.request.requestId, { request: next.request, lease: nextLease });
      next.resolve(nextLease);
    },
    cancel(value) {
      const requestId = typeof value === "string" ? value : value?.requestId;
      const pending = waiters.get(requestId);
      if (!pending) return false;
      waiters.delete(requestId);
      pending.reject(Object.assign(new Error("cancelled"), { code: "REQUEST_CANCELLED" }));
      return true;
    },
    snapshot() {
      return {
        active: [...active.values()].map(({ lease }) => lease),
        pending: [...waiters.values()].map(({ request }) => request),
      };
    },
    setConcurrencyLimit(group, limit) {
      const matching = [...active.values()].filter((entry) => entry.request.concurrencyGroup === group);
      if (!Number.isSafeInteger(limit) || limit < 1) return false;
      packages[group.slice("autocut:".length)].maxConcurrent = limit;
      for (const [requestId, waiter] of [...waiters.entries()]) {
        if (waiter.request.concurrencyGroup !== group) continue;
        if (matching.length >= limit) break;
        waiters.delete(requestId);
        const lease = {
          requestId,
          leaseId: `lease-${++leaseNumber}`,
          concurrencyGroup: group,
          resourceGroups: [],
        };
        active.set(requestId, { request: waiter.request, lease });
        matching.push({ request: waiter.request, lease });
        waiter.resolve(lease);
      }
      return true;
    },
  };

  const packageStore = packageStoreOverride ?? {
    async get(alias) { return packages[alias] ?? null; },
  };
  const coordinatorOptions = {
    database,
    packageStore,
    scheduler,
    now: clock.now,
    timers: clock,
    allowAutomaticExecution,
    resolveCurrentMetadata(currentTask, context = {}) {
      if (resolutionErrors.has(currentTask.id)) throw resolutionErrors.get(currentTask.id);
      const fallbackMetadata = Object.hasOwn(context, "fallbackMetadata")
        ? context.fallbackMetadata
        : context;
      const currentMetadata = origins.has(currentTask.id)
        ? origins.get(currentTask.id)
        : fallbackMetadata;
      if (context.trigger === "automatic" && !isCanonicalAutomaticMetadata(currentMetadata)) {
        return null;
      }
      return currentMetadata;
    },
    startClaimedTask: async (
      currentTask,
      currentMetadata,
      lease,
      trigger,
      actor,
      autoCutRunConsent,
    ) => {
      starts.push({
        taskId: currentTask.id,
        packageAlias: currentMetadata.packageAlias,
        lease,
        trigger,
        actor,
        autoCutRunConsent,
      });
      if (remainingStartFailures > 0) {
        remainingStartFailures -= 1;
        throw Object.assign(new Error("fixture start failure"), { code: "FIXTURE_START_FAILED" });
      }
      if (startError) throw startError;
      database.setTaskStatus(currentTask.id, "in_progress");
      database.setFeishuExecutionState(currentTask.id, database.getFeishuExecution(currentTask.id).version, "running", { leaseId: lease.leaseId });
      return { task: database.getTask(currentTask.id), execution: database.getFeishuExecution(currentTask.id) };
    },
  };
  const createCoordinator = () => createFeishuExecutionCoordinator(coordinatorOptions);
  const coordinator = createCoordinator();
  return {
    clock,
    database,
    scheduler,
    coordinator,
    starts,
    tasks,
    origins,
    resolutionErrors,
    executionReadErrors,
    executions,
    packages,
    createCoordinator,
    get requestCount() { return requestCount; },
  };
}

test("automatic registration persists a five-second deadline", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), currentMetadata, "automatic");
  const execution = fixture.database.getFeishuExecution("task-1");
  assert.equal(execution.state, "delayed");
  assert.equal(execution.readyAt, 6_000);
  assert.equal(fixture.starts.length, 0);
});

test("automatic scheduling respects the local execution policy", async () => {
  const fixture = createFixture({
    allowAutomaticExecution: false,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  await assert.rejects(
    () => fixture.coordinator.schedule(
      fixture.tasks.get("task-1"),
      automaticMetadata("Auto-cut-copyA"),
      "automatic",
    ),
    (error) => error?.code === "AUTOMATIC_EXECUTION_DISABLED",
  );
});

test("delayed automatic execution is cancelled when its trusted origin is removed", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);

  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    currentMetadata,
    "automatic",
  );
  fixture.origins.set("task-1", null);
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);
  assert.equal(fixture.database.getTask("task-1").status, "todo");
});

test("queued automatic execution revalidates its trusted origin after a lease wait", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("running", task("running"));
  fixture.tasks.set("queued", task("queued"));
  fixture.origins.set("queued", currentMetadata);
  await fixture.coordinator.schedule(
    fixture.tasks.get("running"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await fixture.coordinator.schedule(
    fixture.tasks.get("queued"),
    currentMetadata,
    "automatic",
  );

  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.database.getTask("queued").status, "queued");

  fixture.origins.set("queued", null);
  fixture.scheduler.release(
    fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "running"),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["running"]);
  assert.equal(fixture.database.getFeishuExecution("queued"), null);
  assert.equal(fixture.database.getTask("queued").status, "todo");
});

test("cancelling after lease assignment fences the stale queued launch", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("running", task("running"));
  fixture.tasks.set("queued", task("queued"));
  await fixture.coordinator.schedule(
    fixture.tasks.get("running"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await fixture.coordinator.schedule(
    fixture.tasks.get("queued"),
    metadata("Auto-cut-copyA"),
    "manual",
  );

  fixture.scheduler.release(
    fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "running"),
  );
  fixture.coordinator.cancel("queued");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["running"]);
  assert.equal(fixture.database.getFeishuExecution("queued"), null);
});

test("cancelling during launch package lookup fences the stale lease", async () => {
  const packages = { "Auto-cut-copyA": { maxConcurrent: 1 } };
  let reads = 0;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let continueResolve;
  const proceed = new Promise((resolve) => { continueResolve = resolve; });
  const fixture = createFixture({
    packages,
    packageStore: {
      async get(alias) {
        reads += 1;
        if (reads === 2) {
          enteredResolve();
          await proceed;
        }
        return packages[alias] ?? null;
      },
    },
  });
  fixture.tasks.set("task-1", task("task-1"));

  const scheduling = fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await entered;
  fixture.coordinator.cancel("task-1");
  continueResolve();
  await scheduling;

  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);
  assert.equal(fixture.scheduler.snapshot().active.length, 0);
});

test("cancelling during pump package lookup avoids a stale resource request", async () => {
  const packages = { "Auto-cut-copyA": { maxConcurrent: 1 } };
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let continueResolve;
  const proceed = new Promise((resolve) => { continueResolve = resolve; });
  const fixture = createFixture({
    packages,
    packageStore: {
      async get(alias) {
        enteredResolve();
        await proceed;
        return packages[alias] ?? null;
      },
    },
  });
  fixture.tasks.set("task-1", task("task-1"));

  const scheduling = fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await entered;
  fixture.coordinator.cancel("task-1");
  continueResolve();
  await scheduling;

  assert.equal(fixture.requestCount, 0);
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);
});

test("concurrent wake during package lookup submits only one resource request", async () => {
  const packages = { "Auto-cut-copyA": { maxConcurrent: 1 } };
  let reads = 0;
  let firstReleased = false;
  let firstEnteredResolve;
  const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
  let continueFirstResolve;
  const continueFirst = new Promise((resolve) => { continueFirstResolve = resolve; });
  let concurrentEnteredResolve;
  const concurrentEntered = new Promise((resolve) => { concurrentEnteredResolve = resolve; });
  let continueConcurrentResolve;
  const continueConcurrent = new Promise((resolve) => { continueConcurrentResolve = resolve; });
  const fixture = createFixture({
    packages,
    packageStore: {
      async get(alias) {
        reads += 1;
        if (reads === 1) {
          firstEnteredResolve();
          await continueFirst;
        } else if (!firstReleased) {
          concurrentEnteredResolve();
          await continueConcurrent;
        }
        return packages[alias] ?? null;
      },
    },
  });
  fixture.tasks.set("task-1", task("task-1"));

  const scheduling = fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await firstEntered;
  const waking = fixture.coordinator.wake("Auto-cut-copyA");
  const concurrentLookupStarted = await Promise.race([
    concurrentEntered.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  firstReleased = true;
  continueFirstResolve();
  if (concurrentLookupStarted) continueConcurrentResolve();
  await waking;
  await scheduling;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.requestCount, 1);
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
});

test("a transient current-origin read failure preserves an automatic reservation", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    currentMetadata,
    "automatic",
  );

  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.state, "delayed");

  fixture.resolutionErrors.delete("task-1");
  await fixture.coordinator.wake("Auto-cut-copyA");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("a timer retries a transient pre-lease failure without an external wake", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    currentMetadata,
    "automatic",
  );

  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts.length, 0);
  assert.deepEqual(
    fixture.database.getFeishuExecution("task-1"),
    {
      taskId: "task-1",
      state: "delayed",
      mode: "automatic",
      readyAt: 7_000,
      packageAlias: "Auto-cut-copyA",
      packageRevision: 1,
      trigger: "automatic",
      leaseId: null,
      version: 2,
      pumpRetries: 1,
      launchRetries: 0,
      lastError: "EXECUTION_FAILED",
    },
  );

  fixture.resolutionErrors.delete("task-1");
  await fixture.clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("retry backoff and pump retry budget survive coordinator recovery", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), currentMetadata, "automatic");

  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.coordinator.close();

  const recovered = fixture.createCoordinator();
  await recovered.recover();
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.readyAt, 7_000);

  await fixture.clock.advance(999);
  assert.equal(fixture.starts.length, 0);
  await fixture.clock.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.pumpRetries, 2);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.readyAt, 9_000);
});

test("waking during pump backoff does not reset its persisted retry budget", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), currentMetadata, "automatic");

  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.coordinator.wake("Auto-cut-copyA");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.database.getFeishuExecution("task-1")?.pumpRetries, 1);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.readyAt, 7_000);
});

test("a transient launch reservation read failure releases its lease and retries", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("running", task("running"));
  fixture.tasks.set("queued", task("queued"));
  await fixture.coordinator.schedule(
    fixture.tasks.get("running"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  await fixture.coordinator.schedule(
    fixture.tasks.get("queued"),
    metadata("Auto-cut-copyA"),
    "manual",
  );

  fixture.executionReadErrors.set("queued", new Error("temporary execution read failure"));
  fixture.scheduler.release(
    fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "running"),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["running"]);
  assert.equal(fixture.scheduler.snapshot().active.length, 0);

  fixture.executionReadErrors.delete("queued");
  await fixture.clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["running", "queued"]);
});

test("automatic recovery fails closed for simulated, manual, or legacy automatic origins", async () => {
  for (const [taskId, currentMetadata] of [
    ["simulated", automaticMetadata("Auto-cut-copyA", {
      deliverySource: "simulation",
    })],
    ["manual-mode", automaticMetadata("Auto-cut-copyA", { executionMode: "manual" })],
    ["legacy-automatic", metadata("Auto-cut-copyA", { executionMode: "automatic" })],
  ]) {
    const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
    fixture.tasks.set(taskId, task(taskId));
    fixture.origins.set(taskId, currentMetadata);
    fixture.database.createFeishuExecution({
      taskId,
      mode: "automatic",
      readyAt: 1_000,
      packageAlias: "Auto-cut-copyA",
      packageRevision: 1,
      trigger: "automatic",
    });

    await fixture.coordinator.recover();

    assert.equal(fixture.starts.length, 0, taskId);
    assert.equal(fixture.database.getFeishuExecution(taskId), null, taskId);
    assert.equal(fixture.database.getTask(taskId).status, "todo", taskId);
  }
});

test("automatic recovery remains disabled when the local execution policy is off", async () => {
  const fixture = createFixture({
    allowAutomaticExecution: false,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  fixture.database.createFeishuExecution({
    taskId: "task-1",
    mode: "automatic",
    readyAt: 1_000,
    packageAlias: "Auto-cut-copyA",
    packageRevision: 1,
    trigger: "automatic",
  });

  await fixture.coordinator.recover();

  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);
  assert.equal(fixture.requestCount, 0);
});

test("valid automatic recovery still starts after current provenance is revalidated", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  fixture.database.createFeishuExecution({
    taskId: "task-1",
    mode: "automatic",
    readyAt: 1_000,
    packageAlias: "Auto-cut-copyA",
    packageRevision: 1,
    trigger: "automatic",
  });

  await fixture.coordinator.recover();

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("manual execution remains available for trusted simulated and legacy origins", async () => {
  for (const [taskId, currentMetadata] of [
    ["simulated", metadata("Auto-cut-copyA", { deliverySource: "simulation" })],
    ["legacy", metadata("Auto-cut-copyA", { executionMode: "automatic" })],
  ]) {
    const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
    fixture.tasks.set(taskId, task(taskId));
    fixture.origins.set(taskId, currentMetadata);

    const result = await fixture.coordinator.schedule(
      fixture.tasks.get(taskId),
      currentMetadata,
      "manual",
    );

    assert.equal(result.task.status, "in_progress", taskId);
    assert.deepEqual(fixture.starts.map((entry) => entry.taskId), [taskId], taskId);
  }
});

test("manual immediate start skips the delay", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  const result = await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(result.task.status, "in_progress");
  assert.equal(fixture.starts.length, 1);
});

test("retry scheduling carries consent only on its in-memory entry", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const simulatedMetadata = metadata("Auto-cut-copyA", { deliverySource: "simulation" });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", simulatedMetadata);
  const runConsent = {
    allowVideoAudioAsr: true,
    allowConfiguredLocalOutput: true,
  };

  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    simulatedMetadata,
    "retry",
    { actor: { type: "user", id: "local-user" }, autoCutRunConsent: runConsent },
  );

  assert.deepEqual(fixture.starts[0].autoCutRunConsent, runConsent);
  assert.equal(fixture.starts[0].trigger, "retry");
});

test("repeated manual scheduling of the same task is idempotent while the first start is pending", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));

  const first = fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  const second = fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  const secondSnapshot = fixture.database.getFeishuExecution("task-1");
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.task.status, "in_progress");
  assert.equal(secondSnapshot.state, "delayed");
  assert.equal(secondResult.task.id, "task-1");
  assert.equal(fixture.starts.length, 1);
});

test("repeated manual scheduling reuses a running execution after launch settles", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));

  const first = await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  const second = await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );

  assert.equal(first.execution.state, "running");
  assert.equal(second.execution.state, "running");
  assert.equal(fixture.starts.length, 1);
});

test("same-trigger replay restarts an in-memory reservation after a transient pump failure", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  const currentMetadata = automaticMetadata("Auto-cut-copyA");
  fixture.tasks.set("task-1", task("task-1"));
  fixture.origins.set("task-1", currentMetadata);
  await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    currentMetadata,
    "automatic",
  );

  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));
  await fixture.clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts.length, 0);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.state, "delayed");

  fixture.resolutionErrors.delete("task-1");
  const replay = await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    currentMetadata,
    "automatic",
  );

  assert.equal(replay.execution.state, "running");
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
});

test("same-trigger replay resumes persisted non-running reservations", async () => {
  for (const state of ["delayed", "queued"]) {
    const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
    fixture.tasks.set(state, task(state));
    fixture.database.createFeishuExecution({
      taskId: state,
      mode: "manual",
      readyAt: 1_000,
      packageAlias: "Auto-cut-copyA",
      packageRevision: 1,
      trigger: "manual",
    });
    if (state === "queued") {
      const execution = fixture.database.getFeishuExecution(state);
      fixture.database.setFeishuExecutionState(state, execution.version, "queued");
      fixture.database.setTaskStatus(state, "queued");
    }

    const replay = await fixture.coordinator.schedule(
      fixture.tasks.get(state),
      metadata("Auto-cut-copyA"),
      "manual",
    );

    assert.equal(replay.execution.state, "running", state);
    assert.deepEqual(fixture.starts.map((entry) => entry.taskId), [state], state);
  }
});

test("a saturated package queues FIFO while another package starts independently", async () => {
  const fixture = createFixture({
    packages: {
      "Auto-cut-copyA": { maxConcurrent: 1 },
      "Auto-cut-B": { maxConcurrent: 1 },
    },
  });
  for (const id of ["a-1", "a-2", "b-1"]) fixture.tasks.set(id, task(id, id.startsWith("b") ? "Auto-cut-B" : "Auto-cut-copyA"));
  const a1 = await fixture.coordinator.schedule(fixture.tasks.get("a-1"), metadata("Auto-cut-copyA"), "manual");
  const a2 = await fixture.coordinator.schedule(fixture.tasks.get("a-2"), metadata("Auto-cut-copyA"), "manual");
  const b1 = await fixture.coordinator.schedule(fixture.tasks.get("b-1"), metadata("Auto-cut-B"), "manual");
  assert.equal(a1.execution.state, "running");
  assert.equal(a2.execution.state, "queued");
  assert.equal(b1.execution.state, "running");
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["a-1", "b-1"]);
  fixture.scheduler.release(fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "a-1"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["a-1", "b-1", "a-2"]);
});

test("disabled packages remain waiting and do not start", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { state: "disabled", maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  const result = await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(result.task.status, "todo");
  assert.equal(result.execution.state, "delayed");
  assert.equal(fixture.starts.length, 0);
});

test("recovery restores delayed and queued executions once", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.database.createFeishuExecution({ taskId: "task-1", mode: "manual", readyAt: 1_000, packageAlias: "Auto-cut-copyA", packageRevision: 1, trigger: "manual" });
  await fixture.coordinator.recover();
  await fixture.coordinator.recover();
  assert.equal(fixture.starts.length, 1);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("recovery isolates a transient failure and retries it after restoring later rows", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  for (const taskId of ["task-1", "task-2"]) {
    const currentMetadata = automaticMetadata("Auto-cut-copyA");
    fixture.tasks.set(taskId, task(taskId));
    fixture.origins.set(taskId, currentMetadata);
    fixture.database.createFeishuExecution({
      taskId,
      mode: "automatic",
      readyAt: 1_000,
      packageAlias: "Auto-cut-copyA",
      packageRevision: 1,
      trigger: "automatic",
    });
  }
  fixture.resolutionErrors.set("task-1", new Error("temporary origin read failure"));

  await assert.rejects(
    () => fixture.coordinator.recover(),
    /temporary origin read failure/,
  );
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-2"]);
  assert.equal(fixture.database.getFeishuExecution("task-1")?.state, "delayed");
  assert.equal(fixture.database.getFeishuExecution("task-2")?.state, "running");
  fixture.scheduler.release(
    fixture.scheduler.snapshot().active.find((lease) => lease.requestId === "task-2"),
  );

  fixture.resolutionErrors.delete("task-1");
  await fixture.clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-2", "task-1"]);
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("waking a queued execution after a package limit increase starts it once", async () => {
  const fixture = createFixture({
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.tasks.set("task-2", task("task-2"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  await fixture.coordinator.schedule(fixture.tasks.get("task-2"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(fixture.requestCount, 2);
  fixture.packages["Auto-cut-copyA"].maxConcurrent = 2;
  await fixture.coordinator.wake("Auto-cut-copyA");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1", "task-2"]);
  assert.equal(fixture.requestCount, 2);
  assert.equal(fixture.scheduler.snapshot().pending.length, 0);
});

test("closing cancels queued leases and settles the coordinator", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 1 } } });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.tasks.set("task-2", task("task-2"));
  await fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual");
  await fixture.coordinator.schedule(fixture.tasks.get("task-2"), metadata("Auto-cut-copyA"), "manual");
  assert.equal(fixture.scheduler.snapshot().pending.length, 1);

  await Promise.race([
    fixture.coordinator.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("coordinator close timed out")), 100)),
  ]);
  assert.equal(fixture.scheduler.snapshot().pending.length, 0);
});

test("a transient launch failure retries with a bounded delay", async () => {
  const fixture = createFixture({
    failStarts: 1,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));
  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual"),
    (error) => error?.code === "FIXTURE_START_FAILED",
  );
  assert.equal(fixture.database.getTask("task-1").status, "todo");
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "delayed");
  assert.equal(fixture.starts.length, 1);

  await fixture.clock.advance(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.starts.length, 2);
  assert.equal(fixture.database.getTask("task-1").status, "in_progress");
  assert.equal(fixture.database.getFeishuExecution("task-1").state, "running");
});

test("a blocked phased preparation is retained without a coordinator retry", async () => {
  const startError = Object.assign(new Error("document link missing"), {
    code: "document_link_missing",
    feishuAutoCutPreparationBlocked: true,
  });
  const fixture = createFixture({
    startError,
    packages: { "Auto-cut-copyA": { maxConcurrent: 3 } },
  });
  fixture.tasks.set("task-1", task("task-1"));

  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual"),
    (error) => error === startError,
  );
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);
  assert.equal(fixture.starts.length, 1);

  await fixture.clock.advance(30_000);
  assert.equal(fixture.starts.length, 1);
});

test("phased runs stay serial even when the package allows wider concurrency", async () => {
  const fixture = createFixture({ packages: { "Auto-cut-copyA": { maxConcurrent: 3 } } });
  fixture.tasks.set("task-1", task("task-1"));
  fixture.tasks.set("task-2", task("task-2"));
  const phased = { ...metadata("Auto-cut-copyA"), stageId: "initial" };

  const first = await fixture.coordinator.schedule(fixture.tasks.get("task-1"), phased, "manual");
  const second = await fixture.coordinator.schedule(fixture.tasks.get("task-2"), phased, "manual");

  assert.equal(first.execution.state, "running");
  assert.equal(second.execution.state, "queued");
  assert.equal(fixture.scheduler.snapshot().pending[0].fixedMaxConcurrent, true);
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);

  await fixture.coordinator.wake("Auto-cut-copyA");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.database.getFeishuExecution("task-2").state, "queued");
  assert.deepEqual(fixture.starts.map((entry) => entry.taskId), ["task-1"]);
});

test("retry exhaustion releases the durable execution so a manual retry can start", async () => {
  const fixture = createFixture({
    failStarts: 4,
    packages: { "Auto-cut-copyA": { maxConcurrent: 1 } },
  });
  fixture.tasks.set("task-1", task("task-1"));

  await assert.rejects(
    () => fixture.coordinator.schedule(fixture.tasks.get("task-1"), metadata("Auto-cut-copyA"), "manual"),
    (error) => error?.code === "FIXTURE_START_FAILED",
  );
  for (const delay of [1_000, 2_000, 4_000]) {
    await fixture.clock.advance(delay);
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(fixture.starts.length, 4);
  assert.equal(fixture.database.getTask("task-1").status, "todo");
  assert.equal(fixture.database.getFeishuExecution("task-1"), null);

  const retried = await fixture.coordinator.schedule(
    fixture.tasks.get("task-1"),
    metadata("Auto-cut-copyA"),
    "manual",
  );
  assert.equal(retried.task.status, "in_progress");
  assert.equal(retried.execution.state, "running");
  assert.equal(fixture.starts.length, 5);
});
