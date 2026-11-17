import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildVmPmoAiArgs, readVmPmoAiPrompt, runVmPmoAiPlanning, vmPmoAiEnvironment } from "../server/vm-pmo-ai-planner.mjs";
import { createVmPmoOrchestrator } from "../server/vm-pmo-orchestrator.mjs";
import { prepareVmPmoRunInput } from "../server/vm-pmo-run-input.mjs";
import { validateVmPmoAnalyze, validateVmPmoInput, validateVmPmoPlan, validateVmPmoQa }
  from "../server/vm-pmo-result-validator.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const PROMPT = [
  "# AI 剪辑会话启动提示", "", "## Taskboard 自动调度（包侧 v3 已实现）", "", "```text",
  "包仓库：<package_root>", "运行目录：<run_dir>", "意图：<run_dir>\\edit-intent.json", "```", "",
  "## Codex 聊天手动交办", "", "```text", "手动 <路径>", "```", "",
].join("\n");

async function v3Fixture(t, { manualRevision } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vm-v3-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "package");
  await mkdir(path.join(packageRoot, "docs", "prompts"), { recursive: true });
  await writeFile(path.join(packageRoot, "docs", "prompts", "taskboard-ai-editing.md"), PROMPT);
  const manifestPath = path.join(packageRoot, "PACKAGE-MANIFEST.json");
  await writeFile(manifestPath, JSON.stringify({ name: "auto-cut-slicing", version: "0.3.0",
    interface: { workflowTemplate: { id: "vm_pmo_review_video", version: 1 },
      contract: { id: "vm_pmo_review_video", version: 3 }, driverId: "vm_pmo_review_video_v3",
      artifactKind: "review_mp4" } }));
  const sourcePath = path.join(root, "source.mp4");
  await writeFile(sourcePath, "source");
  const args = { runRoot: path.join(root, "runs"), runId: "run-1", taskId: "task-1",
    pythonPath: path.join(root, "python.exe"),
    origin: { source: "feishu-base", packageSource: "subject-config", eventId: "event-1", baseToken: "base-1",
      tableId: "table-1", recordId: "record-1", subjectKey: "base-1:table-1", configVersion: 1, stageId: "initial",
      packageAlias: "slicing", stageSnapshot: { vmContext: { vmid: "vmid-1", title: "课程",
        instruction: "把第二次说的“我们再看一下”删掉，前面那次保留" } } },
    profile: { fields: { namingFieldId: "fld-name", outputAttachmentFieldId: "fld-output" },
      stages: { initial: { instructionFieldId: "fld-instruction" } } },
    packageSnapshot: { packageAlias: "slicing", workspacePath: packageRoot, model: "gpt-6.1-sol",
      reasoningEffort: "high", workflowTemplate: { id: "vm_pmo_review_video", version: 1 } },
    packageIdentity: { name: "auto-cut-slicing", version: "0.3.0", manifestSha256: sha(await readFile(manifestPath)),
      contractVersion: 3, driverId: "vm_pmo_review_video_v3" },
    acquisition: { path: sourcePath, sha256: sha("source"), bytes: 6, duration_ms: 25000,
      vmid_binding: "vm_api_verified", vmid: "vmid-1" },
    ...(manualRevision ? { manualRevision } : {}) };
  return { root, packageRoot, args };
}

async function preparedRun(t, options) {
  const x = await v3Fixture(t, options);
  const prepared = await prepareVmPmoRunInput(x.args);
  const context = JSON.parse(await readFile(prepared.contextPath, "utf8"));
  const input = JSON.parse(await readFile(path.join(context.run_dir, "input.json"), "utf8"));
  return { ...x, prepared, context, input };
}

function base(input, context) {
  return { protocol: input.protocol, schema_version: 3, package: input.package, binding: input.binding,
    record: input.record, review_round: input.review_round, delivery_target: input.delivery_target,
    input_sha256: context.input_sha256, source_sha256: input.source.sha256 };
}

async function writeAnalyze({ context, input }) {
  await writeFile(path.join(context.run_dir, "alignment.words.json"), "{\"words\":[]}\n");
  await writeFile(context.intent_context_path, "{\"schema\":\"auto-cut-slicing/intent-context\"}\n");
  await mkdir(context.evidence_dir);
  await writeFile(path.join(context.evidence_dir, "manifest.json"), "{\"entries\":[]}\n");
  await writeFile(context.analyze_result_path, JSON.stringify({ ...base(input, context), status: "ready",
    planning_mode: "ai_intent", alignment_sha256: sha("{\"words\":[]}\n"),
    intent_context_sha256: sha("{\"schema\":\"auto-cut-slicing/intent-context\"}\n"),
    evidence_manifest_sha256: sha("{\"entries\":[]}\n"), evidence_ids: ["transcript-full"], error: null }));
}

function aiPlan(input, context) {
  return { ...base(input, context), source: input.source,
    instruction_results: [{ instruction_id: "instruction-1", source_field_id: "fld-instruction",
      raw_text: input.instructions[0].raw_text, status: "resolved", segments: ["seg-1", "seg-2"] }],
    segments: [
      { segment_id: "seg-1", source_id: "source-1", source_start_us: 0, duration_us: 10_000_000, target_start_us: 0 },
      { segment_id: "seg-2", source_id: "source-1", source_start_us: 12_000_000, duration_us: 8_000_000,
        target_start_us: 10_000_000 }],
    operations: [{ operation_id: "c1/del-2", intent_id: "del-2", kind: "range", source_start_us: 10_000_000,
      source_end_us: 12_000_000, target_join_us: 10_000_000, matched_text: null, match_strategy: null,
      alignment_sha256: null, provider: null, model: null, adapter: null, must_keep_evidence: [] }],
    expected_duration_ms: 18_000, engine_plan_sha256: "e".repeat(64), alignment_sha256: sha("{\"words\":[]}\n"),
    planning_mode: "ai_intent", output_id: "review", ai_session: input.ai_session, intent_sha256: "f".repeat(64),
    evidence_manifest_sha256: sha("{\"entries\":[]}\n"),
    coverage: [{ span: { instruction_id: "instruction-1" }, disposition: "operation", intent_ids: ["del-2"] }],
    rule_cross_check: "not_applicable" };
}

test("contract v3 freezes AI planning input, session label and the fixed v3 context paths", async (t) => {
  const { input, context, prepared } = await preparedRun(t);
  assert.equal(input.schema_version, 3);
  assert.equal(input.planning_mode, "ai_intent");
  assert.deepEqual(input.ai_session, { agent: "codex", model: "gpt-6.1-sol", session_id: "vm-ai-run-1-attempt-1" });
  assert.equal(prepared.planningMode, "ai_intent");
  for (const [key, name] of [["intent_path", "edit-intent.json"], ["analyze_result_path", "analyze-result.json"],
    ["intent_context_path", "intent-context.json"], ["qa_path", "qa.json"], ["qa_review_path", "qa-review.json"]])
    assert.equal(context[key], path.join(context.run_dir, name));
  assert.equal(context.evidence_dir, path.join(context.run_dir, "evidence"));
  const bound = await validateVmPmoInput({ contextPath: prepared.contextPath });
  assert.equal(bound.input.planning_mode, "ai_intent");
});

test("a v3 structured manual revision plans by rule and carries no AI session", async (t) => {
  const { input, prepared } = await preparedRun(t, { manualRevision: { sourceSha256: sha("source"),
    note: "Keep the opening only.", clips: [{ startMs: 0, endMs: 20000 }] } });
  assert.equal(input.planning_mode, "rule");
  assert.equal(input.ai_session, undefined);
  assert.equal(prepared.planningMode, "rule");
  await validateVmPmoInput({ contextPath: prepared.contextPath });
});

test("a later v3 attempt reuses the earlier source-bound ASR instead of paying for it again", async (t) => {
  const x = await v3Fixture(t);
  const first = await prepareVmPmoRunInput(x.args);
  const firstDir = path.dirname(first.contextPath);
  await writeFile(path.join(firstDir, "alignment.words.json"), "{\"words\":[1]}\n");
  const second = await prepareVmPmoRunInput({ ...x.args, planAttempt: 2 });
  assert.notEqual(path.dirname(second.contextPath), firstDir);
  assert.equal(await readFile(path.join(path.dirname(second.contextPath), "alignment.words.json"), "utf8"),
    "{\"words\":[1]}\n");
});

test("v3 input validation rejects an AI session on a rule run and a tampered context path", async (t) => {
  const { context, input, prepared } = await preparedRun(t);
  const inputPath = path.join(context.run_dir, "input.json");
  await writeFile(inputPath, JSON.stringify({ ...input, planning_mode: "rule" }, null, 2) + "\n");
  await assert.rejects(validateVmPmoInput({ contextPath: prepared.contextPath }), { code: "RUN_BINDING_MISMATCH" });
  await writeFile(inputPath, JSON.stringify(input, null, 2) + "\n");
  await writeFile(prepared.contextPath, JSON.stringify({ ...context,
    input_sha256: sha(await readFile(inputPath)), intent_path: path.join(context.evidence_dir, "edit-intent.json") }));
  await assert.rejects(validateVmPmoInput({ contextPath: prepared.contextPath }), { code: "RUN_BINDING_MISMATCH" });
});

test("analyze receipts must bind the ASR and intent-context bytes they report", async (t) => {
  const run = await preparedRun(t);
  await writeAnalyze(run);
  const ready = await validateVmPmoAnalyze({ contextPath: run.prepared.contextPath });
  assert.equal(ready.status, "ready");
  await writeFile(path.join(run.context.run_dir, "alignment.words.json"), "{\"words\":[\"changed\"]}\n");
  await assert.rejects(validateVmPmoAnalyze({ contextPath: run.prepared.contextPath }), { code: "ANALYZE_RESULT_INVALID" });
});

test("a ready AI plan accepts intent-tagged range deletions and rejects drift from its receipt", async (t) => {
  const run = await preparedRun(t);
  const { context, input, prepared } = run;
  const plan = aiPlan(input, context);
  const planBytes = JSON.stringify(plan);
  await writeFile(context.plan_path, planBytes);
  const receipt = { ...base(input, context), status: "ready", plan_sha256: sha(planBytes),
    instruction_results: plan.instruction_results, error: null, planning_mode: "ai_intent",
    intent_sha256: plan.intent_sha256, coverage: plan.coverage, blockers: [] };
  await writeFile(context.plan_result_path, JSON.stringify(receipt));
  const probe = async () => { await validateVmPmoPlan({ contextPath: prepared.contextPath, ffprobePath: "ffprobe-missing" }); };
  // The plan itself is accepted; the fake source then fails the media probe.
  await assert.rejects(probe(), { code: "SOURCE_MEDIA_INVALID" });
  await writeFile(context.plan_result_path, JSON.stringify({ ...receipt, intent_sha256: "0".repeat(64) }));
  await assert.rejects(probe(), { code: "PLAN_RESULT_INVALID" });
  const tagless = { ...plan, operations: plan.operations.map(({ intent_id, ...rest }) => rest) };
  await writeFile(context.plan_path, JSON.stringify(tagless));
  await writeFile(context.plan_result_path, JSON.stringify({ ...receipt, plan_sha256: sha(JSON.stringify(tagless)) }));
  await assert.rejects(probe(), { code: "PLAN_INVALID" });
});

test("a blocked AI plan returns the package blockers without any plan file", async (t) => {
  const { context, input, prepared } = await preparedRun(t);
  await writeFile(context.plan_result_path, JSON.stringify({ ...base(input, context), status: "blocked",
    plan_sha256: null, instruction_results: [{ instruction_id: "instruction-1", source_field_id: "fld-instruction",
      raw_text: input.instructions[0].raw_text, status: "blocked", segments: [] }],
    error: { code: "INTENT_BLOCKED", message: "Edit intent is blocked" }, planning_mode: "ai_intent",
    intent_sha256: "f".repeat(64), coverage: null,
    blockers: [{ code: "INTENT_AMBIGUOUS_MATCH", rule: "V07", message: "“我们再看一下”出现 3 次，意见没有区分依据" }] }));
  const result = await validateVmPmoPlan({ contextPath: prepared.contextPath });
  assert.equal(result.status, "blocked");
  assert.equal(result.errorCode, "INTENT_BLOCKED");
  assert.deepEqual(result.blockers, [{ code: "INTENT_AMBIGUOUS_MATCH", rule: "V07",
    message: "“我们再看一下”出现 3 次，意见没有区分依据" }]);
});

test("QA receipts must match the rendered plan and the qa.json bytes", async (t) => {
  const { context, input, prepared } = await preparedRun(t);
  const report = "{\"overall\":\"ready_for_review\"}\n";
  await writeFile(context.qa_path, report);
  const receipt = { ...base(input, context), status: "checked", plan_sha256: "d".repeat(64), qa_sha256: sha(report),
    overall: "ready_for_review", counts: { passed: 9, needs_human: 3 }, reverse_asr: true, error: null };
  await writeFile(path.join(context.run_dir, "qa-result.json"), JSON.stringify(receipt));
  const ok = await validateVmPmoQa({ contextPath: prepared.contextPath, planSha256: "d".repeat(64) });
  assert.deepEqual([ok.status, ok.overall, ok.counts.needs_human], ["checked", "ready_for_review", 3]);
  await assert.rejects(validateVmPmoQa({ contextPath: prepared.contextPath, planSha256: "1".repeat(64) }),
    { code: "QA_RESULT_INVALID" });
  await writeFile(context.qa_path, "{\"overall\":\"failed\"}\n");
  await assert.rejects(validateVmPmoQa({ contextPath: prepared.contextPath, planSha256: "d".repeat(64) }),
    { code: "QA_RESULT_INVALID" });
});

test("the AI launch prompt comes from the package template with Taskboard's absolute paths", async (t) => {
  const { packageRoot } = await v3Fixture(t);
  const prompt = await readVmPmoAiPrompt({ packageRoot, runDir: "D:\\runs\\r\\attempt-1", pythonPath: "C:\\py.exe" });
  assert.match(prompt, /包仓库：.*package/u);
  assert.match(prompt, /运行目录：D:\\runs\\r\\attempt-1/u);
  assert.doesNotMatch(prompt, /<run_dir>|<package_root>|手动/u);
  assert.match(prompt, /Python 解释器：C:\\py\.exe/u);
  const args = buildVmPmoAiArgs({ runDir: "D:\\runs\\r\\attempt-1", model: "gpt-6.1-sol", reasoningEffort: "high" });
  assert.deepEqual(args.slice(-6), ["-c", "sandbox_workspace_write.network_access=false", "-m", "gpt-6.1-sol",
    "-c", "model_reasoning_effort=\"high\"", "-"].slice(-6));
  assert.equal(args[args.indexOf("-C") + 1], "D:\\runs\\r\\attempt-1");
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  assert.ok(args.includes('approval_policy="never"'));
  assert.throws(() => buildVmPmoAiArgs({ runDir: "D:\\r", model: "x\" -c y", reasoningEffort: null }),
    { code: "VM_PMO_AI_MODEL_INVALID" });
});

function fakeTurn(behaviour) {
  return ({ args, prompt, onRawEvent }) => {
    const child = new EventEmitter();
    child.pid = 4242;
    const completion = (async () => {
      onRawEvent({ type: "thread.started", thread_id: "thread-1" });
      const exitCode = await behaviour({ args, prompt, child });
      onRawEvent({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "意见 1：删除第二次出现。" } });
      return { exitCode, signal: null };
    })();
    return { child, completion };
  };
}

async function plannerRun(t) {
  const run = await preparedRun(t);
  await writeAnalyze(run);
  const transcriptPath = path.join(path.dirname(run.context.run_dir), "attempt-1.ai-session.jsonl");
  const options = { codexExecutable: "codex", packageRoot: run.packageRoot, pythonPath: run.args.pythonPath,
    context: run.context, model: "gpt-6.1-sol", reasoningEffort: "high", transcriptPath };
  return { ...run, options, transcriptPath };
}

test("an unattended AI turn that writes edit-intent.json leaves the run ready to plan", async (t) => {
  const run = await plannerRun(t);
  let started;
  const result = await runVmPmoAiPlanning({ ...run.options, onStarted: async (evidence) => { started = evidence; },
    spawnTurn: fakeTurn(async () => {
      await writeFile(run.context.intent_path, "{\"status\":\"proposed\"}\n");
      return 0;
    }) });
  assert.equal(result.status, "ready");
  assert.equal(result.intentSha256, sha("{\"status\":\"proposed\"}\n"));
  assert.equal(result.session.codexThreadId, "thread-1");
  assert.equal(result.session.report, "意见 1：删除第二次出现。");
  assert.equal(started.pid, 4242);
  const transcript = await readFile(run.transcriptPath, "utf8");
  assert.match(transcript, /agent_message/u);
  assert.equal(path.dirname(run.transcriptPath), path.dirname(run.context.run_dir));
});

test("an AI turn without an intent, or one that touches protected files or plans, is blocked", async (t) => {
  const run = await plannerRun(t);
  const missing = await runVmPmoAiPlanning({ ...run.options, spawnTurn: fakeTurn(async () => 0) });
  assert.deepEqual([missing.status, missing.errorCode], ["blocked", "INTENT_MISSING"]);

  const tampering = await plannerRun(t);
  const tampered = await runVmPmoAiPlanning({ ...tampering.options, spawnTurn: fakeTurn(async () => {
    await writeFile(tampering.context.intent_path, "{}\n");
    await writeFile(tampering.context.intent_context_path, "{\"changed\":true}\n");
    return 0;
  }) });
  assert.deepEqual([tampered.status, tampered.errorCode], ["blocked", "VM_PMO_AI_SCOPE_VIOLATION"]);

  const planning = await plannerRun(t);
  const planned = await runVmPmoAiPlanning({ ...planning.options, spawnTurn: fakeTurn(async () => {
    await writeFile(planning.context.intent_path, "{}\n");
    await writeFile(planning.context.plan_result_path, "{}\n");
    return 0;
  }) });
  assert.deepEqual([planned.status, planned.errorCode], ["blocked", "VM_PMO_AI_SCOPE_VIOLATION"]);
});

test("an AI turn that exceeds its deadline is stopped and blocked without retrying", async (t) => {
  const run = await plannerRun(t);
  let killed = false;
  const result = await runVmPmoAiPlanning({ ...run.options, timeoutMs: 20, spawnTurn: ({ onRawEvent }) => {
    const child = new EventEmitter();
    child.pid = 999999;
    child.kill = () => { killed = true; };
    let finish;
    const completion = new Promise((resolve) => { finish = resolve; });
    child.on("terminated", () => finish({ exitCode: null, signal: "SIGKILL" }));
    setTimeout(() => child.emit("terminated"), 60);
    void onRawEvent;
    return { child, completion };
  } });
  assert.deepEqual([result.status, result.errorCode], ["blocked", "VM_PMO_AI_TIMEOUT"]);
  void killed;
});

async function orchestratorFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm-v3-orchestrator-"));
  const sqlitePath = path.join(directory, "runs.sqlite");
  let db = new DatabaseSync(sqlitePath);
  const calls = [];
  let now = 1_700_000_000_000;
  let canExecute = async () => true;
  let aiResult = null;
  let planResult = { status: "ready", planSha256: "d".repeat(64) };
  let qaResult = { status: "checked", overall: "ready_for_review", counts: { passed: 8, needs_human: 2 },
    qaSha256: "9".repeat(64), reverseAsr: true };
  const task = { id: "task_vm", status: "todo", archivedAt: null, labels: ["feishu"] };
  const origin = { source: "feishu-base", packageSource: "subject-config", eventId: "evt_vm",
    baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", subjectKey: "bas_vm:tbl_vm",
    configVersion: 4, stageId: "initial", packageAlias: "auto-cut-slicing", executionMode: "manual",
    stageSnapshot: { vmWorkflow: { fields: { outputAttachmentFieldId: "fld_output" } } } };
  const packageSnapshot = { packageAlias: "auto-cut-slicing", packageRevision: 2,
    workflowTemplate: { id: "vm_pmo_review_video", version: 1 } };
  const database = { get database() { return db; }, getTask: () => task,
    getFeishuTaskOrigin: () => origin, getFeishuTaskPackageSnapshot: () => packageSnapshot };
  const binding = { taskId: "task_vm", runId: "run_vm", vmid: "5dd7753a4723ba416403cbad", approvalJobId: "job_vm" };
  const acquisition = { receipt_path: path.join(directory, "receipt.json"), path: path.join(directory, "source.mp4"),
    sha256: "a".repeat(64), bytes: 100, duration_ms: 1000, vmid_binding: "vm_api_verified" };
  const prepared = { contextPath: path.join(directory, "execution-context.json"), inputSha256: "b".repeat(64),
    outputFilename: "课程_初稿.mp4", planningMode: "ai_intent",
    runnerOptions: { contextPath: path.join(directory, "execution-context.json"),
      packageRoot: directory, pythonPath: path.join(directory, "python.exe") } };
  const artifact = { kind: "review_mp4", path: path.join(directory, "review.mp4"), sha256: "c".repeat(64),
    bytes: 200, duration_ms: 1000, width: 1920, height: 1080, fps: 25, has_audio: true, full_decode_passed: true };
  const session = () => ({ codexThreadId: "thread-1", startedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(), exitCode: 0, report: "按意见删除第二次出现。",
    transcriptFile: "attempt-1.ai-session.jsonl" });
  const dependencies = {
    database, now: () => now,
    bindings: {
      reserve: async () => binding, reconcile: async () => binding,
      status: async () => ({ ...binding, status: "ready", acquisition }),
    },
    canExecute: (...args) => canExecute(...args),
    verifyRetryInput: async ({ run }) => { calls.push(["verifyRetryInput", run.planAttempt]); },
    validateSavedPlan: async () => ({ status: "ready", planSha256: "d".repeat(64) }),
    acquireSlot: async () => { calls.push(["slot"]); return { release: async () => { calls.push(["release"]); } }; },
    prepareInput: async ({ planAttempt }) => { calls.push(["prepare", planAttempt]); return prepared; },
    runOffline: async ({ mode, onStarted, planSha256 }) => {
      calls.push([mode, ...(planSha256 ? [planSha256] : [])]);
      await onStarted({ mode, pid: 42, startedAt: new Date(now).toISOString() });
      if (mode === "analyze") return { status: "ready", analyzeSha256: "7".repeat(64) };
      if (mode === "qa") return qaResult;
      return mode === "plan" ? planResult : { status: "rendered", planSha256: "d".repeat(64), artifact };
    },
    recoverOffline: async ({ mode }) => { calls.push(["recover", mode]); return null; },
    runAiPlanning: async ({ run, onStarted }) => {
      calls.push(["ai", run.analyzeSha256]);
      await onStarted({ startedAt: new Date(now).toISOString() });
      return aiResult ?? { status: "ready", intentSha256: "8".repeat(64), session: session() };
    },
    registerArtifact: async () => { calls.push(["artifact"]); return { artifactId: "artifact_vm" }; },
    delivery: {
      enqueue: async (input) => { calls.push(["delivery.enqueue"]); return { runId: input.runId, taskId: "task_vm",
        artifactId: input.artifactId, state: "upload_pending",
        target: { baseToken: "bas_vm", tableId: "tbl_vm", recordId: "rec_vm", fieldId: "fld_output" } }; },
      get: () => null,
    },
    onRunStarted: async () => { calls.push(["processing"]); },
  };
  let service = createVmPmoOrchestrator(dependencies);
  t.after(async () => { await service.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { calls, session, get f() { return service; }, get db() { return db; },
    setAi(value) { aiResult = value; }, setPlan(value) { planResult = value; }, setQa(value) { qaResult = value; },
    setCanExecute(value) { canExecute = value; }, advance(ms) { now += ms; },
    async restart() { await service.close(); db.close(); db = new DatabaseSync(sqlitePath);
      service = createVmPmoOrchestrator(dependencies); } };
}

test("a v3 run analyzes, lets AI write the intent, plans, renders and passes QA before delivery", async (t) => {
  const x = await orchestratorFixture(t);
  await x.f.register({ taskId: "task_vm" });
  const run = await x.f.pump("run_vm");
  assert.equal(run.state, "delivery_pending");
  assert.deepEqual(x.calls.map(([name]) => name), ["prepare", "slot", "analyze", "ai", "plan", "render",
    "processing", "release", "qa", "artifact", "delivery.enqueue"]);
  assert.deepEqual(x.calls.find(([name]) => name === "ai"), ["ai", "7".repeat(64)]);
  assert.deepEqual(x.calls.find(([name]) => name === "qa"), ["qa", "d".repeat(64)]);
  assert.equal(run.intentSha256, "8".repeat(64));
  assert.equal(run.aiSession.report, "按意见删除第二次出现。");
  assert.deepEqual(run.qaResult.counts, { passed: 8, needs_human: 2 });
  assert.ok(run.analyzeStartedAt && run.aiStartedAt && run.qaStartedAt);
});

test("a failed QA blocks the v3 run before any artifact is registered or uploaded", async (t) => {
  const x = await orchestratorFixture(t);
  x.setQa({ status: "checked", overall: "failed", counts: { failed: 1, passed: 7 }, qaSha256: "9".repeat(64) });
  await x.f.register({ taskId: "task_vm" });
  const run = await x.f.pump("run_vm");
  assert.deepEqual([run.state, run.errorCode], ["blocked", "VM_PMO_QA_FAILED"]);
  assert.equal(x.calls.some(([name]) => ["artifact", "delivery.enqueue"].includes(name)), false);
  await assert.rejects(x.f.retryPlan("run_vm"), { code: "VM_PMO_RETRY_NOT_ALLOWED" });
});

test("an AI planning block keeps render evidence absent and allows one new attempt by hand", async (t) => {
  const x = await orchestratorFixture(t);
  x.setAi({ status: "blocked", errorCode: "INTENT_MISSING", session: x.session() });
  await x.f.register({ taskId: "task_vm" });
  const blocked = await x.f.pump("run_vm");
  assert.deepEqual([blocked.state, blocked.errorCode], ["blocked", "INTENT_MISSING"]);
  assert.equal(x.calls.some(([name]) => ["plan", "render"].includes(name)), false);

  const retried = await x.f.retryPlan("run_vm");
  assert.deepEqual([retried.state, retried.planAttempt], ["ready", 2]);
  for (const key of ["prepared", "analyzeStartedAt", "analyzeSha256", "aiStartedAt", "aiSession", "intentSha256"])
    assert.equal(retried[key], undefined, key);
  assert.deepEqual(retried.retryHistory.map(({ errorCode }) => errorCode), ["INTENT_MISSING"]);
  x.setAi(null);
  assert.equal((await x.f.pump("run_vm")).state, "delivery_pending");
  assert.deepEqual(x.calls.filter(([name]) => name === "prepare"), [["prepare", 1], ["prepare", 2]]);
});

test("package blockers from an AI intent are kept for the operator", async (t) => {
  const x = await orchestratorFixture(t);
  x.setPlan({ status: "blocked", errorCode: "INTENT_BLOCKED",
    blockers: [{ code: "INTENT_NEEDS_USER_DECISION", message: "第二次和第三次都可能是指定位置" }] });
  await x.f.register({ taskId: "task_vm" });
  const run = await x.f.pump("run_vm");
  assert.deepEqual([run.state, run.errorCode], ["blocked", "INTENT_BLOCKED"]);
  assert.deepEqual(run.planBlockers, [{ code: "INTENT_NEEDS_USER_DECISION", message: "第二次和第三次都可能是指定位置" }]);
  assert.equal((await x.f.retryPlan("run_vm")).planAttempt, 2);
});

test("an interrupted AI turn is never resumed automatically", async (t) => {
  const x = await orchestratorFixture(t);
  let allow = true;
  x.setCanExecute(async ({ run }) => allow || run.state !== "analyzed");
  await x.f.register({ taskId: "task_vm" });
  allow = false;
  assert.equal((await x.f.pump("run_vm")).state, "analyzed");
  x.db.prepare("UPDATE vm_pmo_runs SET state = 'ai_planning' WHERE run_id = 'run_vm'").run();
  await x.restart();
  const run = await x.f.pump("run_vm");
  assert.deepEqual([run.state, run.errorCode], ["needs_attention", "VM_PMO_AI_OUTCOME_UNKNOWN"]);
  assert.equal(x.calls.filter(([name]) => name === "ai").length, 0);
  assert.equal((await x.f.retryPlan("run_vm")).planAttempt, 2);
});

test("turning automatic editing off parks a v3 run between analyze and AI planning", async (t) => {
  const x = await orchestratorFixture(t);
  let enabled = true;
  x.setCanExecute(async ({ run }) => enabled || run.state !== "analyzed");
  await x.f.register({ taskId: "task_vm" });
  enabled = false;
  const parked = await x.f.pump("run_vm");
  assert.equal(parked.state, "analyzed");
  assert.equal(x.calls.some(([name]) => name === "ai"), false);
  enabled = true;
  assert.equal((await x.f.pump("run_vm")).state, "delivery_pending");
  assert.equal(x.calls.filter(([name]) => name === "analyze").length, 1);
});

test("AI session environment drops Taskboard, Bridge, Feishu and Auto-Cut credentials", () => {
  const kept = vmPmoAiEnvironment({ PATH: "p", OPENAI_API_KEY: "o", CODEX_HOME: "h", HTTPS_PROXY: "x",
    CODEX_FEISHU_BRIDGE_SECRET: "s", CODEX_TASKBOARD_INSTANCE_TOKEN: "t", FEISHU_APP_SECRET: "f",
    CODEX_AUTOCUT_ARTIFACT_REPORT_TOKEN: "a", codex_vm_pmo_python_path: "v", LARK_TOKEN: "l" });
  assert.deepEqual(Object.keys(kept).sort(), ["CODEX_HOME", "HTTPS_PROXY", "OPENAI_API_KEY", "PATH"]);
});
