import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const VM_APPROVAL_ORIGIN = "https://shadow.yangcong345.com";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CODE_LENGTH = 4096;
const EXCHANGE_TIMEOUT_MS = 20_000;
const SAFE_TOKEN = /^[\x21-\x7e]+$/u;

export class VmApprovalAuthError extends Error {
  constructor(code) {
    const safe = typeof code === "string" && /^VM_AUTH_[A-Z0-9_]{1,70}$/u.test(code)
      ? code : "VM_AUTH_FAILED";
    super(safe);
    this.name = "VmApprovalAuthError";
    this.code = safe;
  }
}

function fail(code) { throw new VmApprovalAuthError(code); }
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

async function readJson(response, signal) {
  const length = response.headers?.get("content-length");
  if (length !== null && length !== undefined) {
    if (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES) fail("VM_AUTH_EXCHANGE_FAILED");
  }
  if (!response.body || typeof response.body.getReader !== "function") fail("VM_AUTH_EXCHANGE_FAILED");
  const reader = response.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abortRead, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) fail("VM_AUTH_TIMEOUT");
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("VM_AUTH_EXCHANGE_FAILED");
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("VM_AUTH_EXCHANGE_FAILED");
      chunks.push(value);
    }
    if (signal.aborted) fail("VM_AUTH_TIMEOUT");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
    catch { fail("VM_AUTH_EXCHANGE_FAILED"); }
  } finally {
    signal.removeEventListener("abort", abortRead);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function normalizeToken(value) {
  if (typeof value !== "string") fail("VM_AUTH_EXCHANGE_FAILED");
  const token = value.trim().replace(/^Bearer(?:\s+|$)/iu, "");
  if (!token || token.length > 16_384 || !SAFE_TOKEN.test(token)) fail("VM_AUTH_EXCHANGE_FAILED");
  return token;
}

async function defaultExchange(code, fetchImpl, signal) {
  const controller = new AbortController();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(new VmApprovalAuthError("VM_AUTH_TIMEOUT")); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timer;
  let response;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new VmApprovalAuthError("VM_AUTH_TIMEOUT")); }, EXCHANGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([timeout, aborted, (async () => {
      try {
        response = await fetchImpl(`${VM_APPROVAL_ORIGIN}/api/auth/code/${encodeURIComponent(code)}`, {
          method: "GET", headers: { accept: "application/json" }, credentials: "omit",
          redirect: "error", signal: controller.signal,
        });
      } catch { fail(controller.signal.aborted ? "VM_AUTH_TIMEOUT" : "VM_AUTH_TRANSPORT_FAILED"); }
      if (controller.signal.aborted) fail("VM_AUTH_TIMEOUT");
      if (!response || !Number.isInteger(response.status) || response.redirected === true) fail("VM_AUTH_EXCHANGE_FAILED");
      if (response.status === 401 || response.status === 403) fail("VM_AUTH_REQUIRED");
      if (response.status < 200 || response.status >= 300) fail("VM_AUTH_EXCHANGE_FAILED");
      const body = await readJson(response, controller.signal);
      if (!plainObject(body) || typeof body.shadowToken !== "string") fail("VM_AUTH_EXCHANGE_FAILED");
      return normalizeToken(body.shadowToken);
    })()]);
  } catch (error) {
    if (error instanceof VmApprovalAuthError) throw error;
    fail(controller.signal.aborted ? "VM_AUTH_TIMEOUT" : "VM_AUTH_EXCHANGE_FAILED");
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener("abort", abort);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

/** Starts a temporary loopback SSO receiver. The token is never written to disk. */
export async function startVmLogin({ timeoutMs = 600_000, exchange, fetchImpl = globalThis.fetch } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || (exchange !== undefined && typeof exchange !== "function") || typeof fetchImpl !== "function") {
    fail("VM_AUTH_INPUT_INVALID");
  }
  const state = randomBytes(32).toString("hex");
  const callbackPath = `/vm-auth/${randomBytes(24).toString("hex")}`;
  let status = "waiting";
  let settled = false;
  let server;
  let timeout;
  let resolveToken;
  let rejectToken;
  const lifetime = new AbortController();
  const token = new Promise((resolve, reject) => { resolveToken = resolve; rejectToken = reject; });
  token.catch(() => {});
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) rejectToken(error); else resolveToken(value);
  };
  const stopServer = async (destroy = false) => {
    if (!server?.listening) return;
    const stopped = new Promise((resolve) => server.close(() => resolve()));
    if (destroy) server.closeAllConnections();
    await stopped;
  };
  const close = async () => {
    if (!settled) { status = "closed"; finish(new VmApprovalAuthError("VM_AUTH_CANCELED")); }
    lifetime.abort();
    await stopServer(true);
  };
  server = createServer({ requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    const host = request.headers.host;
    let url;
    try { url = new URL(request.url ?? "", `http://${host ?? "127.0.0.1"}`); } catch { response.writeHead(400); response.end("Invalid callback."); return; }
    const valid = request.method === "GET" && host === `127.0.0.1:${server.address()?.port}`
      && url.origin === `http://${host}`
      && url.pathname === callbackPath && url.searchParams.get("state") === state
      && url.searchParams.getAll("state").length === 1
      && url.searchParams.getAll("code").length === 1 && status === "waiting" && !settled;
    if (!valid) { response.writeHead(400); response.end("Invalid or expired callback."); return; }
    const code = url.searchParams.get("code");
    if (!code || code.length > MAX_CODE_LENGTH || !SAFE_TOKEN.test(code)) {
      response.writeHead(400); response.end("Invalid callback."); return;
    }
    status = "exchanging";
    try {
      const value = exchange ? await exchange(code, { timeoutMs: EXCHANGE_TIMEOUT_MS, signal: lifetime.signal })
        : await defaultExchange(code, fetchImpl, lifetime.signal);
      if (settled) { response.writeHead(410); response.end("Expired callback."); return; }
      finish(null, normalizeToken(value));
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("VM authorization completed. You may close this window.");
      status = "authorized";
      await stopServer();
    } catch (error) {
      const safe = error instanceof VmApprovalAuthError ? error : new VmApprovalAuthError("VM_AUTH_EXCHANGE_FAILED");
      if (settled) return;
      finish(safe);
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("VM authorization exchange failed.");
      status = "exchange_failed";
      await stopServer();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = () => reject(new VmApprovalAuthError("VM_AUTH_LISTENER_FAILED"));
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", onError); resolve(); });
    });
  } catch (error) { finish(error); throw error; }
  server.on("error", () => { finish(new VmApprovalAuthError("VM_AUTH_LISTENER_FAILED")); void close(); });
  timeout = setTimeout(() => {
    status = "expired";
    finish(new VmApprovalAuthError("VM_AUTH_TIMEOUT"));
    lifetime.abort();
    void stopServer(true);
  }, timeoutMs);
  if (typeof timeout.unref === "function") timeout.unref();
  const port = server.address().port;
  const callback = `http://127.0.0.1:${port}${callbackPath}?state=${encodeURIComponent(state)}`;
  return Object.freeze({ loginUrl: `${VM_APPROVAL_ORIGIN}/#/?fromWebUrl=${encodeURIComponent(callback)}`, token, close, get status() { return status; } });
}
