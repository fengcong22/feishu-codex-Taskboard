import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";

import { prepareVmPmoRunInput } from "../server/vm-pmo-run-input.mjs";
import { validateVmPmoInput } from "../server/vm-pmo-result-validator.mjs";
import { createVmPmoAiIntentRunner, vmPmoAiEnvironment } from "../server/vm-pmo-ai-intent.mjs";
import { packageWorkflowFromManifest } from "../shared/feishu-package-workflow.mjs";

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
  assert.deepEqual(result, { outcome: "completed", threadId: "thread-1" });
  assert.equal(spawned.length, 1);
  assert.deepEqual(seen.args.slice(seen.args.indexOf("-C"), seen.args.indexOf("-C") + 4), ["-C", runDir, "-s", "workspace-write"]);
  assert.ok(seen.args.includes("gpt-test"));
  assert.ok(!seen.args.includes("danger-full-access"));
  assert.deepEqual(Object.keys(seen.env).sort(), ["PATH", "USERPROFILE"]);
  assert.match(seen.prompt, /edit-intent\.json/u);
  assert.match(seen.prompt, /不运行 render/u);
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
