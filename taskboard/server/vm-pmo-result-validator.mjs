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
// Schema v3 (AI edit intent) adds these run-local paths; JSON files stay outside evidence_dir.
const V3_CONTEXT_KEYS = ["evidence_dir", "intent_context_path", "intent_path", "analyze_result_path",
  "qa_path", "qa_review_path"];
const V3_JSON_KEYS = V3_CONTEXT_KEYS.filter((key) => key !== "evidence_dir");
const V3_FIXED_FILES = ["alignment.words.json", "output.words.json", ".plan.lock"];
const QA_KINDS = new Set(["coverage_complete", "operation_compiled", "phrase_absent", "phrase_present",
  "cue_first_word", "must_keep_present", "duration_match", "cut_not_inside_word", "sentence_complete",
  "seam_gap", "seam_discontinuity", "opening_frame", "seam_frames", "seam_pause_picture", "freeze_frames",
  "mute_silence", "unlisted_change", "listening", "pacing"]);
const QA_STATUSES = new Set(["passed", "failed", "ai_reviewed", "needs_human", "not_run"]);
const QA_METHODS = new Set(["automatic", "ai_visual", "ai_reading", "human"]);
const QA_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

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
  const v3Context = object(context) && context.schema_version === 3;
  const v3Paths = v3Context ? V3_CONTEXT_KEYS.map((key) => context[key]) : [];
  if (!exactKeys(context, v3Context ? [...CONTEXT_KEYS, ...V3_CONTEXT_KEYS] : CONTEXT_KEYS)
    || context.protocol !== PROTOCOL
    || ![1, 2, 3].includes(context.schema_version) || !digest(context.input_sha256)
    || context.run_dir !== path.dirname(contextPath) || !absoluteCanonical(context.run_dir)
    || !absoluteCanonical(context.source_path)
    || ![context.plan_path, context.plan_result_path, context.result_path,
      context.output_path, ...v3Paths].every((file) => absoluteCanonical(file) && inside(context.run_dir, file))
    || new Set([contextPath, path.join(context.run_dir, "input.json"), context.source_path,
      context.plan_path, context.plan_result_path, context.result_path,
      context.output_path, ...v3Paths].map(pathIdentity)).size !== 7 + v3Paths.length
    || !context.output_path.toLowerCase().endsWith(".mp4")
    || ![context.plan_path, context.plan_result_path, context.result_path,
      ...(v3Context ? V3_JSON_KEYS.map((key) => context[key]) : [])]
      .every((file) => file.toLowerCase().endsWith(".json"))
    || v3Context && (V3_JSON_KEYS.some((key) => !inside(context.run_dir, context[key])
      || inside(context.evidence_dir, context[key]))
      || V3_FIXED_FILES.some((name) => v3Paths.map(pathIdentity)
        .includes(pathIdentity(path.join(context.run_dir, name)))))) fail("RUN_BINDING_MISMATCH");
  try {
    if (await realpath(context.run_dir) !== context.run_dir) fail("RUN_BINDING_MISMATCH");
  } catch { fail("RUN_BINDING_MISMATCH"); }
  for (const file of [contextPath, path.join(context.run_dir, "input.json"),
    ...(verifyOriginalMedia ? [context.source_path] : []), context.plan_path, context.plan_result_path,
    context.result_path, context.output_path, ...v3Paths]) await assertCanonicalLocation(file, "RUN_BINDING_MISMATCH");
  const inputPath = path.join(context.run_dir, "input.json");
  const { value: input, sha256: inputSha256 } = await jsonFile(inputPath, "RUN_BINDING_MISMATCH");
  if (expectedBound && (!same(input, expectedBound.input)
    || inputSha256 !== expectedBound.context.input_sha256)) fail("RUN_BINDING_MISMATCH");
  const version = input?.schema_version;
  if (!exactKeys(input, ["protocol", "schema_version", ...IDENTITY, "source", "instructions", "output_profile",
    ...(version === 3 ? ["planning_mode"] : [])],
    version === 2 ? ["manual_revision"] : version === 3 ? ["manual_revision", "prior_rounds", "ai_session"] : [])
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
  if (version === 3 && !validV3Planning(input)) fail("RUN_BINDING_MISMATCH");
  if (version >= 2) {
    if (input.manual_revision !== undefined) {
      try { validateVmPmoInputManualRevision(input.manual_revision,
        {sourceSha256:input.source.sha256,durationMs:input.source.duration_ms}); }
      catch { fail("RUN_BINDING_MISMATCH"); }
    }
    const stageId = input.binding.stage_id;
    const timeline = stageId === "review" ? "previous_review_video"
      : stageId === "initial" ? "vm_original" : null;
    // Only AI intent planning may carry several instructions; each one belongs to this round.
    if (!timeline || input.source.timeline_basis !== timeline
      || input.instructions.length !== 1 && input.planning_mode !== "ai_intent"
      || input.instructions.some((item) => item.timeline_basis !== timeline
        || item.applicability !== "current_round")) fail("RUN_BINDING_MISMATCH");
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

function validV3Planning(input) {
  const session = input.ai_session;
  if (input.planning_mode === "ai_intent") {
    if (input.manual_revision !== undefined || !exactKeys(session, ["agent", "model", "session_id"])
      || !Object.values(session).every(identifier)) return false;
  } else if (input.planning_mode !== "rule" || session !== undefined) return false;
  const rounds = input.prior_rounds;
  return rounds === undefined || Array.isArray(rounds) && rounds.every((round) =>
    exactKeys(round, ["round_id", "instructions"]) && identifier(round.round_id)
    && Array.isArray(round.instructions) && round.instructions.every((item) =>
      exactKeys(item, ["instruction_id", "raw_text"]) && identifier(item.instruction_id)
      && typeof item.raw_text === "string" && !item.raw_text.includes("\0")));
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

async function exists(filename) {
  try { await lstat(filename); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
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

const V3_RECEIPT_KEYS = ["planning_mode", "intent_sha256", "coverage", "blockers"];
const V3_PLAN_KEYS = ["planning_mode", "output_id", "ai_session", "intent_sha256",
  "evidence_manifest_sha256", "coverage", "rule_cross_check"];

function validV3PlanFields(plan, input) {
  if (plan.planning_mode !== input.planning_mode || !QA_ID.test(plan.output_id)) return false;
  if (input.planning_mode === "rule") {
    return plan.output_id === "review" && plan.ai_session === null && plan.intent_sha256 === null
      && plan.evidence_manifest_sha256 === null && plan.coverage === null && plan.rule_cross_check === null;
  }
  return same(plan.ai_session, input.ai_session) && digest(plan.intent_sha256)
    && digest(plan.evidence_manifest_sha256) && validCoverage(plan.coverage, input)
    && ["agreed", "not_applicable"].includes(plan.rule_cross_check);
}

const DISPOSITIONS = new Set(["operation", "constraint", "context", "unsupported", "needs_evidence", "ambiguous"]);

function validCoverage(coverage, input) {
  const ids = new Set(input.instructions.map((item) => item.instruction_id));
  return Array.isArray(coverage) && coverage.length > 0 && coverage.every((row) => object(row)
    && object(row.span) && ids.has(row.span.instruction_id)
    && Number.isSafeInteger(row.span.start) && Number.isSafeInteger(row.span.end)
    && row.span.start >= 0 && row.span.end > row.span.start
    && typeof row.quote === "string" && DISPOSITIONS.has(row.disposition)
    && (row.intent_ids === undefined || Array.isArray(row.intent_ids)
      && row.intent_ids.every((value) => typeof value === "string")));
}

function validateReadyV2Plan(plan, input, context, sourceSha256) {
  const stageId = input.binding.stage_id;
  const timeline = stageId === "review" ? "previous_review_video"
    : stageId === "initial" ? "vm_original" : null;
  if (!timeline || input.source.timeline_basis !== timeline
    || stageId === "review" && input.review_round.parent?.kind !== "managed_run"
    || stageId === "initial" && input.review_round.parent !== null
    || !same(input.output_profile, { id: "review_mp4_v1", width: 1920, height: 1080,
      fps: 25, audio: "preserve" })
    || input.instructions.length !== 1 && input.planning_mode !== "ai_intent"
    || input.instructions.some((item) => item.timeline_basis !== timeline
      || item.applicability !== "current_round")) fail("PLAN_INVALID");
  const v3 = input.schema_version === 3, aiIntent = v3 && input.planning_mode === "ai_intent";
  if (!exactKeys(plan, ["protocol", "schema_version", ...IDENTITY, "source", "input_sha256",
    "source_sha256", "instruction_results", "segments", "operations", "expected_duration_ms",
    "engine_plan_sha256", "alignment_sha256", ...(v3 ? V3_PLAN_KEYS : [])])) fail("PLAN_INVALID");
  assertIdentity(plan, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (!same(plan.source, input.source) || !digest(plan.engine_plan_sha256)
    || plan.alignment_sha256 !== null && !digest(plan.alignment_sha256)
    || !Array.isArray(plan.instruction_results)
    || plan.instruction_results.length !== input.instructions.length
    || !Array.isArray(plan.segments) || !plan.segments.length
    || !Array.isArray(plan.operations)) fail("PLAN_INVALID");
  if (v3 && !validV3PlanFields(plan, input)) fail("PLAN_INVALID");
  plan.instruction_results.forEach((disposition, index) => {
    const instruction = input.instructions[index];
    // AI intent may cover an instruction only with context/constraint spans, leaving no segment.
    if (!exactKeys(disposition, ["instruction_id", "source_field_id", "raw_text", "status", "segments"])
      || disposition.instruction_id !== instruction.instruction_id
      || disposition.source_field_id !== instruction.source_field_id
      || disposition.raw_text !== instruction.raw_text || disposition.status !== "resolved"
      || !Array.isArray(disposition.segments) || !aiIntent && !disposition.segments.length
      || disposition.segments.some((segmentId) => !identifier(segmentId))) fail("PLAN_INVALID");
  });
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
    || plan.instruction_results.some((disposition) => disposition.segments
      .some((segmentId) => !seen.has(segmentId)))) fail("PLAN_INVALID");
  for (const tagged of plan.operations) {
    // AI intent operations carry the intent_id they were compiled from; rule plans never do.
    if (!object(tagged) || aiIntent !== Object.hasOwn(tagged, "intent_id")
      || aiIntent && !QA_ID.test(tagged.intent_id)) fail("PLAN_INVALID");
    const { intent_id: _intentId, ...operation } = tagged;
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
  if (!Array.isArray(receipt.instruction_results)
    || v3 && (receipt.planning_mode !== input.planning_mode || !Array.isArray(receipt.blockers)
      || receipt.intent_sha256 !== null && !digest(receipt.intent_sha256))) fail("PLAN_RESULT_INVALID");
  if (receipt.status === "blocked") {
    if (receipt.plan_sha256 !== null || !safeError(receipt.error)
      || !instructionResultsMatch(receipt.instruction_results, input.instructions, "blocked")
      || v3 && (receipt.coverage !== null || !receipt.blockers.length
        || receipt.blockers.some((item) => !object(item))))
      fail("PLAN_RESULT_INVALID");
    await assertAbsent(context.plan_path, "PLAN_RESULT_INVALID");
    await assertAbsent(context.output_path, "PLAN_RESULT_INVALID");
    return { status: "blocked", errorCode: receipt.error.code, context, input };
  }
  if (receipt.status !== "ready" || receipt.error !== null || !digest(receipt.plan_sha256))
    fail("PLAN_RESULT_INVALID");
  const { value: plan, sha256: planSha256 } = await jsonFile(context.plan_path, "PLAN_INVALID");
  if (planSha256 !== receipt.plan_sha256) fail("PLAN_BINDING_MISMATCH");
  validateReadyPlan(plan, input, context, sourceSha256);
  if (!same(receipt.instruction_results, plan.instruction_results)
    || v3 && (receipt.blockers.length || !same(receipt.coverage, plan.coverage)
      || receipt.intent_sha256 !== plan.intent_sha256)) fail("PLAN_RESULT_INVALID");
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

/** For schema v3 AI intent runs a rendered MP4 is only deliverable with a passing qa.json;
 * `qa: "skip"` is reserved for the driver's check between render and qa. */
export async function validateVmPmoRender({ contextPath, ffprobePath = "ffprobe",
  ffmpegPath = "ffmpeg", timeoutMs = 120_000, signal, expectedBound, expectedPlan, qa = "require" } = {}) {
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
  if (input.schema_version === 3 && input.planning_mode === "ai_intent" && qa !== "skip") {
    let checked;
    try { checked = await validateVmPmoQa({ contextPath, signal, expectedBound: plan, plan: plan.plan, artifact }); }
    catch (error) {
      if (error?.code === "QA_REPORT_INVALID" && !await exists(context.qa_path)) fail("QA_REQUIRED");
      throw error;
    }
    if (checked.overall === "failed") return { status: "failed", errorCode: "VM_PMO_QA_FAILED", context, input, qa: checked };
    return { ...plan, status: "rendered", artifact, media, result, qa: checked };
  }
  return { ...plan, status: "rendered", artifact, media, result };
}

/** Schema v3 AI intent only: the analyze receipt that binds ASR, intent context and evidence. */
export async function validateVmPmoAnalyze({ contextPath, signal, expectedBound } = {}) {
  const bound = await loadBoundInput(contextPath, signal, expectedBound);
  const { context, input, sourceSha256 } = bound;
  if (input.schema_version !== 3 || input.planning_mode !== "ai_intent") fail("ANALYZE_RESULT_INVALID");
  const { value: result, sha256 } = await jsonFile(context.analyze_result_path, "ANALYZE_RESULT_INVALID");
  if (!exactKeys(result, ["protocol", "schema_version", "status", ...IDENTITY, "input_sha256", "source_sha256",
    "planning_mode", "alignment_sha256", "intent_context_sha256", "evidence_manifest_sha256",
    "evidence_ids", "error"]) || result.planning_mode !== "ai_intent" || !Array.isArray(result.evidence_ids))
    fail("ANALYZE_RESULT_INVALID");
  assertIdentity(result, input, context, sourceSha256, "RUN_BINDING_MISMATCH");
  if (result.status === "blocked") {
    if (!safeError(result.error) || result.alignment_sha256 !== null || result.intent_context_sha256 !== null
      || result.evidence_manifest_sha256 !== null || result.evidence_ids.length) fail("ANALYZE_RESULT_INVALID");
    return { status: "blocked", errorCode: result.error.code, resultSha256: sha256, ...bound };
  }
  if (result.status !== "ready" || result.error !== null
    || ![result.alignment_sha256, result.intent_context_sha256, result.evidence_manifest_sha256].every(digest)
    || !result.evidence_ids.includes("transcript-full")) fail("ANALYZE_RESULT_INVALID");
  const intentContext = await bytesAndHash(context.intent_context_path, "ANALYZE_RESULT_INVALID", MAX_JSON_BYTES);
  const alignment = await bytesAndHash(path.join(context.run_dir, "alignment.words.json"),
    "ANALYZE_RESULT_INVALID", 64 * 1024 * 1024);
  if (intentContext.sha256 !== result.intent_context_sha256 || alignment.sha256 !== result.alignment_sha256)
    fail("ANALYZE_RESULT_INVALID");
  return { status: "ready", resultSha256: sha256, analyze: result, ...bound };
}

function qaCheck(row) {
  return exactKeys(row, ["check_id", "intent_id", "kind", "status", "method", "evidence_ids",
    "target_start_us", "target_end_us", "detail"])
    && QA_ID.test(row.check_id) && (row.intent_id === null || QA_ID.test(row.intent_id))
    && QA_KINDS.has(row.kind) && QA_STATUSES.has(row.status) && QA_METHODS.has(row.method)
    && Array.isArray(row.evidence_ids) && row.evidence_ids.every((value) => QA_ID.test(value))
    && [row.target_start_us, row.target_end_us].every((value) => value === null
      || Number.isSafeInteger(value) && value >= 0)
    && typeof row.detail === "string" && row.detail.length > 0
    && (!["listening", "pacing"].includes(row.kind) || ["needs_human", "not_run", "failed"].includes(row.status))
    && (row.status !== "ai_reviewed" || ["ai_visual", "ai_reading"].includes(row.method));
}

/** Schema v3 AI intent only: qa.json must describe this run's plan and rendered MP4.
 * `overall: failed` is returned as a result, not thrown, so callers can block delivery. */
export async function validateVmPmoQa({ contextPath, signal, expectedBound, plan, artifact } = {}) {
  const bound = await loadBoundInput(contextPath, signal, expectedBound, false);
  const { context, input } = bound;
  if (input.schema_version !== 3 || input.planning_mode !== "ai_intent" || !object(plan) || !object(artifact))
    fail("QA_REPORT_INVALID");
  const { value: report, sha256 } = await jsonFile(context.qa_path, "QA_REPORT_INVALID");
  const bindings = report.bindings;
  if (!exactKeys(report, ["schema", "schema_version", "bindings", "overall", "checks", "limitations"])
    || report.schema !== "auto-cut-slicing/qa-report" || report.schema_version !== 1
    || !exactKeys(bindings, ["intent_sha256", "plan_sha256", "output_id", "output_sha256", "source_sha256s",
      "output_alignment_sha256"])
    || bindings.intent_sha256 !== plan.intent_sha256 || !digest(bindings.plan_sha256)
    || bindings.output_id !== plan.output_id || bindings.output_sha256 !== artifact.sha256
    || !Array.isArray(bindings.source_sha256s) || !bindings.source_sha256s.includes(input.source.sha256)
    || !bindings.source_sha256s.every(digest)
    || bindings.output_alignment_sha256 !== null && !digest(bindings.output_alignment_sha256)
    || !["failed", "ready_for_review"].includes(report.overall)
    || !Array.isArray(report.checks) || !report.checks.length || !report.checks.every(qaCheck)
    || new Set(report.checks.map((row) => row.check_id)).size !== report.checks.length
    || report.overall !== (report.checks.some((row) => row.status === "failed") ? "failed" : "ready_for_review")
    || !Array.isArray(report.limitations) || report.limitations.some((value) => typeof value !== "string"))
    fail("QA_REPORT_INVALID");
  const counts = {};
  for (const row of report.checks) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return { overall: report.overall, qaSha256: sha256, counts,
    reverseAsr: bindings.output_alignment_sha256 !== null, report };
}
