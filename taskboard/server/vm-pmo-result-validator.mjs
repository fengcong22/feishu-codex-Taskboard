import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import {validateVmPmoInputManualRevision} from "./vm-pmo-manual-revision.mjs";

const execFileAsync = promisify(execFile);
const PROTOCOL = "vm_pmo_review_video";
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 1024 * 1024;
const IDENTITY = ["package", "binding", "record", "review_round", "delivery_target"];
const CONTEXT_KEYS = ["protocol", "schema_version", "input_sha256", "run_dir", "source_path",
  "plan_path", "plan_result_path", "result_path", "output_path"];
// v3 adds AI-planning paths. JSON files must stay outside evidence/ and off the package's fixed names.
const V3_CONTEXT_KEYS = ["evidence_dir", "intent_context_path", "intent_path", "analyze_result_path",
  "qa_path", "qa_review_path"];
const V3_FIXED_FILES = ["alignment.words.json", "output.words.json", "qa-result.json", ".plan.lock"];
const PLANNING_MODES = new Set(["rule", "ai_intent"]);
const V3_PLAN_KEYS = ["planning_mode", "output_id", "ai_session", "intent_sha256",
  "evidence_manifest_sha256", "coverage", "rule_cross_check"];
const V3_RECEIPT_KEYS = ["planning_mode", "intent_sha256", "coverage", "blockers"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function same(a, b) { return isDeepStrictEqual(a, b); }

function identifier(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f]/u.test(value);
}

function digest(value) { return typeof value === "string" && SHA256.test(value); }

function interrupted(signal) { if (signal?.aborted) fail("VM_PMO_RUN_INTERRUPTED"); }

function absoluteCanonical(file) {
  return typeof file === "string" && path.isAbsolute(file) && !file.includes("\0")
    && path.normalize(file) === file;
}

function pathIdentity(file) {
  return process.platform === "win32" ? file.toLowerCase() : file;
}

async function assertCanonicalLocation(file, code) {
  try {
    if (await realpath(path.dirname(file)) !== path.dirname(file)) fail(code);
    try { if (await realpath(file) !== file) fail(code); }
    catch (error) { if (error?.code !== "ENOENT") fail(code); }
  } catch { fail(code); }
}

function inside(root, file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) return false;
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function fileInfo(filename, code, maxBytes = Number.MAX_SAFE_INTEGER) {
  try {
    const info = await lstat(filename, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || info.size < 1n || info.size > BigInt(maxBytes)) fail(code);
    return info;
  } catch { fail(code); }
}

function sameInfo(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}

async function bytesAndHash(filename, code, maxBytes) {
  const before = await fileInfo(filename, code, maxBytes);
  let bytes;
  try { bytes = await readFile(filename); } catch { fail(code); }
  const after = await fileInfo(filename, code, maxBytes);
  if (!sameInfo(before, after) || BigInt(bytes.length) !== before.size) fail(code);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), info: after };
}

async function jsonFile(filename, code) {
  const { bytes, sha256 } = await bytesAndHash(filename, code, MAX_JSON_BYTES);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(code); }
  if (!object(value)) fail(code);
  return { value, sha256 };
}

async function hashMedia(filename, code, signal) {
  interrupted(signal);
  const before = await fileInfo(filename, code);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(filename, { signal })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } catch { interrupted(signal); fail(code); }
  const after = await fileInfo(filename, code);
  if (!sameInfo(before, after) || BigInt(bytes) !== before.size) fail(code);
  return { sha256: hash.digest("hex"), bytes, info: after };
}

async function loadBoundInput(contextPath, signal, expectedBound, verifyOriginalMedia = true) {
  interrupted(signal);
  if (!absoluteCanonical(contextPath)
    || path.basename(contextPath) !== "execution-context.json") fail("RUN_BINDING_MISMATCH");
  const { value: context, sha256: contextSha256 } = await jsonFile(contextPath, "RUN_BINDING_MISMATCH");
  if (expectedBound && (contextSha256 !== expectedBound.contextSha256
    || !same(context, expectedBound.context))) fail("RUN_BINDING_MISMATCH");
  const contextV3 = context?.schema_version === 3;
  if (!exactKeys(context, contextV3 ? [...CONTEXT_KEYS, ...V3_CONTEXT_KEYS] : CONTEXT_KEYS)
    || context.protocol !== PROTOCOL
    || ![1, 2, 3].includes(context.schema_version) || !digest(context.input_sha256)
    || context.run_dir !== path.dirname(contextPath) || !absoluteCanonical(context.run_dir)
    || !absoluteCanonical(context.source_path)
    || ![context.plan_path, context.plan_result_path, context.result_path,
      context.output_path].every((file) => absoluteCanonical(file) && inside(context.run_dir, file))
    || new Set([contextPath, path.join(context.run_dir, "input.json"), context.source_path,
      context.plan_path, context.plan_result_path, context.result_path,
      context.output_path].map(pathIdentity)).size !== 7
    || !context.output_path.toLowerCase().endsWith(".mp4")
    || ![context.plan_path, context.plan_result_path, context.result_path]
      .every((file) => file.toLowerCase().endsWith(".json"))) fail("RUN_BINDING_MISMATCH");
  if (contextV3) {
    const jsonPaths = V3_CONTEXT_KEYS.filter((key) => key !== "evidence_dir").map((key) => context[key]);
    const all = [contextPath, path.join(context.run_dir, "input.json"), context.source_path, context.plan_path,
      context.plan_result_path, context.result_path, context.output_path, context.evidence_dir, ...jsonPaths];
    const fixed = new Set(V3_FIXED_FILES.map((name) => pathIdentity(path.join(context.run_dir, name))));
    if (!V3_CONTEXT_KEYS.every((key) => absoluteCanonical(context[key]) && inside(context.run_dir, context[key]))
      || !jsonPaths.every((file) => file.toLowerCase().endsWith(".json") && !inside(context.evidence_dir, file))
      || new Set(all.map(pathIdentity)).size !== all.length
      || all.some((file) => fixed.has(pathIdentity(file)))) fail("RUN_BINDING_MISMATCH");
  }
  try {
    if (await realpath(context.run_dir) !== context.run_dir) fail("RUN_BINDING_MISMATCH");
  } catch { fail("RUN_BINDING_MISMATCH"); }
  for (const file of [contextPath, path.join(context.run_dir, "input.json"),
    ...(verifyOriginalMedia ? [context.source_path] : []), context.plan_path, context.plan_result_path,
    context.result_path, context.output_path,
    ...(contextV3 ? V3_CONTEXT_KEYS.map((key) => context[key]) : [])])
    await assertCanonicalLocation(file, "RUN_BINDING_MISMATCH");
  const inputPath = path.join(context.run_dir, "input.json");
  const { value: input, sha256: inputSha256 } = await jsonFile(inputPath, "RUN_BINDING_MISMATCH");
  if (expectedBound && (!same(input, expectedBound.input)
    || inputSha256 !== expectedBound.context.input_sha256)) fail("RUN_BINDING_MISMATCH");
  const version = input?.schema_version;
  if (!exactKeys(input, ["protocol", "schema_version", ...IDENTITY, "source", "instructions", "output_profile",
    ...(version === 3 ? ["planning_mode"] : [])],
    version === 3 ? ["manual_revision", "ai_session", "prior_rounds"] : version === 2 ? ["manual_revision"] : [])
    || input.protocol !== PROTOCOL || ![1, 2, 3].includes(version) || version !== context.schema_version
    || inputSha256 !== context.input_sha256
    || !object(input.package) || !object(input.binding) || !object(input.record)
    || !object(input.review_round) || !object(input.source) || !object(input.output_profile)
    || !exactKeys(input.package, ["alias", "name", "version", "manifest_sha256"])
    || !digest(input.package.manifest_sha256)
    || ![input.package.alias, input.package.name, input.package.version].every(identifier)
    || !exactKeys(input.binding, ["task_id", "run_id", "subject_key", "config_version",
      "stage_id", "event_id"])
    || !Object.values(input.binding).every(identifier)
    || !exactKeys(input.record, ["base_token", "table_id", "record_id"])
    || !Object.values(input.record).every(identifier)
    || !exactKeys(input.review_round, ["round_id", "input_snapshot_id", "parent"])
    || ![input.review_round.round_id, input.review_round.input_snapshot_id].every(identifier)
    || !exactKeys(input.delivery_target, ["attachment_field_id"])
    || !identifier(input.delivery_target.attachment_field_id)
    || !exactKeys(input.source, ["source_id", "timeline_basis", "vmid", "sha256",
      "bytes", "duration_ms"])
    || ![input.source.source_id, input.source.vmid, input.source.timeline_basis].every(identifier)
    || !Array.isArray(input.instructions) || input.instructions.length < 1
    || input.instructions.some((item) => !exactKeys(item, ["instruction_id",
      "source_field_id", "raw_text", "timeline_basis", "applicability"],
      version >= 2 ? ["must_keep", "visual_evidence"] : [])
      || ![item.instruction_id, item.source_field_id, item.timeline_basis, item.applicability].every(identifier)
      || typeof item.raw_text !== "string" || !item.raw_text.trim()
      || version >= 2 && item.must_keep !== undefined && (!Array.isArray(item.must_keep)
        || item.must_keep.some((phrase) => typeof phrase !== "string" || !phrase.trim() || phrase.includes("\0")))
      || version >= 2 && item.visual_evidence !== undefined && (!exactKeys(item.visual_evidence,
        ["source_sha256", "frame_time", "end"]) || item.visual_evidence.source_sha256 !== input.source.sha256))
    || new Set(input.instructions.map((item) => item.instruction_id)).size !== input.instructions.length
    || !digest(input.source.sha256)
    || !Number.isSafeInteger(input.source.bytes) || input.source.bytes < 1
    || !Number.isSafeInteger(input.source.duration_ms) || input.source.duration_ms < 1)
    fail("RUN_BINDING_MISMATCH");
  if (version === 3 && (!PLANNING_MODES.has(input.planning_mode)
    || input.planning_mode === "ai_intent" && (input.manual_revision !== undefined
      || !exactKeys(input.ai_session, ["agent", "model", "session_id"])
      || !Object.values(input.ai_session).every(identifier))
    || input.planning_mode === "rule" && input.ai_session !== undefined
    || input.prior_rounds !== undefined && (!Array.isArray(input.prior_rounds)
      || input.prior_rounds.some((round) => !exactKeys(round, ["round_id", "instructions"])
        || !identifier(round.round_id) || !Array.isArray(round.instructions)
        || round.instructions.some((item) => !exactKeys(item, ["instruction_id", "raw_text"])
          || !identifier(item.instruction_id) || typeof item.raw_text !== "string")))))
    fail("RUN_BINDING_MISMATCH");
  if (version >= 2) {
    if (input.manual_revision !== undefined) {
      try { validateVmPmoInputManualRevision(input.manual_revision,
        {sourceSha256:input.source.sha256,durationMs:input.source.duration_ms}); }
      catch { fail("RUN_BINDING_MISMATCH"); }
    }
    const stageId = input.binding.stage_id;
    const timeline = stageId === "review" ? "previous_review_video"
      : stageId === "initial" ? "vm_original" : null;
    if (!timeline || input.source.timeline_basis !== timeline || input.instructions.length !== 1
      || input.instructions[0].timeline_basis !== timeline
      || input.instructions[0].applicability !== "current_round") fail("RUN_BINDING_MISMATCH");
    if (stageId === "review") {
      const parent = input.review_round.parent;
      if (!exactKeys(parent, ["kind", "run_id", "artifact_id", "delivery_id", "sha256", "bytes", "duration_ms"])
        || parent.kind !== "managed_run" || ![parent.run_id, parent.artifact_id, parent.delivery_id].every(identifier)
        || parent.run_id === input.binding.run_id || !digest(parent.sha256)
        || parent.sha256 !== input.source.sha256 || parent.bytes !== input.source.bytes
        || parent.duration_ms !== input.source.duration_ms) fail("RUN_BINDING_MISMATCH");
    } else if (input.review_round.parent !== null) fail("RUN_BINDING_MISMATCH");
  }
  // Completed deliveries are verified against their own MP4. Their frozen input
  // identity must remain intact, but the acquired original may have been retired.
  if (!verifyOriginalMedia) return {context,contextSha256,input,sourceSha256:input.source.sha256};
  const source = await hashMedia(context.source_path, "SOURCE_HASH_MISMATCH", signal);
  if (source.sha256 !== input.source.sha256 || source.bytes !== input.source.bytes)
    fail("SOURCE_HASH_MISMATCH");
  return { context, contextSha256, input, sourceSha256: source.sha256 };
}

export async function validateVmPmoInput({ contextPath, signal, expectedBound } = {}) {
  return loadBoundInput(contextPath, signal, expectedBound);
}

export async function validateVmPmoInputSnapshot({contextPath,signal,expectedBound} = {}) {
  if (!object(expectedBound?.context) || !object(expectedBound?.input)
    || !digest(expectedBound.contextSha256)) fail("RUN_BINDING_MISMATCH");
  return loadBoundInput(contextPath,signal,expectedBound,false);
}

function assertIdentity(value, input, context, sourceSha256, code) {
  if (value.protocol !== PROTOCOL || value.schema_version !== input.schema_version
    || value.input_sha256 !== context.input_sha256 || value.source_sha256 !== sourceSha256
    || IDENTITY.some((key) => !same(value[key], input[key]))) fail(code);
}

function safeError(value) {
  return exactKeys(value, ["code", "message"])
    && typeof value.code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(value.code)
    && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 500;
}

/** Blockers are package-written text shown to an operator; keep only short, typed fields. */
export function planBlockers(rows) {
  const text = (value, limit) => typeof value === "string"
    ? value.replace(/[\u0000-\u001f]/gu, " ").slice(0, limit) : null;
  return (Array.isArray(rows) ? rows : []).slice(0, 20).filter(object).map((row) => ({
    code: /^[A-Z][A-Z0-9_]{1,80}$/u.test(row.code ?? "") ? row.code : "INTENT_BLOCKED",
    ...(text(row.rule, 16) ? { rule: text(row.rule, 16) } : {}),
    message: text(row.message ?? row.reason, 500) ?? "",
  }));
}

function instructionResultsMatch(items, instructions, status) {
  return Array.isArray(items) && items.length === instructions.length
    && items.every((item, index) => exactKeys(item, ["instruction_id", "source_field_id",
      "raw_text", "status", "segments"])
      && item.instruction_id === instructions[index].instruction_id
      && item.source_field_id === instructions[index].source_field_id
      && item.raw_text === instructions[index].raw_text
      && item.status === status && Array.isArray(item.segments)
      && (status !== "blocked" || item.segments.length === 0));
}

async function assertAbsent(filename, code) {
  try { await lstat(filename); fail(code); }
  catch (error) { if (error?.code !== "ENOENT") fail(code); }
}

function validateReadyPlan(plan, input, context, sourceSha256) {
  if (input.schema_version >= 2) return validateReadyV2Plan(plan, input, context, sourceSha256);
  if (input.binding.stage_id !== "initial" || input.review_round.parent !== null
    || input.source.timeline_basis !== "vm_original"
    || !same(input.output_profile, { id: "review_mp4_v1", width: 1920, height: 1080,
      fps: 25, audio: "preserve" })
    || input.instructions.length !== 1 || input.instructions.some((item) =>
      item.timeline_basis !== "vm_original" || item.applicability !== "current_round")) fail("PLAN_INVALID");
  if (!exactKeys(plan, ["protocol", "schema_version", ...IDENTITY, "source", "input_sha256",
    "source_sha256", "instruction_results", "segments", "operations", "expected_duration_ms",
    "engine_plan_sha256"])) fail("PLAN_INVALID");
  assertIdentity(plan, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (!same(plan.source, input.source) || !digest(plan.engine_plan_sha256)
    || !Array.isArray(plan.instruction_results) || !Array.isArray(plan.segments)
    || !Array.isArray(plan.operations) || plan.operations.length !== 0
    || input.instructions.length !== 1 || plan.instruction_results.length !== 1
    || plan.segments.length === 0) fail("PLAN_INVALID");
  const instruction = input.instructions[0];
  const disposition = plan.instruction_results[0];
  if (!exactKeys(disposition, ["instruction_id", "source_field_id", "raw_text", "status", "segments"])
    || disposition.instruction_id !== instruction.instruction_id
    || disposition.source_field_id !== instruction.source_field_id
    || disposition.raw_text !== instruction.raw_text || disposition.status !== "resolved"
    || !Array.isArray(disposition.segments)) fail("PLAN_INVALID");
  const seen = new Set();
  let duration = 0;
  for (const segment of plan.segments) {
    if (!exactKeys(segment, ["segment_id", "source_id", "start_ms", "end_ms"])
      || !identifier(segment.segment_id) || seen.has(segment.segment_id)
      || segment.source_id !== input.source.source_id || !Number.isSafeInteger(segment.start_ms)
      || !Number.isSafeInteger(segment.end_ms) || segment.start_ms < 0
      || segment.end_ms <= segment.start_ms || segment.end_ms > input.source.duration_ms) fail("PLAN_INVALID");
    seen.add(segment.segment_id);
    duration += segment.end_ms - segment.start_ms;
  }
  if (!same(disposition.segments, plan.segments.map((segment) => segment.segment_id))
    || !Number.isSafeInteger(duration) || duration !== plan.expected_duration_ms) fail("PLAN_INVALID");
}

function validateReadyV2Plan(plan, input, context, sourceSha256) {
  const stageId = input.binding.stage_id;
  const timeline = stageId === "review" ? "previous_review_video"
    : stageId === "initial" ? "vm_original" : null;
  if (!timeline || input.source.timeline_basis !== timeline
    || stageId === "review" && input.review_round.parent?.kind !== "managed_run"
    || stageId === "initial" && input.review_round.parent !== null
    || !same(input.output_profile, { id: "review_mp4_v1", width: 1920, height: 1080,
      fps: 25, audio: "preserve" }) || input.instructions.length !== 1
    || input.instructions[0].timeline_basis !== timeline
    || input.instructions[0].applicability !== "current_round") fail("PLAN_INVALID");
  const v3 = input.schema_version === 3;
  const ai = v3 && input.planning_mode === "ai_intent";
  if (!exactKeys(plan, ["protocol", "schema_version", ...IDENTITY, "source", "input_sha256",
    "source_sha256", "instruction_results", "segments", "operations", "expected_duration_ms",
    "engine_plan_sha256", "alignment_sha256", ...(v3 ? V3_PLAN_KEYS : [])])) fail("PLAN_INVALID");
  assertIdentity(plan, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (v3 && (plan.planning_mode !== input.planning_mode
    || !same(plan.ai_session, input.ai_session ?? null) || !identifier(plan.output_id)
    || (ai ? !digest(plan.intent_sha256) || !digest(plan.evidence_manifest_sha256)
      || !Array.isArray(plan.coverage) || !plan.coverage.length || plan.coverage.some((row) => !object(row))
      || !["agreed", "not_applicable"].includes(plan.rule_cross_check) || !digest(plan.alignment_sha256)
      : plan.intent_sha256 !== null || plan.evidence_manifest_sha256 !== null || plan.coverage !== null
        || plan.rule_cross_check !== null))) fail("PLAN_INVALID");
  if (!same(plan.source, input.source) || !digest(plan.engine_plan_sha256)
    || plan.alignment_sha256 !== null && !digest(plan.alignment_sha256)
    || !Array.isArray(plan.instruction_results) || plan.instruction_results.length !== 1
    || !Array.isArray(plan.segments) || !plan.segments.length
    || !Array.isArray(plan.operations)) fail("PLAN_INVALID");
  const instruction = input.instructions[0], disposition = plan.instruction_results[0];
  if (!exactKeys(disposition, ["instruction_id", "source_field_id", "raw_text", "status", "segments"])
    || disposition.instruction_id !== instruction.instruction_id
    || disposition.source_field_id !== instruction.source_field_id
    || disposition.raw_text !== instruction.raw_text || disposition.status !== "resolved"
    // An AI-covered instruction may be all constraints or notes and own no segment of its own.
    || !Array.isArray(disposition.segments) || !ai && !disposition.segments.length
    || disposition.segments.some((segmentId) => !identifier(segmentId))) fail("PLAN_INVALID");
  let targetOffset = 0;
  const seen = new Set();
  let totalDurationUs = 0;
  for (const segment of plan.segments) {
    if (!exactKeys(segment, ["segment_id", "source_id", "source_start_us", "duration_us", "target_start_us"])
      || !identifier(segment.segment_id) || seen.has(segment.segment_id)
      || segment.source_id !== input.source.source_id
      || !Number.isSafeInteger(segment.source_start_us) || segment.source_start_us < 0
      || !Number.isSafeInteger(segment.duration_us) || segment.duration_us < 1
      || segment.source_start_us + segment.duration_us > input.source.duration_ms * 1000
      || segment.target_start_us !== targetOffset) fail("PLAN_INVALID");
    seen.add(segment.segment_id);
    targetOffset += segment.duration_us;
    totalDurationUs += segment.duration_us;
  }
  if (Math.round(totalDurationUs / 1000) !== plan.expected_duration_ms
    || !Number.isSafeInteger(plan.expected_duration_ms) || plan.expected_duration_ms < 1
    || disposition.segments.some((segmentId) => !seen.has(segmentId))) fail("PLAN_INVALID");
  for (const entry of plan.operations) {
    // AI plans tag each operation with the intent item it came from; the rest of the row is unchanged.
    if (ai && (!object(entry) || !identifier(entry.intent_id))) fail("PLAN_INVALID");
    const operation = ai ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "intent_id")) : entry;
    if (!object(operation) || !identifier(operation.operation_id)
      || !Number.isSafeInteger(operation.source_start_us) || operation.source_start_us < 0
      || !Number.isSafeInteger(operation.source_end_us) || operation.source_end_us <= operation.source_start_us
      || operation.source_end_us > input.source.duration_ms * 1000) fail("PLAN_INVALID");
    if (operation.kind === "start_cue") {
      const visualSyncKeys = ["visual_anchor_us", "visual_sync_tolerance_us", "visual_sync_delta_us"];
      const hasVisualSyncEvidence = visualSyncKeys.some((key) => Object.hasOwn(operation, key));
      if (!exactKeys(operation, ["operation_id", "kind", "source_start_us", "source_end_us",
        "requested_start_us", "search_end_us", "search_radius_us", "matched_text", "match_strategy",
        "alignment_sha256", "provider", "model", "adapter"], visualSyncKeys)
        || hasVisualSyncEvidence && !visualSyncKeys.every((key) => Object.hasOwn(operation, key))
        || !Number.isSafeInteger(operation.requested_start_us) || operation.requested_start_us < 0
        || operation.requested_start_us > input.source.duration_ms * 1000
        || !Number.isSafeInteger(operation.search_end_us) || operation.search_end_us < operation.source_end_us
        || operation.search_end_us > input.source.duration_ms * 1000
        || !Number.isSafeInteger(operation.search_radius_us) || operation.search_radius_us < 0
        || operation.search_radius_us > input.source.duration_ms * 1_000_000
        || Math.abs(operation.source_start_us - operation.requested_start_us) > operation.search_radius_us
        || typeof operation.matched_text !== "string" || !operation.matched_text.trim()
        || operation.match_strategy !== "unique_exact_whole_token"
        || operation.alignment_sha256 !== plan.alignment_sha256 || !plan.alignment_sha256
        || ![operation.provider, operation.model, operation.adapter].every((value) => typeof value === "string" && value.trim()))
        fail("PLAN_INVALID");
      if (hasVisualSyncEvidence && (!Number.isSafeInteger(operation.visual_anchor_us)
        || operation.visual_anchor_us < 0 || operation.visual_anchor_us > input.source.duration_ms * 1000
        || operation.visual_anchor_us !== operation.requested_start_us
        || !Number.isSafeInteger(operation.visual_sync_tolerance_us)
        || operation.visual_sync_tolerance_us < 0
        || operation.visual_sync_tolerance_us > input.source.duration_ms * 1000
        || operation.visual_sync_delta_us !== Math.abs(operation.source_start_us - operation.visual_anchor_us)
        || operation.visual_sync_delta_us > operation.visual_sync_tolerance_us)) fail("PLAN_INVALID");
    } else if (["word", "mute_word"].includes(operation.kind)) {
      if (!exactKeys(operation, ["operation_id", "kind", "source_start_us", "source_end_us", "target_join_us",
        "matched_text", "match_strategy", "alignment_sha256", "provider", "model", "adapter", "must_keep_evidence"])
        || !Number.isSafeInteger(operation.target_join_us) || operation.target_join_us < 0
        || typeof operation.matched_text !== "string" || !operation.matched_text.trim()
        || operation.match_strategy !== "unique_exact_whole_token"
        || operation.alignment_sha256 !== plan.alignment_sha256 || !plan.alignment_sha256
        || ![operation.provider, operation.model, operation.adapter].every((value) => typeof value === "string" && value.trim())
        || !Array.isArray(operation.must_keep_evidence)) fail("PLAN_INVALID");
    } else if (ai && operation.kind === "range") {
      // Range deletions carry timing only; the word-match fields are null and must_keep stays evidenced.
      if (!exactKeys(operation, ["operation_id", "kind", "source_start_us", "source_end_us", "target_join_us",
        "matched_text", "match_strategy", "alignment_sha256", "provider", "model", "adapter", "must_keep_evidence"])
        || !Number.isSafeInteger(operation.target_join_us) || operation.target_join_us < 0
        || ["matched_text", "match_strategy", "alignment_sha256", "provider", "model", "adapter"]
          .some((key) => operation[key] !== null)
        || !Array.isArray(operation.must_keep_evidence)) fail("PLAN_INVALID");
    } else if (operation.kind === "freeze_frame") {
      if (!exactKeys(operation, ["operation_id", "kind", "source_start_us", "source_end_us",
        "target_start_us", "frame_time_us", "alignment_sha256"])
        || operation.alignment_sha256 !== null
        || !Number.isSafeInteger(operation.target_start_us) || operation.target_start_us < 0
        || !Number.isSafeInteger(operation.frame_time_us) || operation.frame_time_us < 0
        || operation.frame_time_us >= input.source.duration_ms * 1000) fail("PLAN_INVALID");
    } else fail("PLAN_INVALID");
  }
}

export async function validateVmPmoPlan({ contextPath, signal, ffprobePath = "ffprobe", timeoutMs = 120_000,
  expectedBound, expectedPlan } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    fail("SOURCE_MEDIA_INVALID");
  const bound = await loadBoundInput(contextPath, signal, expectedBound);
  const { context, input, sourceSha256 } = bound;
  const { value: receipt } = await jsonFile(context.plan_result_path, "PLAN_RESULT_INVALID");
  const v3 = input.schema_version === 3;
  if (!exactKeys(receipt, ["protocol", "schema_version", "status", ...IDENTITY,
    "input_sha256", "source_sha256", "plan_sha256", "instruction_results", "error",
    ...(v3 ? V3_RECEIPT_KEYS : [])]))
    fail("PLAN_RESULT_INVALID");
  assertIdentity(receipt, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (!Array.isArray(receipt.instruction_results)) fail("PLAN_RESULT_INVALID");
  if (v3 && (receipt.planning_mode !== input.planning_mode || !Array.isArray(receipt.blockers)
    || receipt.intent_sha256 !== null && !digest(receipt.intent_sha256))) fail("PLAN_RESULT_INVALID");
  if (receipt.status === "blocked") {
    if (receipt.plan_sha256 !== null || !safeError(receipt.error)
      || !instructionResultsMatch(receipt.instruction_results, input.instructions, "blocked")
      || v3 && (receipt.coverage !== null || !receipt.blockers.length))
      fail("PLAN_RESULT_INVALID");
    await assertAbsent(context.plan_path, "PLAN_RESULT_INVALID");
    await assertAbsent(context.output_path, "PLAN_RESULT_INVALID");
    return { status: "blocked", errorCode: receipt.error.code, context, input,
      ...(v3 ? { blockers: planBlockers(receipt.blockers) } : {}) };
  }
  if (receipt.status !== "ready" || receipt.error !== null || !digest(receipt.plan_sha256)
    || v3 && receipt.blockers.length) fail("PLAN_RESULT_INVALID");
  const { value: plan, sha256: planSha256 } = await jsonFile(context.plan_path, "PLAN_INVALID");
  if (planSha256 !== receipt.plan_sha256) fail("PLAN_BINDING_MISMATCH");
  validateReadyPlan(plan, input, context, sourceSha256);
  if (!same(receipt.instruction_results, plan.instruction_results)
    || v3 && (receipt.intent_sha256 !== plan.intent_sha256 || !same(receipt.coverage, plan.coverage)))
    fail("PLAN_RESULT_INVALID");
  if (expectedPlan && (planSha256 !== expectedPlan.planSha256 || !same(plan, expectedPlan.plan)
    || !same(receipt, expectedPlan.receipt))) fail("PLAN_BINDING_MISMATCH");
  const sourceMedia = await probeMov(context.source_path, { ffprobePath, timeoutMs, signal }, "SOURCE_MEDIA_INVALID");
  if (Math.abs(sourceMedia.durationMs - input.source.duration_ms) > 1) fail("SOURCE_MEDIA_INVALID");
  const sourceAfter = await hashMedia(context.source_path, "SOURCE_HASH_MISMATCH", signal);
  if (sourceAfter.sha256 !== sourceSha256 || sourceAfter.bytes !== input.source.bytes) fail("SOURCE_HASH_MISMATCH");
  return { status: "ready", plan, planSha256, receipt, ...bound };
}

function mediaEnvironment() {
  const allowed = new Set(["path", "systemroot", "windir", "temp", "tmp", "lang", "lc_all"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
}

async function probeMov(file, { ffprobePath, timeoutMs, signal }, code) {
  interrupted(signal);
  const options = { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: mediaEnvironment(), signal };
  let probe;
  try {
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-protocol_whitelist", "file",
      "-f", "mov", "-enable_drefs", "0", "-show_format", "-show_streams", "-of", "json", file], options);
    probe = JSON.parse(stdout);
  } catch { interrupted(signal); fail(code); }
  if (!object(probe) || !Array.isArray(probe.streams)) fail(code);
  const videos = probe.streams.filter((stream) => stream.codec_type === "video"
    && stream.disposition?.attached_pic !== 1);
  const audios = probe.streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length !== 1) fail(code);
  const video = videos[0];
  const audio = audios[0];
  const [frames, seconds] = String(video.avg_frame_rate).split("/").map(Number);
  const fps = frames / seconds;
  const durationMs = Math.round(Number(probe.format?.duration) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) fail(code);
  return { probe, video, audio, fps, durationMs };
}

function trackCoversPlan(track, expectedMs) {
  const startMs = Number(track.start_time) * 1000;
  const durationMs = Number(track.duration) * 1000;
  return Number.isFinite(startMs) && Math.abs(startMs) <= 80
    && Number.isFinite(durationMs) && durationMs > 0 && Math.abs(durationMs - expectedMs) <= 80
    && Math.abs(startMs + durationMs - expectedMs) <= 80;
}

async function probeMedia(file, { ffprobePath, ffmpegPath, timeoutMs, signal, expectedDurationMs }) {
  const { video, audio, fps, durationMs } = await probeMov(file,
    { ffprobePath, timeoutMs, signal }, "MEDIA_VALIDATION_FAILED");
  if (video.codec_name !== "h264" || audio.codec_name !== "aac"
    || video.width !== 1920 || video.height !== 1080 || fps !== 25
    || video.pix_fmt !== "yuv420p"
    || !trackCoversPlan(video, expectedDurationMs) || !trackCoversPlan(audio, expectedDurationMs))
    fail("MEDIA_VALIDATION_FAILED");
  const options = { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: mediaEnvironment(), signal };
  try {
    await execFileAsync(ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-max_error_rate", "0",
      "-protocol_whitelist", "file", "-f", "mov", "-enable_drefs", "0", "-i", file,
      "-map", "0:v:0", "-map", "0:a:0",
      "-f", "null", "-"], options);
  } catch { interrupted(signal); fail("MEDIA_VALIDATION_FAILED"); }
  return { durationMs, video: { codec: "h264", width: 1920, height: 1080, fps }, audio: { codec: "aac" } };
}

export async function validateVmPmoRender({ contextPath, ffprobePath = "ffprobe",
  ffmpegPath = "ffmpeg", timeoutMs = 120_000, signal, expectedBound, expectedPlan } = {}) {
  interrupted(signal);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    fail("MEDIA_VALIDATION_FAILED");
  const plan = await validateVmPmoPlan({ contextPath, signal, ffprobePath, timeoutMs, expectedBound, expectedPlan });
  if (plan.status !== "ready") fail("PLAN_BLOCKED");
  const { context, input, sourceSha256, planSha256 } = plan;
  const { value: result } = await jsonFile(context.result_path, "RENDER_RESULT_INVALID");
  if (!exactKeys(result, ["protocol", "schema_version", "status", ...IDENTITY,
    "input_sha256", "source_sha256", "plan_sha256", "instruction_results",
    "artifacts", "error"])) fail("RENDER_RESULT_INVALID");
  assertIdentity(result, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (result.plan_sha256 !== planSha256) fail("PLAN_BINDING_MISMATCH");
  if (!Array.isArray(result.instruction_results)) fail("RENDER_RESULT_INVALID");
  if (result.status === "blocked" || result.status === "failed") {
    if (!safeError(result.error) || !Array.isArray(result.artifacts) || result.artifacts.length
      || !instructionResultsMatch(result.instruction_results, input.instructions, "blocked"))
      fail("RENDER_RESULT_INVALID");
    await assertAbsent(context.output_path, "RENDER_RESULT_INVALID");
    return { status: result.status, errorCode: result.error.code, context, input };
  }
  if (result.status !== "rendered" || result.error !== null
    || !same(result.instruction_results, plan.plan.instruction_results)
    || !Array.isArray(result.artifacts) || result.artifacts.length !== 1) fail("RENDER_RESULT_INVALID");
  const artifact = result.artifacts[0];
  if (!exactKeys(artifact, ["kind", "path", "sha256", "bytes", "duration_ms",
    "width", "height", "fps", "has_audio", "full_decode_passed"])
    || artifact.kind !== "review_mp4" || artifact.path !== context.output_path
    || !digest(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes < 1 || !Number.isSafeInteger(artifact.duration_ms)
    || artifact.duration_ms < 1 || artifact.width !== 1920 || artifact.height !== 1080
    || artifact.fps !== 25 || artifact.has_audio !== true
    || artifact.full_decode_passed !== true) fail("RUN_BINDING_MISMATCH");
  const actual = await hashMedia(context.output_path, "MEDIA_VALIDATION_FAILED", signal);
  if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) fail("MEDIA_VALIDATION_FAILED");
  const media = await probeMedia(context.output_path, { ffprobePath, ffmpegPath, timeoutMs, signal,
    expectedDurationMs: plan.plan.expected_duration_ms });
  if (Math.abs(media.durationMs - artifact.duration_ms) > 80
    || Math.abs(media.durationMs - plan.plan.expected_duration_ms) > 80) fail("MEDIA_VALIDATION_FAILED");
  const after = await hashMedia(context.output_path, "MEDIA_VALIDATION_FAILED", signal);
  if (!sameInfo(actual.info, after.info) || actual.sha256 !== after.sha256) fail("MEDIA_VALIDATION_FAILED");
  return { ...plan, status: "rendered", artifact, media, result };
}

function requireAiInput(input) {
  if (input.schema_version !== 3 || input.planning_mode !== "ai_intent") fail("RUN_BINDING_MISMATCH");
}

/** analyze-result.json binds the source ASR, the intent context and the first evidence manifest. */
export async function validateVmPmoAnalyze({ contextPath, signal, expectedBound } = {}) {
  const bound = await loadBoundInput(contextPath, signal, expectedBound);
  const { context, input, sourceSha256 } = bound;
  requireAiInput(input);
  const { value: result, sha256 } = await jsonFile(context.analyze_result_path, "ANALYZE_RESULT_INVALID");
  if (!exactKeys(result, ["protocol", "schema_version", "status", ...IDENTITY, "input_sha256", "source_sha256",
    "planning_mode", "alignment_sha256", "intent_context_sha256", "evidence_manifest_sha256", "evidence_ids", "error"])
    || result.planning_mode !== "ai_intent" || !Array.isArray(result.evidence_ids)) fail("ANALYZE_RESULT_INVALID");
  assertIdentity(result, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (result.status === "blocked") {
    if (!safeError(result.error) || result.alignment_sha256 !== null || result.intent_context_sha256 !== null
      || result.evidence_manifest_sha256 !== null) fail("ANALYZE_RESULT_INVALID");
    await assertAbsent(context.intent_path, "ANALYZE_RESULT_INVALID");
    return { status: "blocked", errorCode: result.error.code, analyzeSha256: sha256, context, input };
  }
  if (result.status !== "ready" || result.error !== null
    || ![result.alignment_sha256, result.intent_context_sha256, result.evidence_manifest_sha256].every(digest)
    || !result.evidence_ids.every(identifier)) fail("ANALYZE_RESULT_INVALID");
  const alignment = await bytesAndHash(path.join(context.run_dir, "alignment.words.json"),
    "ANALYZE_RESULT_INVALID", 256 * 1024 * 1024);
  const intentContext = await bytesAndHash(context.intent_context_path, "ANALYZE_RESULT_INVALID", MAX_JSON_BYTES);
  if (alignment.sha256 !== result.alignment_sha256 || intentContext.sha256 !== result.intent_context_sha256)
    fail("ANALYZE_RESULT_INVALID");
  return { status: "ready", analyzeSha256: sha256, alignmentSha256: result.alignment_sha256,
    intentContextSha256: result.intent_context_sha256, context, input };
}

const QA_STATUSES = new Set(["passed", "failed", "needs_human", "not_run", "ai_reviewed"]);

/** qa-result.json is written once; checked only means QA ran, overall carries the outcome. */
export async function validateVmPmoQa({ contextPath, signal, expectedBound, planSha256 } = {}) {
  const bound = await loadBoundInput(contextPath, signal, expectedBound, false);
  const { context, input, sourceSha256 } = bound;
  requireAiInput(input);
  const { value: result } = await jsonFile(path.join(context.run_dir, "qa-result.json"), "QA_RESULT_INVALID");
  if (!exactKeys(result, ["protocol", "schema_version", "status", ...IDENTITY, "input_sha256", "source_sha256",
    "plan_sha256", "qa_sha256", "overall", "counts", "reverse_asr", "error"])
    || typeof result.reverse_asr !== "boolean") fail("QA_RESULT_INVALID");
  assertIdentity(result, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (result.status === "blocked" || result.status === "failed") {
    if (!safeError(result.error) || result.qa_sha256 !== null || result.overall !== null || result.counts !== null)
      fail("QA_RESULT_INVALID");
    return { status: result.status, errorCode: result.error.code };
  }
  if (result.status !== "checked" || result.error !== null || result.plan_sha256 !== planSha256 || !digest(planSha256)
    || !digest(result.qa_sha256) || !["failed", "ready_for_review"].includes(result.overall)
    || !object(result.counts) || Object.entries(result.counts).some(([key, count]) =>
      !QA_STATUSES.has(key) || !Number.isSafeInteger(count) || count < 0)) fail("QA_RESULT_INVALID");
  const report = await bytesAndHash(context.qa_path, "QA_RESULT_INVALID", 16 * 1024 * 1024);
  if (report.sha256 !== result.qa_sha256) fail("QA_RESULT_INVALID");
  return { status: "checked", overall: result.overall, counts: { ...result.counts }, qaSha256: result.qa_sha256,
    reverseAsr: result.reverse_asr };
}
