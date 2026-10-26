import { startVmLogin } from "./vm-approval-auth.mjs";
import { createVmApprovalClient, VM_APPROVAL_ORIGIN } from "./vm-approval-client.mjs";
import { VmSourceError } from "./vm-source-transfer.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_ERRORS = new Set([
  "VM_AUTH_REQUIRED", "VM_AUTH_CANCELED", "VM_AUTH_TIMEOUT", "VM_AUTH_FAILED",
  "VM_AUTH_INPUT_INVALID", "VM_AUTH_EXCHANGE_FAILED", "VM_AUTH_TRANSPORT_FAILED", "VM_AUTH_LISTENER_FAILED",
  "VM_API_INPUT_INVALID", "VM_API_TIMEOUT", "VM_API_TRANSPORT_FAILED", "VM_API_HTTP_FAILED",
  "VM_API_RESPONSE_TOO_LARGE", "VM_API_RESPONSE_INVALID", "VM_API_PAGINATION_INVALID", "VM_API_LIMIT_EXCEEDED",
  "VM_IDENTITY_INVALID", "VM_APPLICANT_CHANGED",
]);
const AUTH_FAILURES = new Set(["VM_AUTH_REQUIRED", "VM_IDENTITY_INVALID", "VM_APPLICANT_CHANGED"]);

function fail(code) { throw new VmSourceError(code); }
function safeCode(error, fallback) { return SAFE_ERRORS.has(error?.code) ? error.code : fallback; }
function text(value, max = 200) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function identityFrom(response) {
  const identity = response?.raw?.feishu;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)
    || !text(identity.name) || !text(identity.user_id) || !ID.test(identity.user_id)
    || !text(identity.open_id) || !ID.test(identity.open_id) || !text(identity.enterprise_email, 320)
    || !Array.isArray(identity.departments) || !identity.departments.length
    || identity.departments.some((id) => !text(id) || !ID.test(id))) fail("VM_IDENTITY_INVALID");
  // Keep only verified fields needed by the worker and notification transport.
  return { name: identity.name, user_id: identity.user_id, open_id: identity.open_id,
    enterprise_email: identity.enterprise_email, departments: [...identity.departments] };
}
function normalizeToken(value) {
  if (typeof value !== "string") fail("VM_AUTH_EXCHANGE_FAILED");
  const token = value.trim().replace(/^Bearer(?:\s+|$)/iu, "");
  if (!token || token.length > 16_384 || !/^[\x21-\x7e]+$/u.test(token)) fail("VM_AUTH_EXCHANGE_FAILED");
  return token;
}
function expiryFrom(token) {
  const unknown = { expiresAt: null, expirySource: "unknown" };
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return unknown;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const expiresAt = payload?.exp * 1000;
    if (typeof payload?.exp !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0
      || expiresAt > 8_640_000_000_000_000) return unknown;
    return { expiresAt, expirySource: "token" };
  } catch { return unknown; }
}
async function stopReceiver(receiver) {
  try { await receiver?.close?.(); } catch { /* Receiver cleanup never changes authorization state. */ }
}

/** Shared credentials live only in the client closure and never in public session snapshots. */
export function createVmDownloadSession({
  now = Date.now, startLogin = startVmLogin, createClient = createVmApprovalClient,
  checkIntervalMs = 60_000, onChange,
} = {}) {
  if (typeof now !== "function" || typeof startLogin !== "function" || typeof createClient !== "function"
    || !Number.isSafeInteger(checkIntervalMs) || checkIntervalMs <= 0 || checkIntervalMs > 2_147_483_647
    || (onChange !== undefined && typeof onChange !== "function")) fail("VM_AUTH_INPUT_INVALID");
  let status = "disconnected", errorCode = null, lastCheckedAt = null, lastAuthorizedAt = null, pendingAuthorizationAt = null;
  let verifiedIdentity = null, currentClient = null, allowsAccountChange = false;
  let expiry = { expiresAt: null, expirySource: "unknown" };
  let generation = 0, closed = false, pending = null, checking = null, timer;

  function snapshot() {
    return { status, account: verifiedIdentity ? { name: verifiedIdentity.name, userId: verifiedIdentity.user_id } : null,
      ...expiry, lastCheckedAt, lastAuthorizedAt, errorCode, automaticRefreshSupported: false, crossDeviceAuthorizationSupported: false };
  }
  function changed() {
    try { Promise.resolve(onChange?.(snapshot())).catch(() => {}); } catch { /* observer only */ }
  }
  function cancelTimer() { clearTimeout(timer); timer = undefined; }
  function scheduleCheck() {
    cancelTimer();
    if (closed || !currentClient) return;
    timer = setTimeout(() => { void check(); }, checkIntervalMs);
    timer.unref?.();
  }
  function current(version, client) {
    return !closed && version === generation && (client === undefined || client === currentClient);
  }

  function verify(version, client) {
    if (checking?.generation === version) return checking.promise;
    cancelTimer();
    const operation = { generation: version, promise: null };
    operation.promise = (async () => {
      try {
        const identity = identityFrom(await client.getIdentity());
        if (!current(version, client)) return snapshot();
        if (verifiedIdentity && !allowsAccountChange && identity.user_id !== verifiedIdentity.user_id) {
          fail("VM_APPLICANT_CHANGED");
        }
        verifiedIdentity = identity;
        if (allowsAccountChange) {
          lastAuthorizedAt = pendingAuthorizationAt;
          pendingAuthorizationAt = null;
        }
        allowsAccountChange = false;
        status = "connected";
        errorCode = null;
      } catch (error) {
        if (!current(version, client)) return snapshot();
        errorCode = safeCode(error, "VM_API_TRANSPORT_FAILED");
        if (AUTH_FAILURES.has(errorCode)) {
          status = "auth_required";
          currentClient = null;
          allowsAccountChange = false;
          pendingAuthorizationAt = null;
        } else status = "unavailable";
      }
      if (current(version)) {
        lastCheckedAt = now();
        changed();
        scheduleCheck();
      }
      return snapshot();
    })().finally(() => { if (checking === operation) checking = null; });
    checking = operation;
    return operation.promise;
  }

  async function completeLogin(entry) {
    try {
      const token = normalizeToken(await entry.receiver.token);
      if (!current(entry.generation)) return;
      const authorizationAt = now();
      let candidate;
      candidate = createClient({ token, onToken: (renewed) => {
        if (!current(entry.generation, candidate)) return;
        expiry = expiryFrom(renewed);
        changed();
      } });
      if (!candidate || typeof candidate.getIdentity !== "function") fail("VM_AUTH_FAILED");
      currentClient = candidate;
      pendingAuthorizationAt = authorizationAt;
      allowsAccountChange = true;
      expiry = expiryFrom(token);
      await verify(entry.generation, candidate);
    } catch (error) {
      if (current(entry.generation)) {
        currentClient = null;
        errorCode = safeCode(error, "VM_AUTH_FAILED");
        status = ["VM_AUTH_TRANSPORT_FAILED", "VM_AUTH_LISTENER_FAILED", "VM_API_TIMEOUT",
          "VM_API_TRANSPORT_FAILED", "VM_API_HTTP_FAILED"].includes(errorCode) ? "unavailable" : "auth_required";
        changed();
      }
    } finally {
      if (pending === entry) pending = null;
      await stopReceiver(entry.receiver);
    }
  }

  function beginLogin() {
    if (closed) return Promise.reject(new VmSourceError("VM_AUTH_CANCELED"));
    if (pending) return pending.promise;
    generation += 1;
    cancelTimer();
    currentClient = null;
    checking = null;
    allowsAccountChange = false;
    pendingAuthorizationAt = null;
    expiry = { expiresAt: null, expirySource: "unknown" };
    status = "connecting";
    errorCode = null;
    changed();
    const entry = { generation, receiver: null, promise: null };
    pending = entry;
    entry.promise = (async () => {
      try {
        entry.receiver = await startLogin();
        // Consume rejection even if startup completed after disconnection.
        Promise.resolve(entry.receiver?.token).catch(() => {});
        if (!current(entry.generation)) {
          await stopReceiver(entry.receiver);
          fail("VM_AUTH_CANCELED");
        }
        let url;
        try { url = new URL(entry.receiver?.loginUrl); } catch { fail("VM_AUTH_FAILED"); }
        if (url.origin !== VM_APPROVAL_ORIGIN || url.username || url.password
          || typeof entry.receiver?.token?.then !== "function" || typeof entry.receiver?.close !== "function") {
          fail("VM_AUTH_FAILED");
        }
        void completeLogin(entry);
        return { loginUrl: entry.receiver.loginUrl, session: snapshot() };
      } catch (error) {
        const code = safeCode(error, "VM_AUTH_FAILED");
        if (current(entry.generation)) {
          status = "unavailable";
          errorCode = code;
          changed();
        }
        if (pending === entry) pending = null;
        await stopReceiver(entry.receiver);
        throw new VmSourceError(code);
      }
    })();
    return entry.promise;
  }

  async function disconnect() {
    generation += 1;
    cancelTimer();
    const old = pending;
    pending = null;
    checking = null;
    currentClient = null;
    verifiedIdentity = null;
    allowsAccountChange = false;
    pendingAuthorizationAt = null;
    expiry = { expiresAt: null, expirySource: "unknown" };
    status = "disconnected";
    errorCode = null;
    lastCheckedAt = null;
    lastAuthorizedAt = null;
    changed();
    await stopReceiver(old?.receiver);
    return snapshot();
  }
  async function requireLogin(code = "VM_AUTH_REQUIRED") {
    if (closed) return snapshot();
    generation += 1;
    cancelTimer();
    const old = pending;
    pending = null;
    checking = null;
    currentClient = null;
    allowsAccountChange = false;
    pendingAuthorizationAt = null;
    status = "auth_required";
    errorCode = AUTH_FAILURES.has(code) ? code : "VM_AUTH_REQUIRED";
    changed();
    await stopReceiver(old?.receiver);
    return snapshot();
  }
  function check() {
    return currentClient && !closed ? verify(generation, currentClient) : Promise.resolve(snapshot());
  }
  async function close() {
    if (closed) return;
    closed = true;
    await disconnect();
  }

  return Object.freeze({ snapshot, client: () => status === "connected" ? currentClient : null,
    identity: () => verifiedIdentity ? structuredClone(verifiedIdentity) : null,
    beginLogin, disconnect, requireLogin, check, close });
}
