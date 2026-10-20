import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { validateVmPmoInput, validateVmPmoPlan, validateVmPmoRender } from "../server/vm-pmo-result-validator.mjs";

const runCommand = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let sourcePromise;
async function sourceFixture() {
  sourcePromise ??= (async () => {
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-fixture-source-")));
    try {
      const source = path.join(temporary, "source.mp4");
      await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "color=c=black:s=1280x720:r=25:d=1", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=48000:duration=1", "-c:v", "libx264", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { timeout: 120_000 });
      return await readFile(source);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  })();
  return sourcePromise;
}

async function fixture(t) {
  const runDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-validate-")));
  t.after(() => rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const paths = Object.fromEntries(["input", "source", "plan", "plan-result", "result", "review"]
    .map((name) => [name, path.join(runDir, `${name}${["source", "review"].includes(name) ? ".mp4" : ".json"}`)]));
  const sourceBytes = await sourceFixture();
  await writeFile(paths.source, sourceBytes);
  const identity = {
    protocol: "vm_pmo_review_video", schema_version: 1,
    package: { alias: "vm", name: "vm-package", version: "1.0.0", manifest_sha256: "a".repeat(64) },
    binding: { task_id: "task-1", run_id: "run-1", subject_key: "base:table", config_version: "config-1",
      stage_id: "initial", event_id: "event-1" },
    record: { base_token: "base", table_id: "table", record_id: "record" },
    review_round: { round_id: "round-1", input_snapshot_id: "snapshot-1", parent: null },
    delivery_target: { attachment_field_id: "fld-output" },
  };
  const source = { source_id: "source-1", timeline_basis: "vm_original",
    vmid: "vmid-1", sha256: hash(sourceBytes), bytes: sourceBytes.length, duration_ms: 1000 };
  const instructions = [{ instruction_id: "instruction-1", source_field_id: "fld-instruction",
    raw_text: "0:00-0:01", timeline_basis: "vm_original", applicability: "current_round" }];
  const input = { ...identity, source, instructions, output_profile: { id: "review_mp4_v1",
    width: 1920, height: 1080, fps: 25, audio: "preserve" } };
  const inputBytes = Buffer.from(JSON.stringify(input));
  await writeFile(paths.input, inputBytes);
  const context = { protocol: identity.protocol, schema_version: 1, input_sha256: hash(inputBytes),
    run_dir: runDir, source_path: paths.source, plan_path: paths.plan,
    plan_result_path: paths["plan-result"], result_path: paths.result, output_path: paths.review };
  const contextPath = path.join(runDir, "execution-context.json");
  await writeFile(contextPath, JSON.stringify(context));
  const plan = { ...identity, source, input_sha256: context.input_sha256, source_sha256: source.sha256,
    instruction_results: [{ instruction_id: instructions[0].instruction_id,
      source_field_id: instructions[0].source_field_id, raw_text: instructions[0].raw_text,
      status: "resolved", segments: ["s1"] }],
    segments: [{ segment_id: "s1", source_id: "source-1", start_ms: 0, end_ms: 1000 }],
    operations: [], expected_duration_ms: 1000, engine_plan_sha256: "b".repeat(64) };
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(paths.plan, planBytes);
  const planSha256 = hash(planBytes);
  const planResult = { ...identity, status: "ready", input_sha256: context.input_sha256,
    source_sha256: source.sha256, plan_sha256: planSha256,
    instruction_results: plan.instruction_results, error: null };
  await writeFile(paths["plan-result"], JSON.stringify(planResult));
  return { contextPath, context, identity, source, input, paths, plan, planResult, planSha256 };
}

async function replaceInput(current, input) {
  const bytes = Buffer.from(JSON.stringify(input));
  await writeFile(current.paths.input, bytes);
  current.context.input_sha256 = hash(bytes);
  await writeFile(current.contextPath, JSON.stringify(current.context));
  current.input = input;
}

async function blockedPlan(current, input = current.input) {
  await replaceInput(current, input);
  await rm(current.paths.plan);
  const receipt = { ...current.identity, review_round: input.review_round,
    binding: input.binding, status: "blocked", input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256, plan_sha256: null,
    instruction_results: input.instructions.map(({ instruction_id, source_field_id, raw_text }) => ({
      instruction_id, source_field_id, raw_text, status: "blocked", segments: [],
    })), error: { code: "INSTRUCTION_UNSUPPORTED", message: "Unsupported instruction" } };
  await writeFile(current.paths["plan-result"], JSON.stringify(receipt));
  return receipt;
}

function renderReceipt(current, overrides = {}) {
  return { ...current.identity, status: "rendered", input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256, plan_sha256: current.planSha256,
    instruction_results: current.plan.instruction_results, artifacts: [], error: null, ...overrides };
}

test("accepts a bound single ordered-segment plan", async (t) => {
  const current = await fixture(t);
  const validated = await validateVmPmoPlan({ contextPath: current.contextPath });
  assert.equal(validated.planSha256, current.planSha256);
  assert.equal(validated.plan.expected_duration_ms, 1000);
});

test("validates a v2 initial plan with source-bound semantic operations", async (t) => {
  const current = await fixture(t);
  const identity = { ...current.identity, schema_version: 2 };
  const instruction = { ...current.input.instructions[0], raw_text: "0:00 剪掉‘测试词’的声音",
    must_keep: [], visual_evidence: undefined };
  delete instruction.visual_evidence;
  const input = { ...identity, source: current.source, instructions: [instruction],
    output_profile: current.input.output_profile };
  await replaceInput(current, input);
  current.context.schema_version = 2;
  await writeFile(current.contextPath, JSON.stringify(current.context));

  const alignmentSha256 = "c".repeat(64);
  const plan = { ...identity, source: current.source, input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256,
    instruction_results: [{ instruction_id: instruction.instruction_id,
      source_field_id: instruction.source_field_id, raw_text: instruction.raw_text,
      status: "resolved", segments: ["s1"] }],
    segments: [{ segment_id: "s1", source_id: current.source.source_id,
      source_start_us: 0, duration_us: 1_000_000, target_start_us: 0 }],
    operations: [{ operation_id: "part1/edit1", kind: "mute_word", source_start_us: 200_000,
      source_end_us: 400_000, target_join_us: 200_000, matched_text: "测试词",
      match_strategy: "unique_exact_whole_token", alignment_sha256: alignmentSha256,
      provider: "fixture", model: "fixture", adapter: "fixture", must_keep_evidence: [] }],
    expected_duration_ms: 1_000, engine_plan_sha256: "b".repeat(64), alignment_sha256: alignmentSha256 };
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(current.paths.plan, planBytes);
  const planSha256 = hash(planBytes);
  const receipt = { ...identity, status: "ready", input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256, plan_sha256: planSha256,
    instruction_results: plan.instruction_results, error: null };
  await writeFile(current.paths["plan-result"], JSON.stringify(receipt));

  const validated = await validateVmPmoPlan({ contextPath: current.contextPath });
  assert.equal(validated.input.binding.stage_id, "initial");
  assert.equal(validated.plan.operations[0].kind, "mute_word");
});

test("validates frozen review text identity without parsing requested edit operations", async (t) => {
  const current = await fixture(t);
  const parent = { kind: "managed_run", run_id: "parent-run", artifact_id: "parent-artifact",
    delivery_id: "delivery-1", sha256: current.source.sha256, bytes: current.source.bytes, duration_ms: 1000 };
  const identity = { ...current.identity, schema_version: 2,
    binding: { ...current.identity.binding, stage_id: "review" },
    review_round: { round_id: "review-run", input_snapshot_id: "review-snapshot", parent } };
  const source = { ...current.source, timeline_basis: "previous_review_video" };
  const instructions = [{ ...current.input.instructions[0], raw_text: "剪辑包根据这条原始意见处理",
    timeline_basis: "previous_review_video" }];
  const input = { ...identity, source, instructions, output_profile: current.input.output_profile };
  const inputBytes = Buffer.from(JSON.stringify(input));
  await writeFile(current.paths.input, inputBytes);
  current.context.schema_version = 2;
  current.context.input_sha256 = hash(inputBytes);
  await writeFile(current.contextPath, JSON.stringify(current.context));

  const alignment = { schema_version: 1, source_sha256: source.sha256, provider: "fixture",
    model: "fixture", adapter: "fixture", words: [
      { text: "前", start: 0, end: 0.2 }, { text: "词", start: 0.2, end: 0.4 },
      { text: "中", start: 0.4, end: 0.6 }, { text: "词", start: 0.6, end: 0.8 },
      { text: "后", start: 0.8, end: 1 },
    ] };
  const alignmentBytes = Buffer.from(JSON.stringify(alignment));
  await writeFile(path.join(path.dirname(current.contextPath), "alignment.words.json"), alignmentBytes);
  const plan = { ...identity, source, input_sha256: current.context.input_sha256, source_sha256: source.sha256,
    instruction_results: [{ instruction_id: instructions[0].instruction_id,
      source_field_id: instructions[0].source_field_id, raw_text: instructions[0].raw_text,
      status: "resolved", segments: ["clip-1"] }],
    segments: [
      { segment_id: "clip-1", source_id: source.source_id, source_start_us: 0,
        duration_us: 200_000, target_start_us: 0 },
      { segment_id: "clip-2", source_id: source.source_id, source_start_us: 400_000,
        duration_us: 600_000, target_start_us: 200_000 },
    ],
    operations: [{ operation_id: "delete-1", kind: "word", source_start_us: 200_000,
      source_end_us: 400_000, target_join_us: 200_000, matched_text: "词",
      match_strategy: "unique_exact_whole_token", alignment_sha256: hash(alignmentBytes),
      provider: "fixture", model: "fixture", adapter: "fixture", must_keep_evidence: [] },
    { operation_id: "clip-1/start_cue", kind: "start_cue", source_start_us: 0,
      source_end_us: 200_000, requested_start_us: 0, search_end_us: 200_000,
      search_radius_us: 3_000_000, matched_text: "前", match_strategy: "unique_exact_whole_token",
      alignment_sha256: hash(alignmentBytes), provider: "fixture", model: "fixture", adapter: "fixture" }],
    expected_duration_ms: 800, engine_plan_sha256: "b".repeat(64), alignment_sha256: hash(alignmentBytes) };
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(current.paths.plan, planBytes);
  const receipt = { ...identity, status: "ready", input_sha256: current.context.input_sha256,
    source_sha256: source.sha256, plan_sha256: hash(planBytes), instruction_results: plan.instruction_results, error: null };
  await writeFile(current.paths["plan-result"], JSON.stringify(receipt));
  const validated = await validateVmPmoPlan({ contextPath: current.contextPath });
  assert.equal(validated.status, "ready");
  assert.equal(validated.plan.expected_duration_ms, 800);
});

test("rejects a stale parent and malformed ordered segments", async (t) => {
  const current = await fixture(t);
  const replacePlan = async (plan) => {
    const bytes = Buffer.from(JSON.stringify(plan));
    await writeFile(current.paths.plan, bytes);
    await writeFile(current.paths["plan-result"], JSON.stringify({ ...current.planResult, plan_sha256: hash(bytes) }));
  };
  await replacePlan({ ...current.plan,
    review_round: { ...current.plan.review_round, parent: { imported_id: "wrong" } } });
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }),
    { code: "RUN_BINDING_MISMATCH" });
  await replacePlan({ ...current.plan, segments: [{ ...current.plan.segments[0], end_ms: 2000 }] });
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }),
    { code: "PLAN_INVALID" });
});

test("rejects changed source", async (t) => {
  const current = await fixture(t);
  await writeFile(current.paths.source, "changed source");
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }),
    { code: "SOURCE_HASH_MISMATCH" });
});

test("rejects symlinked plan", async (t) => {
  const current = await fixture(t);
  const original = path.join(path.dirname(current.paths.plan), "original-plan.json");
  await writeFile(original, await readFile(current.paths.plan));
  await rm(current.paths.plan);
  try { await symlink(original, current.paths.plan); }
  catch (error) { if (error?.code === "EPERM") return t.skip("symlink creation is unavailable"); throw error; }
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }),
    { code: "RUN_BINDING_MISMATCH" });
});

test("rejects wrong artifact path before accepting media", async (t) => {
  const current = await fixture(t);
  const artifact = { kind: "review_mp4", path: path.join(path.dirname(current.paths.review), "elsewhere.mp4"),
    sha256: "c".repeat(64), bytes: 42, duration_ms: 1000, width: 1920, height: 1080,
    fps: 25, has_audio: true, full_decode_passed: true };
  const result = { ...current.identity, status: "rendered", input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256, plan_sha256: current.planSha256,
    instruction_results: current.plan.instruction_results, artifacts: [artifact], error: null };
  await writeFile(current.paths.result, JSON.stringify(result));
  await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }),
    { code: "RUN_BINDING_MISMATCH" });
});

test("validates an actual H264/AAC 1080p25 MP4 and full decode", async (t) => {
  const current = await fixture(t);
  try {
    await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=25:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-shortest", current.paths.review], { timeout: 120_000 });
  } catch (error) {
    if (error?.code === "ENOENT") return t.skip("ffmpeg is unavailable");
    throw error;
  }
  const bytes = await readFile(current.paths.review);
  const result = { ...current.identity, status: "rendered", input_sha256: current.context.input_sha256,
    source_sha256: current.source.sha256, plan_sha256: current.planSha256,
    instruction_results: current.plan.instruction_results,
    artifacts: [{ kind: "review_mp4", path: current.paths.review, sha256: hash(bytes), bytes: bytes.length,
      duration_ms: 1000, width: 1920, height: 1080, fps: 25,
      has_audio: true, full_decode_passed: true }], error: null };
  await writeFile(current.paths.result, JSON.stringify(result));
  const validated = await validateVmPmoRender({ contextPath: current.contextPath });
  assert.equal(validated.status, "rendered");
  assert.equal(validated.media.video.codec, "h264");
  assert.equal(validated.media.audio.codec, "aac");
  for (const change of [{ sha256: "0".repeat(64) }, { bytes: bytes.length + 1 }, { duration_ms: 1400 }]) {
    await writeFile(current.paths.result, JSON.stringify({ ...result,
      artifacts: [{ ...result.artifacts[0], ...change }] }));
    await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }), { code: "MEDIA_VALIDATION_FAILED" });
  }
});

test("accepts a legal blocked receipt preserving multiple unsupported opinions", async (t) => {
  const current = await fixture(t);
  const input = { ...current.input, binding: { ...current.input.binding, stage_id: "first_review" },
    review_round: { ...current.input.review_round, parent: { imported_id: "previous-video" } },
    instructions: [...current.input.instructions, { ...current.input.instructions[0],
      instruction_id: "instruction-2", raw_text: "需要增强节奏" }] };
  await blockedPlan(current, input);
  const result = await validateVmPmoPlan({ contextPath: current.contextPath });
  assert.equal(result.status, "blocked");
  assert.equal(result.errorCode, "INSTRUCTION_UNSUPPORTED");
  assert.deepEqual(result.input.instructions, input.instructions);
});

test("rejects a blocked receipt losing an opinion or retaining a plan/output", async (t) => {
  const current = await fixture(t);
  const receipt = await blockedPlan(current);
  await writeFile(current.paths["plan-result"], JSON.stringify({ ...receipt, instruction_results: [] }));
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "PLAN_RESULT_INVALID" });
  await writeFile(current.paths["plan-result"], JSON.stringify(receipt));
  await writeFile(current.paths.review, "forbidden output");
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "PLAN_RESULT_INVALID" });
});

test("accepts blocked render only when no output artifact exists", async (t) => {
  const current = await fixture(t);
  const receipt = renderReceipt(current, { status: "blocked",
    instruction_results: current.input.instructions.map(({ instruction_id, source_field_id, raw_text }) => ({
      instruction_id, source_field_id, raw_text, status: "blocked", segments: [],
    })), error: { code: "RENDER_BLOCKED", message: "Render blocked" } });
  await writeFile(current.paths.result, JSON.stringify(receipt));
  assert.equal((await validateVmPmoRender({ contextPath: current.contextPath })).status, "blocked");
  await writeFile(current.paths.review, "forbidden output");
  await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }), { code: "RENDER_RESULT_INVALID" });
});

test("allows a canonical source outside run directory and rejects path collisions", async (t) => {
  const current = await fixture(t);
  const store = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-source-store-")));
  t.after(() => rm(store, { recursive: true, force: true }));
  current.context.source_path = path.join(store, "source.mp4");
  await writeFile(current.context.source_path, await readFile(current.paths.source));
  await writeFile(current.contextPath, JSON.stringify(current.context));
  assert.equal((await validateVmPmoPlan({ contextPath: current.contextPath })).status, "ready");
  current.context.plan_path = current.context.plan_result_path;
  await writeFile(current.contextPath, JSON.stringify(current.context));
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "RUN_BINDING_MISMATCH" });
});

test("rejects output directory aliases escaping run directory", async (t) => {
  const current = await fixture(t);
  const external = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-pmo-outside-")));
  t.after(() => rm(external, { recursive: true, force: true }));
  const alias = path.join(current.context.run_dir, "alias");
  try { await symlink(external, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error?.code === "EPERM") return t.skip("directory link is unavailable"); throw error; }
  current.context.output_path = path.join(alias, "review.mp4");
  await writeFile(current.contextPath, JSON.stringify(current.context));
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "RUN_BINDING_MISMATCH" });
});

test("rejects empty, control-character and numeric identity values and duplicate opinion IDs", async (t) => {
  const current = await fixture(t);
  const input = current.input;
  for (const [group, field, invalid] of [["package", "alias", ""], ["binding", "config_version", 1],
    ["record", "record_id", "record\n"], ["review_round", "round_id", " "],
    ["delivery_target", "attachment_field_id", null], ["source", "vmid", 42]]) {
    await replaceInput(current, { ...input, [group]: { ...input[group], [field]: invalid } });
    await assert.rejects(validateVmPmoInput({ contextPath: current.contextPath }), { code: "RUN_BINDING_MISMATCH" });
  }
  await replaceInput(current, { ...input, instructions: [input.instructions[0], input.instructions[0]] });
  await assert.rejects(validateVmPmoInput({ contextPath: current.contextPath }), { code: "RUN_BINDING_MISMATCH" });
});

test("honors cancellation before validation", async (t) => {
  const current = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath, signal: controller.signal }),
    { code: "VM_PMO_RUN_INTERRUPTED" });
});

test("rejects unsupported success capability even when bound receipts mirror the input", async (t) => {
  for (const [name, mutate] of [["review stage", (input) => { input.binding.stage_id = "first_review"; }],
    ["parent", (input) => { input.review_round.parent = { imported_id: "previous" }; }],
    ["timeline", (input) => { input.source.timeline_basis = "review_video"; }],
    ["profile", (input) => { input.output_profile.fps = 24; }],
    ["multiple opinions", (input) => { input.instructions.push({ ...input.instructions[0], instruction_id: "other" }); }]]) {
    await t.test(name, async (subtest) => {
      const current = await fixture(subtest);
      const input = structuredClone(current.input);
      mutate(input);
      await replaceInput(current, input);
      const plan = { ...current.plan, package: input.package, binding: input.binding, record: input.record,
        review_round: input.review_round, source: input.source, input_sha256: current.context.input_sha256 };
      const bytes = Buffer.from(JSON.stringify(plan));
      await writeFile(current.paths.plan, bytes);
      await writeFile(current.paths["plan-result"], JSON.stringify({ ...current.planResult,
        binding: input.binding, review_round: input.review_round, input_sha256: current.context.input_sha256,
        plan_sha256: hash(bytes) }));
      await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "PLAN_INVALID" });
    });
  }
});

test("rejects declared extra artifacts, unknown fields and missing audio", async (t) => {
  const current = await fixture(t);
  const artifact = { kind: "review_mp4", path: current.paths.review, sha256: "c".repeat(64),
    bytes: 42, duration_ms: 1000, width: 1920, height: 1080, fps: 25,
    has_audio: true, full_decode_passed: true };
  for (const [overrides, code] of [[{ artifacts: [artifact, artifact] }, "RENDER_RESULT_INVALID"],
    [{ artifacts: [artifact], unexpected: "unknown" }, "RENDER_RESULT_INVALID"],
    [{ artifacts: [{ ...artifact, has_audio: false }] }, "RUN_BINDING_MISMATCH"],
    [{ artifacts: [artifact], instruction_results: [] }, "RENDER_RESULT_INVALID"]]) {
    await writeFile(current.paths.result, JSON.stringify(renderReceipt(current, overrides)));
    await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }), { code });
  }
});

test("independently rejects a silent or 24fps MP4 despite a valid-looking declaration", async (t) => {
  for (const silent of [true, false]) {
    await t.test(silent ? "silent output" : "wrong frame rate", async (subtest) => {
      const current = await fixture(subtest);
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        `color=c=black:s=1920x1080:r=${silent ? 25 : 24}:d=1`];
      if (!silent) args.push("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1");
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
      if (!silent) args.push("-c:a", "aac", "-shortest");
      args.push(current.paths.review);
      try { await runCommand("ffmpeg", args, { timeout: 120_000 }); }
      catch (error) { if (error?.code === "ENOENT") return subtest.skip("ffmpeg is unavailable"); throw error; }
      const bytes = await readFile(current.paths.review);
      const artifact = { kind: "review_mp4", path: current.paths.review, sha256: hash(bytes), bytes: bytes.length,
        duration_ms: 1000, width: 1920, height: 1080, fps: 25, has_audio: true, full_decode_passed: true };
      await writeFile(current.paths.result, JSON.stringify(renderReceipt(current, { artifacts: [artifact] })));
      await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }), { code: "MEDIA_VALIDATION_FAILED" });
    });
  }
});

test("cancels a running ffprobe validator without exposing subprocess output", async (t) => {
  const current = await fixture(t);
  const output = Buffer.from("bound artifact awaiting media probe");
  await writeFile(current.paths.review, output);
  const artifact = { kind: "review_mp4", path: current.paths.review, sha256: hash(output), bytes: output.length,
    duration_ms: 1000, width: 1920, height: 1080, fps: 25, has_audio: true, full_decode_passed: true };
  await writeFile(current.paths.result, JSON.stringify(renderReceipt(current, { artifacts: [artifact] })));
  const fakeProbe = path.join(current.context.run_dir, process.platform === "win32" ? "probe.exe" : "probe");
  const marker = path.join(current.context.run_dir, "probe-started.txt");
  if (process.platform === "win32") {
    const program = `public class Probe { public static void Main(string[] args) {
      System.IO.File.WriteAllText(${JSON.stringify(marker)}, "started");
      System.Threading.Thread.Sleep(10000); } }`;
    const command = `Add-Type -TypeDefinition '${program.replaceAll("'", "''")}' -OutputAssembly '${fakeProbe.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
    await runCommand("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 30_000 });
  } else {
    await writeFile(fakeProbe, `#!/bin/sh\nprintf started > '${marker.replaceAll("'", "'\\''")}'\nsleep 10\n`, { mode: 0o700 });
  }
  const controller = new AbortController();
  const pending = validateVmPmoRender({ contextPath: current.contextPath, signal: controller.signal,
    ffprobePath: fakeProbe, timeoutMs: 1500 });
  pending.catch(() => {});
  let started = false;
  for (let count = 0; count < 100; count += 1) {
    try { started = Boolean(await readFile(marker, "utf8")); } catch { /* Wait for the probe to start. */ }
    if (started) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  assert.equal(started, true, "native probe started before cancellation");
  await assert.rejects(pending, { code: "VM_PMO_RUN_INTERRUPTED" });
});

test("rejects an output whose audio covers only a fraction of the video", async (t) => {
  const current = await fixture(t);
  await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "color=c=black:s=1920x1080:r=25:d=1", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=48000:duration=0.02", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-c:a", "aac", current.paths.review], { timeout: 120_000 });
  const bytes = await readFile(current.paths.review);
  const artifact = { kind: "review_mp4", path: current.paths.review, sha256: hash(bytes), bytes: bytes.length,
    duration_ms: 1000, width: 1920, height: 1080, fps: 25, has_audio: true, full_decode_passed: true };
  await writeFile(current.paths.result, JSON.stringify(renderReceipt(current, { artifacts: [artifact] })));
  await assert.rejects(validateVmPmoRender({ contextPath: current.contextPath }), { code: "MEDIA_VALIDATION_FAILED" });
});

test("rejects a ready plan bound to a referenced source playlist", async (t) => {
  const current = await fixture(t);
  const playlist = Buffer.from(`ffconcat version 1.0\nfile '${current.paths.source.replaceAll("\\", "/")}'\n`);
  const playlistPath = path.join(current.context.run_dir, "source.ffconcat");
  await writeFile(playlistPath, playlist);
  current.context.source_path = playlistPath;
  const input = { ...current.input, source: { ...current.source, sha256: hash(playlist), bytes: playlist.length } };
  await replaceInput(current, input);
  const plan = { ...current.plan, source: input.source, source_sha256: input.source.sha256,
    input_sha256: current.context.input_sha256 };
  const planBytes = Buffer.from(JSON.stringify(plan));
  await writeFile(current.paths.plan, planBytes);
  await writeFile(current.paths["plan-result"], JSON.stringify({ ...current.planResult,
    source_sha256: input.source.sha256, input_sha256: current.context.input_sha256, plan_sha256: hash(planBytes) }));
  await assert.rejects(validateVmPmoPlan({ contextPath: current.contextPath }), { code: "SOURCE_MEDIA_INVALID" });
});
