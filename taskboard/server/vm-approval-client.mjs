import { VmSourceError } from "./vm-source-transfer.mjs";

export const VM_APPROVAL_ORIGIN = "https://shadow.yangcong345.com";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_APPLICATIONS = 10_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ERROR_CODES = new Set([
  "VM_AUTH_REQUIRED", "VM_API_INPUT_INVALID", "VM_API_TIMEOUT", "VM_API_TRANSPORT_FAILED",
  "VM_API_HTTP_FAILED", "VM_API_RESPONSE_TOO_LARGE", "VM_API_RESPONSE_INVALID",
  "VM_API_PAGINATION_INVALID", "VM_API_LIMIT_EXCEEDED",
]);

function fail(code) { throw new VmSourceError(code); }

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function normalizeToken(value) {
  if (typeof value !== "string") fail("VM_AUTH_REQUIRED");
  const token = value.trim().replace(/^Bearer(?:\s+|$)/iu, "");
  if (!token) fail("VM_AUTH_REQUIRED");
  if (token.length > 16_384 || !/^[\x21-\x7e]+$/u.test(token)) fail("VM_API_INPUT_INVALID");
  return token;
}

function identifier(value) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("VM_API_INPUT_INVALID");
  return value;
}

async function readJson(response, signal) {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
      fail("VM_API_RESPONSE_INVALID");
    }
    if (Number(declaredLength) > MAX_RESPONSE_BYTES) fail("VM_API_RESPONSE_TOO_LARGE");
  }
  if (!response.body || typeof response.body.getReader !== "function") fail("VM_API_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const abortRead = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abortRead, { once: true });
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal.aborted) fail("VM_API_TIMEOUT");
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("VM_API_RESPONSE_INVALID");
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail("VM_API_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    if (signal.aborted) fail("VM_API_TIMEOUT");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    } catch { fail("VM_API_RESPONSE_INVALID"); }
  } finally {
    signal.removeEventListener("abort", abortRead);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* A timed-out read may still own the lock. */ }
  }
}

/** Tokens stay in this closure; callers receive neither tokens nor transport errors. */
export function createVmApprovalClient({ token, fetchImpl = globalThis.fetch, timeoutMs = 30_000, onToken } = {}) {
  let currentToken = normalizeToken(token);
  if (typeof fetchImpl !== "function" || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || (onToken !== undefined && typeof onToken !== "function")) fail("VM_API_INPUT_INVALID");

  async function request(endpoint, body) {
    const controller = new AbortController();
    let timer;
    let response;
    let encodedBody;
    if (body !== undefined) {
      if (!plainObject(body)) fail("VM_API_INPUT_INVALID");
      try { encodedBody = JSON.stringify(body); } catch { fail("VM_API_INPUT_INVALID"); }
      if (typeof encodedBody !== "string" || Buffer.byteLength(encodedBody) > MAX_RESPONSE_BYTES) {
        fail("VM_API_INPUT_INVALID");
      }
    }
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new VmSourceError("VM_API_TIMEOUT"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        response = await fetchImpl(`${VM_APPROVAL_ORIGIN}${endpoint}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            accept: "application/json",
            authorization: currentToken,
            shadowauthorization: currentToken,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: encodedBody }),
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (controller.signal.aborted) fail("VM_API_TIMEOUT");
        if (!response || !Number.isInteger(response.status) || response.redirected === true) {
          fail("VM_API_RESPONSE_INVALID");
        }
        if (response.status === 401 || response.status === 403) fail("VM_AUTH_REQUIRED");
        if (response.status < 200 || response.status >= 300) fail("VM_API_HTTP_FAILED");
        const result = await readJson(response, controller.signal);
        const renewed = response.headers?.get("shadowauthorization");
        if (renewed !== null && renewed !== undefined) {
          try { currentToken = normalizeToken(renewed); } catch { fail("VM_API_RESPONSE_INVALID"); }
          // Observation must not turn a successful remote submission into a failed one.
          try { Promise.resolve(onToken?.(currentToken)).catch(() => {}); } catch { /* observer only */ }
        }
        return result;
      })()]);
    } catch (error) {
      if (error instanceof VmSourceError && ERROR_CODES.has(error.code)) throw error;
      fail(controller.signal.aborted ? "VM_API_TIMEOUT" : "VM_API_TRANSPORT_FAILED");
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  return Object.freeze({
    getIdentity() { return request("/api/auth/me"); },
    getVideos(vmid) {
      if (typeof vmid !== "string" || !/^[a-f0-9]{24}$/u.test(vmid)) fail("VM_API_INPUT_INVALID");
      return request("/api/video-manager/video/getVideoList", { pageIndex: 1, pageSize: 100, videoIds: [vmid] });
    },
    getDepartments(departmentIds) {
      if (!Array.isArray(departmentIds) || !departmentIds.length || departmentIds.length > 100) {
        fail("VM_API_INPUT_INVALID");
      }
      const ids = departmentIds.map(identifier);
      if (new Set(ids).size !== ids.length) fail("VM_API_INPUT_INVALID");
      return request("/api/feishu-open-apis/contact/v1/department/detail/batch_get", { department_ids: ids });
    },
    async listApplications() {
      const list = [];
      const seen = new Set();
      let count;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const result = await request("/api/video-manager/videoApply/getVideoApplys", {
          page, size: PAGE_SIZE, beginTime: "", endTime: "", applyType: "VIDEO_DOWNLOAD",
        });
        if (!plainObject(result) || !Array.isArray(result.list) || result.list.length > PAGE_SIZE
          || !Number.isSafeInteger(result.count) || result.count < 0) fail("VM_API_PAGINATION_INVALID");
        if (result.count > MAX_APPLICATIONS) fail("VM_API_LIMIT_EXCEEDED");
        count ??= result.count;
        if (count !== result.count || list.length + result.list.length > count) fail("VM_API_PAGINATION_INVALID");
        for (const item of result.list) {
          if (!plainObject(item) || typeof item.id !== "string" || !IDENTIFIER.test(item.id)
            || seen.has(item.id)) fail("VM_API_PAGINATION_INVALID");
          seen.add(item.id);
          list.push(item);
        }
        if (list.length === count) return { list, count };
        if (!result.list.length) fail("VM_API_PAGINATION_INVALID");
      }
      fail("VM_API_LIMIT_EXCEEDED");
    },
    getApplication(id) {
      const query = new URLSearchParams({ id: identifier(id) });
      return request(`/api/video-manager/videoApply/getVideoApply?${query}`);
    },
    async submitApplication(body) {
      if (!plainObject(body)) fail("VM_API_INPUT_INVALID");
      return request("/api/video-manager/video/applyVideo", body);
    },
  });
}
