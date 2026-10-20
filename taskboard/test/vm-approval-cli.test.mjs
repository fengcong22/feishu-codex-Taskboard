import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../cli/vm-approval.mjs";
import { VmApprovalAuthError } from "../server/vm-approval-auth.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const VMID = "0123456789abcdef01234567";
const TOKEN = "fixture-token-never-output";

function capture() {
  let text = "";
  return { stream: { write(chunk) { text += chunk; } }, text: () => text };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vm-approval-cli-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const request = path.join(root, "request.json");
  const raw = {
    schema_version: 1, vmid: VMID, department: "Fixture department", reason: "Fixture review",
    output_root: path.join(root, "output"), allowed_origins: ["https://media.example.com"],
  };
  await writeFile(request, JSON.stringify(raw));
  return { root, request, raw, state: path.join(root, "queue.sqlite") };
}

function dependencies(initial = { id: "job-1", status: "queued", next_attempt_at: 0 }) {
  let job = structuredClone(initial);
  const calls = { stores: [], closes: 0, clients: [], processes: [], enqueues: [], resumes: [] };
  const store = {
    get: (id) => job?.id === id ? structuredClone(job) : null,
    list: () => job ? [structuredClone(job)] : [],
    close: () => { calls.closes += 1; },
  };
  return {
    calls, store,
    setJob: (value) => { job = structuredClone(value); },
    overrides: {
      env: { SHADOW_TOKEN: TOKEN },
      createStore: (options) => { calls.stores.push(options); return store; },
      createClient: (options) => { calls.clients.push(options); return { fixture: true }; },
      validate: (request) => request,
      enqueue: (receivedStore, raw, options) => {
        calls.enqueues.push({ receivedStore, raw, options });
        job = { id: options.id ?? "generated-job", status: "queued", request: raw };
        return structuredClone(job);
      },
      processJob: async (receivedStore, id, options) => {
        calls.processes.push({ receivedStore, id, options });
        return structuredClone(job);
      },
      resume: (receivedStore, id, options) => {
        calls.resumes.push({ receivedStore, id, options });
        job = { ...job, status: "queued" };
        return structuredClone(job);
      },
      summarize: (received) => ({ id: received.id, status: received.status }),
    },
  };
}

async function run(argv, overrides = {}) {
  const stdout = capture();
  const exitCode = await main(argv, { stdout: stdout.stream, ...overrides });
  const text = stdout.text();
  return { exitCode, text, output: JSON.parse(text) };
}

test("help describes approval commands and requires no queue or client", async () => {
  const stdout = capture();
  const exitCode = await main(["--help"], {
    stdout: stdout.stream,
    createStore: () => assert.fail("help must not open state"),
    createClient: () => assert.fail("help must not contact VM"),
  });
  assert.equal(exitCode, 0);
  for (const phrase of ["enqueue", "status", "tick", "run", "resume", "--login", "SHADOW_TOKEN", "Exit codes:"]) {
    assert.ok(stdout.text().includes(phrase));
  }
});

test("rejects invalid commands, duplicate flags, unsafe IDs and token arguments before side effects", async (t) => {
  const { state, request } = await fixture(t);
  const invalid = [
    [], ["download"], ["enqueue", "--state", state], ["status"], ["tick", "--state", state],
    ["run", "--state", state, "--id", "job-1", "--max-wait-ms", "0"],
    ["run", "--state", state, "--id", "job-1", "--max-wait-ms", "1e6"],
    ["run", "--state", state, "--id", "job-1", "--max-wait-ms", "2147483648"],
    ["tick", "--state", state, "--id", "job-1", "--max-wait-ms", "5"],
    ["tick", "--state", state, "--id", "job-1", "--ffmpeg", "relative-ffmpeg"],
    ["tick", "--state", state, "--id", "job-1", "--token", TOKEN],
    ["tick", "--state", state, "--id", "job-1", "--login", "true"],
    ["tick", "--state", state, "--id", "job-1", "--login", "--login"],
    ["status", "--state", state, "--state", state],
    ["status", "--state", state, "--id", "https://private.example"],
    ["status", "--state", state, "--id", "bad\nid"],
    ["enqueue", "--state", state, "--request", request, "--unknown", "x"],
  ];
  for (const argv of invalid) {
    const result = await run(argv, { createStore: () => assert.fail("invalid args must not open state") });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.output, { status: "failed", error: { code: "VM_REQUEST_INVALID" } });
    assert.doesNotMatch(result.text, /fixture-token|private.example/u);
  }
});

test("rejects missing, directory, malformed, oversized and symbolic-link request files", async (t) => {
  const { root, request, state } = await fixture(t);
  const directory = path.join(root, "directory");
  const malformed = path.join(root, "malformed.json");
  const oversized = path.join(root, "oversized.json");
  await mkdir(directory);
  await writeFile(malformed, "{secret");
  await writeFile(oversized, " ".repeat(64 * 1024 + 1));
  const files = [path.join(root, "missing.json"), directory, malformed, oversized];
  const linked = path.join(root, "linked.json");
  try { await symlink(request, linked); files.push(linked); }
  catch (error) { if (!["EPERM", "EACCES"].includes(error.code)) throw error; }
  for (const file of files) {
    const result = await run(["enqueue", "--state", state, "--request", file], {
      createStore: () => assert.fail("invalid request must not open state"),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output.error.code, "VM_REQUEST_INVALID");
  }
});

test("enqueue validates first, persists without network and outputs only its summary", async (t) => {
  const { raw, state, request } = await fixture(t);
  const { calls, store, overrides } = dependencies(null);
  const now = () => 1000;
  let validated;
  const result = await run(["enqueue", "--state", state, "--request", request, "--id", "chosen-id"], {
    ...overrides, now, env: {},
    validate: (received) => { validated = received; return received; },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(validated, raw);
  assert.deepEqual(result.output, { id: "chosen-id", status: "queued" });
  assert.deepEqual(calls.stores, [{ file: path.resolve(state), now }]);
  assert.deepEqual(calls.enqueues, [{ receivedStore: store, raw, options: { id: "chosen-id", now } }]);
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.processes.length, 0);
  assert.equal(calls.closes, 1);
  assert.doesNotMatch(result.text, /Fixture review|media.example|output_root/u);
});

test("validation failure never opens a state file", async (t) => {
  const { state, request } = await fixture(t);
  for (const code of ["VM_REQUEST_INVALID", "VM_APPROVAL_REQUEST_INVALID"]) {
    const result = await run(["enqueue", "--state", state, "--request", request], {
      validate: () => { throw new VmSourceError(code); },
      createStore: () => assert.fail("invalid schema must not open state"),
    });
    assert.equal(result.exitCode, 2);
  }
});

test("status lists safe summaries or a single existing job without credentials", async (t) => {
  const { state } = await fixture(t);
  for (const [args, output] of [
    [[], { jobs: [{ id: "job-1", status: "queued" }] }],
    [["--id", "job-1"], { id: "job-1", status: "queued" }],
  ]) {
    const { calls, overrides } = dependencies({ id: "job-1", status: "queued", request: { reason: "private reason" } });
    const result = await run(["status", "--state", state, ...args], { ...overrides, env: {} });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.output, output);
    assert.equal(calls.clients.length, 0);
    assert.equal(calls.closes, 1);
    assert.doesNotMatch(result.text, /private reason/u);
  }
});

test("missing job reports a safe error and does not start login or contact VM", async (t) => {
  const { state } = await fixture(t);
  for (const command of ["status", "resume", "tick", "run"]) {
    const { calls, overrides } = dependencies(null);
    const result = await run([command, "--state", state, "--id", "absent"], {
      ...overrides, startLogin: () => assert.fail("missing job must not start login"),
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.output.error.code, "VM_APPROVAL_JOB_NOT_FOUND");
    assert.equal(calls.clients.length, 0);
    assert.equal(calls.closes, 1);
  }
});

test("missing token preserves the queued job and never invokes its worker", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides, store } = dependencies();
  const before = store.get("job-1");
  const result = await run(["tick", "--state", state, "--id", "job-1"], { ...overrides, env: {} });
  assert.equal(result.exitCode, 5);
  assert.deepEqual(result.output, { status: "auth_required", error: { code: "VM_AUTH_REQUIRED" } });
  assert.deepEqual(store.get("job-1"), before);
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.processes.length, 0);
  assert.equal(calls.closes, 1);
});

test("tick uses only the environment token and forwards absolute media tool paths", async (t) => {
  const { root, state } = await fixture(t);
  const { calls, overrides, store } = dependencies();
  const now = () => 2000;
  const ffprobe = path.join(root, "bin", "ffprobe");
  const ffmpeg = path.join(root, "bin", "ffmpeg");
  const result = await run(["tick", "--state", state, "--id", "job-1", "--ffprobe", ffprobe, "--ffmpeg", ffmpeg], {
    ...overrides, now,
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(calls.clients, [{ token: TOKEN }]);
  assert.deepEqual(calls.processes, [{ receivedStore: store, id: "job-1", options: {
    client: { fixture: true }, now, ffprobePath: ffprobe, ffmpegPath: ffmpeg,
  } }]);
  assert.equal(calls.closes, 1);
  assert.doesNotMatch(result.text, /fixture-token/u);
});

test("run waits in bounded intervals and stops once acquisition is ready", async (t) => {
  const { state } = await fixture(t);
  const { overrides, calls } = dependencies();
  let current = 1000;
  let advances = 0;
  const waits = [];
  const result = await run(["run", "--state", state, "--id", "job-1"], {
    ...overrides, now: () => current,
    processJob: async () => ({ id: "job-1", status: ++advances === 3 ? "ready" : "approval_pending", next_attempt_at: 61_000 }),
    sleep: async (milliseconds) => { waits.push(milliseconds); current += milliseconds; },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, "ready");
  assert.deepEqual(waits, [30_000, 30_000]);
  assert.equal(calls.clients.length, 1);
  assert.equal(calls.closes, 1);
});

test("run returns pending at its wait limit without another tick", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides } = dependencies({ id: "job-1", status: "approval_pending", next_attempt_at: 60_000 });
  let current = 0;
  const waits = [];
  const result = await run(["run", "--state", state, "--id", "job-1", "--max-wait-ms", "1500"], {
    ...overrides, now: () => current,
    sleep: async (milliseconds) => { waits.push(milliseconds); current += milliseconds; },
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(waits, [1500]);
  assert.equal(calls.processes.length, 1);
  assert.equal(calls.closes, 1);
});

test("terminal states exit without login, a new submission or downloading", async (t) => {
  const { state } = await fixture(t);
  for (const status of ["ready", "rejected", "canceled", "needs_attention", "auth_required", "dead_letter"]) {
    const { calls, overrides } = dependencies({ id: "job-1", status });
    const result = await run(["run", "--state", state, "--id", "job-1", "--login"], {
      ...overrides, startLogin: () => assert.fail("terminal job must be resumed explicitly"),
    });
    assert.equal(result.exitCode, status === "ready" ? 0 : status === "auth_required" ? 5 : 3);
    assert.equal(result.output.status, status);
    assert.equal(calls.processes.length, 0);
    assert.equal(calls.clients.length, 0);
    assert.equal(calls.closes, 1);
  }
});

test("resume delegates to workflow with retained state and no credentials", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides, store } = dependencies({ id: "job-1", status: "auth_required", submission_intent: { id: "intent-1" } });
  const now = () => 9000;
  const result = await run(["resume", "--state", state, "--id", "job-1"], { ...overrides, now, env: {} });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.status, "queued");
  assert.deepEqual(calls.resumes, [{ receivedStore: store, id: "job-1", options: { now } }]);
  assert.deepEqual(store.get("job-1").submission_intent, { id: "intent-1" });
  assert.equal(calls.clients.length, 0);
});

test("normal login announces its URL, keeps its token in memory and closes the listener", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides } = dependencies();
  const stdout = capture();
  let loginOptions;
  let closed = false;
  const exitCode = await main(["tick", "--state", state, "--id", "job-1", "--login"], {
    ...overrides, stdout: stdout.stream,
    startLogin: async (options) => {
      loginOptions = options;
      return { loginUrl: "https://login.example.com/normal-sso", token: Promise.resolve("fresh-token-never-output"), close: () => { closed = true; } };
    },
  });
  assert.equal(exitCode, 4);
  assert.deepEqual(loginOptions, { timeoutMs: 600_000 });
  const [loginLine, ...resultLines] = stdout.text().split("\n");
  assert.deepEqual(JSON.parse(loginLine), { status: "awaiting_login", login_url: "https://login.example.com/normal-sso" });
  assert.deepEqual(JSON.parse(resultLines.join("\n")), { id: "job-1", status: "queued" });
  assert.deepEqual(calls.clients, [{ token: "fresh-token-never-output" }]);
  assert.equal(closed, true);
  assert.equal(calls.closes, 1);
  assert.doesNotMatch(stdout.text(), /fresh-token|fixture-token/u);
});

test("interrupted login closes its listener and never starts VM processing", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides } = dependencies();
  const controller = new AbortController();
  const stdout = capture();
  let closed = false;
  const exitCode = await main(["tick", "--state", state, "--id", "job-1", "--login"], {
    ...overrides, signal: controller.signal, stdout: stdout.stream,
    startLogin: async () => {
      queueMicrotask(() => controller.abort());
      return { loginUrl: "https://login.example.com/normal-sso", token: new Promise(() => {}), close: () => { closed = true; } };
    },
  });
  assert.equal(exitCode, 130);
  assert.equal(closed, true);
  assert.equal(calls.clients.length, 0);
  assert.equal(calls.processes.length, 0);
  assert.equal(calls.closes, 1);
  assert.match(stdout.text(), /VM_APPROVAL_INTERRUPTED/u);
});

test("interrupting a wait releases resources without retrying the worker", async (t) => {
  const { state } = await fixture(t);
  const { calls, overrides } = dependencies();
  const controller = new AbortController();
  const result = await run(["run", "--state", state, "--id", "job-1"], {
    ...overrides, signal: controller.signal,
    sleep: async () => { controller.abort(); throw new Error("private abort details"); },
  });
  assert.equal(result.exitCode, 130);
  assert.equal(result.output.error.code, "VM_APPROVAL_INTERRUPTED");
  assert.equal(calls.processes.length, 1);
  assert.equal(calls.closes, 1);
  assert.doesNotMatch(result.text, /private abort details/u);
});

test("API and unexpected failures expose only safe codes and close resources", async (t) => {
  const { state } = await fixture(t);
  for (const [error, expected, exitCode] of [
    [new VmSourceError("VM_AUTH_REQUIRED"), "VM_AUTH_REQUIRED", 5],
    [new VmSourceError("VM_API_HTTP_FAILED"), "VM_API_HTTP_FAILED", 3],
    [new Error("Bearer private-token https://private.example?signed=secret"), "VM_APPROVAL_FAILED", 3],
  ]) {
    const { calls, overrides } = dependencies();
    const result = await run(["tick", "--state", state, "--id", "job-1"], {
      ...overrides, processJob: async () => { throw error; },
    });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.output.error.code, expected);
    assert.equal(calls.closes, 1);
    assert.doesNotMatch(result.text, /Bearer|private-token|https:|secret/u);
  }
});

test("normal login errors retain safe auth codes and close the listener", async (t) => {
  const { state } = await fixture(t);
  for (const [code, expectedExit] of [["VM_AUTH_TIMEOUT", 5], ["VM_AUTH_EXCHANGE_FAILED", 5], ["VM_AUTH_CANCELED", 130]]) {
    const { overrides, calls } = dependencies();
    const stdout = capture();
    let closed = false;
    const exitCode = await main(["tick", "--state", state, "--id", "job-1", "--login"], {
      ...overrides, stdout: stdout.stream,
      startLogin: async () => ({
        loginUrl: "https://login.example.com/normal-sso", token: Promise.reject(new VmApprovalAuthError(code)),
        close: () => { closed = true; },
      }),
    });
    assert.equal(exitCode, expectedExit);
    assert.equal(JSON.parse(stdout.text().trim().split("\n").at(-1)).error.code, code);
    assert.equal(closed, true);
    assert.equal(calls.clients.length, 0);
    assert.equal(calls.closes, 1);
  }
});

test("real queue and workflow preserve pending approval across commands and authentication renewal", async (t) => {
  const { state, raw, request } = await fixture(t);
  const applicationId = "application-1";
  await writeFile(request, JSON.stringify({ ...raw, application_id: applicationId }));
  const enqueueResult = await run(["enqueue", "--state", state, "--request", request, "--id", "job-1"], { env: {} });
  assert.equal(enqueueResult.exitCode, 0);
  assert.equal(enqueueResult.output.status, "queued");
  const identity = { raw: { feishu: {
    name: "Fixture User", user_id: "user-1", open_id: "open-1", enterprise_email: "fixture@example.com", departments: ["dep-1"],
  } } };
  let submits = 0;
  const client = {
    getIdentity: async () => identity,
    getVideos: async () => ({ videos: [{ id: VMID }], total: 1 }),
    getApplication: async () => ({
      id: applicationId, instanceCode: "instance-1", applyStatus: "PENDING", applyUser: { feishuUserId: "user-1" },
      applyReason: raw.reason, videoUse: "ORIGINAL", videoQuality: "HIGH", urlObjList: [{ id: VMID }],
    }),
    submitApplication: async () => { submits += 1; assert.fail("adopted application must not be submitted again"); },
  };
  const tick = await run(["tick", "--state", state, "--id", "job-1"], {
    env: { SHADOW_TOKEN: TOKEN }, createClient: () => client,
  });
  assert.equal(tick.exitCode, 4);
  assert.equal(tick.output.status, "waiting_approval");
  assert.equal(tick.output.application_id, applicationId);
  assert.equal(tick.output.submission_attempts, 0);
  const denied = await run(["tick", "--state", state, "--id", "job-1"], {
    env: { SHADOW_TOKEN: TOKEN }, now: () => tick.output.next_attempt_at,
    createClient: () => ({ ...client, getIdentity: async () => { throw new VmSourceError("VM_AUTH_REQUIRED"); } }),
  });
  assert.equal(denied.exitCode, 5);
  assert.equal(denied.output.status, "auth_required");
  const resumed = await run(["resume", "--state", state, "--id", "job-1"], { env: {} });
  assert.equal(resumed.exitCode, 0);
  assert.equal(resumed.output.status, "waiting_approval");
  const current = await run(["status", "--state", state, "--id", "job-1"], { env: {} });
  assert.equal(current.exitCode, 0);
  assert.equal(current.output.status, "waiting_approval");
  assert.equal(current.output.application_id, applicationId);
  assert.equal(current.output.submission_attempts, 0);
  assert.equal(submits, 0);
  for (const result of [enqueueResult, tick, denied, resumed, current]) {
    assert.doesNotMatch(result.text, /fixture-token|Fixture review|Fixture User|enterprise_email|output_root/u);
  }
});
