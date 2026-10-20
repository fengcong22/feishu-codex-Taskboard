import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createVmApprovalClient } from "../server/vm-approval-client.mjs";
import { createVmDownloadSession } from "../server/vm-download-session.mjs";
import { VmSourceError } from "../server/vm-source-transfer.mjs";

const IDENTITY = { name: "测试", user_id: "user-1", open_id: "open-1",
  enterprise_email: "fixture@example.test", departments: ["department-1"] };
const INITIAL = { status: "disconnected", account: null, expiresAt: null, expirySource: "unknown",
  lastCheckedAt: null, errorCode: null, automaticRefreshSupported: false, crossDeviceAuthorizationSupported: false };
const LOGIN_URL = "https://shadow.yangcong345.com/#/?fromWebUrl=fixture";
const TOKEN = "session-token-never-public";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function jwt(exp) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.fixture`;
}
function response(identity = IDENTITY, token) {
  return new Response(JSON.stringify({ raw: { feishu: identity } }), {
    headers: token ? { shadowauthorization: token } : {},
  });
}
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("Session did not reach the expected state");
}
function fixture(t, options = {}) {
  let time = 1_800_000_000_000;
  const logins = [], requests = [], changes = [], results = [];
  const session = createVmDownloadSession({
    now: () => time,
    checkIntervalMs: 60_000,
    startLogin: async () => {
      const token = deferred();
      const receiver = { loginUrl: LOGIN_URL, token: token.promise,
        closed: false, async close() { this.closed = true; } };
      logins.push({ ...token, receiver });
      return receiver;
    },
    createClient: ({ token, onToken }) => createVmApprovalClient({ token, onToken, fetchImpl: async (url, init) => {
      requests.push({ url, ...init });
      const result = results.shift();
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result() : result ?? response();
    } }),
    onChange: (value) => changes.push(value),
    ...options,
  });
  t.after(() => session.close());
  return { session, logins, requests, changes, results,
    advance(ms) { time += ms; },
    async connect(token = TOKEN) {
      await session.beginLogin();
      logins.at(-1).resolve(token);
      await until(() => session.snapshot().status !== "connecting");
    },
  };
}

test("login returns before SSO completes and concurrent callers reuse the receiver", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.session.snapshot(), INITIAL);
  const [first, second] = await Promise.all([f.session.beginLogin(), f.session.beginLogin()]);
  assert.deepEqual(first, { loginUrl: LOGIN_URL, session: { ...INITIAL, status: "connecting" } });
  assert.deepEqual(second, first);
  assert.equal(f.logins.length, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.client(), null);
  assert.equal(f.session.identity(), null);
  f.logins[0].resolve(TOKEN);
  await until(() => f.session.snapshot().status === "connected");
  assert.deepEqual(f.session.snapshot(), { ...INITIAL, status: "connected",
    account: { name: "测试", userId: "user-1" }, lastCheckedAt: 1_800_000_000_000 });
  assert.ok(f.session.client());
  assert.deepEqual(f.session.identity(), IDENTITY);
  assert.equal(f.logins[0].receiver.closed, true);
  const copy = f.session.identity();
  copy.departments.push("injected");
  assert.deepEqual(f.session.identity(), IDENTITY);
  assert.doesNotMatch(JSON.stringify({ session: f.session.snapshot(), changes: f.changes }), /session-token|enterprise_email|open_id|raw|shadowToken/u);
});

test("JWT expiry is metadata and even a past expiry does not replace server verification", async (t) => {
  const f = fixture(t);
  await f.connect(jwt(1_700_000_000));
  assert.equal(f.session.snapshot().status, "connected");
  assert.equal(f.session.snapshot().expiresAt, 1_700_000_000_000);
  assert.equal(f.session.snapshot().expirySource, "token");
  assert.equal(f.requests.length, 1);
});

test("rotated credentials update expiry in the shared client and opaque rotation clears it", async (t) => {
  const f = fixture(t);
  f.results.push(response(IDENTITY, jwt(1_900_000_000)));
  await f.connect(jwt(1_800_000_000));
  assert.equal(f.session.snapshot().expiresAt, 1_900_000_000_000);
  const shared = f.session.client();
  f.results.push(response(IDENTITY, "opaque-rotated-token"));
  await shared.getIdentity();
  assert.equal(f.requests[1].headers.authorization, jwt(1_900_000_000));
  assert.equal(f.session.snapshot().expiresAt, null);
  assert.equal(f.session.snapshot().expirySource, "unknown");
  await shared.getIdentity();
  assert.equal(f.requests[2].headers.authorization, "opaque-rotated-token");
  assert.equal(f.session.client(), shared);
});

test("malformed JWT exp never fabricates an expiry", async (t) => {
  for (const token of [TOKEN, jwt("1900000000"), jwt(-1), jwt(null), jwt(1e100), "a.not-json.c"]) {
    const f = fixture(t);
    await f.connect(token);
    assert.equal(f.session.snapshot().expiresAt, null);
    assert.equal(f.session.snapshot().expirySource, "unknown");
  }
});

test("invalid identity cannot create an authenticated session", async (t) => {
  for (const identity of [null, {}, { ...IDENTITY, user_id: "" }, { ...IDENTITY, open_id: "bad\nid" },
    { ...IDENTITY, departments: [] }, { ...IDENTITY, enterprise_email: "" }]) {
    const f = fixture(t);
    f.results.push(response(identity));
    await f.connect();
    assert.equal(f.session.snapshot().status, "auth_required");
    assert.equal(f.session.snapshot().errorCode, "VM_IDENTITY_INVALID");
    assert.equal(f.session.snapshot().account, null);
    assert.equal(f.session.identity(), null);
    assert.equal(f.session.client(), null);
  }
});

test("disconnect invalidates a late SSO token without creating a client", async (t) => {
  const f = fixture(t);
  await f.session.beginLogin();
  await f.session.disconnect();
  f.logins[0].resolve(TOKEN);
  await nextTurn();
  assert.deepEqual(f.session.snapshot(), INITIAL);
  assert.equal(f.requests.length, 0);
  assert.equal(f.logins[0].receiver.closed, true);
});

test("disconnect closes a receiver whose startup completes late", async (t) => {
  const started = deferred(), token = deferred();
  let closed = false;
  const f = fixture(t, { startLogin: () => started.promise });
  const beginning = f.session.beginLogin();
  const rejected = assert.rejects(beginning, { code: "VM_AUTH_CANCELED" });
  await f.session.disconnect();
  started.resolve({ loginUrl: LOGIN_URL, token: token.promise, async close() { closed = true; token.reject(new Error(TOKEN)); } });
  await rejected;
  assert.equal(closed, true);
  assert.deepEqual(f.session.snapshot(), INITIAL);
});

test("disconnect during identity verification cannot publish a late account", async (t) => {
  const f = fixture(t), identity = deferred();
  f.results.push(() => identity.promise);
  await f.session.beginLogin();
  f.logins[0].resolve(TOKEN);
  await until(() => f.requests.length === 1);
  await f.session.disconnect();
  identity.resolve(response());
  await nextTurn();
  assert.deepEqual(f.session.snapshot(), INITIAL);
  assert.equal(f.session.identity(), null);
});

test("transient network failure retains the credential for recovery without reporting expiry", async (t) => {
  const f = fixture(t);
  await f.connect();
  const shared = f.session.client();
  f.advance(60_000);
  f.results.push(new Error(`network failure ${TOKEN}`));
  const failed = await f.session.check();
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.errorCode, "VM_API_TRANSPORT_FAILED");
  assert.equal(failed.lastCheckedAt, 1_800_000_060_000);
  assert.deepEqual(failed.account, { name: "测试", userId: "user-1" });
  assert.deepEqual(f.session.identity(), IDENTITY);
  assert.equal(f.session.client(), null);
  assert.equal((await f.session.check()).status, "connected");
  assert.equal(f.session.client(), shared);
  assert.equal(f.session.snapshot().errorCode, null);
});

test("authentication rejection stops checks until a freshly verified login", async (t) => {
  const f = fixture(t);
  await f.connect();
  f.results.push(new Response("private", { status: 401 }));
  assert.equal((await f.session.check()).status, "auth_required");
  assert.equal(f.session.snapshot().errorCode, "VM_AUTH_REQUIRED");
  assert.equal(f.session.client(), null);
  assert.deepEqual(f.session.identity(), IDENTITY);
  await f.session.check();
  assert.equal(f.requests.length, 2);
  await f.connect("new-session-token");
  assert.equal(f.session.snapshot().status, "connected");
  assert.equal(f.requests[2].headers.authorization, "new-session-token");
});

test("workflow authentication rejection requires new login while preserving notification identity", async (t) => {
  const f = fixture(t);
  await f.connect(jwt(1_950_000_000));
  const required = await f.session.requireLogin();
  assert.equal(required.status, "auth_required");
  assert.equal(required.errorCode, "VM_AUTH_REQUIRED");
  assert.equal(required.expiresAt, 1_950_000_000_000);
  assert.deepEqual(f.session.identity(), IDENTITY);
  assert.equal(f.session.client(), null);
  await f.session.check();
  assert.equal(f.requests.length, 1);
  await f.connect();
  assert.equal(f.session.snapshot().status, "connected");
});

test("requireLogin fences in-flight checks and accepts only explicit authentication codes", async (t) => {
  const f = fixture(t), delayed = deferred();
  await f.connect(jwt(1_950_000_000));
  f.results.push(() => delayed.promise);
  const checking = f.session.check();
  await until(() => f.requests.length === 2);
  await f.session.requireLogin(`private ${TOKEN}`);
  delayed.resolve(response(IDENTITY, jwt(1_600_000_000)));
  await checking;
  assert.equal(f.session.snapshot().status, "auth_required");
  assert.equal(f.session.snapshot().expiresAt, 1_950_000_000_000);
  assert.equal(f.session.snapshot().errorCode, "VM_AUTH_REQUIRED");
  assert.equal(f.session.client(), null);
  assert.doesNotMatch(JSON.stringify(f.changes), /session-token/u);
  await f.session.requireLogin("VM_APPLICANT_CHANGED");
  assert.equal(f.session.snapshot().errorCode, "VM_APPLICANT_CHANGED");
  await f.session.requireLogin("VM_API_TRANSPORT_FAILED");
  assert.equal(f.session.snapshot().errorCode, "VM_AUTH_REQUIRED");
});

test("requireLogin cancels pending SSO and cannot revive a closed session", async (t) => {
  const f = fixture(t);
  await f.session.beginLogin();
  await f.session.requireLogin();
  f.logins[0].resolve(TOKEN);
  await nextTurn();
  assert.equal(f.logins[0].receiver.closed, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.snapshot().status, "auth_required");
  await f.session.close();
  assert.deepEqual(await f.session.requireLogin(), INITIAL);
});

test("a changed identity requires explicit login before it can replace the account", async (t) => {
  const f = fixture(t);
  await f.connect();
  const other = { ...IDENTITY, name: "另一用户", user_id: "user-2", open_id: "open-2" };
  f.results.push(response(other));
  assert.equal((await f.session.check()).errorCode, "VM_APPLICANT_CHANGED");
  assert.equal(f.session.snapshot().status, "auth_required");
  assert.equal(f.session.identity().user_id, "user-1");
  f.results.push(response(other));
  await f.connect("other-user-token");
  assert.deepEqual(f.session.snapshot().account, { name: "另一用户", userId: "user-2" });
});

test("concurrent checks share one request and late old results cannot alter a new login", async (t) => {
  const f = fixture(t), delayed = deferred();
  await f.connect();
  f.results.push(() => delayed.promise);
  const first = f.session.check(), second = f.session.check();
  await until(() => f.requests.length === 2);
  assert.equal(f.requests.length, 2);
  await f.connect(jwt(1_950_000_000));
  const latest = f.session.client();
  delayed.resolve(response(IDENTITY, jwt(1_600_000_000)));
  await Promise.all([first, second]);
  assert.equal(f.session.snapshot().status, "connected");
  assert.equal(f.session.snapshot().expiresAt, 1_950_000_000_000);
  assert.equal(f.session.client(), latest);
});

test("background login failures publish safe codes and remain reconnectable", async (t) => {
  const f = fixture(t);
  await f.session.beginLogin();
  f.logins[0].reject(Object.assign(new Error(TOKEN), { code: TOKEN }));
  await until(() => f.session.snapshot().status !== "connecting");
  assert.equal(f.session.snapshot().errorCode, "VM_AUTH_FAILED");
  assert.equal(f.session.client(), null);
  assert.doesNotMatch(JSON.stringify(f.changes), /session-token/u);
  await f.connect();
  assert.equal(f.session.snapshot().status, "connected");
});

test("SSO exchange transport failures are unavailable rather than expired authentication", async (t) => {
  const f = fixture(t);
  await f.session.beginLogin();
  f.logins[0].reject(new VmSourceError("VM_AUTH_TRANSPORT_FAILED"));
  await until(() => f.session.snapshot().status !== "connecting");
  assert.equal(f.session.snapshot().status, "unavailable");
  assert.equal(f.session.snapshot().errorCode, "VM_AUTH_TRANSPORT_FAILED");
  assert.equal(f.session.client(), null);
  await f.connect();
  assert.equal(f.session.snapshot().status, "connected");
});

test("close cancels pending login and blocks every late result", async (t) => {
  const f = fixture(t);
  await f.session.beginLogin();
  await f.session.close();
  f.logins[0].resolve(TOKEN);
  await nextTurn();
  assert.equal(f.logins[0].receiver.closed, true);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.session.snapshot(), INITIAL);
  await assert.rejects(f.session.beginLogin(), { code: "VM_AUTH_CANCELED" });
});

test("a transient first identity check can recover without another SSO login", async (t) => {
  const f = fixture(t);
  f.results.push(new Error(TOKEN));
  await f.connect();
  assert.equal(f.session.snapshot().status, "unavailable");
  assert.equal(f.session.identity(), null);
  assert.equal((await f.session.check()).status, "connected");
  assert.deepEqual(f.session.identity(), IDENTITY);
});

test("periodic verification continues until close and observer failures do not corrupt state", async (t) => {
  const checked = deferred();
  const f = fixture(t, { checkIntervalMs: 10, onChange: async (snapshot) => {
    if (snapshot.status === "auth_required") checked.resolve();
    throw new Error(TOKEN);
  } });
  await f.connect();
  f.results.push(new Response("private", { status: 403 }));
  await Promise.race([checked.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Periodic verification did not run")), 1000);
    checked.promise.then(() => clearTimeout(timer));
  })]);
  assert.equal(f.session.snapshot().status, "auth_required");
  await f.session.close();
  assert.deepEqual(f.session.snapshot(), INITIAL);
  await assert.rejects(f.session.beginLogin(), { code: "VM_AUTH_CANCELED" });
  assert.deepEqual(await f.session.check(), INITIAL);
});

test("invalid session dependencies fail before any login or timers", () => {
  for (const options of [{ now: false }, { startLogin: null }, { createClient: false },
    { checkIntervalMs: 0 }, { checkIntervalMs: 1.1 }, { checkIntervalMs: 2_147_483_648 }, { onChange: false }]) {
    assert.throws(() => createVmDownloadSession(options), { code: "VM_AUTH_INPUT_INVALID" });
  }
});
