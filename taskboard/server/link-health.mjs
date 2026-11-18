/**
 * Background link-health sampler for the dashboard.
 *
 * The dashboard must not call the network while rendering a board read, so the
 * Bridge `/health` probe and the VM sign-in state are sampled on a timer and
 * cached here instead. A read then only touches this cache. Bridge `/health` is
 * unauthenticated and already redacted, and both probes are read-only: nothing
 * here starts, wakes or re-authenticates anything.
 *
 * Failures are also cached, so a Bridge that has been down for an hour reads as
 * "down for an hour" instead of "unknown".
 */

const DEFAULT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 4_000;

/**
 * @param {object} options
 * @param {() => URL | null} options.bridgeUrl Resolves the loopback Bridge URL, or null when unset.
 * @param {() => object | null} [options.vmSession] Pure read of the VM sign-in snapshot, or null.
 * @param {() => {enabled: boolean, version: number}} [options.automaticExecution] Pure read of the local switch.
 * @param {typeof fetch} [options.fetchImpl] Bind once at construction: a global that
 *   a test or host later replaces must not change what this monitor probes with.
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now]
 */
export function createLinkHealthMonitor({
  bridgeUrl,
  vmSession = null,
  automaticExecution = null,
  fetchImpl = globalThis.fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = Date.now,
} = {}) {
  if (typeof bridgeUrl !== "function") throw new TypeError("bridgeUrl is required");
  let bridge = { state: "unknown", checkedAt: null, detail: null };
  let timer = null;
  let closed = false;
  let sampling = null;

  function sampleBridge() {
    const startedAt = now();
    let url;
    try {
      url = bridgeUrl();
    } catch {
      url = null;
    }
    if (!url) {
      bridge = { state: "unconfigured", checkedAt: new Date(now()).toISOString(), detail: null };
      return Promise.resolve();
    }
    const endpoint = new URL("/health", url);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;
    if (timeout && typeof timeout.unref === "function") timeout.unref();
    return Promise.resolve()
      .then(() => fetchImpl(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller?.signal,
      }))
      .then(async (response) => {
        if (!response.ok) {
          bridge = { state: "error", checkedAt: new Date(now()).toISOString(), detail: `HTTP_${response.status}` };
          return;
        }
        let body;
        try {
          body = await response.json();
        } catch {
          bridge = { state: "error", checkedAt: new Date(now()).toISOString(), detail: "INVALID_RESPONSE" };
          return;
        }
        bridge = { state: "up", checkedAt: new Date(now()).toISOString(), detail: null, health: viewHealth(body) };
      })
      .catch(() => {
        // Never surface the raw error: it can carry a host or path.
        bridge = { state: "down", checkedAt: new Date(now()).toISOString(), detail: null };
      })
      .finally(() => { if (timeout) clearTimeout(timeout); void startedAt; });
  }

  async function sample() {
    if (closed) return;
    if (sampling) return sampling;
    sampling = sampleBridge().finally(() => { sampling = null; });
    return sampling;
  }

  /**
   * Begin sampling. Only the real server entry point calls this: a probe must
   * never run in a test or an injected server that stands up a fake Bridge,
   * because those assert on the exact requests the Bridge receives.
   */
  function start() {
    if (closed || timer) return;
    void sample();
    timer = setInterval(() => { void sample(); }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    await sampling?.catch(() => {});
  }

  /** Pure read: no network, no worker start, no configuration write. */
  function snapshot() {
    const checkedAt = bridge.checkedAt;
    const ageMs = checkedAt === null ? null : Math.max(0, now() - Date.parse(checkedAt));
    return {
      bridge: {
        state: bridge.state,
        checkedAt,
        ageMs,
        // A probe older than a few intervals no longer proves anything.
        stale: ageMs !== null && ageMs > intervalMs * 4,
        detail: bridge.detail ?? null,
        listener: bridge.health?.listener ?? null,
        queue: bridge.health?.queue ?? null,
      },
      vmSession: readVmSession(vmSession),
      automaticExecution: readAutomaticExecution(automaticExecution),
      intervalMs,
    };
  }

  return { start, close, sample, snapshot, get intervalMs() { return intervalMs; } };
}

/** Keep only the field names the dashboard renders; the Bridge response is remote data. */
function viewHealth(body) {
  const health = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const listener = health.feishuListener;
  const queue = health.queue;
  const state = listener && typeof listener.state === "string"
    && /^[a-z_]{1,40}$/u.test(listener.state) ? listener.state : null;
  return {
    listener: listener && typeof listener === "object"
      ? {
          state,
          lastEventAt: validIso(listener.lastEventAt),
          lastError: safeCode(listener.lastError?.code ?? listener.lastError),
        }
      : null,
    queue: queue && typeof queue === "object" && !Array.isArray(queue)
      ? Object.fromEntries(["pending", "processing", "retryWait", "deadLetter"].map(key => [
          key,
          Number.isSafeInteger(queue[key]) && queue[key] >= 0 ? queue[key] : null,
        ]))
      : null,
  };
}

function readVmSession(read) {
  if (typeof read !== "function") return null;
  let value;
  try {
    value = read();
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const status = typeof value.status === "string" ? value.status : null;
  const expiresAt = Number.isFinite(value.expiresAt) ? value.expiresAt : null;
  return {
    status,
    accountName: typeof value.account?.name === "string" ? value.account.name : null,
    expiresAt,
    errorCode: safeCode(value.errorCode),
  };
}

function readAutomaticExecution(read) {
  if (typeof read !== "function") return null;
  try {
    const value = read();
    return value && typeof value === "object"
      ? { enabled: value.enabled === true, version: Number.isSafeInteger(value.version) ? value.version : null }
      : null;
  } catch {
    return null;
  }
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,100}$/u.test(value) ? value : null;
}
