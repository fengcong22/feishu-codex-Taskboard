import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";

import { prepareVmPmoRunInput } from "../server/vm-pmo-run-input.mjs";
import { validateVmPmoInput } from "../server/vm-pmo-result-validator.mjs";
import { createVmPmoAiIntentRunner, isVmPmoAiProviderFailure, vmPmoAiEnvironment } from "../server/vm-pmo-ai-intent.mjs";
import { packageWorkflowFromManifest } from "../shared/feishu-package-workflow.mjs";
import { AI_INTENT_SCOPE_VIOLATION, AI_PROVIDER_FAILED, runVmPmoDriver } from "../server/vm-pmo-v3-driver.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const V3_INTERFACE = { workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
  contract: { id: "vm_pmo_review_video", version: 3 }, driverId: "vm_pmo_review_video_v3", artifactKind: "review_mp4" };

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-v3-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot);
  const manifestPath = path.join(packageRoot, "PACKAGE-MANIFEST.json");
  await writeFile(manifestPath, JSON.stringify({ name: "auto-cut-slicing", version: "0.3.0", interface: V3_INTERFACE }));
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "source");
  return { runRoot: path.join(root, "runs"), runId: "run-1", taskId: "task-1", pythonPath: path.join(root, "python.exe"),
    origin: { source: "feishu-base", packageSource: "subject-config", eventId: "event-1", baseToken: "base-1",
      tableId: "table-1", recordId: "record-1", subjectKey: "base-1:table-1", configVersion: 1, stageId: "initial",
      packageAlias: "slicing", stageSnapshot: { vmContext: { vmid: "vmid-1", title: "name", instruction: "开头那句重复的删掉" } } },
    profile: { fields: { namingFieldId: "fld-name", outputAttachmentFieldId: "fld-output" },
      stages: { initial: { instructionFieldId: "fld-instruction" } } },
    packageSnapshot: { packageAlias: "slicing", workspacePath: packageRoot,
      workflowTemplate: { id: "vm_pmo_review_video", version: 1 } },
    packageIdentity: { name: "auto-cut-slicing", version: "0.3.0", manifestSha256: sha(await readFile(manifestPath)),
      contractVersion: 3, driverId: "vm_pmo_review_video_v3" },
    acquisition: { path: sourcePath, sha256: sha("source"), bytes: 6, duration_ms: 25000,
      vmid_binding: "vm_api_verified", vmid: "vmid-1" },
    aiSession: { agent: "codex", model: "gpt-test" } };
}

test("package workflow accepts the v3 contract only with its fixed driver", () => {
  assert.equal(packageWorkflowFromManifest(V3_INTERFACE).id, "vm_pmo_review_video");
  const { driverId: _driver, ...withoutDriver } = V3_INTERFACE;
  assert.throws(() => packageWorkflowFromManifest(withoutDriver));
  assert.throws(() => packageWorkflowFromManifest({ ...V3_INTERFACE, driverId: "vm_pmo_review_video_v2" }));
});

test("v3 input plans free-form feedback through AI intent with six run-local paths", async t => {
  const args = await fixture(t);
  const prepared = await prepareVmPmoRunInput(args);
  const bound = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(bound.input.schema_version, 3);
  assert.equal(bound.input.planning_mode, "ai_intent");
  assert.deepEqual(bound.input.ai_session, { agent: "codex", model: "gpt-test", session_id: "taskboard-run-1-p1" });
  assert.equal(bound.input.instructions[0].raw_text, "开头那句重复的删掉");
  for (const key of ["evidence_dir", "intent_context_path", "intent_path", "analyze_result_path", "qa_path", "qa_review_path"])
    assert.equal(path.dirname(bound.context[key]), bound.context.run_dir);
  await assert.rejects(prepareVmPmoRunInput({ ...args, runId: "run-2", aiSession: undefined }),
    { code: "VM_PMO_AI_NOT_CONFIGURED" });
});

test("v3 manual revision keeps the deterministic rule path without an AI session", async t => {
  const args = await fixture(t);
  const prepared = await prepareVmPmoRunInput({ ...args, aiSession: undefined,
    manualRevision: { sourceSha256: args.acquisition.sha256, note: "人工返修", clips: [{ startMs: 0, endMs: 1000 }] } });
  const { input } = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(input.planning_mode, "rule");
  assert.equal(input.ai_session, undefined);
  assert.equal(input.manual_revision.clips[0].end_ms, 1000);
});

test("v3 input validation refuses mixed planning modes", async t => {
  const args = await fixture(t);
  const prepared = await prepareVmPmoRunInput(args);
  const context = JSON.parse(await readFile(prepared.contextPath, "utf8"));
  const original = JSON.parse(await readFile(path.join(context.run_dir, "input.json"), "utf8"));
  for (const change of [
    null,
    input => { delete input.ai_session; },
    input => { input.planning_mode = "rule"; },
    input => { input.planning_mode = "guess"; },
    input => { input.manual_revision = { source_sha256: input.source.sha256, note: "x", clips: [{ start_ms: 0, end_ms: 10 }] }; },
    input => { input.prior_rounds = [{ round_id: "round-0" }]; },
  ]) {
    const directory = await mkdtemp(path.join(path.dirname(context.run_dir), "tampered-"));
    const input = structuredClone(original);
    if (change) change(input);
    const bytes = Buffer.from(JSON.stringify(input));
    await writeFile(path.join(directory, "input.json"), bytes);
    const moved = Object.fromEntries(Object.entries(context).map(([key, value]) =>
      [key, typeof value === "string" && value.startsWith(context.run_dir + path.sep)
        ? path.join(directory, path.relative(context.run_dir, value)) : value]));
    await writeFile(path.join(directory, "execution-context.json"),
      JSON.stringify({ ...moved, run_dir: directory, input_sha256: sha(bytes) }));
    const checked = validateVmPmoInput({ contextPath: path.join(directory, "execution-context.json") });
    // The unchanged copy proves the rejections come from the planning fields, not the relocation.
    if (!change) assert.equal((await checked).input.planning_mode, "ai_intent");
    else await assert.rejects(checked, { code: "RUN_BINDING_MISMATCH" });
  }
});

// A hanging fake has no pid so the deadline never signals a real process on this machine.
function fakeTurn({ events = [], exitCode = 0, hang = false } = {}) {
  const seen = {};
  const spawnTurn = ({ executable, args, prompt, env, onRawEvent }) => {
    Object.assign(seen, { executable, args, prompt, env });
    const child = new EventEmitter();
    child.pid = hang ? undefined : 4242;
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    child.kill = () => resolve({ exitCode: null, signal: "SIGKILL" });
    seen.child = child;
    setImmediate(() => {
      for (const event of events) onRawEvent(event);
      if (!hang) resolve({ exitCode, signal: null });
    });
    return { child, completion };
  };
  return { seen, spawnTurn };
}

async function sessionFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-ai-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "attempt-1");
  const sessionDir = path.join(root, "session");
  await mkdir(runDir);
  await mkdir(sessionDir);
  const context = { run_dir: runDir, intent_path: path.join(runDir, "edit-intent.json"),
    intent_context_path: path.join(runDir, "intent-context.json"), evidence_dir: path.join(runDir, "evidence") };
  return { root, runDir, sessionDir, context };
}

test("AI intent session runs in the run directory with the package prompt and no private credentials", async t => {
  const { sessionDir, context, runDir } = await sessionFixture(t);
  const { seen, spawnTurn } = fakeTurn({ events: [{ type: "thread.started", thread_id: "thread-1" },
    { type: "item.completed", item: { type: "agent_message", text: "报告" } }] });
  const runner = createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", spawnTurn,
    environment: { PATH: "p", USERPROFILE: "u", FEISHU_APP_SECRET: "s", CODEX_FEISHU_BRIDGE_SECRET: "b", VM_TOKEN: "v" } });
  const spawned = [];
  const result = await runner.run({ context, packageRoot: "E:\\pkg", pythonPath: "C:\\py.exe", sessionDir,
    onSpawn: evidence => { spawned.push(evidence); } });
  assert.deepEqual(result, { outcome: "completed", threadId: "thread-1", report: "报告", providerFailure: false });
  assert.equal(spawned.length, 1);
  assert.deepEqual(seen.args.slice(seen.args.indexOf("-C"), seen.args.indexOf("-C") + 4), ["-C", runDir, "-s", "workspace-write"]);
  assert.ok(seen.args.includes("gpt-test"));
  assert.ok(!seen.args.includes("danger-full-access"));
  assert.ok(seen.args.includes('approval_policy="never"'));
  assert.equal(seen.args[seen.args.indexOf("sandbox_workspace_write.network_access=false") - 1], "-c");
  assert.deepEqual(Object.keys(seen.env).sort(), ["PATH", "USERPROFILE"]);
  assert.match(seen.prompt, /edit-intent\.json/u);
  assert.match(seen.prompt, /不运行 render/u);
  assert.ok(seen.prompt.includes("Set-Location E:\\pkg"));
  assert.ok(seen.prompt.includes("包仓库：E:\\pkg"));
  assert.equal(await readFile(path.join(sessionDir, "report.txt"), "utf8"), "报告");
  assert.equal(JSON.parse(await readFile(path.join(sessionDir, "outcome.json"), "utf8")).outcome, "completed");
  assert.deepEqual(Object.keys(vmPmoAiEnvironment({ JIRA_TOKEN: "x", HOME: "h" })), ["HOME"]);
});

test("AI intent session is stopped at its deadline and reported as a timeout", async t => {
  const { sessionDir, context } = await sessionFixture(t);
  const { seen, spawnTurn } = fakeTurn({ hang: true });
  const runner = createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", spawnTurn, timeoutMs: 20 });
  const result = await runner.run({ context, packageRoot: "E:\\pkg", pythonPath: "C:\\py.exe", sessionDir });
  assert.equal(result.outcome, "timeout");
  assert.ok(seen.child);
  assert.equal(JSON.parse(await readFile(path.join(sessionDir, "outcome.json"), "utf8")).timeout_ms, 20);
});

test("AI intent session failure and unconfigured model are explicit", async t => {
  const { sessionDir, context } = await sessionFixture(t);
  const { spawnTurn } = fakeTurn({ events: [{ type: "turn.failed" }] });
  const runner = createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", spawnTurn });
  assert.equal((await runner.run({ context, packageRoot: "E:\\pkg", pythonPath: "C:\\py.exe", sessionDir })).outcome, "failed");
  assert.throws(() => createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "bad model" }),
    { code: "VM_PMO_AI_NOT_CONFIGURED" });
});

test("a provider refusal before any work is told apart from a failed session", async t => {
  const refusal = [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" },
    { type: "error", message: "unexpected status 402 Payment Required: {\"code\":\"INSUFFICIENT_BALANCE\"}" },
    { type: "turn.failed", error: { message: "unexpected status 402 Payment Required" } }];
  assert.equal(isVmPmoAiProviderFailure(refusal), true);
  assert.equal(isVmPmoAiProviderFailure([{ type: "error", message: "Reconnecting... 2/5 (unexpected status 429)" },
    { type: "item.completed", item: { type: "error", message: "warn" } }, { type: "turn.failed", error: {} }]), true);
  // Work done before the refusal makes it a failed session; so does an unrelated failure.
  assert.equal(isVmPmoAiProviderFailure([{ type: "item.completed", item: { type: "command_execution" } },
    ...refusal]), false);
  assert.equal(isVmPmoAiProviderFailure([{ type: "turn.failed", error: { message: "model said no" } }]), false);
  assert.equal(isVmPmoAiProviderFailure([{ type: "error", message: "unexpected status 400 Bad Request" }]), false);

  const { sessionDir, context } = await sessionFixture(t);
  const { spawnTurn } = fakeTurn({ events: refusal, exitCode: 1 });
  const runner = createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", spawnTurn });
  const result = await runner.run({ context, packageRoot: "E:/pkg", pythonPath: "C:/py.exe", sessionDir });
  assert.deepEqual([result.outcome, result.providerFailure], ["failed", true]);
  assert.equal(JSON.parse(await readFile(path.join(sessionDir, "outcome.json"), "utf8")).provider_failure, true);
});

test("a provider refusal blocks as AI_PROVIDER_FAILED and keeps the old conversation", async t => {
  const { plan, sessions } = await analyzedRun(t);
  const calls = [];
  const aiIntent = { session: { agent: "codex", model: "gpt-test" }, async run({ resumeThreadId }) {
    calls.push(resumeThreadId);
    return { outcome: "failed", threadId: null, providerFailure: true };
  } };
  assert.deepEqual(await plan(aiIntent, { resumeThreadId: "thread-old" }),
    { status: "blocked", errorCode: AI_PROVIDER_FAILED });
  assert.deepEqual(calls, ["thread-old"]);
  assert.equal((await readdir(sessions)).length, 1);
});

test("AI intent session can put a sandbox-readable FFmpeg directory first on PATH", () => {
  const env = vmPmoAiEnvironment({ Path: "C:\Windows", FEISHU_APP_ID: "x" }, { toolDir: "E:\tools\ffmpeg" });
  assert.deepEqual(Object.keys(env), ["Path"]);
  assert.equal(env.Path.split(path.delimiter)[0], "E:\tools\ffmpeg");
  assert.throws(() => createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", toolDir: "tools" }),
    { code: "VM_PMO_AI_NOT_CONFIGURED" });
});

// Drives the driver's AI step with a ready analyze receipt and a scripted session; no package needed.
async function analyzedRun(t) {
  const args = await fixture(t);
  const prepared = await prepareVmPmoRunInput(args);
  const { context, input } = await validateVmPmoInput({ contextPath: prepared.contextPath });
  const put = async (file, text) => { await writeFile(file, text); return sha(text); };
  const alignmentSha256 = await put(path.join(context.run_dir, "alignment.words.json"), "{\"words\":[]}\n");
  const intentContextSha256 = await put(context.intent_context_path, "{\"schema\":\"intent-context\"}\n");
  await mkdir(context.evidence_dir);
  const manifestSha256 = await put(path.join(context.evidence_dir, "manifest.json"), "{\"entries\":[]}\n");
  await writeFile(context.analyze_result_path, JSON.stringify({ protocol: input.protocol, schema_version: 3,
    status: "ready", package: input.package, binding: input.binding, record: input.record,
    review_round: input.review_round, delivery_target: input.delivery_target, input_sha256: context.input_sha256,
    source_sha256: input.source.sha256, planning_mode: "ai_intent", alignment_sha256: alignmentSha256,
    intent_context_sha256: intentContextSha256, evidence_manifest_sha256: manifestSha256,
    evidence_ids: ["transcript-full"], error: null }));
  const session = (write) => ({ session: { agent: "codex", model: "gpt-test" }, async run() { await write(); return { outcome: "completed", threadId: "t" }; } });
  const plan = (aiIntent, aiHistory = null) => runVmPmoDriver({ mode: "plan", contextPath: prepared.contextPath,
    packageRoot: args.packageSnapshot.workspacePath, pythonPath: args.pythonPath, aiIntent, aiHistory });
  const sessions = path.join(path.dirname(context.run_dir), "ai-sessions");
  return { context, session, plan, sessions };
}

test("an AI session that only adds evidence passes the boundary", async t => {
  const { context, session, plan } = await analyzedRun(t);
  const result = await plan(session(() => writeFile(path.join(context.evidence_dir, "extra.json"), "{}\n")));
  assert.deepEqual(result, { status: "blocked", errorCode: "AI_INTENT_MISSING" });
});

test("an AI session that edits a protected file or writes a plan output is blocked and recorded", async t => {
  for (const [name, write, expected] of [
    ["tamper", (context) => writeFile(context.intent_context_path, "{\"tampered\":true}\n"),
      { changed_protected_files: ["intent-context.json"], unexpected_outputs: [] }],
    ["early-plan", (context) => writeFile(context.plan_result_path, "{}\n"),
      { changed_protected_files: [], unexpected_outputs: ["plan-result.json"] }],
  ]) {
    const { context, session, plan, sessions } = await analyzedRun(t);
    const result = await plan(session(async () => {
      await writeFile(context.intent_path, "{}\n");
      await write(context);
    }));
    assert.deepEqual(result, { status: "blocked", errorCode: AI_INTENT_SCOPE_VIOLATION }, name);
    const [directory] = await readdir(sessions);
    const record = JSON.parse(await readFile(path.join(sessions, directory, "scope-violation.json"), "utf8"));
    assert.deepEqual({ changed_protected_files: record.changed_protected_files,
      unexpected_outputs: record.unexpected_outputs }, expected, name);
  }
});

test("a broken attempt is refused before it uses an AI session slot", async t => {
  const { context, session, plan, sessions } = await analyzedRun(t);
  await writeFile(context.plan_path, "{}\n");
  await assert.rejects(plan(session(() => assert.fail("AI must not start"))), { code: "VM_PMO_RUN_INPUT_INVALID" });
  const used = await readdir(sessions).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  assert.deepEqual(used, []);
});

test("a review round resumes the previous AI conversation with the new run directory and images", async t => {
  const { sessionDir, context } = await sessionFixture(t);
  const { seen, spawnTurn } = fakeTurn({ events: [{ type: "thread.started", thread_id: "thread-old" }] });
  const runner = createVmPmoAiIntentRunner({ codexExecutable: "codex.exe", model: "gpt-test", spawnTurn });
  const result = await runner.run({ context, packageRoot: "E:/pkg", pythonPath: "C:/py.exe", sessionDir,
    resumeThreadId: "thread-old", history: { parentRunDir: "E:/runs/parent/attempt-1", imagePaths: ["E:/shots/1.png"] } });
  assert.equal(result.outcome, "completed");
  const tail = seen.args.slice(seen.args.indexOf("resume"));
  assert.deepEqual(tail, ["resume", "-i", "E:/shots/1.png", "thread-old", "-"]);
  assert.equal(seen.args[seen.args.indexOf("-C") + 1], context.run_dir);
  assert.match(seen.prompt, /新一轮审核修改/u);
  assert.ok(seen.prompt.includes("E:/runs/parent/attempt-1"));
  assert.match(seen.prompt, /审核截图/u);
  assert.match(seen.prompt, /要把工作做到底/u);
  const outcome = JSON.parse(await readFile(path.join(sessionDir, "outcome.json"), "utf8"));
  assert.deepEqual([outcome.resumed_from, outcome.images], ["thread-old", 1]);
  await assert.rejects(runner.run({ context, packageRoot: "E:/pkg", pythonPath: "C:/py.exe", sessionDir,
    resumeThreadId: "bad id;" }), { code: "VM_PMO_RUN_INPUT_INVALID" });
});

test("a review round falls back to a fresh session when the old conversation cannot be reopened", async t => {
  const { context, plan, sessions } = await analyzedRun(t);
  const calls = [];
  const aiIntent = { session: { agent: "codex", model: "gpt-test" }, async run({ resumeThreadId, history }) {
    calls.push({ resumeThreadId, parentRunDir: history?.parentRunDir });
    return resumeThreadId ? { outcome: "failed", threadId: null } : { outcome: "completed", threadId: "fresh" };
  } };
  const result = await plan(aiIntent, { resumeThreadId: "thread-old", parentRunDir: "E:/runs/p/attempt-1" });
  assert.deepEqual(result, { status: "blocked", errorCode: "AI_INTENT_MISSING" });
  assert.deepEqual(calls, [{ resumeThreadId: "thread-old", parentRunDir: "E:/runs/p/attempt-1" },
    { resumeThreadId: null, parentRunDir: "E:/runs/p/attempt-1" }]);
  const names = (await readdir(sessions)).sort();
  assert.equal(names.length, 2);
  assert.ok(JSON.parse(await readFile(path.join(sessions, names[0], "resume-failed.json"), "utf8")).resume_thread_id);
  void context;
});

test("review input carries earlier rounds as read-only prior_rounds", async t => {
  const args = await fixture(t);
  await assert.rejects(prepareVmPmoRunInput({ ...args, priorRounds: [{ round_id: "x", instructions: "no" }] }),
    { code: "VM_PMO_INPUT_UNTRUSTED" });
  const initial = await prepareVmPmoRunInput({ ...args, priorRounds: [{ round_id: "initial",
    instructions: [{ instruction_id: "instruction-1", raw_text: "旧意见" }] }] });
  const input = JSON.parse(await readFile(path.join(path.dirname(initial.contextPath), "input.json"), "utf8"));
  // Only review rounds have earlier rounds to show.
  assert.equal(input.prior_rounds, undefined);
});

const CUT = [{ source_start_us: 0, duration_us: 3_300_000, target_start_us: 0 },
  { source_start_us: 4_000_000, duration_us: 1_600_000, target_start_us: 3_300_000 }];

async function rebasedArgs(t) {
  const args = await fixture(t);
  args.origin.stageId = "review";
  args.origin.stageSnapshot = { ...args.origin.stageSnapshot, reviewRound: 1,
    vmContext: { ...args.origin.stageSnapshot.vmContext, instruction: "结尾那句话没说完，补完整" },
    reviewParent: { runId: "parent-run", artifactId: "parent-artifact", deliveryId: "delivery-1",
      localPath: "E:/parent.mp4", sha256: "e".repeat(64), bytes: 10, durationMs: 4_900, reviewRound: 0 },
    reviewSource: { basis: "vm_original", rootRunId: "parent-run", acquisition: structuredClone(args.acquisition) } };
  args.profile.stages.review = { instructionFieldId: "fld-review" };
  args.rebase = { rounds: [{ instructionId: "round-0", sourceFieldId: "fld-instruction", rawText: "0:00-0:05.60" }],
    timeMaps: [{ time_map_id: "cut-0", plan_sha256: "f".repeat(64), segments: CUT }] };
  return args;
}

test("a review on the original source re-applies every round and maps the reviewed cut", async t => {
  const args = await rebasedArgs(t);
  const prepared = await prepareVmPmoRunInput(args);
  const { input } = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(input.source.timeline_basis, "vm_original");
  assert.equal(input.source.sha256, args.acquisition.sha256);
  assert.equal(input.review_round.source_basis, "vm_original");
  assert.equal(input.review_round.parent.sha256, "e".repeat(64));
  assert.deepEqual(input.instructions.map((item) => [item.instruction_id, item.timeline_basis, item.applicability, item.time_map_id]),
    [["round-0", "vm_original", "carried_over", undefined],
      ["round-1", "previous_review_video", "current_round", "cut-0"]]);
  assert.deepEqual(input.time_maps[0].segments, CUT);
  assert.equal(input.prior_rounds, undefined);
});

test("a review on the original source refuses another source, rule planning or a broken chain", async t => {
  for (const [name, change] of [
    ["other file", (args) => { args.origin.stageSnapshot.reviewSource.acquisition.sha256 = "0".repeat(64); }],
    ["missing round", (args) => { args.rebase.rounds = []; }],
    ["wrong map", (args) => { args.rebase.timeMaps[0].time_map_id = "cut-x"; args.rebase.rounds.push({
      instructionId: "round-1", sourceFieldId: "fld-review", rawText: "x", timeMapId: "cut-0" }); }],
    ["rule planning", (args) => { args.manualRevision = { sourceSha256: args.acquisition.sha256, note: "x",
      clips: [{ startMs: 0, endMs: 1000 }] }; }],
  ]) {
    const args = await rebasedArgs(t);
    args.runId = `run-${name.replace(/ /gu, "-")}`;
    change(args);
    await assert.rejects(prepareVmPmoRunInput(args), { code: "VM_PMO_REVIEW_SOURCE_INVALID" }, name);
  }
});

test("QA reports from the package's mechanical picture checks are accepted", async () => {
  const { validVmPmoQaChecks } = await import("../server/vm-pmo-result-validator.mjs");
  const row = (check_id, kind, extra = {}) => ({ check_id, intent_id: null, kind, status: "passed",
    method: "automatic", evidence_ids: [], target_start_us: 0, target_end_us: null, detail: "ok", ...extra });
  // The package groups frame checks under one id; the kind tells them apart.
  const checks = ["frame_count", "frame_timing", "black_frames", "blurred_frames", "luma_flashes", "still_frames"]
    .map(kind => row("frames", kind));
  checks.push(row("speech", "speech_present"),
    row("frames-0", "opening_frame", { status: "needs_human", frames: ["t0us_after.png"] }));
  assert.equal(validVmPmoQaChecks(checks), true);
  assert.equal(validVmPmoQaChecks([...checks, row("frames", "still_frames")]), false);
  assert.equal(validVmPmoQaChecks([row("frames", "unknown_kind")]), false);
  assert.equal(validVmPmoQaChecks([row("frames-0", "opening_frame", { frames: [] })]), false);
  assert.equal(validVmPmoQaChecks([row("frames-0", "opening_frame", { other: 1 })]), false);
});
