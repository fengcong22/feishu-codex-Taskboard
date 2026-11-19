const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const STARTED_STATES = new Set(["running", "reported", "completed", "rendering", "rendered",
  "delivery_pending", "delivery_confirmed"]);
// Material moments describe the source acquisition, so they precede any render evidence.
const MATERIAL_MOMENTS = Object.freeze({ materials_ready: "materialsReady", download_failed: "downloadFailed" });
const MATERIAL_READY_STATES = new Set(["ready", "preparing", "prepared", "planning", "planned", "blocked", "needs_attention"]);
const MOMENTS = new Set(["processing", "completed", "ai_notes", ...Object.keys(MATERIAL_MOMENTS)]);
const FAILURE_SLOT = /^(?:auto|e[a-f0-9]{32})$/u;
// AI notes are keyed by their content, so a later round or a rerun writes a new note once.
const NOTES_SLOT = /^n[a-f0-9]{32}$/u;
const NOTES_STATES = new Set(["completed", "blocked", "needs_attention"]);
export const VM_AI_NOTES_MAX_LENGTH = 4096;

/** One idempotency key per run and moment; repeated download failures are keyed by their cause. */
export function vmWritebackIdempotencyKey(runId, moment, slot) {
  if (moment === "download_failed" || moment === "ai_notes") return `vm:${runId}:${moment}:${slot}`;
  return `vm:${runId}:${moment}`;
}

export function parseVmWritebackIdempotencyKey(key, runId) {
  if (typeof key !== "string" || !key.startsWith(`vm:${runId}:`)) return null;
  const rest = key.slice(`vm:${runId}:`.length);
  if (["processing", "completed", "materials_ready"].includes(rest)) return { moment: rest, slot: null };
  const notes = /^ai_notes:(.+)$/u.exec(rest);
  if (notes) return NOTES_SLOT.test(notes[1]) ? { moment: "ai_notes", slot: notes[1] } : null;
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
  // AI notes may describe a block before any render, so they need no render start evidence.
  const material = Object.hasOwn(MATERIAL_MOMENTS, moment) || moment === "ai_notes";
  const stateAllowed = moment === "ai_notes" ? NOTES_STATES.has(run?.state)
    : moment === "materials_ready"
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

/** The bindings a run writes through are the frozen subject's own; `getActiveSubject` answers that
 * snapshot, never the live record. A newer subject version may carry every binding unchanged (an
 * operator renamed an option or added one a run does not use), and such a run must still finish. */
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
  // The operation writes an option id; a renamed label still resolves to the same option, so only the
  // id has to exist on both sides. A missing or duplicated id is a real binding change.
  if (expected.length !== 1 || live.length !== 1) throw fail("VM_WRITEBACK_OPTION_CHANGED");
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
  // A run whose approved download finished after "下载失败" was written continues from that option.
  const failed = stage.writeback?.downloadFailed;
  if (moment === "processing" && object(failed) && failed.fieldId === stage.statusFieldId
    && validId(failed.optionId)) {
    validatedOption(subject, liveFields, failed.fieldId, failed.optionId);
    if (!statusOptions.includes(failed.optionId)) statusOptions.push(failed.optionId);
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

function textField(field) {
  const type = field?.type, uiType = fieldUiType(field);
  return (type === 1 || type === "1" || type === "text")
    && (uiType === undefined || uiType === null || typeof uiType === "string" && uiType.toLowerCase() === "text");
}

/** The configured AI-notes field must still be the same plain text field in the snapshot and live metadata. */
function notesOperation(subject, liveFields, text) {
  const id = subject.vmWorkflow.fields?.aiNotesFieldId;
  if (!validId(id)) throw fail("VM_WRITEBACK_BINDING_MISSING");
  const snapshot = (subject.metadata?.fields ?? []).filter((field) => fieldId(field) === id);
  if (snapshot.length !== 1 || !textField(snapshot[0]) || typeof fieldName(snapshot[0]) !== "string")
    throw fail("VM_WRITEBACK_CONFIG_CHANGED");
  const live = Array.isArray(liveFields) ? liveFields.filter((field) => fieldId(field) === id) : [];
  if (live.length !== 1 || !textField(live[0]) || fieldName(live[0]) !== fieldName(snapshot[0]))
    throw fail("VM_WRITEBACK_FIELD_CHANGED");
  if (typeof text !== "string" || !text.trim() || text.length > VM_AI_NOTES_MAX_LENGTH || text.includes("\0"))
    throw fail("VM_WRITEBACK_INPUT_INVALID");
  return { type: "text", fieldId: id, value: text };
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
  getDelivery, isLatestStageRun, enqueueWritebackIntent, aiNotesText = async () => null,
  notesSlot = () => null } = {}) {
  if ([resolveTrustedRun, getActiveSubject, listFields, getDelivery, isLatestStageRun,
    enqueueWritebackIntent].some((callback) => typeof callback !== "function"))
    throw fail("VM_WRITEBACK_SERVICE_INVALID");

  async function plan({ runId, moment, slot = null } = {}) {
    if (!validId(runId) || !MOMENTS.has(moment)
      || (moment === "download_failed" ? !FAILURE_SLOT.test(slot ?? "")
        : moment === "ai_notes" ? !NOTES_SLOT.test(slot ?? "") : slot !== null))
      throw fail("VM_WRITEBACK_INPUT_INVALID");
    const run = trustedRun(await resolveTrustedRun({ runId }), runId, moment);
    if (await isLatestStageRun({ run: structuredClone(run) }) !== true)
      throw fail("VM_WRITEBACK_STAGE_ADVANCED");
    const subject = activeSubject(await getActiveSubject({ subjectKey: run.subjectKey }), run);
    if (moment === "completed") confirmedDelivery(await getDelivery({ runId }), run, subject);
    const liveFields = await listFields({ baseToken: run.target.baseToken,
      tableId: run.target.tableId });
    let operation;
    if (moment === "ai_notes") {
      // The text is rebuilt from server-owned run evidence; the slot names exactly that text.
      const text = await aiNotesText({ run: structuredClone(run) });
      if (notesSlot(text) !== slot) throw fail("VM_WRITEBACK_STAGE_ADVANCED");
      operation = notesOperation(subject, liveFields, text);
    } else operation = validatedOperation(subject, liveFields, moment, run.stageId);
    return Object.freeze({ idempotencyKey: vmWritebackIdempotencyKey(runId, moment, slot),
      taskId: run.taskId, runId, courseBindingId: null, operation });
  }

  return Object.freeze({ plan, async enqueue(input) {
    return enqueueWritebackIntent(await plan(input));
  } });
}
