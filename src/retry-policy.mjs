export const DEFAULT_DELIVERY_POLICY = Object.freeze({
  maxAttempts: 8,
  initialDelayMs: 5_000,
  maxDelayMs: 300_000,
  leaseMs: 30_000,
  pollIntervalMs: 1_000,
});

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
  const code = typeof error?.code === "string" && error.code
    ? error.code
    : "DELIVERY_FAILED";
  return {
    code,
    status,
    retryable: code === "TASKBOARD_UNAVAILABLE" || status === 429 || (status >= 500 && status < 600),
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
