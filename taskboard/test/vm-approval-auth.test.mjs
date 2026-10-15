import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { startVmLogin, VM_APPROVAL_ORIGIN } from "../server/vm-approval-auth.mjs";

function callbackUrl(login) {
  const query = new URLSearchParams(new URL(login.loginUrl).hash.slice(3));
  return new URL(query.get("fromWebUrl"));
}

function callback(url, { host, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, agent: false, headers: host ? { host } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function loginFixture(t, options = {}) {
  const login = await startVmLogin({ timeoutMs: 10_000, ...options });
  t.after(() => login.close());
  const url = callbackUrl(login);
  url.searchParams.set("code", "fixture-code");
  return { login, url };
}

test("SSO uses random loopback callback and fixed code exchange without auth or cookies", async (t) => {
  const calls = [];
  const { login, url } = await loginFixture(t, { fetchImpl: async (uri, init) => {
    calls.push({ uri, init });
    return new Response(JSON.stringify({ shadowToken: "Bearer fixture-token" }));
  } });
  assert.equal(new URL(login.loginUrl).origin, VM_APPROVAL_ORIGIN);
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/vm-auth\/[a-f0-9]{48}$/u);
  assert.match(url.searchParams.get("state"), /^[a-f0-9]{64}$/u);
  const result = await callback(url);
  assert.equal(await login.token, "fixture-token");
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["referrer-policy"], "no-referrer");
  assert.doesNotMatch(result.text, /fixture-(code|token)/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].uri, `${VM_APPROVAL_ORIGIN}/api/auth/code/fixture-code`);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
  assert.equal(login.status, "authorized");
  assert.equal(Object.isFrozen(login), true);
});

test("invalid state, host, callback path and code do not consume the login", async (t) => {
  let calls = 0;
  const { login, url } = await loginFixture(t, { exchange: async () => { calls++; return "fixture-token"; } });
  const badState = new URL(url); badState.searchParams.set("state", "bad");
  const badPath = new URL(url); badPath.pathname = "/wrong";
  const duplicate = new URL(url); duplicate.searchParams.append("code", "other");
  const duplicateState = new URL(url); duplicateState.searchParams.append("state", "other");
  const empty = new URL(url); empty.searchParams.set("code", "");
  const tooLong = new URL(url); tooLong.searchParams.set("code", "x".repeat(4097));
  const whitespace = new URL(url); whitespace.searchParams.set("code", "code\nsecret");
  for (const changed of [badState, badPath, duplicate, duplicateState, empty, tooLong, whitespace]) {
    assert.equal((await callback(changed)).status, 400);
  }
  assert.equal((await callback(url, { host: "evil.example" })).status, 400);
  assert.equal((await callback(url, { method: "POST" })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await callback(url)).status, 200);
  assert.equal(await login.token, "fixture-token");
  assert.equal(calls, 1);
});

test("accepted callback is one-use while exchange is in progress", async (t) => {
  let release;
  let started;
  let calls = 0;
  const began = new Promise((resolve) => { started = resolve; });
  const { login, url } = await loginFixture(t, { exchange: async () => {
    calls++;
    started();
    return new Promise((resolve) => { release = resolve; });
  } });
  const first = callback(url);
  await began;
  assert.equal((await callback(url)).status, 400);
  release("fixture-token");
  assert.equal((await first).status, 200);
  assert.equal(await login.token, "fixture-token");
  assert.equal(calls, 1);
});

test("exchange failures are sanitized and do not print callback or token", async (t) => {
  const { login, url } = await loginFixture(t, { exchange: async () => { throw new Error("private-token https://private/?code=fixture-code"); } });
  const rejected = assert.rejects(login.token, (error) => {
    assert.equal(error.code, "VM_AUTH_EXCHANGE_FAILED");
    assert.doesNotMatch(`${error.stack}${JSON.stringify(error)}`, /private-token|https:|fixture-code/u);
    return true;
  });
  const result = await callback(url);
  await rejected;
  assert.equal(result.status, 502);
  assert.doesNotMatch(result.text, /private-token|https:|fixture-code/u);
});

test("login expires and closes the loopback listener", async (t) => {
  const { login, url } = await loginFixture(t, { timeoutMs: 30, exchange: async () => "unused" });
  await assert.rejects(login.token, { code: "VM_AUTH_TIMEOUT" });
  assert.equal(login.status, "expired");
  await assert.rejects(callback(url));
});

test("close cancels pending login idempotently", async (t) => {
  const { login, url } = await loginFixture(t, { exchange: async () => "unused" });
  const rejected = assert.rejects(login.token, { code: "VM_AUTH_CANCELED" });
  await login.close();
  await login.close();
  await rejected;
  await assert.rejects(callback(url));
});

test("timeout cannot later be turned into a successful login by a late exchange", async (t) => {
  let release;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const { login, url } = await loginFixture(t, { timeoutMs: 60, exchange: async () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  } });
  const requestResult = callback(url).catch(() => null);
  await began;
  await assert.rejects(login.token, { code: "VM_AUTH_TIMEOUT" });
  release("must-not-publish-token");
  await requestResult;
  assert.equal(login.status, "expired");
  await assert.rejects(login.token, { code: "VM_AUTH_TIMEOUT" });
});

test("closing cancels a stalled exchange and a stalled response stream", async (t) => {
  for (const stalledBody of [false, true]) {
    let signal;
    let began;
    let bodyCanceled = false;
    const started = new Promise((resolve) => { began = resolve; });
    const { login, url } = await loginFixture(t, { fetchImpl: async (_, init) => {
      signal = init.signal;
      began();
      if (!stalledBody) return new Promise(() => {});
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
        cancel() { bodyCanceled = true; },
      }));
    } });
    const pending = callback(url).catch(() => null);
    await started;
    await login.close();
    await assert.rejects(login.token, { code: "VM_AUTH_CANCELED" });
    await pending;
    assert.equal(signal.aborted, true);
    if (stalledBody) assert.equal(bodyCanceled, true);
  }
});

test("fixed exchange rejects HTTP failures, redirects, malformed and oversized data", async (t) => {
  for (const [response, code] of [
    [new Response("secret", { status: 401 }), "VM_AUTH_REQUIRED"],
    [new Response("secret", { status: 403 }), "VM_AUTH_REQUIRED"],
    [new Response("secret", { status: 500 }), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response("", { status: 302, headers: { location: "https://evil.example" } }), "VM_AUTH_EXCHANGE_FAILED"],
    [{ status: 200, redirected: true }, "VM_AUTH_EXCHANGE_FAILED"],
    [new Response("{"), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response(new Uint8Array([255])), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response("{}"), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response('{"shadowToken":"Bearer"}'), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response('{"shadowToken":"secret\\nvalue"}'), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }), "VM_AUTH_EXCHANGE_FAILED"],
    [new Response(`"${"x".repeat(2 * 1024 * 1024)}"`), "VM_AUTH_EXCHANGE_FAILED"],
  ]) {
    const { login, url } = await loginFixture(t, { fetchImpl: async () => response });
    const rejected = assert.rejects(login.token, { code });
    assert.equal((await callback(url)).status, 502);
    await rejected;
  }
});

test("rejects invalid login configuration before listening", async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 0.5 }, { timeoutMs: 2_147_483_648 }, { exchange: false }, { fetchImpl: null }]) {
    await assert.rejects(startVmLogin(options), { code: "VM_AUTH_INPUT_INVALID" });
  }
});
