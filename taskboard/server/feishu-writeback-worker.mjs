import { randomUUID } from "node:crypto";

import { FEISHU_WRITEBACK_LEASE_DURATION_MS } from "./feishu-delivery-store.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_ATTEMPTS = 8;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 300_000;
const CONFLICT_CODES = new Set([
  "FIELD_CHANGED",
  "FIELD_METADATA_INVALID",
  "FIELD_NOT_WRITABLE",
  "FIELD_OPTION_CHANGED",
  "FIELD_VALUE_CONFLICT",
  "WRITEBACK_REFERENCE_INVALID",
]);

function canonicalTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function timestampMilliseconds(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && canonicalTimestamp(milliseconds) === value
    ? milliseconds : null;
}

function safeError(error, fallback = "FEISHU_WRITEBACK_FAILED") {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,128}$/u.test(error.code)
    ? error.code : fallback;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 1_024) : "Feishu writeback could not be completed";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  return { code, message, status };
}

function retryable(error) {
  return error.code === "FEISHU_WRITEBACK_FAILED"
    || error.code === "WRITEBACK_UNAVAILABLE"
    || error.status === 408
    || error.status === 429
    || (error.status >= 500 && error.status < 600);
}

function retryDelay(attemptCount, random) {
  const base = Math.min(
    INITIAL_RETRY_DELAY_MS * (2 ** Math.max(0, attemptCount - 1)),
    MAX_RETRY_DELAY_MS,
  );
  return Math.max(0, Math.round(base * (1 + ((random() * 2 - 1) * 0.2))));
}

function workerClaim(intent) {
  if (!intent || typeof intent !== "object"
    || typeof intent.id !== "string" || !intent.id
    || typeof intent.claimToken !== "string" || !intent.claimToken
    || !Number.isSafeInteger(intent.version) || intent.version < 1) {
    throw new TypeError("The writeback store returned an invalid claim");
  }
  return {
    operationId: intent.id,
    claimToken: intent.claimToken,
    version: intent.version,
  };
}

/**
 * Delivers persisted Feishu writeback intents. The Bridge is the only remote
 * caller and receives an opaque claim; it resolves the target through the
 * authenticated Taskboard resolver before writing an existing Base field.
 */
export function createFeishuWritebackWorker({
  store,
  dispatch,
  onUpdate = () => {},
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!store || typeof store.claimNextWritebackIntent !== "function"
    || typeof store.recoverExpiredWritebackIntents !== "function") {
    throw new TypeError("store is required");
  }
  if (typeof dispatch !== "function") throw new TypeError("dispatch is required");

  let closed = false;
  let drainPromise = null;
  let wakeRequested = false;
  let retryTimer = null;

  function publish(intent) {
    if (!intent) return;
    try { onUpdate(intent); } catch (error) {
      console.error(`Feishu writeback update subscriber failed: ${safeError(error).code}`);
    }
  }

  function scheduleNextWake() {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    if (closed) return;

    const candidates = [
      typeof store.getNextWritebackAttemptAt === "function" ? store.getNextWritebackAttemptAt() : null,
      typeof store.getNextWritebackLeaseExpiry === "function" ? store.getNextWritebackLeaseExpiry() : null,
    ].map(timestampMilliseconds).filter((value) => value !== null);
    if (candidates.length === 0) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, Math.min(...candidates) - now()),
    );
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!closed) void wake();
    }, delay);
    retryTimer.unref?.();
  }

  function startLeaseRenewal(intent, claim) {
    if (typeof store.renewWritebackIntentLease !== "function") return { stop() {} };
    let stopped = false;
    let timer = null;
    const interval = Math.max(1, Math.floor(FEISHU_WRITEBACK_LEASE_DURATION_MS / 3));
    const schedule = () => {
      if (stopped || closed) return;
      timer = setTimer(() => {
        timer = null;
        if (stopped || closed) return;
        try {
          const renewed = store.renewWritebackIntentLease(intent.id, intent.claimToken);
          if (!renewed) {
            stopped = true;
            return;
          }
          if (Number.isSafeInteger(renewed.version) && renewed.version > 0) claim.version = renewed.version;
        } catch (error) {
          console.error(`Feishu writeback lease renewal failed: ${safeError(error).code}`);
        }
        schedule();
      }, interval);
      timer.unref?.();
    };
    schedule();
    return {
      stop() {
        stopped = true;
        if (timer) clearTimer(timer);
        timer = null;
      },
    };
  }

  async function processIntent(intent) {
    publish(intent);
    const claim = workerClaim(intent);
    const renewal = startLeaseRenewal(intent, claim);
    try {
      await dispatch(claim);
      publish(store.markWritebackIntentSucceeded(intent.id, intent.claimToken));
    } catch (error) {
      const failure = safeError(error);
      if (failure.code === "WRITEBACK_CLAIM_STALE") return;
      if (CONFLICT_CODES.has(failure.code) || failure.status === 409) {
        publish(store.markWritebackIntentConflict(intent.id, intent.claimToken, {
          code: failure.code,
          message: failure.message,
        }));
      } else if (retryable(failure) && intent.attemptCount < MAX_ATTEMPTS) {
        const nextAttemptAt = canonicalTimestamp(now() + retryDelay(intent.attemptCount, random));
        publish(store.markWritebackIntentRetryWait(intent.id, intent.claimToken, {
          code: failure.code,
          message: failure.message,
          nextAttemptAt,
        }));
      } else {
        publish(store.markWritebackIntentDeadLetter(intent.id, intent.claimToken, {
          code: retryable(failure) ? "WRITEBACK_RETRIES_EXHAUSTED" : failure.code,
          message: retryable(failure) ? "Feishu writeback retry budget exhausted" : failure.message,
        }));
      }
    } finally {
      renewal.stop();
    }
  }

  async function drain() {
    while (!closed) {
      wakeRequested = false;
      store.recoverExpiredWritebackIntents();
      const intent = store.claimNextWritebackIntent({ leaseMs: FEISHU_WRITEBACK_LEASE_DURATION_MS });
      if (!intent) {
        scheduleNextWake();
        return;
      }
      await processIntent(intent);
      if (!wakeRequested) continue;
    }
  }

  function wake() {
    if (closed) return Promise.resolve();
    wakeRequested = true;
    if (!drainPromise) {
      const running = drain();
      drainPromise = running;
      void running.finally(() => {
        if (drainPromise !== running) return;
        drainPromise = null;
        if (!closed && wakeRequested) void wake();
      }).catch(() => {});
    }
    return drainPromise;
  }

  return {
    start: wake,
    wake,
    async close() {
      closed = true;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
      await drainPromise;
    },
  };
}
