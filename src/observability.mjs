import { createHash } from "node:crypto";

export function safeReference(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12);
}

export function logDelivery(
  logger,
  level,
  { eventId, tableId, recordId, deliveryState, attempts, errorCode, taskIdentifier },
) {
  const entry = {
    component: "bridge-delivery",
    event: safeReference(eventId),
    table: safeReference(tableId),
    record: safeReference(recordId),
    deliveryState,
    attempts,
    ...(errorCode ? { errorCode } : {}),
    ...(taskIdentifier ? { taskIdentifier } : {}),
  };
  logger?.[level]?.(JSON.stringify(entry));
}
