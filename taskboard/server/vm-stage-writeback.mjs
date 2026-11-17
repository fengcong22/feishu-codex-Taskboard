const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const STARTED_STATES = new Set(["running", "reported", "completed", "rendering", "rendered",
  "delivery_pending", "delivery_confirmed"]);
// Material moments describe the source acquisition, so they precede any render evidence.
const MATERIAL_MOMENTS = Object.freeze({ materials_ready: "materialsReady", download_failed: "downloadFailed" });
const MATERIAL_READY_STATES = new Set(["ready", "preparing", "prepared", "planning", "planned", "blocked", "needs_attention"]);
const MOMENTS = new Set(["processing", "completed", ...Object.keys(MATERIAL_MOMENTS)]);
const FAILURE_SLOT = /^(?:auto|e[a-f0-9]{32})$/u;

/** One idempotency key per run and moment; repeated download failures are keyed by their cause. */
export function vmWritebackIdempotencyKey(runId, moment, slot) {
  if (moment === "download_failed") return `vm:${runId}:download_failed:${slot}`;
  return `vm:${runId}:${moment}`;
}

export function parseVmWritebackIdempotencyKey(key, runId) {
  if (typeof key !== "string" || !key.startsWith(`vm:${runId}:`)) return null;
  const rest = key.slice(`vm:${runId}:`.length);
  if (["processing", "completed", "materials_ready"].includes(rest)) return { moment: rest, slot: null };
  const failed = /^download_failed:(.+)$/u.exec(rest);
  return failed && FAILURE_SLOT.test(failed[1]) ? { moment: "download_failed", slot: failed[1] } : null;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  if (code === "VM_WRITEBACK_STAGE_ADVANCED") error.status = 409;
  return error;
}

function validId(value) { return typeof value === "string" && IDENTIFIER.test(value); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

function trustedRun(run, runId, moment) {
  const target = run?.target;
  const startedAt = typeof run?.runnerStartedAt === "string" ? Date.parse(run.runnerStartedAt) : NaN;
  const material = Object.hasOwn(MATERIAL_MOMENTS, moment);
  const stateAllowed = moment === "materials_ready"
    ? run?.stageId === "initial" && object(run?.acquisition)
      && (MATERIAL_READY_STATES.has(run.state) || STARTED_STATES.has(run.state))
    : moment === "download_failed"
      ? run?.stageId === "initial" && run.state === "blocked" && run.errorCode === "VM_DOWNLOAD_FAILED"
      : STARTED_STATES.has(run?.state)
        || moment === "processing" && ["blocked", "needs_attention"].includes(run?.state);
  if (!object(run) || run.runId !== runId || !validId(run.taskId)
    || run.productionOrigin !== true || !["initial", "review"].includes(run.stageId)
    || typeof run.subjectKey !== "string" || run.subjectKey.length > 512
    || !Number.isSafeInteger(run.configVersion) || run.configVersion < 1
    || !stateAllowed
    || !material && (!Number.isFinite(startedAt)
      || new Date(startedAt).toISOString() !== run.runnerStartedAt)
    || !object(target) || ![target.baseToken, target.tableId, target.recordId].every(validId)
    || run.subjectKey !== `${target.baseToken}:${target.tableId}`)
    throw fail("VM_WRITEBACK_UNTRUSTED");
  return run;
}

function activeSubject(subject, run) {
  if (!object(subject) || subject.lifecycle !== "enabled"
    || subject.workflowTemplate?.id !== "vm_pmo_review_video"
    || subject.workflowTemplate?.version !== 1
    || subject.subjectKey !== run.subjectKey || subject.configVersion !== run.configVersion
    || subject.baseToken !== run.target.baseToken || subject.tableId !== run.target.tableId
    || subject.vmWorkflow?.stages?.initial?.enabled !== true
    || typeof subject.vmWorkflow?.stages?.review?.enabled !== "boolean"
    || typeof subject.vmWorkflow?.finalArchive?.enabled !== "boolean")
    throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  return subject;
}

function optionId(option) { return option?.optionId ?? option?.option_id ?? option?.id; }
function optionName(option) { return option?.name ?? option?.value; }
function fieldId(field) { return field?.fieldId ?? field?.field_id; }
function fieldName(field) { return field?.fieldName ?? field?.field_name; }
function fieldUiType(field) { return field?.uiType ?? field?.ui_type; }
function fieldOptions(field) { return field?.property?.options ?? field?.options; }

function singleSelect(field) {
  const type = field?.type;
  const uiType = fieldUiType(field);
  const hasType = type !== undefined && type !== null;
  const hasUiType = uiType !== undefined && uiType !== null;
  return (hasType || hasUiType)
    && (!hasType || type === 3 || type === "3" || type === "single_select")
    && (!hasUiType || typeof uiType === "string"
      && uiType.toLowerCase().replace(/[\s_-]/gu, "") === "singleselect");
}

function expectedField(subject, id) {
  const fields = subject.metadata?.fields;
  if (!Array.isArray(fields)) throw fail("VM_WRITEBACK_METADATA_MISSING");
  const matches = fields.filter((field) => fieldId(field) === id);
  if (matches.length !== 1 || !singleSelect(matches[0])
    || typeof fieldName(matches[0]) !== "string" || !fieldName(matches[0]).trim())
    throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  return matches[0];
}

function liveBoundField(subject, liveFields, id) {
  const snapshot = expectedField(subject, id);
  if (!Array.isArray(liveFields)) throw fail("VM_WRITEBACK_METADATA_MISSING");
  const matches = liveFields.filter((field) => fieldId(field) === id);
  if (matches.length !== 1 || !singleSelect(matches[0])
    || fieldName(matches[0]) !== fieldName(snapshot)) throw fail("VM_WRITEBACK_FIELD_CHANGED");
  const expectedOptions = fieldOptions(snapshot);
  const liveOptions = fieldOptions(matches[0]);
  if (!Array.isArray(expectedOptions) || !Array.isArray(liveOptions))
    throw fail("VM_WRITEBACK_METADATA_MISSING");
  return { expectedOptions, liveOptions };
}

function validatedOption(subject, liveFields, fieldIdValue, optionIdValue) {
  const { expectedOptions, liveOptions } = liveBoundField(subject, liveFields, fieldIdValue);
  const expected = expectedOptions.filter((option) => optionId(option) === optionIdValue);
  const live = liveOptions.filter((option) => optionId(option) === optionIdValue);
  if (expected.length !== 1 || live.length !== 1
    || typeof optionName(expected[0]) !== "string" || !optionName(expected[0]).trim()
    || optionName(live[0]) !== optionName(expected[0])) throw fail("VM_WRITEBACK_OPTION_CHANGED");
}

function validatedOperation(subject, liveFields, moment, stageId) {
  const stage = subject.vmWorkflow.stages[stageId];
  if (stage?.enabled !== true) throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  if (Object.hasOwn(MATERIAL_MOMENTS, moment)) return materialOperation(subject, liveFields, moment, stage);
  const binding = stage.writeback?.[moment];
  if (!object(binding) || !validId(binding.fieldId) || !validId(binding.optionId))
    throw fail("VM_WRITEBACK_BINDING_MISSING");
  validatedOption(subject, liveFields, binding.fieldId, binding.optionId);
  if (!validId(stage.statusFieldId) || !validId(stage.triggerOptionId))
    throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  validatedOption(subject, liveFields, stage.statusFieldId, stage.triggerOptionId);
  const previous = stage.writeback?.processing;
  if (moment === "completed" && (!object(previous) || !validId(previous.fieldId) || !validId(previous.optionId)))
    throw fail("VM_WRITEBACK_BINDING_MISSING");
  if (moment === "completed") validatedOption(subject, liveFields, previous.fieldId, previous.optionId);
  const expectedStatus = moment === "completed" && previous.fieldId === stage.statusFieldId
    ? previous.optionId : stage.triggerOptionId;
  const statusOptions = [expectedStatus];
  // A source writeback may already have moved the status off the trigger.
  const ready = stage.writeback?.materialsReady;
  if (moment === "processing" && object(ready) && ready.fieldId === stage.statusFieldId && validId(ready.optionId)) {
    validatedOption(subject, liveFields, ready.fieldId, ready.optionId);
    statusOptions.push(ready.optionId);
  }
  if (binding.fieldId === stage.statusFieldId && !statusOptions.includes(binding.optionId))
    statusOptions.push(binding.optionId);
  return { type: "single_select", fieldId: binding.fieldId, optionId: binding.optionId,
    guard: { fieldId: stage.statusFieldId, optionIds: statusOptions } };
}

function materialOperation(subject, liveFields, moment, stage) {
  const binding = stage.writeback?.[MATERIAL_MOMENTS[moment]];
  if (!object(binding) || !validId(binding.fieldId) || !validId(binding.optionId)
    || binding.fieldId !== stage.statusFieldId) throw fail("VM_WRITEBACK_BINDING_MISSING");
  if (!validId(stage.statusFieldId) || !validId(stage.triggerOptionId))
    throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  validatedOption(subject, liveFields, stage.statusFieldId, stage.triggerOptionId);
  validatedOption(subject, liveFields, binding.fieldId, binding.optionId);
  const statusOptions = [stage.triggerOptionId];
  const peers = moment === "download_failed" ? ["materialsReady", "downloadFailed"] : ["materialsReady"];
  for (const key of peers) {
    const peer = stage.writeback?.[key];
    if (!object(peer) || peer.fieldId !== stage.statusFieldId || !validId(peer.optionId)) continue;
    validatedOption(subject, liveFields, peer.fieldId, peer.optionId);
    if (!statusOptions.includes(peer.optionId)) statusOptions.push(peer.optionId);
  }
  return { type: "single_select", fieldId: binding.fieldId, optionId: binding.optionId,
    guard: { fieldId: stage.statusFieldId, optionIds: statusOptions } };
}

function confirmedDelivery(delivery, run, subject) {
  const target = delivery?.target;
  if (!object(delivery) || delivery.state !== "delivered"
    || delivery.runId !== run.runId || delivery.taskId !== run.taskId
    || !validId(delivery.fileToken) || !object(target)
    || target.baseToken !== run.target.baseToken || target.tableId !== run.target.tableId
    || target.recordId !== run.target.recordId
    || target.fieldId !== subject.vmWorkflow.fields?.outputAttachmentFieldId)
    throw fail("VM_WRITEBACK_DELIVERY_UNCONFIRMED");
}

/** The dependencies must resolve server-owned state; callers supply only a run ID and moment. */
export function createVmStageWriteback({ resolveTrustedRun, getActiveSubject, listFields,
  getDelivery, isLatestStageRun, enqueueWritebackIntent } = {}) {
  if ([resolveTrustedRun, getActiveSubject, listFields, getDelivery, isLatestStageRun,
    enqueueWritebackIntent].some((callback) => typeof callback !== "function"))
    throw fail("VM_WRITEBACK_SERVICE_INVALID");

  async function plan({ runId, moment, slot = null } = {}) {
    if (!validId(runId) || !MOMENTS.has(moment)
      || (moment === "download_failed" ? !FAILURE_SLOT.test(slot ?? "") : slot !== null))
      throw fail("VM_WRITEBACK_INPUT_INVALID");
    const run = trustedRun(await resolveTrustedRun({ runId }), runId, moment);
    if (await isLatestStageRun({ run: structuredClone(run) }) !== true)
      throw fail("VM_WRITEBACK_STAGE_ADVANCED");
    const subject = activeSubject(await getActiveSubject({ subjectKey: run.subjectKey }), run);
    if (moment === "completed") confirmedDelivery(await getDelivery({ runId }), run, subject);
    const liveFields = await listFields({ baseToken: run.target.baseToken,
      tableId: run.target.tableId });
    const operation = validatedOperation(subject, liveFields, moment, run.stageId);
    return Object.freeze({ idempotencyKey: vmWritebackIdempotencyKey(runId, moment, slot),
      taskId: run.taskId, runId, courseBindingId: null, operation });
  }

  return Object.freeze({ plan, async enqueue(input) {
    return enqueueWritebackIntent(await plan(input));
  } });
}
