import { canonicalSha256 } from "./feishu-source-manifest.mjs";

const REGISTRATION_FIELDS = [
  "source", "eventId", "baseToken", "tableId", "recordId", "statusFieldId",
  "beforeOptionId", "afterOptionId", "stageId", "eventOccurredAt", "deliverySource",
  "subjectKey", "configVersion", "controlledContext",
];

export function stageRegistrationOrigin({ event, binding, controlledContext }) {
  return {
    source: "feishu-base", eventId: event.eventId, baseToken: event.baseToken,
    tableId: event.tableId, recordId: event.recordId, statusFieldId: event.statusFieldId,
    beforeOptionId: event.beforeOptionId, afterOptionId: event.afterOptionId,
    stageId: binding.stageId, eventOccurredAt: event.occurredAt,
    deliverySource: event.deliverySource, subjectKey: binding.subjectKey,
    configVersion: binding.configVersion, controlledContext,
  };
}

export function registrationFingerprint(origin) {
  return canonicalSha256(Object.fromEntries(REGISTRATION_FIELDS
    .filter((key) => origin[key] !== undefined)
    .map((key) => [key, origin[key]])));
}

export { canonicalSha256 as originFingerprint };
