export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  maxAttempts: 8,
  initialDelayMs: 5_000,
  maxDelayMs: 300_000,
  leaseMs: 30_000,
  pollIntervalMs: 1_000,
});

const SAFE_DELIVERY_ERROR_CODES = new Map([
  "BODY_TOO_LARGE",
  "BRIDGE_FAILURE",
  "DELIVERY_FAILED",
  "EVENT_RECORD_ID_MISMATCH",
  "EVENT_RECORD_INVALID",
  "EVENT_LOCK_TIMEOUT",
  "EVENT_SNAPSHOT_MISSING",
  "FEISHU_EVENT_HANDLER_FAILED",
  "FEISHU_LISTENER_START_FAILED",
  "FEISHU_RECORD_LOOKUP_FAILED",
  "FEISHU_SDK_MISSING",
  "FEISHU_TITLE_LOOKUP_FAILED",
  "FEISHU_TITLE_LOOKUP_TIMEOUT",
  "INTERNAL_ERROR",
  "INVALID_ACTOR",
  "INVALID_BODY",
  "INVALID_EVENT",
  "INVALID_FIELD",
  "INVALID_HOST",
  "INVALID_JSON",
  "INVALID_ORIGIN",
  "INVALID_PATH",
  "INVALID_QUERY_PARAMETER",
  "LEGACY_EVENT_SNAPSHOT_MISSING",
  "LOCAL_ONLY",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "PROCESSING_EVENT_SNAPSHOT_MISSING",
  "PROJECT_EXISTS",
  "PROJECT_NOT_FOUND",
  "STATE_LOCK_TARGET_CHANGED",
  "STATE_LOCK_TARGET_UNSUPPORTED",
  "STATE_LOCK_TIMEOUT",
  "STATE_LOCK_UNSUPPORTED_PLATFORM",
  "STATE_FILE_INVALID",
  "TASKBOARD_INVALID_RESPONSE",
  "TASKBOARD_REQUEST_FAILED",
  "TASKBOARD_UNAVAILABLE",
  "TASK_NOT_FOUND",
  "UNKNOWN_FIELD",
  "UNKNOWN_QUERY_PARAMETER",
  "UNSUPPORTED_MEDIA_TYPE",
  "VERSION_CONFLICT",
].map((code) => [code, code]));

export function safeDeliveryErrorCode(value, fallback = "DELIVERY_FAILED") {
  const safeFallback = SAFE_DELIVERY_ERROR_CODES.get(fallback) ?? "DELIVERY_FAILED";
  if (typeof value !== "string") return safeFallback;
  return SAFE_DELIVERY_ERROR_CODES.get(value.trim()) ?? safeFallback;
}

function positiveInteger(value, name, minimum = 1) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

export function validateDeliveryPolicy(input) {
  const source = input === undefined
    ? {}
    : plainObject(input, "delivery");
  const result = {
    maxAttempts: positiveInteger(
      source.maxAttempts ?? DEFAULT_DELIVERY_POLICY.maxAttempts,
      "delivery.maxAttempts",
    ),
    initialDelayMs: positiveInteger(
      source.initialDelayMs ?? DEFAULT_DELIVERY_POLICY.initialDelayMs,
      "delivery.initialDelayMs",
    ),
    maxDelayMs: positiveInteger(
      source.maxDelayMs ?? DEFAULT_DELIVERY_POLICY.maxDelayMs,
      "delivery.maxDelayMs",
    ),
    leaseMs: positiveInteger(
      source.leaseMs ?? DEFAULT_DELIVERY_POLICY.leaseMs,
      "delivery.leaseMs",
    ),
    pollIntervalMs: positiveInteger(
      source.pollIntervalMs ?? DEFAULT_DELIVERY_POLICY.pollIntervalMs,
      "delivery.pollIntervalMs",
      100,
    ),
  };
  if (result.maxDelayMs < result.initialDelayMs) {
    throw new Error("delivery.maxDelayMs must be >= delivery.initialDelayMs");
  }
  return result;
}

export function classifyDeliveryError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const code = safeDeliveryErrorCode(error?.code);
  return {
    code,
    status,
    retryable: code === "TASKBOARD_UNAVAILABLE"
      || code === "EVENT_LOCK_TIMEOUT"
      || code === "STATE_LOCK_TIMEOUT"
      || status === 408
      || status === 429
      || (status >= 500 && status < 600),
  };
}

export function calculateNextAttemptAt({
  attempts,
  now,
  initialDelayMs,
  maxDelayMs,
  random = Math.random,
}) {
  const baseDelay = Math.min(
    initialDelayMs * (3 ** Math.max(0, attempts - 1)),
    maxDelayMs,
  );
  const jittered = Math.round(baseDelay * (1 + ((random() * 2 - 1) * 0.2)));
  return now + Math.max(0, jittered);
}

export function summarizeDeliveryError(error, at) {
  const { code, status } = classifyDeliveryError(error);
  return { code, status, at };
}
