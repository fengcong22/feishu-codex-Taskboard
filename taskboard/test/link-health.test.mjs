import assert from "node:assert/strict";
import { test } from "node:test";

import { createLinkHealthMonitor } from "../server/link-health.mjs";

const BRIDGE = () => new URL("http://127.0.0.1:47824");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function monitor(overrides = {}) {
  return createLinkHealthMonitor({
    bridgeUrl: BRIDGE,
    intervalMs: 30_000,
    ...overrides,
  });
}

test("a healthy bridge is cached as a redacted snapshot and never probed by a read", async () => {
  let calls = 0;
  const subject = monitor({
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(String(url), "http://127.0.0.1:47824/health");
      return jsonResponse({
        ok: true,
        feishuListener: { state: "sdk_managed", lastEventAt: "2026-11-18T07:00:00.000Z", lastError: null },
        queue: { pending: 2, processing: 1, retryWait: 3, deadLetter: 0 },
      });
    },
  });
  await subject.sample();
  assert.equal(calls, 1);
  const first = subject.snapshot();
  // Reading the snapshot must not probe again.
  subject.snapshot();
  subject.snapshot();
  assert.equal(calls, 1);
  assert.equal(first.bridge.state, "up");
  assert.equal(first.bridge.stale, false);
  assert.equal(first.bridge.listener.state, "sdk_managed");
  assert.equal(first.bridge.listener.lastEventAt, "2026-11-18T07:00:00.000Z");
  assert.deepEqual(first.bridge.queue, { pending: 2, processing: 1, retryWait: 3, deadLetter: 0, deadLetterAcknowledged: null });
  await subject.close();
});

test("an unreachable bridge stays down instead of reading as unknown", async () => {
  const subject = monitor({
    fetchImpl: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:47824"); },
  });
  await subject.sample();
  const snapshot = subject.snapshot();
  assert.equal(snapshot.bridge.state, "down");
  // The raw error can carry a host and path, so it is never surfaced.
  assert.equal(snapshot.bridge.detail, null);
  await subject.close();
});

test("an HTTP error and a non-JSON body are reported as safe codes", async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response("nope", { status: 502 }), "HTTP_502"],
    [async () => new Response("not json", { status: 200 }), "INVALID_RESPONSE"],
  ]) {
    const subject = monitor({ fetchImpl });
    await subject.sample();
    const snapshot = subject.snapshot();
    assert.equal(snapshot.bridge.state, "error");
    assert.equal(snapshot.bridge.detail, expected);
    await subject.close();
  }
});

test("an unset or non-loopback bridge address is not probed at all", async () => {
  let calls = 0;
  const unset = monitor({ bridgeUrl: () => null, fetchImpl: async () => { calls += 1; return jsonResponse({}); } });
  await unset.sample();
  assert.equal(calls, 0);
  assert.equal(unset.snapshot().bridge.state, "unconfigured");
  await unset.close();

  const throwing = monitor({
    bridgeUrl: () => { throw new Error("bad url"); },
    fetchImpl: async () => { calls += 1; return jsonResponse({}); },
  });
  await throwing.sample();
  assert.equal(calls, 0);
  assert.equal(throwing.snapshot().bridge.state, "unconfigured");
  await throwing.close();
});

test("a stale sample is flagged rather than trusted forever", async () => {
  let clock = Date.parse("2026-11-18T08:00:00.000Z");
  const subject = monitor({
    now: () => clock,
    intervalMs: 30_000,
    fetchImpl: async () => jsonResponse({
      feishuListener: { state: "sdk_managed", lastEventAt: null, lastError: null },
      queue: { pending: 0, processing: 0, retryWait: 0, deadLetter: 0 },
    }),
  });
  await subject.sample();
  assert.equal(subject.snapshot().bridge.stale, false);
  clock += 30_000 * 5;
  const later = subject.snapshot();
  assert.equal(later.bridge.stale, true);
  assert.equal(later.bridge.ageMs, 150_000);
  await subject.close();
});

test("remote field names and values are whitelisted, so unknown data cannot reach the board", async () => {
  const subject = monitor({
    fetchImpl: async () => jsonResponse({
      feishuListener: { state: "sdk_managed", lastEventAt: "not a date", lastError: { code: "lowercase" }, secret: "leak" },
      queue: { pending: -1, processing: "many", retryWait: 1.5, deadLetter: 4, extra: 9 },
      internalToken: "leak",
    }),
  });
  await subject.sample();
  const { bridge } = subject.snapshot();
  assert.equal(bridge.listener.lastEventAt, null);
  assert.equal(bridge.listener.lastError, null);
  assert.equal(bridge.listener.secret, undefined);
  assert.deepEqual(bridge.queue, { pending: null, processing: null, retryWait: null, deadLetter: 4, deadLetterAcknowledged: null });
  assert.equal(bridge.internalToken, undefined);
  await subject.close();
});

test("VM sign-in and the local automation switch are read without side effects", async () => {
  let sessionReads = 0;
  const subject = monitor({
    fetchImpl: async () => jsonResponse({ feishuListener: { state: "disabled" } }),
    vmSession: () => {
      sessionReads += 1;
      return { status: "connected", account: { name: "张三", userId: "u1" }, expiresAt: 1_800_000_000_000, errorCode: null };
    },
    automaticExecution: () => ({ enabled: false, version: 7 }),
  });
  await subject.sample();
  const snapshot = subject.snapshot();
  assert.ok(sessionReads >= 1);
  assert.deepEqual(snapshot.vmSession, {
    status: "connected", accountName: "张三", expiresAt: 1_800_000_000_000, errorCode: null,
  });
  assert.deepEqual(snapshot.automaticExecution, { enabled: false, version: 7 });
  await subject.close();
});

test("a failing probe source degrades to null instead of breaking the whole read", async () => {
  const subject = monitor({
    fetchImpl: async () => jsonResponse({}),
    vmSession: () => { throw new Error("vm store unavailable"); },
    automaticExecution: () => { throw new Error("db unavailable"); },
  });
  await subject.sample();
  const snapshot = subject.snapshot();
  assert.equal(snapshot.vmSession, null);
  assert.equal(snapshot.automaticExecution, null);
  await subject.close();
});

test("start samples immediately and close stops the timer", async () => {
  let calls = 0;
  const subject = monitor({
    intervalMs: 10,
    fetchImpl: async () => { calls += 1; return jsonResponse({ feishuListener: { state: "sdk_managed" } }); },
  });
  subject.start();
  await subject.sample();
  assert.ok(calls >= 1);
  await subject.close();
  const after = calls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, after, "no probe runs after close");
});
